import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ActionButton } from "../components/ui/ActionButton";
import { IconCheck, IconRefresh, IconSend, IconTelegram, IconX } from "../components/icons/AppIcons";

interface TelegramMobilePageProps {
  onError: (message: string) => void;
}

type TgStatus = {
  connected?: boolean;
  status?: string;
  phone?: string | null;
  username?: string | null;
  displayName?: string | null;
  needsCode?: boolean;
  needsPassword?: boolean;
  needsQr?: boolean;
  pendingPhone?: string | null;
  qrDataUrl?: string | null;
  qrLoginUri?: string | null;
  qrExpires?: number | null;
  configured?: boolean;
  bridge_configured?: boolean;
  message?: string;
  error?: string | null;
};

function pickQrImage(st: TgStatus | null): string | null {
  if (!st) return null;
  const candidates = [st.qrDataUrl];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("data:image")) return c;
  }
  return null;
}

export function TelegramMobilePage({ onError }: TelegramMobilePageProps) {
  const { user } = useAuth();
  const [status, setStatus] = useState<TgStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [showPhoneLogin, setShowPhoneLogin] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testMessage, setTestMessage] = useState("Hello from Kafi Sales Agent Telegram Mobile.");
  const [notice, setNotice] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const st = (await client.getTelegramPersonalStatus()) as TgStatus;
      setStatus(st);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load Telegram Mobile status");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadStatus();
    const t = window.setInterval(() => void loadStatus(), 10000);
    return () => window.clearInterval(t);
  }, [loadStatus]);

  const connected = Boolean(status?.connected);
  const qrImage = pickQrImage(status);
  const awaitingQr = Boolean(status?.needsQr || qrImage) && !connected;

  useEffect(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!awaitingQr || connected) return;

    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const st = (await client.pollTelegramPersonalQrLogin()) as TgStatus;
          setStatus(st);
          if (st.connected) {
            setNotice("Telegram Mobile connected.");
            setPairing(false);
          } else if (st.needsPassword) {
            setNotice("Two-step verification is on — enter your Telegram password.");
            setPairing(false);
          }
        } catch {
          /* keep polling */
        }
      })();
    }, 2500);

    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [awaitingQr, connected]);

  async function startQrLogin() {
    setPairing(true);
    setBusy(true);
    setNotice(null);
    setShowPhoneLogin(false);
    try {
      const st = (await client.startTelegramPersonalQrLogin()) as TgStatus;
      setStatus(st);
      setNotice(
        st.message ||
          "Scan this QR code in Telegram: Settings → Devices → Link Desktop Device.",
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not generate Telegram QR code");
    } finally {
      setBusy(false);
      setPairing(false);
    }
  }

  async function startLogin() {
    setBusy(true);
    setNotice(null);
    try {
      const st = (await client.startTelegramPersonalLogin(phone.trim())) as TgStatus;
      setStatus(st);
      setNotice(st.message || "Check Telegram on your phone for the login code.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not start Telegram login");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setBusy(true);
    setNotice(null);
    try {
      const st = (await client.confirmTelegramPersonalCode(code.trim())) as TgStatus;
      setStatus(st);
      setCode("");
      setNotice(st.message || "Code submitted.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword() {
    setBusy(true);
    setNotice(null);
    try {
      const st = (await client.confirmTelegramPersonalPassword(password)) as TgStatus;
      setStatus(st);
      setPassword("");
      setNotice(st.message || "Connected.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Password failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this Telegram Mobile session?")) return;
    setBusy(true);
    try {
      const st = (await client.disconnectTelegramPersonal()) as TgStatus;
      setStatus(st);
      setNotice("Disconnected — generate a QR code to link again.");
      setShowPhoneLogin(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setNotice(null);
    try {
      await client.sendTelegramPersonal(testTo.trim(), testMessage.trim());
      setNotice("Test message sent.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
        Loading Telegram Mobile…
      </div>
    );
  }

  const unconfigured = status?.configured === false || status?.bridge_configured === false;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-5 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Telegram Mobile</h2>
            <p className="mt-1 text-sm text-slate-400">
              Link the Telegram account on your phone (same idea as WhatsApp Mobile). Messages send
              as <span className="text-slate-200">you</span>, not as a bot.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Signed in as {user?.full_name || user?.username || "user"} · session is per login.
            </p>
          </div>
          <ActionButton
            type="button"
            variant="secondary"
            icon={IconRefresh}
            onClick={() => void loadStatus()}
            disabled={busy || pairing}
          >
            Refresh
          </ActionButton>
        </div>

        {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}
        {status?.error ? <p className="text-xs text-rose-300">{status.error}</p> : null}

        {unconfigured ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100 space-y-2">
            <p className="font-medium">Bridge not configured yet</p>
            <ol className="list-decimal list-inside text-xs text-amber-100/90 space-y-1">
              <li>
                Create an app at{" "}
                <a
                  className="underline text-sky-300"
                  href="https://my.telegram.org"
                  target="_blank"
                  rel="noreferrer"
                >
                  my.telegram.org
                </a>{" "}
                → copy api_id / api_hash
              </li>
              <li>
                Deploy <code className="text-[11px]">telegram_bridge/</code> on Railway with those
                values + <code className="text-[11px]">TELEGRAM_BRIDGE_SECRET</code>
              </li>
              <li>
                Set <code className="text-[11px]">TELEGRAM_BRIDGE_URL</code> and the same secret on
                Sales Agent
              </li>
            </ol>
          </div>
        ) : connected ? (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-3">
            <p className="text-emerald-200 font-semibold text-lg">Telegram Mobile Connected</p>
            <p className="text-sm text-slate-300">
              {status?.displayName || status?.username || "Account"}{" "}
              {status?.phone ? (
                <span className="text-slate-400">· {status.phone}</span>
              ) : null}
              {status?.username ? (
                <span className="text-slate-500"> · @{status.username}</span>
              ) : null}
            </p>
            <ActionButton
              type="button"
              variant="secondary"
              icon={IconX}
              onClick={() => void disconnect()}
              disabled={busy}
            >
              Disconnect
            </ActionButton>
          </div>
        ) : status?.needsPassword ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              Two-step verification is enabled. Enter your Telegram cloud password.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Telegram password"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
            <ActionButton
              type="button"
              icon={IconCheck}
              onClick={() => void submitPassword()}
              disabled={busy || !password}
            >
              {busy ? "Checking…" : "Confirm password"}
            </ActionButton>
          </div>
        ) : status?.needsCode ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              Open Telegram on your phone
              {status.pendingPhone ? (
                <>
                  {" "}
                  (<span className="text-slate-200">{status.pendingPhone}</span>)
                </>
              ) : null}{" "}
              and enter the login code.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Login code"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono tracking-widest"
              autoComplete="one-time-code"
            />
            <ActionButton
              type="button"
              icon={IconCheck}
              onClick={() => void submitCode()}
              disabled={busy || !code.trim()}
            >
              {busy ? "Verifying…" : "Confirm code"}
            </ActionButton>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-lg border border-slate-700/80 bg-slate-950/40 p-4 space-y-2">
              <p className="text-sm font-medium text-slate-200">Scan QR with Telegram on your phone</p>
              <ol className="list-decimal list-inside text-xs text-slate-400 space-y-1">
                <li>Open Telegram on your mobile</li>
                <li>
                  Go to <span className="text-slate-300">Settings → Devices → Link Desktop Device</span>
                </li>
                <li>Scan the QR code shown below</li>
              </ol>
            </div>

            {qrImage ? (
              <div className="text-center space-y-4 py-2">
                <img
                  src={qrImage}
                  alt="Telegram login QR code"
                  className="mx-auto w-72 h-72 sm:w-80 sm:h-80 rounded-3xl bg-white p-4 shadow-2xl border-4 border-sky-500/40 object-contain"
                />
                <div className="inline-flex items-center gap-2 text-sm text-sky-300 bg-sky-500/10 px-4 py-1.5 rounded-full border border-sky-500/30 font-semibold">
                  <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-ping" />
                  Waiting for scan… QR refreshes automatically
                </div>
                <ActionButton
                  type="button"
                  variant="secondary"
                  icon={IconRefresh}
                  onClick={() => void startQrLogin()}
                  disabled={busy || pairing}
                  className="w-full justify-center"
                >
                  {pairing ? "Refreshing QR…" : "Refresh QR code"}
                </ActionButton>
              </div>
            ) : (
              <div className="text-center space-y-3 py-4">
                <p className="text-sm text-slate-300">
                  Generate a QR code to link your Telegram account — no phone number needed.
                </p>
                <ActionButton
                  type="button"
                  icon={IconTelegram}
                  onClick={() => void startQrLogin()}
                  disabled={busy || pairing}
                  className="w-full justify-center text-base py-3 font-bold"
                >
                  {pairing ? "Generating QR…" : "Generate QR code"}
                </ActionButton>
              </div>
            )}

            <div className="border-t border-slate-800 pt-4">
              <button
                type="button"
                className="text-xs text-slate-500 hover:text-slate-300 underline"
                onClick={() => setShowPhoneLogin((v) => !v)}
              >
                {showPhoneLogin ? "Hide phone login" : "Prefer phone + login code instead?"}
              </button>
              {showPhoneLogin ? (
                <div className="mt-3 space-y-3">
                  <p className="text-sm text-slate-300">
                    Enter the phone number for the Telegram account already logged in on your phone
                    (include country code, e.g. +92…).
                  </p>
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+92…"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                  <ActionButton
                    type="button"
                    icon={IconTelegram}
                    onClick={() => void startLogin()}
                    disabled={busy || phone.trim().length < 8}
                  >
                    {busy ? "Sending code…" : "Send login code to Telegram"}
                  </ActionButton>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {connected ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <h3 className="text-sm font-medium text-slate-200">Test send</h3>
          <input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="Recipient phone or @username"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <textarea
            value={testMessage}
            onChange={(e) => setTestMessage(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <ActionButton
            type="button"
            icon={IconSend}
            onClick={() => void sendTest()}
            disabled={busy || !testTo.trim() || !testMessage.trim()}
          >
            {busy ? "Sending…" : "Send test message"}
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}
