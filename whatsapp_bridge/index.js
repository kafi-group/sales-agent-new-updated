const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BRIDGE_SECRET = (process.env.WHATSAPP_BRIDGE_SECRET || "").trim();
const BACKEND_WEBHOOK_URL = (
  process.env.BACKEND_WEBHOOK_URL ||
  process.env.KAFI_BACKEND_URL ||
  "http://127.0.0.1:8001"
)
  .trim()
  .replace(/\/+$/, "");
// Prefer a Railway volume mount (/data) so QR sessions survive redeploys.
// Without a volume, container restarts wipe sessions/ and phones show "last active" then need re-scan.
const SESSIONS_DIR = (() => {
  const fromEnv = (process.env.WHATSAPP_SESSIONS_DIR || "").trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync("/data")) return path.join("/data", "whatsapp-sessions");
  return path.join(__dirname, "sessions");
})();

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
console.log(`[WhatsApp Bridge] Sessions directory: ${SESSIONS_DIR}`);

const logger = pino({ level: "silent" });

// In-memory active session tracking
// Map<sessionId, { sock, connected, phone, qr, qrDataUrl, status, shuttingDown }
const activeSessions = new Map();
const initLocks = new Map();

function socketIsOpen(sock) {
  if (!sock) return false;
  const ws = sock.ws;
  if (!ws) return false;
  if (typeof ws.isOpen === "boolean") return ws.isOpen;
  const state = ws.readyState;
  return state === 1; // OPEN only — never treat a dead/unknown socket as live
}

function isReallyConnected(sessionObj) {
  if (!sessionObj || sessionObj.shuttingDown || !sessionObj.sock) return false;
  return Boolean(sessionObj.connected && sessionObj.sock.user && socketIsOpen(sessionObj.sock));
}

function markSessionDisconnected(sessionObj, reason) {
  if (!sessionObj) return;
  sessionObj.connected = false;
  if (sessionObj.status === "qr-pending" || sessionObj.status === "connecting") return;
  sessionObj.status = "disconnected";
  if (reason) {
    console.log(`[Session] Marked disconnected (${reason})`);
  }
}

function attachSocketWatch(sock, sessionObj, sessionId) {
  const ws = sock?.ws;
  if (!ws || ws.__kafiWatchAttached) return;
  ws.__kafiWatchAttached = true;
  const onDead = (evt) => {
    if (sessionObj.shuttingDown) return;
    markSessionDisconnected(sessionObj, `websocket ${evt || "close"}`);
    console.log(`[Session ${sessionId}] WebSocket ended without a clean WhatsApp logout event`);
  };
  try {
    ws.on?.("close", () => onDead("close"));
    ws.on?.("error", () => onDead("error"));
  } catch {
    // Some Baileys builds expose a raw browser-style socket.
  }
}

