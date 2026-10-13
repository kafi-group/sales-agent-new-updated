import { useEffect, useState } from "react";
import {
  getNotificationMode,
  subscribeNotificationPrefs,
  subscribeQuotationMeetingPopup,
  type QuotationMeetingPopupPayload,
} from "../utils/notify";

interface QuotationMeetingAlertToastsProps {
  onViewClient: (buyerId: number) => void;
}

const AUTO_DISMISS_MS = 60_000;

function formatMeetingTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "soon";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function QuotationMeetingAlertToasts({ onViewClient }: QuotationMeetingAlertToastsProps) {
  const [alerts, setAlerts] = useState<QuotationMeetingPopupPayload[]>([]);
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

    const unsubscribe = subscribeQuotationMeetingPopup((payload) => {
      if (getNotificationMode() === "off") return;
      setAlerts((prev) => {
        if (prev.some((item) => item.id === payload.id)) return prev;
        return [payload, ...prev].slice(0, 5);
      });
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

  function dismiss(alert: QuotationMeetingPopupPayload) {
    setAlerts((prev) => prev.filter((item) => item.id !== alert.id));
  }

  function viewClient(alert: QuotationMeetingPopupPayload) {
    dismiss(alert);
    onViewClient(alert.buyerId);
  }

  if (mode === "off" || alerts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-3 max-w-sm w-[calc(100vw-2rem)] pointer-events-none">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          role="alert"
          className="pointer-events-auto w-full rounded-xl border-2 border-violet-500/80 bg-slate-950/95 backdrop-blur shadow-2xl shadow-violet-900/30 animate-[slideUp_0.35s_ease-out]"
        >
          <div className="px-4 py-3 border-b border-violet-500/20 flex items-start gap-3">
            <span className="mt-0.5 shrink-0 text-violet-400 animate-pulse" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM7 12h5v5H7z" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-violet-300 text-xs font-semibold uppercase tracking-wide">
                Meeting starting soon
              </p>
              <p className="text-slate-100 font-semibold truncate mt-0.5">{alert.companyName}</p>
              {alert.contactName && (
                <p className="text-slate-300 text-sm truncate">{alert.contactName}</p>
              )}
              <p className="text-slate-400 text-xs mt-1">
                Scheduled for {formatMeetingTime(alert.meetingAt)}
                {alert.minutesUntil > 0 ? ` — in ${alert.minutesUntil} min` : " — starting now"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismiss(alert)}
              className="shrink-0 text-slate-500 hover:text-slate-300 text-lg leading-none"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="px-4 py-2.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dismiss(alert)}
              className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 text-xs"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => viewClient(alert)}
              className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium"
            >
              View in AI Mode
            </button>
          </div>
        </div>
      ))}

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(1.5rem); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
