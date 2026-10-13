import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../api/client";
import { ActionButton } from "../components/ui/ActionButton";
import { IconRefresh, IconWhatsApp } from "../components/icons/AppIcons";

interface WhatsAppQrPageProps {
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

export function WhatsAppQrPage({ onError }: WhatsAppQrPageProps) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [qr, setQr] = useState<Record<string, unknown> | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [toPhone, setToPhone] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshLock = useRef(false);

  const connected = isConnectedStatus(status);
  const statusLabel = String(status?.status ?? (connected ? "connected" : "disconnected"));
  const qrPending = statusLabel.toLowerCase() === "qr-pending";
  const qrImage = qrImageFromPayload(qr);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    if (!opts?.silent) setLoading(true);
    try {
      const [st, session] = await Promise.all([
        client.getWhatsAppPersonalStatus(),
        client.getWhatsAppPersonalSession(),
      ]);
      setStatus(st);
      setSessionId(session.session_id);

      if (isConnectedStatus(st)) {
        setQr(null);
        return;
      }

      try {
        const qrData = await client.getWhatsAppPersonalQr();
        setQr(qrData);
      } catch {
        setQr(null);
      }
    } catch (e) {
      if (!opts?.silent) {
        onError(e instanceof Error ? e.message : "Could not load WhatsApp Personal status");
      }
    } finally {
      setLoading(false);
      refreshLock.current = false;
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pollMs = useMemo(() => {
    if (connected) return 8_000;
    if (qrPending || !qrImage) return 3_000;
    return 8_000;
  }, [connected, qrPending, qrImage]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh({ silent: true }), pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);

  async function handlePair() {
    setPairing(true);
    setNotice(null);
    try {
      const qrData = await client.pairWhatsAppPersonal();
      setQr(qrData);
      setStatus((prev) => ({ ...(prev ?? {}), connected: false, status: "qr-pending" }));
      setNotice("Scan this QR with WhatsApp → Linked devices on your phone.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not generate QR code");
    } finally {
      setPairing(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm("Disconnect personal WhatsApp on this device? You can scan a new QR after.")) {
      return;
    }
    setLoading(true);
    try {
      await client.disconnectWhatsAppPersonal();
      setNotice("Disconnected — tap Generate QR code to link your phone.");
      setQr(null);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    setSending(true);
    setNotice(null);
    try {
      await client.sendWhatsAppPersonal({ to_phone: toPhone.trim(), message: message.trim() });
      setNotice("Message sent from your personal WhatsApp.");
      setMessage("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="space-y-4 max-w-2xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-medium text-slate-100">WhatsApp QR (Personal)</h2>
          <p className="text-sm text-slate-500 mt-1">
            Scan with your phone — separate from Meta Business WhatsApp. Session:{" "}
            <code className="text-slate-400">{sessionId || "…"}</code>
          </p>
        </div>
        <ActionButton icon={IconRefresh} size="md" onClick={() => void refresh()} title="Refresh">
          Refresh
        </ActionButton>
      </div>

      {notice ? (
        <p className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
          {notice}
        </p>
      ) : null}

      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
        {loading && !qrImage ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : connected ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-300">
              Connected — messages send from your scanned personal WhatsApp number.
            </p>
            <ActionButton
              icon={IconRefresh}
              variant="ghost"
              size="md"
              onClick={() => void handleDisconnect()}
              title="Disconnect and scan another phone"
            >
              Disconnect / scan new QR
            </ActionButton>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-amber-200">
              {qrPending
                ? "Waiting for scan — open WhatsApp on your phone → Linked devices → Link a device."
                : "Not connected yet. Generate a QR code, then scan it from your phone."}
            </p>
            {qrImage ? (
              <img
                src={qrImage}
                alt="WhatsApp QR code"
                className="mx-auto w-64 h-64 rounded-lg bg-white p-3"
              />
            ) : (
              <ActionButton
                icon={IconWhatsApp}
                variant="primary"
                size="md"
                disabled={pairing}
                onClick={() => void handlePair()}
                title="Generate QR code"
              >
                {pairing ? "Generating QR…" : "Generate QR code"}
              </ActionButton>
            )}
            {qrImage ? (
              <ActionButton
                icon={IconRefresh}
                variant="ghost"
                size="md"
                disabled={pairing}
                onClick={() => void handlePair()}
                title="Refresh QR code"
              >
                {pairing ? "Refreshing…" : "Refresh QR code"}
              </ActionButton>
            ) : null}
          </div>
        )}

        <div className="border-t border-slate-800 pt-4 space-y-3">
          <p className="text-xs text-slate-400">
            Status: <span className="text-slate-300">{statusLabel}</span>
          </p>
          <p className="text-xs text-slate-400">Quick send (personal WhatsApp)</p>
          <input
            value={toPhone}
            onChange={(e) => setToPhone(e.target.value)}
            placeholder="Recipient phone e.g. +923001234567"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="Message"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
          <ActionButton
            icon={IconWhatsApp}
            variant="primary"
            size="md"
            disabled={sending || !connected || !toPhone.trim() || !message.trim()}
            onClick={() => void handleSend()}
          >
            {sending ? "Sending…" : "Send personal WhatsApp"}
          </ActionButton>
        </div>
      </div>
    </section>
  );
}
