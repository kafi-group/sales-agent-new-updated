import { useEffect, useState } from "react";
import {
  getNotificationMode,
  subscribeInterestedClientsActivityPopup,
  subscribeNotificationPrefs,
  type InterestedClientsActivityPopupPayload,
} from "../utils/notify";

interface InterestedClientsActivityToastsProps {
  onViewFeed: () => void;
}

const AUTO_DISMISS_MS = 12_000;

export function InterestedClientsActivityToasts({
  onViewFeed,
}: InterestedClientsActivityToastsProps) {
  const [alerts, setAlerts] = useState<InterestedClientsActivityPopupPayload[]>([]);
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

    const unsubscribe = subscribeInterestedClientsActivityPopup((payload) => {
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

  if (mode === "off" || alerts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-[min(100vw-2rem,24rem)]">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="rounded-xl border border-emerald-500/30 bg-slate-900/95 backdrop-blur shadow-lg p-3"
        >
          <p className="text-sm font-medium text-emerald-200">Interested Clients</p>
          <p className="text-sm text-slate-200 mt-1">{alert.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setAlerts((prev) => prev.filter((item) => item.id !== alert.id));
                onViewFeed();
              }}
              className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 text-xs font-medium"
            >
              View in AI Mode
            </button>
            <button
              type="button"
              onClick={() =>
                setAlerts((prev) => prev.filter((item) => item.id !== alert.id))
              }
              className="rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-1.5 text-xs text-slate-300"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
