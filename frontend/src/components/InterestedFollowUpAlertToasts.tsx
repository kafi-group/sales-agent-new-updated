import { useEffect, useState } from "react";
import {
  getNotificationMode,
  subscribeInterestedFollowUpPopup,
  subscribeNotificationPrefs,
  type InterestedFollowUpPopupPayload,
} from "../utils/notify";

interface InterestedFollowUpAlertToastsProps {
  onViewClient: (
    buyerId: number,
    section?: "interested_clients" | "not_received_call_clients" | "sales_interested_clients",
  ) => void;
  onAcknowledge: (buyerId: number) => Promise<void>;
}

const AUTO_DISMISS_MS = 30_000;

function formatDue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "now";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function InterestedFollowUpAlertToasts({
  onViewClient,
  onAcknowledge,
}: InterestedFollowUpAlertToastsProps) {
  const [alerts, setAlerts] = useState<InterestedFollowUpPopupPayload[]>([]);
  const [acknowledging, setAcknowledging] = useState<number | null>(null);
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

    const unsubscribe = subscribeInterestedFollowUpPopup((payload) => {
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

  async function dismiss(alert: InterestedFollowUpPopupPayload) {
    setAlerts((prev) => prev.filter((item) => item.id !== alert.id));
    setAcknowledging(alert.buyerId);
    try {
      await onAcknowledge(alert.buyerId);
    } finally {
      setAcknowledging(null);
    }
  }

  async function viewClient(alert: InterestedFollowUpPopupPayload) {
    setAlerts((prev) => prev.filter((item) => item.id !== alert.id));
    setAcknowledging(alert.buyerId);
    try {
      await onAcknowledge(alert.buyerId);
      onViewClient(alert.buyerId, alert.tableSection ?? "interested_clients");
    } finally {
      setAcknowledging(null);
    }
  }

  if (mode === "off" || alerts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-3 max-w-sm w-[calc(100vw-2rem)] pointer-events-none">
      {alerts.map((alert) => {
        const busy = acknowledging === alert.buyerId;

        return (
          <div
            key={alert.id}
            role="alert"
            className="pointer-events-auto w-full rounded-xl border-2 border-amber-500/80 bg-slate-950/95 backdrop-blur shadow-2xl shadow-amber-900/30 animate-[slideUp_0.35s_ease-out]"
          >
            <div className="px-4 py-3 border-b border-amber-500/20 flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-amber-400 animate-pulse" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-amber-300 text-xs font-semibold uppercase tracking-wide">
                  Follow up reminder
                </p>
                <p className="text-slate-100 font-semibold truncate mt-0.5">{alert.companyName}</p>
                {alert.contactName && (
                  <p className="text-slate-300 text-sm truncate">{alert.contactName}</p>
                )}
                <p className="text-slate-400 text-xs mt-1">
                  Scheduled for {formatDue(alert.dueAt)} — action needed
                </p>
              </div>
              <button
                type="button"
                onClick={() => void dismiss(alert)}
                disabled={busy}
                className="shrink-0 text-slate-500 hover:text-slate-300 text-lg leading-none disabled:opacity-50"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            <div className="px-4 py-2.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void dismiss(alert)}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 text-xs disabled:opacity-50"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => void viewClient(alert)}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium disabled:opacity-50"
              >
                View client
              </button>
            </div>
          </div>
        );
      })}

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(1.5rem); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
