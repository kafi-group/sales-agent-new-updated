import { useEffect, useState } from "react";

export type BulkActionAccent = "emerald" | "red" | "amber" | "violet" | "sky";

export interface BulkActionProgress {
  title: string;
  mode: "determinate" | "indeterminate";
  /** Completed units (for determinate mode). */
  current?: number;
  /** Total units (for determinate mode). */
  total?: number;
  /** Optional secondary line, e.g. current company name. */
  detail?: string | null;
  /** Epoch ms when the action started — used for elapsed time. */
  startedAt: number;
  accent?: BulkActionAccent;
  /** Epoch ms when the current item started (countdown for this lead). */
  itemStartedAt?: number;
  /** Abort budget for the current item in ms. */
  itemTimeoutMs?: number;
  /** Expected seconds per remaining item (for batch countdown). */
  expectedSecPerItem?: number;
  /** Label like "Normal · 90s/lead". */
  patienceLabel?: string;
}

const ACCENT_BAR: Record<BulkActionAccent, string> = {
  emerald: "bg-gradient-to-r from-emerald-600 to-emerald-400",
  red: "bg-gradient-to-r from-red-700 to-red-500",
  amber: "bg-gradient-to-r from-amber-600 to-amber-400",
  violet: "bg-gradient-to-r from-violet-600 to-emerald-500",
  sky: "bg-gradient-to-r from-sky-600 to-sky-400",
};

const ACCENT_BORDER: Record<BulkActionAccent, string> = {
  emerald: "border-emerald-700/40",
  red: "border-red-800/40",
  amber: "border-amber-700/40",
  violet: "border-violet-700/40",
  sky: "border-sky-700/40",
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

interface BulkActionProgressPanelProps {
  progress: BulkActionProgress;
}

export function BulkActionProgressPanel({ progress }: BulkActionProgressPanelProps) {
  const [now, setNow] = useState(() => Date.now());
  const accent = progress.accent ?? "emerald";

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 400);
    return () => window.clearInterval(id);
  }, []);

  const elapsedSec = Math.max(0, (now - progress.startedAt) / 1000);
  const current = Math.max(0, progress.current ?? 0);
  const total = Math.max(0, progress.total ?? 0);
  const percent =
    progress.mode === "determinate" && total > 0
      ? Math.min(99, Math.floor((current / total) * 100))
      : null;

  const itemStartedAt = progress.itemStartedAt;
  const itemTimeoutMs = progress.itemTimeoutMs;
  const leadCountdownSec =
    itemStartedAt != null && itemTimeoutMs != null && itemTimeoutMs > 0
      ? Math.max(0, (itemTimeoutMs - (now - itemStartedAt)) / 1000)
      : null;

  const remainingAfterCurrent = Math.max(0, total - current - 1);
  const expectedSec =
    progress.expectedSecPerItem ??
    (itemTimeoutMs != null ? (itemTimeoutMs / 1000) * 0.75 : null);
  const batchCountdownSec =
    leadCountdownSec != null && expectedSec != null
      ? leadCountdownSec + remainingAfterCurrent * expectedSec
      : leadCountdownSec;

  return (
    <div
      className={`rounded-lg border ${ACCENT_BORDER[accent]} bg-slate-950 px-4 py-3 space-y-3 shrink-0`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 animate-pulse ${
              accent === "red"
                ? "bg-red-400"
                : accent === "amber"
                  ? "bg-amber-400"
                  : accent === "violet"
                    ? "bg-violet-400"
                    : accent === "sky"
                      ? "bg-sky-400"
                      : "bg-emerald-400"
            }`}
          />
          <p className="text-sm font-medium text-slate-100 truncate">{progress.title}</p>
        </div>
        <span className="text-xs tabular-nums text-slate-400 shrink-0">
          {percent != null ? `${percent}% · ` : ""}
          elapsed {formatElapsed(elapsedSec)}
        </span>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        {progress.mode === "determinate" && percent != null ? (
          <div
            className={`h-full rounded-full transition-[width] duration-300 ease-out ${ACCENT_BAR[accent]}`}
            style={{ width: `${Math.max(percent, current > 0 ? 4 : 0)}%` }}
          />
        ) : (
          <div className="relative h-full w-full overflow-hidden">
            <div
              className={`absolute inset-y-0 w-2/5 rounded-full ${ACCENT_BAR[accent]}`}
              style={{
                animation: "kafi-bulk-progress-slide 1.4s ease-in-out infinite",
              }}
            />
            <style>{`
              @keyframes kafi-bulk-progress-slide {
                0% { left: -40%; }
                100% { left: 100%; }
              }
            `}</style>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-slate-400">
        {progress.mode === "determinate" && total > 0 ? (
          <span className="text-slate-300">
            {Math.min(current, total)} / {total}
          </span>
        ) : (
          <span className="text-slate-300">Working…</span>
        )}
        {progress.patienceLabel ? (
          <span className="text-slate-500">{progress.patienceLabel}</span>
        ) : null}
        {leadCountdownSec != null ? (
          <span className="text-amber-200/90">
            This lead{" "}
            <span className="font-medium text-amber-100">
              {formatCountdown(leadCountdownSec)}
            </span>
          </span>
        ) : null}
        {batchCountdownSec != null && total > 1 ? (
          <span className="text-emerald-200/90">
            Batch ~{" "}
            <span className="font-medium text-emerald-100">
              {formatCountdown(batchCountdownSec)}
            </span>
          </span>
        ) : null}
        {progress.detail ? (
          <span className="truncate min-w-0 text-slate-500">
            Current: <span className="text-slate-300">{progress.detail}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
