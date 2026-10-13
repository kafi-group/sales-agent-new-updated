import { useEffect, useState } from "react";
import {
  client,
  type AiSalesAgentLogEvent,
  type AiSalesAgentLogsResponse,
} from "../api/client";

interface AiSalesAgentLogsModalProps {
  onClose: () => void;
  /** Optional — prefer local inline errors so the sticky header is not polluted. */
  onError?: (message: string) => void;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function personaChip(persona: string, label: string) {
  const p = (persona || "").toLowerCase();
  const cls =
    p === "female"
      ? "border-emerald-500/40 text-emerald-200 bg-emerald-500/10"
      : p === "male"
        ? "border-sky-500/40 text-sky-200 bg-sky-500/10"
        : "border-violet-500/40 text-violet-200 bg-violet-500/10";
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function laneChip(lane: string | null, label: string | null) {
  if (!lane) return null;
  const l = lane.toLowerCase();
  const cls =
    l === "auto_mode"
      ? "border-fuchsia-500/40 text-fuchsia-200 bg-fuchsia-500/10"
      : l === "data_update"
        ? "border-amber-500/40 text-amber-200 bg-amber-500/10"
        : "border-cyan-500/40 text-cyan-200 bg-cyan-500/10";
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${cls}`}>
      {label || lane}
    </span>
  );
}

export function AiSalesAgentLogsModal({ onClose }: AiSalesAgentLogsModalProps) {
  const [data, setData] = useState<AiSalesAgentLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<number | null>(null);
  const [view, setView] = useState<"runs" | "summary">("runs");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    client
      .listAiSalesAgentLogs({ limit: 200 })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        const raw = e instanceof Error ? e.message : "Failed to load AI Sales Agent logs";
        // Keep sticky header clean — show inside the modal only.
        const friendly = /not found|404/i.test(raw)
          ? "Logs API is not available on this server yet (redeploy may still be finishing). Try again in a minute."
          : raw;
        setLoadError(friendly);
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = data?.summary;
  const runs = data?.runs ?? [];

  function renderRunBox(run: AiSalesAgentLogEvent) {
    const open = openRunId === run.id;
    return (
      <div
        key={run.id}
        className="rounded-lg border border-slate-700 bg-slate-950/60 overflow-hidden"
      >
        <button
          type="button"
          onClick={() => setOpenRunId(open ? null : run.id)}
          className="w-full text-left px-3 py-2.5 flex flex-wrap items-center gap-2 hover:bg-slate-900/80"
          aria-expanded={open}
        >
          <span className="text-slate-400 text-xs w-3">{open ? "▾" : "▸"}</span>
          <span className="text-xs font-semibold text-amber-200">
            {formatWhen(run.created_at)}
          </span>
          <span className="text-xs text-slate-300 font-medium">{run.user_label}</span>
          {personaChip(run.persona, run.persona_label)}
          {laneChip(run.queue_lane, run.lane_label)}
          <span className="ml-auto text-xs tabular-nums text-emerald-300 font-semibold">
            {run.contact_count} used
          </span>
        </button>
        {open ? (
          <div className="border-t border-slate-800 px-3 py-2.5 space-y-2">
            {run.note ? <p className="text-xs text-slate-400">{run.note}</p> : null}
            <ul className="max-h-56 overflow-y-auto space-y-1 text-xs">
              {run.contacts.map((c, i) => (
                <li
                  key={`${run.id}-${c.task_id ?? i}-${c.buyer_id ?? i}`}
                  className="rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1.5 text-slate-200"
                >
                  <span className="font-medium">{c.company_name || `Lead #${c.buyer_id ?? "—"}`}</span>
                  {c.contact_name ? (
                    <span className="text-slate-400"> · {c.contact_name}</span>
                  ) : null}
                  {c.contact_phone ? (
                    <span className="block font-mono text-[10px] text-sky-300/90">
                      {c.contact_phone}
                    </span>
                  ) : null}
                  {c.contact_email ? (
                    <span className="block font-mono text-[10px] text-slate-400">
                      {c.contact_email}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">AI Sales Agent logs</h2>
            <p className="text-sm text-slate-400 mt-0.5">
              <span className="text-slate-200">Used</span> counts only when Outreach, Data Update, or
              AI Auto Mode actually starts. Assigned counts are placements; difference = assigned −
              used.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {summary ? (
          <div className="px-5 py-3 border-b border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <div className="rounded-lg border border-slate-700/80 bg-slate-950/50 px-2 py-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Assigned</p>
              <p className="text-lg font-semibold text-slate-100 tabular-nums">
                {summary.total_assigned}
              </p>
            </div>
            <div className="rounded-lg border border-emerald-700/40 bg-emerald-950/20 px-2 py-2">
              <p className="text-[10px] uppercase tracking-wide text-emerald-400/80">Used</p>
              <p className="text-lg font-semibold text-emerald-200 tabular-nums">
                {summary.total_used}
              </p>
            </div>
            <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 px-2 py-2">
              <p className="text-[10px] uppercase tracking-wide text-amber-400/80">Difference</p>
              <p className="text-lg font-semibold text-amber-200 tabular-nums">
                {summary.total_difference}
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/80 bg-slate-950/50 px-2 py-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Runs</p>
              <p className="text-lg font-semibold text-slate-100 tabular-nums">
                {summary.total_runs}
              </p>
            </div>
          </div>
        ) : null}

        <div className="px-5 pt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setView("runs")}
            className={`px-3 py-1 text-xs font-semibold rounded-lg border ${
              view === "runs"
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-100"
                : "border-slate-600 text-slate-400 hover:text-slate-200"
            }`}
          >
            Process runs
          </button>
          <button
            type="button"
            onClick={() => setView("summary")}
            className={`px-3 py-1 text-xs font-semibold rounded-lg border ${
              view === "summary"
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-100"
                : "border-slate-600 text-slate-400 hover:text-slate-200"
            }`}
          >
            By user / date
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : loadError ? (
            <p className="text-sm text-amber-200/90 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              {loadError}
            </p>
          ) : view === "runs" ? (
            runs.length === 0 ? (
              <p className="text-sm text-slate-500">
                No process starts logged yet. Counts appear when Start (Outreach / Auto Mode) or Data
                Update runs.
              </p>
            ) : (
              runs.map(renderRunBox)
            )
          ) : !summary ? (
            <p className="text-sm text-slate-500">No summary yet.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-slate-300 mb-2">By user</h3>
                <div className="space-y-2">
                  {summary.by_user.length === 0 ? (
                    <p className="text-sm text-slate-500">No user activity yet.</p>
                  ) : (
                    summary.by_user.map((b) => (
                      <div
                        key={`u-${b.key}`}
                        className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs space-y-1"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-slate-100">{b.key}</span>
                          <span className="text-slate-400">assigned {b.assigned}</span>
                          <span className="text-emerald-300">used {b.used}</span>
                          <span className="text-amber-300">diff {b.difference}</span>
                          <span className="text-slate-500">{b.runs} run(s)</span>
                        </div>
                        {Object.keys(b.used_by_persona_lane).length > 0 ? (
                          <p className="text-[11px] text-slate-400">
                            Used:{" "}
                            {Object.entries(b.used_by_persona_lane)
                              .map(([k, n]) => {
                                const [per, lane] = k.split(":");
                                const pl =
                                  per === "female" ? "Sara" : per === "male" ? "Rayan" : per;
                                const ll =
                                  lane === "auto_mode"
                                    ? "Auto Mode"
                                    : lane === "data_update"
                                      ? "Data Update"
                                      : "Outreach";
                                return `${pl} ${ll} ${n}`;
                              })
                              .join(" · ")}
                          </p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-slate-300 mb-2">By date</h3>
                <div className="space-y-2">
                  {summary.by_date.length === 0 ? (
                    <p className="text-sm text-slate-500">No dated activity yet.</p>
                  ) : (
                    summary.by_date.map((b) => (
                      <div
                        key={`d-${b.key}`}
                        className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs flex flex-wrap gap-2 items-center"
                      >
                        <span className="font-semibold text-slate-100">{b.key}</span>
                        <span className="text-slate-400">assigned {b.assigned}</span>
                        <span className="text-emerald-300">used {b.used}</span>
                        <span className="text-amber-300">diff {b.difference}</span>
                        <span className="text-slate-500">{b.runs} run(s)</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
