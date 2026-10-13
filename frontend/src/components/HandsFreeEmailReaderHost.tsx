import { useEffect, useState } from "react";
import {
  handsFreeSpeechSupported,
  isHandsFreeEmailReaderActive,
  stopHandsFreeEmailReader,
  subscribeHandsFreeEmailReader,
  type HandsFreeSessionStatus,
} from "../utils/handsFreeEmailReader";
import { getNotificationMode, subscribeNotificationPrefs } from "../utils/notify";

/**
 * Floating status while hands-free email reader is active (mic listening / reading aloud).
 */
export function HandsFreeEmailReaderHost() {
  const [mode, setMode] = useState(getNotificationMode);
  const [status, setStatus] = useState<HandsFreeSessionStatus | null>(null);

  useEffect(() => {
    return subscribeNotificationPrefs(() => setMode(getNotificationMode()));
  }, []);

  useEffect(() => {
    return subscribeHandsFreeEmailReader(setStatus);
  }, []);

  if (mode !== "handsfree_email") return null;
  if (!status || status.phase === "idle") return null;
  if (!isHandsFreeEmailReaderActive() && status.phase === "done") {
    // brief done state still useful
  }

  const listening =
    status.phase === "listening_offer" || status.phase === "listening_next";
  const reading = status.phase === "reading";

  return (
    <div className="fixed bottom-4 left-1/2 z-[110] w-[min(24rem,calc(100vw-1.5rem))] -translate-x-1/2 pointer-events-none">
      <div className="pointer-events-auto rounded-2xl border-2 border-violet-500/70 bg-slate-950/95 backdrop-blur shadow-2xl shadow-violet-950/40 px-4 py-3">
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 text-lg ${listening ? "animate-pulse text-violet-300" : reading ? "text-emerald-300" : "text-slate-300"}`}
            aria-hidden
          >
            {listening ? "🎤" : reading ? "🔊" : "📬"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-300">
              Hands-free email reader
            </p>
            <p className="text-sm text-slate-100 mt-0.5">{status.statusLine}</p>
            {status.total > 0 ? (
              <p className="text-xs text-slate-500 mt-1">
                {Math.min(status.index + 1, status.total)} / {status.total}
                {!handsFreeSpeechSupported()
                  ? " · Mic/speech not supported in this browser"
                  : ""}
              </p>
            ) : null}
            {status.lastHeard ? (
              <p className="text-xs text-slate-400 mt-1 truncate">
                Heard: “{status.lastHeard}”
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => stopHandsFreeEmailReader("Stopped.")}
            className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-900"
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
