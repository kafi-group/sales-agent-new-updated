import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { client } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ActionButton } from "../components/ui/ActionButton";
import { IconRefresh, IconSend, IconWhatsApp } from "../components/icons/AppIcons";

interface WhatsAppMobilePageProps {
  onError: (message: string) => void;
}

function qrImageFromPayload(qr: Record<string, unknown> | null): string | null {
  if (!qr) return null;
  const candidates = [qr.qrDataUrl, qr.dataUrl, qr.qr];
  for (const value of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (value.startsWith("data:")) return value;
    return `data:image/png;base64,${value}`;
  }
  return null;
}

function isConnectedStatus(st: Record<string, unknown> | null): boolean {
  if (!st) return false;
  const label = String(st.status ?? "").toLowerCase();
  if (st.connected === false) return false;
  if (["disconnected", "qr-pending", "connecting", "close", "closed", "logged_out"].includes(label)) {
    return false;
  }
  return Boolean(st.connected) && (label === "connected" || label === "open" || label === "ready" || label === "");
}

function isConnectingStatus(st: Record<string, unknown> | null): boolean {
  const label = String(st?.status ?? "").toLowerCase();
  return label === "connecting";
}

function WhatsAppMobileHeaderStrip({
  userName,
  avatarUrl,
  connected,
  connectedPhone,
}: {
  userName: string;
  avatarUrl: string | null;
  connected: boolean;
  connectedPhone?: string | null;
}) {
  const label = connectedPhone || (connected ? "Linked" : "Not linked");
  return (
    <>
      <div
        title={label}
        className="relative shrink-0 w-9 h-9 rounded-full overflow-hidden border border-emerald-400/70 bg-emerald-500/15"
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
        ) : (
          <span className="w-full h-full flex items-center justify-center text-emerald-300 text-sm font-bold">
            {userName.charAt(0).toUpperCase()}
          </span>
        )}
        <span
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-950 ${
            connected ? "bg-emerald-400" : "bg-slate-500"
          }`}
        />
      </div>
      <p className="min-w-0 flex-1 text-xs sm:text-sm text-slate-400 truncate leading-snug">
        Link your personal WhatsApp by scanning QR. Each login has its own isolated session.
      </p>
      <span className="inline-flex shrink-0 rounded-lg border border-emerald-600/80 bg-emerald-600 px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-semibold text-white">
        Scan &amp; connect
      </span>
    </>
  );
}

export function WhatsAppMobilePage({ onError }: WhatsAppMobilePageProps) {
  const { user } = useAuth();
  const userName = user?.full_name || user?.username || "Your account";

  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [qr, setQr] = useState<Record<string, unknown> | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [toPhone, setToPhone] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [teamStatus, setTeamStatus] = useState<Array<Record<string, unknown>>>([]);

  const avatarStorageKey = `whatsapp_avatar_${user?.id || "default"}`;
  const phoneStorageKey = `whatsapp_phone_number_${user?.id || "default"}`;
  const [customAvatar, setCustomAvatar] = useState<string | null>(() => {
    return localStorage.getItem(avatarStorageKey) || null;
  });
  const [customPhone, setCustomPhone] = useState<string | null>(() => {
    return localStorage.getItem(phoneStorageKey) || null;
  });
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [avatarInput, setAvatarInput] = useState("");
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");

  const [imgFailed, setImgFailed] = useState(false);
  const pairingLock = useRef(false);
  const refreshLock = useRef(false);
  const qrRef = useRef<Record<string, unknown> | null>(null);
  const connected = isConnectedStatus(status);
  const connecting = isConnectingStatus(status);
  const statusLabel = String(status?.status ?? (connected ? "connected" : "disconnected"));
  const connectedPhone = status?.phone
    ? String(status.phone)
    : status?.connectedPhone
      ? String(status.connectedPhone)
      : null;
  const profilePictureUrl = (
    (status?.profilePictureUrl || status?.profile_picture_url || status?.profilePic) as string
  ) || null;

  const displayAvatarUrl = customAvatar || (!imgFailed ? profilePictureUrl : null);

  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [headerSlotSm, setHeaderSlotSm] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById("wa-mobile-header-slot"));
    setHeaderSlotSm(document.getElementById("wa-mobile-header-slot-sm"));
  }, []);

  useEffect(() => {
    setImgFailed(false);
  }, [profilePictureUrl]);

  function handleSaveCustomAvatar(url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
      localStorage.removeItem(avatarStorageKey);
      setCustomAvatar(null);
    } else {
      localStorage.setItem(avatarStorageKey, trimmed);
      setCustomAvatar(trimmed);
    }
    setEditingAvatar(false);
    setImgFailed(false);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const res = evt.target?.result as string;
      if (res) {
        handleSaveCustomAvatar(res);
      }
    };
    reader.readAsDataURL(file);
  }
  const qrPending = statusLabel.toLowerCase() === "qr-pending";
  const qrImage = qrImageFromPayload(qr);
  qrRef.current = qr;

  const refresh = useCallback(async (opts?: { silent?: boolean; skipQr?: boolean; includeTeam?: boolean }) => {
    if (pairingLock.current || refreshLock.current) return;
    refreshLock.current = true;
    if (!opts?.silent) setLoading(true);
    const includeTeam = opts?.includeTeam ?? !opts?.silent;
    try {
      const [st, session, teamRes] = await Promise.all([
        client.getWhatsAppPersonalStatus(),
        client.getWhatsAppPersonalSession(),
        includeTeam
          ? client.getWhatsAppPersonalTeamStatus().catch(() => [])
          : Promise.resolve(null),
      ]);
      setStatus(st);
      setSessionId(session.session_id);
      if (Array.isArray(teamRes)) {
        setTeamStatus(teamRes);
      }

      if (isConnectedStatus(st)) {
        setQr(null);
        qrRef.current = null;
        return;
      }

      if (opts?.skipQr || isConnectingStatus(st) || qrImageFromPayload(qrRef.current)) {
        return;
      }

      let qrData: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          qrData = await client.getWhatsAppPersonalQr();
          if (qrData?.qr || qrData?.qrDataUrl || isConnectedStatus(qrData)) break;
        } catch {
          // ignore, retry
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
      }
      if (isConnectedStatus(qrData)) {
        setStatus(qrData);
        setQr(null);
        qrRef.current = null;
        return;
      }
      if (qrData?.qr || qrData?.qrDataUrl) {
        setQr(qrData);
        qrRef.current = qrData;
      }
    } catch (e) {
      if (!opts?.silent) {
        onError(e instanceof Error ? e.message : "Could not load WhatsApp Mobile status");
      }
    } finally {
      setLoading(false);
      refreshLock.current = false;
    }
  }, [onError]);

  const refreshTeam = useCallback(async () => {
    try {
      const teamRes = await client.getWhatsAppPersonalTeamStatus();
      if (Array.isArray(teamRes)) setTeamStatus(teamRes);
    } catch {
      /* Isolated from the rest of the dashboard — never raise a global header error. */
    }
  }, []);

  async function handleDisconnectTargetUser(targetUserId: number, targetName: string) {
    if (
      !window.confirm(
        `Disconnect mobile WhatsApp for ${targetName}? This will ONLY disconnect ${targetName}'s session and will NOT affect any other user's WhatsApp.`
      )
    ) {
      return;
    }
    try {
      await client.disconnectWhatsAppPersonalUser(targetUserId);
      setNotice(`Disconnected ${targetName}'s WhatsApp session successfully.`);
      await refresh({ silent: true, skipQr: true, includeTeam: false });
      void refreshTeam();
    } catch (e) {
      onError(e instanceof Error ? e.message : `Failed to disconnect ${targetName}`);
    }
  }

  useEffect(() => {
    setCustomAvatar(localStorage.getItem(`whatsapp_avatar_${user?.id || "default"}`) || null);
    setCustomPhone(localStorage.getItem(`whatsapp_phone_number_${user?.id || "default"}`) || null);
    setStatus(null);
    setQr(null);
    setLoading(true);
    void refresh();
  }, [user?.id, refresh]);

  const pollMs = useMemo(() => {
    if (connected) return 8_000;
    if (connecting) return 2_000;
    if (qrPending || qrImage) return 4_000;
    return 8_000;
  }, [connected, connecting, qrPending, qrImage]);

  useEffect(() => {
    const timer = window.setInterval(
      () => void refresh({ silent: true, includeTeam: false }),
      pollMs,
    );
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);

  useEffect(() => {
    void refreshTeam();
    const timer = window.setInterval(() => void refreshTeam(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshTeam]);

  async function handlePair(forceNew = false) {
    if (forceNew) {
      const ok = window.confirm(
        `Generate a FRESH QR for ${userName}? This unlinks ONLY ${userName}'s WhatsApp Mobile session. ` +
          `Asim / Usman / Sadia / other accounts stay connected.`
      );
      if (!ok) return;
    }
    pairingLock.current = true;
    setPairing(true);
    setNotice(null);
    setStatus({ connected: false, status: "qr-pending" });
    setQr(null);
    qrRef.current = null;
    try {
      const qrData = await client.pairWhatsAppPersonal({ forceNew });
      if (isConnectedStatus(qrData)) {
        setStatus(qrData);
        setQr(null);
        qrRef.current = null;
        setNotice(`${userName}'s WhatsApp is already connected.`);
      } else {
        setQr(qrData);
        qrRef.current = qrData;
        setStatus({ ...(qrData ?? {}), connected: false, status: "qr-pending" });
        setNotice(
          forceNew
            ? `Scan this fresh QR code with WhatsApp on ${userName}'s mobile phone. Keep this page open until it says Connected.`
            : `Connecting ${userName}'s WhatsApp… If a QR appears, scan it. Existing sessions restore without kicking other users.`
        );
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not generate QR code");
    } finally {
      pairingLock.current = false;
      setPairing(false);
    }
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        `Disconnect mobile WhatsApp for ${userName}? This will ONLY disconnect ${userName}'s session (${sessionId}). Other team members' WhatsApp accounts will remain connected.`
      )
    ) {
      return;
    }
    pairingLock.current = true;
    setLoading(true);
    setStatus({ connected: false, status: "disconnected" });
    setQr(null);
    qrRef.current = null;
    localStorage.removeItem(phoneStorageKey);
    setCustomPhone(null);
    try {
      await client.disconnectWhatsAppPersonal();
      setNotice(
        `Disconnected ${userName}'s mobile WhatsApp. Unlink this device on your phone (Linked devices), then tap Generate QR Code to pair again.`
      );
      pairingLock.current = false;
      await refresh({ silent: true, skipQr: true, includeTeam: false });
      void refreshTeam();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      pairingLock.current = false;
      setLoading(false);
    }
  }

  async function handleSend() {
    setSending(true);
    setNotice(null);
    try {
      await client.sendWhatsAppPersonal({ to_phone: toPhone.trim(), message: message.trim() });
      setNotice("Test message sent from your linked mobile WhatsApp.");
      setMessage("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6 w-full max-w-full">
      {headerSlot
        ? createPortal(
            <WhatsAppMobileHeaderStrip
              userName={userName}
              avatarUrl={displayAvatarUrl}
              connected={connected}
              connectedPhone={customPhone || connectedPhone}
            />,
            headerSlot,
          )
        : null}
      {headerSlotSm
        ? createPortal(
            <WhatsAppMobileHeaderStrip
              userName={userName}
              avatarUrl={displayAvatarUrl}
              connected={connected}
              connectedPhone={customPhone || connectedPhone}
            />,
            headerSlotSm,
          )
        : null}

      {notice ? (
        <div className="text-base text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl px-6 py-4 flex items-center justify-between shadow-lg">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white text-sm font-semibold ml-4">
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Main Connection Container - Stretched Full Width */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Connection Status & QR Code Panel (Col 7) */}
        <div className="lg:col-span-7 rounded-3xl border border-slate-800 bg-slate-900/80 p-8 space-y-8 flex flex-col justify-between shadow-2xl">
          <div>
            <h3 className="text-xl font-bold text-slate-100 mb-6 flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
              Connection Status
            </h3>
            
            {connected ? (
              <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6 space-y-6 shadow-inner">
                {/* 3x Larger Profile Picture & User Info Container */}
                <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 text-center sm:text-left">
                  {/* Avatar: 3X Larger (176px x 176px) */}
                  <div className="relative shrink-0 group">
                    {displayAvatarUrl ? (
                      <img
                        src={displayAvatarUrl}
                        alt={`${userName}'s WhatsApp profile`}
                        referrerPolicy="no-referrer"
                        onError={() => setImgFailed(true)}
                        className="w-44 h-44 rounded-full object-cover border-4 border-emerald-400 shadow-2xl ring-4 ring-emerald-500/20 transition-transform duration-200 group-hover:scale-[1.02]"
                      />
                    ) : (
                      <div className="w-44 h-44 rounded-full bg-emerald-500/20 text-emerald-300 font-extrabold text-5xl flex items-center justify-center border-4 border-emerald-400/80 shadow-2xl ring-4 ring-emerald-500/20">
                        {userName.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="absolute bottom-2 right-2 w-7 h-7 bg-emerald-500 border-4 border-slate-900 rounded-full shadow-md" />
                    
                    <button
                      type="button"
                      onClick={() => setEditingAvatar(true)}
                      className="absolute inset-0 bg-slate-950/80 text-white rounded-full flex flex-col items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity font-semibold px-4 text-center backdrop-blur-sm"
                      title="Change or upload profile picture"
                    >
                      <span className="text-sm font-bold text-emerald-300">Edit Photo</span>
                      <span className="text-[10px] text-slate-300 mt-1">Upload file or URL</span>
                    </button>
                  </div>

                  <div className="space-y-3 pt-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <h4 className="text-2xl font-extrabold text-emerald-300 tracking-tight">WhatsApp Mobile Connected</h4>
                      <button
                        type="button"
                        onClick={() => setEditingAvatar(true)}
                        className="text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 px-3 py-1 rounded-lg font-medium transition-colors"
                      >
                        Set / Change Photo
                      </button>
                    </div>

                    {/* Prominent Connected Phone Number Badge */}
                    <div className="bg-slate-950/80 border-2 border-emerald-500/40 rounded-2xl p-4 space-y-3 shadow-inner my-2">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="space-y-0.5">
                          <span className="text-xs text-emerald-400 font-extrabold uppercase tracking-wider block">
                            📱 Connected Mobile Phone Number
                          </span>
                          <span className="text-2xl font-extrabold font-mono text-slate-100 tracking-wide block">
                            {customPhone || connectedPhone || "Phone Number Linked"}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPhoneInput(customPhone || connectedPhone || "");
                            setEditingPhone(true);
                          }}
                          className="text-xs bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 px-3 py-1.5 rounded-xl font-bold transition-colors shadow-sm"
                        >
                          ✏️ Label / Edit Number
                        </button>
                      </div>

                      {editingPhone && (
                        <div className="pt-3 border-t border-slate-800 flex items-center gap-3 flex-wrap">
                          <input
                            type="text"
                            value={phoneInput}
                            onChange={(e) => setPhoneInput(e.target.value)}
                            placeholder="Type phone number or SIM label (e.g. +923142867152)..."
                            className="flex-1 min-w-[200px] text-base bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const val = phoneInput.trim();
                              if (val) {
                                localStorage.setItem(phoneStorageKey, val);
                                setCustomPhone(val);
                              } else {
                                localStorage.removeItem(phoneStorageKey);
                                setCustomPhone(null);
                              }
                              setEditingPhone(false);
                            }}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-bold shadow-md"
                          >
                            Save Number
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingPhone(false)}
                            className="px-3 py-2 text-slate-400 hover:text-white text-xs font-semibold"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>

                    <p className="text-base text-emerald-400 font-semibold">
                      Account Session: {userName}
                    </p>
                    <p className="text-sm text-slate-300 leading-relaxed pt-1">
                      Your mobile WhatsApp is active. Post-call follow-ups and test sends use this linked number.
                    </p>
                  </div>
                </div>

                {editingAvatar && (
                  <div className="p-4 rounded-xl bg-slate-950/90 border border-slate-700 text-sm space-y-3 shadow-xl">
                    <p className="text-slate-200 font-semibold text-base">Set WhatsApp Profile Picture</p>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        placeholder="Paste image URL..."
                        value={avatarInput}
                        onChange={(e) => setAvatarInput(e.target.value)}
                        className="flex-1 rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveCustomAvatar(avatarInput)}
                        className="px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-500 font-semibold text-sm transition-colors"
                      >
                        Save URL
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-800">
                      <label className="cursor-pointer text-emerald-400 hover:text-emerald-300 font-semibold text-sm underline">
                        Upload image file
                        <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                      </label>
                      {customAvatar && (
                        <button
                          type="button"
                          onClick={() => handleSaveCustomAvatar("")}
                          className="text-red-400 hover:underline font-medium text-xs"
                        >
                          Remove custom photo
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingAvatar(false)}
                        className="text-slate-400 hover:text-white font-medium text-xs"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-6">
                <h4 className="text-lg font-bold text-amber-300">Not Connected</h4>
                <p className="text-sm text-slate-200 mt-1.5 leading-relaxed">
                  Scan the QR code below to pair your mobile WhatsApp number with your sales account.
                </p>
              </div>
            )}
          </div>

          {!connected ? (
            <div className="space-y-6 text-center py-4">
              {connecting ? (
                <div className="py-10 space-y-3">
                  <div className="text-lg font-bold text-emerald-300">Phone scanned — finishing login…</div>
                  <p className="text-sm text-slate-300 max-w-md mx-auto leading-relaxed">
                    WhatsApp is restarting the session. Keep this page open. If your phone stays on “Logging in…”, wait about 10 seconds.
                  </p>
                  <div className="inline-flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 px-4 py-1.5 rounded-full border border-emerald-500/30 font-semibold">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                    Completing connection…
                  </div>
                </div>
              ) : loading && !qrImage ? (
                <div className="py-12 text-slate-400 text-base font-medium animate-pulse">
                  Initializing WhatsApp Mobile bridge session…
                </div>
              ) : qrImage ? (
                <div className="space-y-4">
                  <div className="relative inline-block">
                    {/* QR Code: Super Large (420px x 420px) */}
                    <img
                      src={qrImage}
                      alt="WhatsApp Mobile QR code"
                      className="mx-auto w-80 h-80 sm:w-[420px] sm:h-[420px] rounded-3xl bg-white p-5 shadow-2xl border-4 border-emerald-500/50 object-contain"
                    />
                    <div className="mt-4 inline-flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 px-4 py-1.5 rounded-full border border-emerald-500/30 font-semibold">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                      Auto-checking connection…
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-8 space-y-4">
                  <p className="text-base text-slate-300 font-medium">Ready to pair your mobile WhatsApp?</p>
                  <ActionButton
                    icon={IconWhatsApp}
                    variant="primary"
                    size="md"
                    disabled={pairing}
                    onClick={() => void handlePair(false)}
                    title="Generate QR code"
                    className="w-full justify-center text-base py-3 font-bold"
                  >
                    {pairing ? "Generating QR Code…" : "Generate QR Code"}
                  </ActionButton>
                </div>
              )}

              {qrImage && !connecting ? (
                <ActionButton
                  icon={IconRefresh}
                  variant="ghost"
                  size="md"
                  disabled={pairing}
                  onClick={() => void handlePair(true)}
                  title="Refresh QR code (this account only)"
                  className="w-full justify-center text-base py-3"
                >
                  {pairing ? "Refreshing QR…" : "Refresh QR Code"}
                </ActionButton>
              ) : null}

              <ActionButton
                icon={IconRefresh}
                variant="ghost"
                size="md"
                onClick={() => void handleDisconnect()}
                title="Disconnect this WhatsApp session so you can unlink the device on your phone"
                className="w-full justify-center text-slate-400 hover:text-red-400 text-base py-3 border border-slate-800"
              >
                Disconnect / Unpair Mobile
              </ActionButton>
            </div>
          ) : (
            <div className="pt-6 border-t border-slate-800 space-y-3">
              <ActionButton
                icon={IconWhatsApp}
                variant="primary"
                size="md"
                disabled={pairing}
                onClick={() => void handlePair(true)}
                title="Re-pair this account only — other users stay connected"
                className="w-full justify-center text-base py-3 font-bold bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {pairing ? "Generating Fresh QR Code…" : "Re-Pair WhatsApp (Generate Fresh QR Code)"}
              </ActionButton>
              
              <ActionButton
                icon={IconRefresh}
                variant="ghost"
                size="md"
                onClick={() => void handleDisconnect()}
                title="Disconnect personal mobile WhatsApp"
                className="w-full justify-center text-slate-400 hover:text-red-400 text-base py-3 border border-slate-800"
              >
                Disconnect / Unpair Mobile
              </ActionButton>
            </div>
          )}

          <div className="text-xs text-slate-300 pt-3 border-t border-slate-800/80 flex items-center justify-between flex-wrap gap-2">
            <span>Account Session: <span className="text-emerald-400 font-bold text-sm">{userName}</span></span>
            <span className="bg-slate-800/80 px-2.5 py-1 rounded-full text-emerald-300 font-semibold border border-slate-700">Isolated Multi-User Session</span>
          </div>
        </div>

        {/* Pairing Instructions & Quick Test Sender (Col 5) */}
        <div className="lg:col-span-5 space-y-8 flex flex-col justify-between">
          {/* How to Connect Box */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-8 space-y-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-100">How to Connect</h3>
            <ol className="space-y-4 text-base text-slate-200">
              <li className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-extrabold text-sm flex items-center justify-center shrink-0 mt-0.5">
                  1
                </span>
                <span className="leading-relaxed">
                  Open <strong className="text-slate-50 font-bold">WhatsApp</strong> on your mobile phone.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-extrabold text-sm flex items-center justify-center shrink-0 mt-0.5">
                  2
                </span>
                <span className="leading-relaxed">
                  Tap <strong className="text-slate-50 font-bold">Settings</strong> (on iPhone) or <strong className="text-slate-50 font-bold">Menu ⋮</strong> (on Android) → <strong className="text-slate-50 font-bold">Linked Devices</strong>.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-extrabold text-sm flex items-center justify-center shrink-0 mt-0.5">
                  3
                </span>
                <span className="leading-relaxed">
                  Tap <strong className="text-slate-50 font-bold">Link a Device</strong> and scan the QR code on your computer screen.
                </span>
              </li>
            </ol>
          </div>

          {/* Quick Test Sender */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-8 space-y-6 shadow-2xl">
            <div>
              <h3 className="text-xl font-bold text-slate-100">Quick Test Sender</h3>
              <p className="text-sm text-slate-400 mt-1">
                Send a test message directly from your linked mobile WhatsApp number to verify.
              </p>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-semibold text-slate-300 block mb-2">Recipient Phone Number</label>
                <input
                  value={toPhone}
                  onChange={(e) => setToPhone(e.target.value)}
                  placeholder="e.g. +923001234567"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-300 block mb-2">Message Text</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Hello, testing WhatsApp Mobile integration!"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <ActionButton
                icon={IconSend}
                variant="primary"
                size="md"
                disabled={sending || !connected || !toPhone.trim() || !message.trim()}
                onClick={() => void handleSend()}
                className="w-full justify-center text-base py-3.5 font-bold"
              >
                {sending ? "Sending Test Message…" : "Send Test Message"}
              </ActionButton>
            </div>
          </div>
        </div>
      </div>

      {/* Team WhatsApp Multi-User Session Status Section */}
      <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-8 space-y-6 shadow-2xl mt-8">
        <div className="flex items-center justify-between gap-4 flex-wrap border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-xl font-bold text-slate-100 flex items-center gap-3">
              <IconWhatsApp className="w-6 h-6 text-emerald-400" />
              Sales Team WhatsApp Sessions Overview
            </h3>
            <p className="text-sm text-slate-300 mt-1">
              Every team member has their own independent WhatsApp session namespace. Disconnecting one team member does NOT affect other users.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshTeam()}
            className="text-xs bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 px-3.5 py-2 rounded-xl font-bold transition-colors"
          >
            🔄 Refresh Team Status
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {teamStatus.map((t) => {
            const isUserConnected = Boolean(t.connected) && String(t.status ?? "").toLowerCase() === "connected";
            const isSelf = Boolean(t.is_current_user);
            const fullName = String(t.full_name || t.username || "Team User");
            const roleName = String(t.role || "User").toUpperCase();
            const sessionTag = String(t.session_id || "");
            const userPhone = t.phone ? String(t.phone) : null;
            const pic = t.profile_picture_url ? String(t.profile_picture_url) : null;
            const targetId = Number(t.user_id);

            return (
              <div
                key={targetId}
                className={`rounded-2xl border p-5 flex flex-col justify-between space-y-4 shadow-xl transition-all ${
                  isUserConnected
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : "border-slate-800 bg-slate-950/60"
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      {pic ? (
                        <img
                          src={pic}
                          alt={fullName}
                          className="w-10 h-10 rounded-full object-cover border-2 border-emerald-400 shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 text-emerald-400 font-bold flex items-center justify-center text-base shrink-0">
                          {fullName.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <h4 className="text-base font-bold text-slate-100 leading-tight">
                          {fullName}
                        </h4>
                        <span className="text-[11px] font-mono text-slate-400">
                          {roleName} {isSelf ? "(You)" : ""}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`text-xs px-2.5 py-1 rounded-full font-bold shrink-0 ${
                        isUserConnected
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                          : "bg-slate-800 text-slate-400 border border-slate-700"
                      }`}
                    >
                      {isUserConnected ? "🟢 Connected" : "🔴 Not Connected"}
                    </span>
                  </div>

                  <div className="space-y-1 text-xs pt-1">
                    <div className="text-slate-300 font-mono">
                      Session: <span className="text-emerald-400 font-semibold">{sessionTag}</span>
                    </div>
                    <div className="text-slate-200 font-mono font-semibold">
                      Phone: {userPhone ? userPhone : isUserConnected ? "Connected" : "Not linked (Scan QR)"}
                    </div>
                  </div>
                </div>

                {isUserConnected ? (
                  <button
                    type="button"
                    onClick={() => void handleDisconnectTargetUser(targetId, fullName)}
                    className="w-full text-xs py-2 px-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 font-semibold transition-colors text-center"
                  >
                    Disconnect {fullName}'s WhatsApp
                  </button>
                ) : (
                  <div className="text-xs text-slate-500 text-center py-1 font-medium">
                    No active WhatsApp session
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
