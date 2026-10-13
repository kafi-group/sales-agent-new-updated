import { useEffect, useState } from "react";
import {
  getNotificationMode,
  subscribeNotificationPrefs,
  subscribeWhatsAppPopup,
  type WhatsAppPopupPayload,
} from "../utils/notify";

interface WhatsAppAlertToastsProps {
  onOpenWhatsAppInbox: () => void;
}

const AUTO_DISMISS_MS = 15_000;

export function WhatsAppAlertToasts({ onOpenWhatsAppInbox }: WhatsAppAlertToastsProps) {
  const [alerts, setAlerts] = useState<WhatsAppPopupPayload[]>([]);
  const [mode, setMode] = useState(getNotificationMode);

  useEffect(() => {
    return subscribeNotificationPrefs(() => {
      const next = getNotificationMode();
      setMode(next);
      if (next === "off") setAlerts([]);
    });
  }, []);

  useEffect(() => {
    const timers = new Map<string, number>();

    const unsubscribe = subscribeWhatsAppPopup((payload) => {
      if (getNotificationMode() === "off") return;
      setAlerts((prev) => [payload, ...prev].slice(0, 3));
      const timer = window.setTimeout(() => {
        setAlerts((prev) => prev.filter((item) => item.id !== payload.id));
        timers.delete(payload.id);
      }, AUTO_DISMISS_MS);
      timers.set(payload.id, timer);
    });

    return () => {
      unsubscribe();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  function dismiss(id: string) {
    setAlerts((prev) => prev.filter((item) => item.id !== id));
  }

  if (mode === "off" || alerts.length === 0) return null;

  return (
    <div className="fixed top-36 right-4 z-[99] flex flex-col items-end gap-3 max-w-sm w-[calc(100vw-2rem)] pointer-events-none">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          role="alert"
          className="pointer-events-auto w-full rounded-xl border-2 border-emerald-500/80 bg-slate-950/95 backdrop-blur shadow-2xl shadow-emerald-900/30 animate-[slideInWa_0.35s_ease-out]"
        >
          <div className="px-4 py-3 border-b border-emerald-500/20 flex items-start gap-3">
            <span className="mt-0.5 shrink-0 text-emerald-400 animate-pulse" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.75 1.53 5.28L2 22l4.94-1.62a9.83 9.83 0 0 0 5.1 1.4h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2Zm5.79 14.06c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.1.11-1.77-.11a15.4 15.4 0 0 1-1.6-.6c-2.82-1.22-4.66-4.07-4.8-4.26-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.35.26-.28.57-.35.76-.35.19 0 .38 0 .55.01.18.01.42-.07.65.5.24.58.81 2 .88 2.14.07.14.12.31.02.5-.1.19-.15.31-.29.48-.14.17-.3.37-.43.5-.14.14-.29.29-.13.57.17.28.75 1.24 1.62 2.01 1.11 1 2.05 1.31 2.34 1.46.29.14.46.12.63-.07.17-.19.72-.83.91-1.12.19-.28.38-.24.65-.14.26.1 1.68.79 1.97.93.29.14.48.21.55.33.07.12.07.71-.17 1.39Z" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-emerald-300 text-xs font-semibold uppercase tracking-wide">
                {alert.count > 1 ? `${alert.count} new WhatsApp messages` : "New WhatsApp message"}
              </p>
              <p className="text-slate-100 font-semibold truncate mt-0.5">{alert.from}</p>
              <p className="text-slate-400 text-sm truncate">{alert.preview}</p>
            </div>
            <button
              type="button"
              onClick={() => dismiss(alert.id)}
              className="shrink-0 text-slate-500 hover:text-slate-300 text-lg leading-none"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="px-4 py-2.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dismiss(alert.id)}
              className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 text-xs"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                dismiss(alert.id);
                onOpenWhatsAppInbox();
              }}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
            >
              Open WhatsApp
            </button>
          </div>
        </div>
      ))}

      <style>{`
        @keyframes slideInWa {
          from { opacity: 0; transform: translateX(1.5rem); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