function isLiveSession(sessionObj) {
  if (!sessionObj || !sessionObj.sock || sessionObj.shuttingDown) return false;
  if (isReallyConnected(sessionObj)) return true;
  const status = String(sessionObj.status || "").toLowerCase();
  return status === "qr-pending" || status === "connecting";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function qrImageIsComplete(sessionObj) {
  if (!sessionObj) return false;
  const url = sessionObj.qrDataUrl;
  if (typeof url !== "string" || !url.startsWith("data:image/") || url.length < 80) return false;
  return Boolean(sessionObj.qr && sessionObj.qrRenderedFor === sessionObj.qr);
}

async function renderQrDataUrl(qr) {
  // Low ECC keeps dense WhatsApp pairing strings scannable.
  return QRCode.toDataURL(qr, {
    errorCorrectionLevel: "L",
    margin: 2,
    width: 480,
    type: "image/png",
  });
}

async function ensureQrRendered(sessionObj) {
  if (!sessionObj?.qr || qrImageIsComplete(sessionObj)) return sessionObj;
  try {
    const dataUrl = await renderQrDataUrl(sessionObj.qr);
    if (sessionObj.qr && !sessionObj.shuttingDown) {
      sessionObj.qrDataUrl = dataUrl;
      sessionObj.qrRenderedFor = sessionObj.qr;
    }
  } catch (err) {
    console.error("[QR] Render retry failed:", err?.message || err);
  }
  return sessionObj;
}

async function waitForQrOrConnected(sessionObj, timeoutMs = 28000) {
  const started = Date.now();
  while (sessionObj && Date.now() - started < timeoutMs) {
    if (sessionObj.shuttingDown) break;
    await ensureQrRendered(sessionObj);
    // Wait for the finished PNG. The raw pairing string arrives first and is not an image.
    if (isReallyConnected(sessionObj) || qrImageIsComplete(sessionObj)) return sessionObj;
    await sleep(250);
  }
  await ensureQrRendered(sessionObj);
  return sessionObj;
}

async function fetchProfilePicture(sock) {
  try {
    const rawJid = sock.user?.id || "";
    if (!rawJid) return null;
    const cleanNum = rawJid.split("@")[0].split(":")[0];
    const userJid = cleanNum ? `${cleanNum}@s.whatsapp.net` : rawJid;

    try {
      const url = await sock.profilePictureUrl(userJid, "image");
      if (url) return url;
    } catch (e) {}

    try {
      const url = await sock.profilePictureUrl(rawJid, "image");
      if (url) return url;
    } catch (e) {}

    try {
      const previewUrl = await sock.profilePictureUrl(userJid, "preview");
      if (previewUrl) return previewUrl;
    } catch (e) {}

    try {
      const previewUrl = await sock.profilePictureUrl(rawJid, "preview");
      if (previewUrl) return previewUrl;
    } catch (e) {}

    return null;
  } catch (err) {
    console.warn("[ProfilePicture] Error fetching profile picture:", err?.message);
    return null;
  }
}

async function forwardInboundToBackend(sessionId, payload) {
  if (!BACKEND_WEBHOOK_URL) return;
  const targetUrl = `${BACKEND_WEBHOOK_URL}/api/whatsapp-personal/inbound`;
  try {
    const headers = { "Content-Type": "application/json" };
    if (BRIDGE_SECRET) {
      headers["x-bridge-secret"] = BRIDGE_SECRET;
    }
    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[Session ${sessionId}] Webhook response not OK (${res.status}): ${errText}`);
    } else {
      const kind = payload.from_me ? "Phone/outbound" : "Inbound";
      console.log(`[Session ${sessionId}] ${kind} message forwarded to backend successfully`);
    }
  } catch (err) {
    console.error(`[Session ${sessionId}] Failed to forward inbound message to backend:`, err.message);
  }
}

// Security middleware
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();
  if (BRIDGE_SECRET) {
    const provided = req.headers["x-bridge-secret"] || req.query.secret;
    if (provided !== BRIDGE_SECRET) {
      return res.status(401).json({ error: "Unauthorized: Invalid bridge secret" });
    }
  }
  next();
});

function getSessionDir(sessionId) {
  const safeId = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(SESSIONS_DIR, safeId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function hasSavedCreds(sessionId) {
  const safeId = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return fs.existsSync(path.join(SESSIONS_DIR, safeId, "creds.json"));
}

async function initBaileysSession(sessionId, forceNew = false) {
  const safeSessionId = String(sessionId || "default").trim();
  if (!safeSessionId) throw new Error("Session ID is required");

  while (initLocks.has(safeSessionId)) {
    try {
      await initLocks.get(safeSessionId);
    } catch {
      break;
    }
  }

  let existing = activeSessions.get(safeSessionId);
  if (existing && !forceNew && isLiveSession(existing)) {
    return existing;
  }

  let releaseLock = () => {};
  const lockPromise = new Promise((resolve) => {
    releaseLock = resolve;
  });
  initLocks.set(safeSessionId, lockPromise);

  try {
    existing = activeSessions.get(safeSessionId);
    if (existing && !forceNew && isLiveSession(existing)) {
      return existing;
    }

    if (existing && existing.sock) {
      existing.shuttingDown = true;
      try {
        existing.sock.ev.removeAllListeners();
        existing.sock.end(undefined);
      } catch (e) {
        // Ignore cleanup error
      }
    }

    const sessionDir = getSessionDir(safeSessionId);

    if (forceNew) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {
        console.error(`[Session ${safeSessionId}] Error clearing directory:`, e);
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (err) {
      console.warn(`[Session ${safeSessionId}] Could not fetch WA version, using Baileys default:`, err?.message);
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      // WhatsApp rejects custom/"Desktop" fingerprints with 428 and never emits a QR.
      browser: Browsers.macOS("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      getMessage: async () => undefined,
    });

    const sessionObj = {
      sock,
      connected: false,
      phone: null,
      profilePictureUrl: null,
      qr: null,
      qrDataUrl: null,
      status: "connecting",
      shuttingDown: false,
    };

    activeSessions.set(safeSessionId, sessionObj);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (sessionObj.shuttingDown) return;

      if (qr) {
        sessionObj.qr = qr;
        sessionObj.status = "qr-pending";
        sessionObj.connected = false;
        // Drop any previous picture so callers cannot return a half-old code.
        sessionObj.qrRenderedFor = null;
        console.log(`[Session ${safeSessionId}] QR received from WhatsApp, rendering image`);
        try {
          const dataUrl = await renderQrDataUrl(qr);
          if (sessionObj.qr === qr && !sessionObj.shuttingDown) {
            sessionObj.qrDataUrl = dataUrl;
            sessionObj.qrRenderedFor = qr;
            console.log(`[Session ${safeSessionId}] QR image ready (${dataUrl.length} chars)`);
          }
        } catch (err) {
          console.error(`[Session ${safeSessionId}] Error generating QR data URL:`, err);
        }
      }

      if (connection === "connecting") {
        sessionObj.status = sessionObj.qr ? "qr-pending" : "connecting";
      }

      if (connection === "open") {
        sessionObj.connected = true;
        sessionObj.status = "connected";
        sessionObj.qr = null;
        sessionObj.qrDataUrl = null;
        const jid = sock.user?.id || "";
        const rawNum = jid.split("@")[0].split(":")[0];
        sessionObj.phone = rawNum ? `+${rawNum}` : null;
        attachSocketWatch(sock, sessionObj, safeSessionId);
        console.log(`[Session ${safeSessionId}] Connected as ${sessionObj.phone || jid}`);

        fetchProfilePicture(sock)
          .then((url) => {
            sessionObj.profilePictureUrl = url;
          })
          .catch(() => {});
      }

      if (connection === "close") {
        sessionObj.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const restartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
        sessionObj.status = "disconnected";

        console.log(
          `[Session ${safeSessionId}] Closed. Reason: ${statusCode}, reconnecting: ${!loggedOut && !sessionObj.shuttingDown}`
        );

        if (sessionObj.shuttingDown) {
          if (activeSessions.get(safeSessionId) === sessionObj) {
            activeSessions.delete(safeSessionId);
          }
          return;
        }

        if (loggedOut) {
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (e) {
            // Ignore
          }
          if (activeSessions.get(safeSessionId) === sessionObj) {
            activeSessions.delete(safeSessionId);
          }
          return;
        }

        // 515 after QR scan is normal: WhatsApp requires a fresh socket with saved creds.
        const delay = restartRequired ? 800 : 2500;
        setTimeout(() => {
          const current = activeSessions.get(safeSessionId);
          if (current && current.shuttingDown) return;
          initBaileysSession(safeSessionId, false).catch((err) => {
            console.error(`[Session ${safeSessionId}] Reconnect failed:`, err);
          });
        }, delay);
      }
    });

    sock.ev.on("messages.upsert", async (m) => {
      try {
        // notify = live events; append = sync/history (needed for phone-sent fromMe echoes)
        if (m.type !== "notify" && m.type !== "append") return;
        for (const msg of m.messages) {
          const fromMe = Boolean(msg.key?.fromMe);
          // append history floods on reconnect — only keep phone-sent (fromMe) echoes
          if (m.type === "append" && !fromMe) continue;
          const remoteJid = msg.key.remoteJid || "";
          if (!remoteJid || remoteJid.includes("@broadcast") || remoteJid.includes("@g.us")) {
            continue;
          }
          // Status / newsletter JIDs
          if (remoteJid === "status@broadcast" || remoteJid.includes("@newsletter")) {
            continue;
          }

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            "";

          if (!text.trim()) continue;

          const rawPhone = remoteJid.split("@")[0].split(":")[0];
          const pushName = msg.pushName || "";

          console.log(
            `[Session ${safeSessionId}] ${fromMe ? "fromMe" : "Incoming"} WhatsApp message ` +
              `${fromMe ? "to" : "from"} ${rawPhone}: "${text.trim().slice(0, 50)}"`
          );

          await forwardInboundToBackend(safeSessionId, {
            session_id: safeSessionId,
            from_phone: rawPhone ? `+${rawPhone}` : remoteJid,
            wa_id: rawPhone || remoteJid,
            message: text.trim(),
            provider_message_id: msg.key.id,
            profile_name: pushName,
            from_me: fromMe,
          });
        }
      } catch (err) {
        console.error(`[Session ${safeSessionId}] Error processing messages.upsert:`, err);
      }
    });

    return sessionObj;
  } finally {
    initLocks.delete(safeSessionId);
    releaseLock();
  }
}

// Helper to format recipient phone into JID & raw digits
function formatJid(phone) {
  let cleaned = String(phone || "").replace(/\D/g, "");
  if (!cleaned) throw new Error("Invalid phone number");
  if (cleaned.startsWith("03") && cleaned.length === 11) {
    cleaned = "92" + cleaned.slice(1);
  } else if (cleaned.startsWith("0") && (cleaned.length === 10 || cleaned.length === 11)) {
    cleaned = "92" + cleaned.slice(1);
  }
  const jid = cleaned.endsWith("@s.whatsapp.net") ? cleaned : `${cleaned}@s.whatsapp.net`;
  return { rawDigits: cleaned, jid };
}

// --- Endpoints ---

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "kafi-whatsapp-bridge",
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "kafi-whatsapp-bridge",
    description: "Baileys WhatsApp Mobile multi-session bridge",
  });
});

function sessionPayload(sessionId, sessionObj) {
  if (!sessionObj) {
    return {
      session: sessionId,
      connected: false,
      status: "disconnected",
      phone: null,
      profilePictureUrl: null,
      profile_picture_url: null,
      qr: null,
      qrDataUrl: null,
    };
  }
  const live = isReallyConnected(sessionObj);
  if (sessionObj.connected && !live) {
    markSessionDisconnected(sessionObj, `${sessionId} stale connected flag`);
  }
  const pending = ["qr-pending", "connecting"].includes(String(sessionObj.status || "").toLowerCase());
  return {
    session: sessionId,
    connected: live,
    status: live ? "connected" : pending ? sessionObj.status : "disconnected",
    phone: live ? sessionObj.phone || null : null,
    profilePictureUrl: live ? sessionObj.profilePictureUrl || null : null,
    profile_picture_url: live ? sessionObj.profilePictureUrl || null : null,
    // Never send the raw Baileys pairing text — the UI used to paint it as a broken PNG.
    qr: null,
    qrDataUrl: qrImageIsComplete(sessionObj) ? sessionObj.qrDataUrl : null,
  };
}

app.get("/status", async (req, res) => {
  const sessionId = req.query.session || req.query.sessionId || "default";
  try {
    let sessionObj = activeSessions.get(sessionId);
    if (sessionObj && sessionObj.connected && !isReallyConnected(sessionObj)) {
      markSessionDisconnected(sessionObj, `${sessionId} dead socket on /status`);
    }
    // Restore a previously scanned session from saved creds, but do not start a
    // brand-new QR socket from status polling (that used to kill in-progress logins).
    if (!isLiveSession(sessionObj) && hasSavedCreds(sessionId)) {
      sessionObj = await initBaileysSession(sessionId, false);
    }
    if (sessionObj && isReallyConnected(sessionObj) && !sessionObj.profilePictureUrl && sessionObj.sock) {
      try {
        sessionObj.profilePictureUrl = await fetchProfilePicture(sessionObj.sock);
      } catch (e) {
        // Never fail status just because the profile photo lookup failed.
      }
    }
    return res.json(sessionPayload(sessionId, sessionObj));
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

app.get("/qr", async (req, res) => {
  const sessionId = req.query.session || req.query.sessionId || "default";
  try {
    let sessionObj = activeSessions.get(sessionId);
    if (!sessionObj || !isLiveSession(sessionObj)) {
      sessionObj = await initBaileysSession(sessionId, false);
    }

    sessionObj = await waitForQrOrConnected(sessionObj, 16000);
    if (!isReallyConnected(sessionObj) && !qrImageIsComplete(sessionObj) && !hasSavedCreds(sessionId)) {
      console.log(`[Session ${sessionId}] /qr timed out without image; starting a fresh pairing socket`);
      sessionObj = await initBaileysSession(sessionId, true);
      sessionObj = await waitForQrOrConnected(sessionObj, 18000);
    }
    return res.json(sessionPayload(sessionId, sessionObj));
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

app.post("/pair", async (req, res) => {
  const sessionId = req.body?.session || req.body?.sessionId || req.query?.session || "default";
  // Only wipe creds when explicitly requested (Re-Pair / fresh QR).
  // Default: restore existing session so Refresh does not kick a live phone link.
  const forceNew = Boolean(
    req.body?.forceNew ||
      req.body?.force ||
      req.body?.fresh ||
      req.query?.forceNew === "1" ||
      req.query?.force === "1"
  );
  try {
    let sessionObj;
    if (forceNew) {
      sessionObj = await initBaileysSession(sessionId, true);
    } else {
      // Keep an in-progress QR. Wiping here used to restart the socket before the PNG finished.
      sessionObj = activeSessions.get(sessionId);
      if (!isLiveSession(sessionObj)) {
        sessionObj = await initBaileysSession(sessionId, false);
      }
    }
    sessionObj = await waitForQrOrConnected(sessionObj, 16000);
    if (!isReallyConnected(sessionObj) && !qrImageIsComplete(sessionObj) && !hasSavedCreds(sessionId)) {
      // Stale empty session never emits a scannable QR. Do not wipe saved creds here.
      console.log(`[Session ${sessionId}] No QR after wait; forcing a fresh pairing socket`);
      sessionObj = await initBaileysSession(sessionId, true);
      sessionObj = await waitForQrOrConnected(sessionObj, 18000);
    }
    return res.json(sessionPayload(sessionId, sessionObj));
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

async function stopSession(sessionId) {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    existing.shuttingDown = true;
    existing.connected = false;
    existing.status = "disconnected";
    if (existing.sock) {
      try {
        await existing.sock.logout();
      } catch (e) {
        try {
          existing.sock.end(undefined);
        } catch (e2) {
          // Ignore
        }
      }
    }
  }
  const sessionDir = path.join(SESSIONS_DIR, String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_"));
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (e) {
    // Ignore directory removal errors
  }
  activeSessions.delete(sessionId);
  return { ok: true, session: sessionId, connected: false, status: "disconnected" };
}

app.post("/disconnect", async (req, res) => {
  const sessionId = req.body?.session || req.body?.sessionId || req.query?.session || "default";
  try {
    return res.json(await stopSession(sessionId));
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

app.post("/logout", async (req, res) => {
  const sessionId = req.body?.session || req.body?.sessionId || req.query?.session || "default";
  try {
    return res.json(await stopSession(sessionId));
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

const WHATSAPP_DOC_MAX_BYTES = 16 * 1024 * 1024;

function isAllowedDocumentUrl(raw) {
  try {
    const parsed = new URL(String(raw || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return /\/api\/catalogues\/[a-z0-9_-]+\/download$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function lookupWhatsAppJid(sock, rawDigits) {
  const attempts = [rawDigits, `${rawDigits}@s.whatsapp.net`];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const lookedUp = await sock.onWhatsApp(attempt);
      const rows = Array.isArray(lookedUp) ? lookedUp : lookedUp ? [lookedUp] : [];
      const hit = rows.find((row) => row && row.exists && row.jid);
      if (hit) return String(hit.jid);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw new Error(
      `Could not check ${rawDigits} on WhatsApp (${lastError.message || "lookup failed"}). ` +
        "The message was not sent."
    );
  }
  return null;
}

function ackLevel(status) {
  if (status && typeof status === "object" && typeof status.toNumber === "function") {
    return ackLevel(status.toNumber());
  }
  if (status === 0 || status === "ERROR") return 0;
  if (status === "PENDING") return 1;
  if (status === "SERVER_ACK") return 2;
  if (status === "DELIVERY_ACK") return 3;
  if (status === "READ") return 4;
  if (status === "PLAYED") return 5;
  return typeof status === "number" ? status : null;
}

function watchDelivery(sock, timeoutMs) {
  const buffered = [];
  let messageId = "";
  let settled = false;
  let timer = null;
  let resolveAck;
  let rejectAck;
  const promise = new Promise((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });

  function cleanup() {
    if (timer) clearTimeout(timer);
    sock.ev.off("messages.update", onUpdate);
    sock.ev.off("message-receipt.update", onReceipt);
  }

  function finish(ok, value) {
    if (settled) return;
    settled = true;
    cleanup();
    if (ok) resolveAck(value);
    else rejectAck(value);
  }

  function consider(id, status) {
    if (!messageId || id !== messageId) return false;
    const level = ackLevel(status);
    if (level === 0) {
      finish(false, new Error("WhatsApp rejected the message before the recipient could receive it."));
      return true;
    }
    if (typeof level === "number" && level >= 2) {
      finish(true, level);
      return true;
    }
    return false;
  }

  function onUpdate(updates) {
    const list = Array.isArray(updates) ? updates : [updates];
    if (!messageId) {
      buffered.push(...list);
      return;
    }
    for (const update of list) {
      if (consider(update?.key?.id, update?.update?.status)) return;
    }
  }

  function onReceipt(updates) {
    const list = Array.isArray(updates) ? updates : [updates];
    if (!messageId) {
      for (const update of list) buffered.push({ key: update?.key, update: { status: 3 } });
      return;
    }
    for (const update of list) {
      if (consider(update?.key?.id, 3)) return;
    }
  }

  sock.ev.on("messages.update", onUpdate);
  sock.ev.on("message-receipt.update", onReceipt);
  timer = setTimeout(() => {
    finish(
      false,
      new Error(
        "WhatsApp did not confirm delivery. The recipient did not get this message. " +
          "Check that your linked phone is online, then try again."
      )
    );
  }, timeoutMs);

  return {
    promise,
    arm(id, initialStatus) {
      messageId = id;
      if (consider(id, initialStatus)) return;
      for (const update of buffered.splice(0, buffered.length)) {
        if (consider(update?.key?.id, update?.update?.status)) return;
      }
    },
    stop() {
      finish(true, null);
    },
  };
}

async function sendAndConfirm(sock, jid, content, timeoutMs) {
  const watch = watchDelivery(sock, timeoutMs);
  try {
    const sent = await sock.sendMessage(jid, content);
    const messageId = sent?.key?.id;
    if (!messageId) {
      watch.stop();
      throw new Error("WhatsApp did not accept the message.");
    }
    watch.arm(messageId, sent.status);
    const ack = await watch.promise;
    return { messageId, ack };
  } catch (err) {
    watch.stop();
    throw err;
  }
}

app.post("/send", async (req, res) => {
  const sessionId = req.body?.session || req.body?.sessionId || "default";
  const toPhone = req.body?.to || req.body?.phone || req.body?.to_phone;
  const message = req.body?.message || req.body?.text || "";
  const documentUrl = (req.body?.document_url || req.body?.documentUrl || "").trim();
  const filename = (req.body?.filename || req.body?.fileName || "catalogue.pdf").trim();

  if (!toPhone) return res.status(400).json({ error: "Missing recipient phone number (to)" });
  if (!String(message).trim() && !documentUrl) {
    return res.status(400).json({ error: "Missing message text" });
  }

  try {
    let sessionObj = activeSessions.get(sessionId);
    if (!isReallyConnected(sessionObj)) {
      if (sessionObj) markSessionDisconnected(sessionObj, `${sessionId} send while socket dead`);
      return res.status(409).json({
        error: "Personal WhatsApp is not connected. Open WhatsApp Mobile and scan QR.",
        connected: false,
      });
    }

    const { rawDigits } = formatJid(toPhone);
    const jid = await lookupWhatsAppJid(sessionObj.sock, rawDigits);
    if (!jid) {
      return res.status(404).json({
        error: `${rawDigits} is not on WhatsApp, so nothing was sent.`,
      });
    }

    let payload;
    let mode = "text";
    if (documentUrl) {
      if (!isAllowedDocumentUrl(documentUrl)) {
        return res.status(400).json({ error: "Catalogue download URL was not accepted." });
      }
      const downloaded = await fetch(documentUrl);
      if (!downloaded.ok) {
        return res.status(502).json({
          error: `Could not download the catalogue PDF (${downloaded.status}). Nothing was sent.`,
        });
      }
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      if (!bytes.length) {
        return res.status(502).json({ error: "Catalogue PDF was empty. Nothing was sent." });
      }
      if (bytes.length > WHATSAPP_DOC_MAX_BYTES) {
        return res.status(413).json({
          error: "Catalogue PDF is too large to attach on WhatsApp. Send the download link instead.",
        });
      }
      payload = {
        document: bytes,
        mimetype: "application/pdf",
        fileName: filename || "catalogue.pdf",
        caption: String(message || "").trim() || undefined,
      };
      mode = "document";
    } else {
      payload = { text: String(message) };
    }

    const confirmMs = mode === "document" ? 40000 : 15000;
    const confirmed = await sendAndConfirm(sessionObj.sock, jid, payload, confirmMs);
    console.log(`[Session ${sessionId}] Delivered ${mode} to ${jid} ack=${confirmed.ack}`);

    return res.json({
      status: "sent",
      delivered: true,
      mode,
      session: sessionId,
      to: toPhone,
      jid,
      messageId: confirmed.messageId,
      ack: confirmed.ack,
    });
  } catch (err) {
    console.error(`[Session ${sessionId}] Send error:`, err);
    return res.status(500).json({ error: err.message || "Failed to send message" });
  }
});

setInterval(() => {
  for (const [sessionId, sessionObj] of activeSessions.entries()) {
    if (!sessionObj || sessionObj.shuttingDown) continue;
    if (sessionObj.connected && !isReallyConnected(sessionObj)) {
      markSessionDisconnected(sessionObj, `${sessionId} watchdog`);
      if (hasSavedCreds(sessionId)) {
        initBaileysSession(sessionId, false).catch((err) => {
          console.error(`[Session ${sessionId}] Watchdog reconnect failed:`, err?.message || err);
        });
      }
    }
  }
}, 15_000);

function listSavedSessionIds() {
  try {
    return fs
      .readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => fs.existsSync(path.join(SESSIONS_DIR, name, "creds.json")));
  } catch {
    return [];
  }
}

async function restoreSavedSessionsOnBoot() {
  const ids = listSavedSessionIds();
  if (!ids.length) {
    console.log("[WhatsApp Bridge] No saved sessions to restore on boot");
    return;
  }
  console.log(`[WhatsApp Bridge] Restoring ${ids.length} saved session(s) from disk…`);
  for (const sessionId of ids) {
    try {
      await initBaileysSession(sessionId, false);
      console.log(`[WhatsApp Bridge] Restored session ${sessionId}`);
    } catch (err) {
      console.error(`[WhatsApp Bridge] Failed to restore ${sessionId}:`, err?.message || err);
    }
  }
}

app.listen(PORT, () => {
  console.log(`[WhatsApp Bridge] Listening on port ${PORT}`);
  // Re-link phones after Railway restart without asking users to re-scan (needs volume).
  restoreSavedSessionsOnBoot().catch((err) => {
    console.error("[WhatsApp Bridge] Boot restore failed:", err?.message || err);
  });
});
