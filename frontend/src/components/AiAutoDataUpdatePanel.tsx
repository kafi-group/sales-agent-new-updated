import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  type AiSalesAgentTask,
  type AiSalesDataUpdateStatus,
} from "../api/client";
import { resolveAgentsForMasterList } from "../lib/orgAdminLocalStore";

interface Props {
  onError: (message: string) => void;
  tasks: AiSalesAgentTask[];
  onTasksChanged: () => void;
  /** Active Master List — only agents ticked for this list get schedule cards. */
  masterType?: string;
  /** When set, use this agent list instead of loading all active agents. */
  allowedAgents?: Array<{ id: string; label: string }>;
}

const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
] as const;

type QueueLane = "outreach" | "data_update" | "auto_mode";

const LANE_LABEL: Record<QueueLane, string> = {
  outreach: "Outreach",
  data_update: "Data Update",
  auto_mode: "AI Auto Mode",
};

// "Test call to your phone" tasks: kept out of Outreach / Data Update / AI Auto Mode.
function isDirectTask(t: AiSalesAgentTask): boolean {
  return Boolean(t.is_test) || String(t.queue_lane || "").toLowerCase() === "direct";
}

function normalizeLane(raw: string | null | undefined): QueueLane {
  const v = (raw || "outreach").trim().toLowerCase();
  if (v === "data_update") return "data_update";
  if (v === "auto_mode") return "auto_mode";
  return "outreach";
}

type DataUpdateFieldChange = {
  field?: string;
  label?: string;
  before?: string;
  after?: string;
};

type DataUpdateLogEntry = {
  at?: string;
  buyer_id?: number;
  label?: string;
  ok?: boolean;
  skipped?: boolean;
  filled?: string[];
  changes?: DataUpdateFieldChange[];
  error?: string | null;
  provider?: string | null;
  reason?: string | null;
};

type DataUpdateLastReport = {
  finished_at?: string;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  filled_total?: number;
  done?: number;
  total?: number;
  log?: DataUpdateLogEntry[];
  run_id?: string | null;
  partial?: boolean;
};

function formatLogTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function logResultLabel(entry: DataUpdateLogEntry): { text: string; cls: string } {
  if (entry.skipped) return { text: "Skipped", cls: "text-slate-400" };
  if (entry.ok && (entry.filled?.length || entry.changes?.length))
    return { text: "Updated", cls: "text-emerald-300" };
  if (entry.ok) return { text: "OK (nothing new)", cls: "text-slate-400" };
  return { text: "Failed", cls: "text-rose-300" };
}

function LogEntriesList({
  entries,
  onView,
}: {
  entries: DataUpdateLogEntry[];
  onView: (entry: DataUpdateLogEntry) => void;
}) {
  if (entries.length === 0) {
    return <p className="text-[11px] text-slate-500">No per-contact lines yet.</p>;
  }
  return (
    <ul className="max-h-52 overflow-y-auto space-y-1.5">
      {[...entries].reverse().map((entry, idx) => {
        const result = logResultLabel(entry);
        return (
          <li
            key={`${entry.buyer_id ?? "x"}-${entry.at ?? idx}`}
            className="rounded border border-slate-800 px-2 py-1.5 text-[11px]"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-slate-500 tabular-nums shrink-0">
                {formatLogTime(entry.at)}
              </span>
              <span className="font-medium text-slate-100 break-words min-w-0 flex-1">
                {entry.label || `Lead #${entry.buyer_id ?? "?"}`}
              </span>
              <span className={`font-semibold ${result.cls}`}>{result.text}</span>
              <button
                type="button"
                onClick={() => onView(entry)}
                className="shrink-0 px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/15 text-[10px] font-semibold"
              >
                View
              </button>
            </div>
            {entry.filled?.length ? (
              <p className="text-emerald-300/90 mt-0.5">Filled: {entry.filled.join(", ")}</p>
            ) : null}
            {entry.error ? (
              <p className="text-rose-300/90 mt-0.5 break-words">{String(entry.error)}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function DataUpdateActivityLog({
  liveLog,
  lastReport,
  runHistory,
  agentLabel,
}: {
  liveLog: DataUpdateLogEntry[];
  lastReport?: DataUpdateLastReport | null;
  runHistory?: DataUpdateLastReport[] | null;
  agentLabel: string;
}) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<"current" | "history">("current");
  const [viewEntry, setViewEntry] = useState<DataUpdateLogEntry | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const history = useMemo(() => {
    const raw = Array.isArray(runHistory) ? runHistory.filter((h) => h && typeof h === "object") : [];
    if (raw.length) return raw;
    if (lastReport) return [lastReport];
    return [];
  }, [runHistory, lastReport]);

  const currentEntries =
    liveLog.length > 0
      ? liveLog
      : Array.isArray(lastReport?.log)
        ? lastReport!.log!
        : [];

  if (!currentEntries.length && !lastReport && history.length === 0) return null;

  const isLive = liveLog.length > 0;

  return (
    <>
      <div className="rounded-md border border-slate-700 bg-slate-950/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex flex-wrap items-center justify-between gap-2 px-2.5 py-2 text-left hover:bg-slate-900/60"
        >
          <span className="text-xs font-semibold text-slate-100 inline-flex items-center gap-1.5">
            <span className="text-slate-400">{open ? "▾" : "▸"}</span>
            Activity log
            <span className="text-[10px] font-normal text-slate-500">
              ({tab === "current" ? currentEntries.length : history.length}
              {tab === "history" ? " runs" : ""})
            </span>
          </span>
          {isLive ? (
            <span className="text-[10px] text-cyan-300/80">Live this run</span>
          ) : lastReport ? (
            <span className="text-[10px] text-slate-500">
              Last finished {formatLogTime(lastReport.finished_at)}
            </span>
          ) : (
            <span className="text-[10px] text-slate-500">Saved history</span>
          )}
        </button>

        {open ? (
          <div className="px-2.5 pb-2.5 space-y-2 border-t border-slate-800 pt-2">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setTab("current")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                  tab === "current"
                    ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-100"
                    : "border-slate-700 text-slate-500 hover:text-slate-300"
                }`}
              >
                This run
              </button>
              <button
                type="button"
                onClick={() => setTab("history")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                  tab === "history"
                    ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-100"
                    : "border-slate-700 text-slate-500 hover:text-slate-300"
                }`}
              >
                History ({history.length})
              </button>
            </div>

            {tab === "current" ? (
              <>
                {lastReport && !isLive ? (
                  <p className="text-[10px] text-slate-500">
                    Finished {formatLogTime(lastReport.finished_at)} · ok{" "}
                    {lastReport.succeeded ?? 0} · skip {lastReport.skipped ?? 0} · fail{" "}
                    {lastReport.failed ?? 0}
                  </p>
                ) : null}
                <LogEntriesList entries={currentEntries} onView={setViewEntry} />
              </>
            ) : history.length === 0 ? (
              <p className="text-[11px] text-slate-500">
                No saved runs yet for {agentLabel}. Finished Data Update runs stay here so you can
                review them later.
              </p>
            ) : (
              <ul className="max-h-64 overflow-y-auto space-y-1.5">
                {history.map((report, idx) => {
                  const runKey = String(report.run_id || report.finished_at || idx);
                  const expanded = expandedRunId === runKey;
                  const lines = Array.isArray(report.log) ? report.log : [];
                  return (
                    <li
                      key={runKey}
                      className="rounded border border-slate-800 overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRunId((cur) => (cur === runKey ? null : runKey))
                        }
                        className="w-full flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5 text-left text-[11px] hover:bg-slate-900/50"
                      >
                        <span className="text-slate-500">{expanded ? "▾" : "▸"}</span>
                        <span className="text-slate-200 font-medium">
                          {formatLogTime(report.finished_at) || "Run"}
                        </span>
                        {report.partial ? (
                          <span className="text-[10px] text-amber-300/90">interrupted</span>
                        ) : null}
                        <span className="text-slate-500 ml-auto tabular-nums">
                          {lines.length} contacts · ok {report.succeeded ?? 0} · skip{" "}
                          {report.skipped ?? 0} · fail {report.failed ?? 0}
                        </span>
                      </button>
                      {expanded ? (
                        <div className="px-2 pb-2 border-t border-slate-800/80 pt-1.5">
                          <LogEntriesList entries={lines} onView={setViewEntry} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {viewEntry ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-lg max-h-[85vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl flex flex-col">
            <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  {viewEntry.label || `Lead #${viewEntry.buyer_id ?? "?"}`}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {formatLogTime(viewEntry.at)} · {logResultLabel(viewEntry).text}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewEntry(null)}
                className="text-slate-400 hover:text-slate-200 text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {viewEntry.reason ? (
                <p className="text-xs text-slate-400">{viewEntry.reason}</p>
              ) : null}
              {viewEntry.error ? (
                <p className="text-xs text-rose-300">{String(viewEntry.error)}</p>
              ) : null}
              {(viewEntry.changes?.length ?? 0) > 0 ? (
                <ul className="space-y-2">
                  {viewEntry.changes!.map((ch) => (
                    <li
                      key={`${viewEntry.buyer_id}-${ch.field}`}
                      className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs"
                    >
                      <p className="font-semibold text-slate-200 mb-2">
                        {ch.label || ch.field}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                            Before
                          </p>
                          <p className="text-slate-400 break-words">{ch.before || "(empty)"}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-emerald-400/80 mb-1">
                            After
                          </p>
                          <p className="text-emerald-200 break-words">{ch.after || "(empty)"}</p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : viewEntry.filled?.length ? (
                <div className="text-xs text-slate-300 space-y-1">
                  <p>Fields filled (this run was before before/after capture):</p>
                  <ul className="list-disc pl-4 text-emerald-300">
                    {viewEntry.filled.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <p className="text-slate-500 pt-1">
                    Run Data Update again to store full before/after values.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  No field changes recorded for this contact
                  {viewEntry.reason ? ` — ${viewEntry.reason}` : "."}
                </p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setViewEntry(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function AiAutoDataUpdatePanel({
  onError,
  tasks,
  onTasksChanged,
  masterType = "fmcg",
  allowedAgents,
}: Props) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<AiSalesDataUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [personas, setPersonas] = useState<Array<{ id: string; label: string }>>([]);
  const [savingPersona, setSavingPersona] = useState<string | null>(null);
  const [runningPersona, setRunningPersona] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldownDraft, setCooldownDraft] = useState<Record<string, string>>({
    female: "45",
    male: "45",
  });
  const [selectedByPersona, setSelectedByPersona] = useState<Record<string, Set<number>>>({
    female: new Set(),
    male: new Set(),
  });
  const savingLockRef = useRef(0);
  const movingLockRef = useRef(0);

  useEffect(() => {
    if (allowedAgents) {
      setPersonas(allowedAgents.length ? allowedAgents : []);
      return;
    }
    let cancelled = false;
    void client
      .listOrgAiSalesAgents(true, masterType)
      .then((res) => {
        if (cancelled) return;
        const rows = resolveAgentsForMasterList(res.agents || [], masterType, true).map((a) => ({
          id: a.id,
          label: ("name" in a && a.name ? String(a.name) : a.id) || a.id,
        }));
        setPersonas(rows);
      })
      .catch(() => {
        if (cancelled) return;
        const rows = resolveAgentsForMasterList([], masterType, true).map((a) => ({
          id: a.id,
          label: ("name" in a && a.name ? String(a.name) : a.id) || a.id,
        }));
        setPersonas(rows);
      });
    return () => {
      cancelled = true;
    };
  }, [masterType, allowedAgents]);

  const load = useCallback(async () => {
    try {
      const data = await client.getAiSalesDataUpdate();
      setStatus(data);
      setCooldownDraft((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(data.schedules || {})) {
          next[key] = String(data.schedules?.[key]?.cooldown_sec ?? 45);
        }
        return next;
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load Data Update schedule");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      // Don't clobber in-flight edits with a poll refresh.
      if (savingLockRef.current || movingLockRef.current) return;
      void load();
    }, 12000);
    return () => window.clearInterval(t);
  }, [load]);

  const queues = useMemo(() => {
    const out: Record<string, Record<QueueLane, AiSalesAgentTask[]>> = {};
    for (const p of personas) {
      out[p.id] = { outreach: [], data_update: [], auto_mode: [] };
    }
    const known = new Set(personas.map((p) => p.id));
    for (const t of tasks) {
      if (!known.has(t.persona)) continue;
      if (isDirectTask(t)) continue; // test calls are listed in their own section
      out[t.persona][normalizeLane(t.queue_lane)].push(t);
    }
    return out;
  }, [tasks, personas]);

  const directQueues = useMemo(() => {
    const out: Record<string, AiSalesAgentTask[]> = {};
    for (const p of personas) out[p.id] = [];
    for (const t of tasks) {
      if (isDirectTask(t) && out[t.persona]) out[t.persona].push(t);
    }
    return out;
  }, [tasks, personas]);

  function personaLabel(id: string): string {
    return personas.find((p) => p.id === id)?.label || id;
  }

  function patchLocalSchedule(
    persona: string,
    patch: {
      enabled?: boolean;
      time?: string;
      end_time?: string;
      stop_mode?: "until_done" | "until_end_time";
      weekdays?: string[];
      cooldown_sec?: number;
    },
  ) {
    setStatus((prev) => {
      const blankSchedule = {
        enabled: false,
        time: "10:00",
        end_time: "",
        stop_mode: "until_done" as const,
        weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        cooldown_sec: 45,
      };
      const blankRun = {
        status: "idle",
        progress: {
          done: 0,
          total: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          filled_total: 0,
        },
      };
      const base: AiSalesDataUpdateStatus = prev ?? {
        schedules: { female: { ...blankSchedule }, male: { ...blankSchedule } },
        run_state: { female: { ...blankRun }, male: { ...blankRun } },
      };
      return {
        ...base,
        schedules: {
          ...base.schedules,
          [persona]: {
            ...(base.schedules?.[persona] ?? blankSchedule),
            ...patch,
          },
        },
      };
    });
  }

  async function saveSchedule(
    persona: string,
    patch: {
      enabled?: boolean;
      time?: string;
      end_time?: string;
      stop_mode?: "until_done" | "until_end_time";
      weekdays?: string[];
      cooldown_sec?: number;
    },
  ) {
    // Optimistic UI — never freeze the form behind a global `saving` lock.
    patchLocalSchedule(persona, patch);
    setSavingPersona(persona);
    savingLockRef.current += 1;
    setNotice(null);
    const unlock = window.setTimeout(() => {
      setSavingPersona((cur) => (cur === persona ? null : cur));
    }, 12_000);
    try {
      const next = await client.updateAiSalesDataUpdateSchedule({ persona, ...patch });
      setStatus(next);
      if (typeof patch.cooldown_sec === "number") {
        setCooldownDraft((d) => ({ ...d, [persona]: String(next.schedules?.[persona]?.cooldown_sec ?? patch.cooldown_sec) }));
      }
      setNotice(`Saved ${personaLabel(persona)} Data Update schedule.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save schedule");
      // Re-sync from server so optimistic edit does not stick if save failed.
      void load();
    } finally {
      window.clearTimeout(unlock);
      savingLockRef.current = Math.max(0, savingLockRef.current - 1);
      setSavingPersona((cur) => (cur === persona ? null : cur));
    }
  }

  async function runNow(persona: string) {
    setRunningPersona(persona);
    setNotice(null);
    try {
      const res = await client.runAiSalesDataUpdateNow(persona);
      setStatus(res.status as AiSalesDataUpdateStatus);
      setNotice(
        `Started Data Update for ${personaLabel(persona)} — ${res.total} contact(s). Autopilot runs 1-at-a-time with cooldown.`,
      );
      onTasksChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to start Data Update");
    } finally {
      setRunningPersona(null);
    }
  }

  function toggleSelect(persona: string, taskId: number) {
    setSelectedByPersona((prev) => {
      const next = new Set(prev[persona] || []);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return { ...prev, [persona]: next };
    });
  }

  function selectAllInLane(persona: string, lane: QueueLane, on: boolean) {
    const ids = (queues[persona]?.[lane] || []).map((t) => t.id);
    setSelectedByPersona((prev) => {
      const next = new Set(prev[persona] || []);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return { ...prev, [persona]: next };
    });
  }

  async function moveSelected(persona: string, lane: QueueLane) {
    const allIds = (
      ["outreach", "data_update", "auto_mode"] as QueueLane[]
    ).flatMap((l) => (queues[persona]?.[l] || []).map((t) => t.id));
    const ids = [...(selectedByPersona[persona] || [])].filter((id) => allIds.includes(id));
    if (!ids.length) {
      onError("Select one or more contacts first.");
      return;
    }
    setMoving(true);
    movingLockRef.current += 1;
    const unlock = window.setTimeout(() => setMoving(false), 12_000);
    try {
      await client.setAiSalesTaskLane({ task_ids: ids, queue_lane: lane });
      setSelectedByPersona((prev) => ({ ...prev, [persona]: new Set() }));
      onTasksChanged();
      setNotice(
        `Moved ${ids.length} contact(s) to ${LANE_LABEL[lane]} — still on ${personaLabel(persona)}.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move contacts");
    } finally {
      window.clearTimeout(unlock);
      movingLockRef.current = Math.max(0, movingLockRef.current - 1);
      setMoving(false);
    }
  }

  async function setLane(taskId: number, lane: QueueLane) {
    setMoving(true);
    movingLockRef.current += 1;
    const unlock = window.setTimeout(() => setMoving(false), 12_000);
    try {
      await client.setAiSalesTaskLane({ task_ids: [taskId], queue_lane: lane });
      onTasksChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move contact");
    } finally {
      window.clearTimeout(unlock);
      movingLockRef.current = Math.max(0, movingLockRef.current - 1);
      setMoving(false);
    }
  }

  if (loading && !status) {
    return (
      <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-4 text-sm text-slate-400">
        Loading AI Auto Data Update Schedule…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-500/40 bg-gradient-to-br from-cyan-950/30 to-slate-900/60 shadow-lg shadow-cyan-950/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div>
          <h3 className="text-base font-semibold text-slate-100">AI Auto Data Update Schedule</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Each AI Sales Agent keeps their own contacts. Split each agent&apos;s list into Outreach
            (calls), Data Update (research), or AI Auto Mode (emails / Auto Mode actions) — one
            contact, one lane.
          </p>
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="px-4 pb-4 space-y-4 border-t border-cyan-500/20 pt-3">
          {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}
          {savingPersona ? (
            <p className="text-[11px] text-slate-500">
              Saving {personaLabel(savingPersona || "")} schedule…
            </p>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            {personas.length === 0 ? (
              <div className="md:col-span-2 rounded-lg border border-dashed border-slate-600 bg-slate-950/40 px-4 py-6 text-center space-y-2">
                <p className="text-sm text-slate-200">
                  No AI Sales Agents assigned to this master list.
                </p>
                <p className="text-xs text-slate-500">
                  In Settings → Access to master lists, tick the agents that should work this list
                  (product-specialized agents). Until then, Sara / Rayan / others stay hidden here.
                </p>
              </div>
            ) : null}
            {personas.map((p) => {
              const sch = status?.schedules?.[p.id];
              const run = status?.run_state?.[p.id];
              const prog = run?.progress;
              const outreach = queues[p.id]?.outreach || [];
              const dataUpdate = queues[p.id]?.data_update || [];
              const autoMode = queues[p.id]?.auto_mode || [];
              const direct = directQueues[p.id] || [];
              const selected = selectedByPersona[p.id] || new Set<number>();
              const stopMode = (sch?.stop_mode || "until_done") as "until_done" | "until_end_time";
              const otherLanes = (from: QueueLane): QueueLane[] =>
                (["outreach", "data_update", "auto_mode"] as QueueLane[]).filter((l) => l !== from);
              return (
                <div
                  key={p.id}
                  className="min-w-0 overflow-hidden rounded-lg border border-slate-700 bg-slate-950/50 p-3 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold text-slate-100">{p.label}</h4>
                      <p className="text-[10px] text-slate-500 mt-0.5">
                        Toggle = schedule armed (waits for start time). Does not start instantly.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveSchedule(p.id, { enabled: !sch?.enabled })}
                      title={
                        sch?.enabled
                          ? "Schedule ON — autopilot starts at the daily time on selected days"
                          : "Schedule OFF — will not auto-start (use Run now to start manually)"
                      }
                      className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
                        sch?.enabled ? "bg-emerald-500" : "bg-slate-700"
                      }`}
                      aria-pressed={Boolean(sch?.enabled)}
                      aria-label={`${p.label} schedule enabled`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                          sch?.enabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-slate-400">
                      Start (Asia/Karachi)
                      <input
                        type="time"
                        value={sch?.time || "10:00"}
                        onChange={(e) => void saveSchedule(p.id, { time: e.target.value })}
                        className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                      />
                    </label>
                    <label className="block text-xs text-slate-400">
                      End (optional)
                      <input
                        type="time"
                        value={sch?.end_time || ""}
                        disabled={stopMode === "until_done"}
                        onChange={(e) => void saveSchedule(p.id, { end_time: e.target.value })}
                        className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-40"
                      />
                    </label>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-[11px] text-slate-400 font-medium">Stop when</p>
                    <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        className="mt-0.5 accent-cyan-500"
                        checked={stopMode === "until_done"}
                        onChange={() => void saveSchedule(p.id, { stop_mode: "until_done" })}
                      />
                      <span>Until this agent&apos;s Data Update queue is empty</span>
                    </label>
                    <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        className="mt-0.5 accent-cyan-500"
                        checked={stopMode === "until_end_time"}
                        onChange={() => void saveSchedule(p.id, { stop_mode: "until_end_time" })}
                      />
                      <span>At end time (even if contacts remain)</span>
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {WEEKDAYS.map((d) => {
                      const on = (sch?.weekdays || []).includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => {
                            const cur = new Set(sch?.weekdays || []);
                            if (on) cur.delete(d.id);
                            else cur.add(d.id);
                            void saveSchedule(p.id, { weekdays: [...cur] });
                          }}
                          className={`px-2 py-0.5 rounded text-[11px] border ${
                            on
                              ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-100"
                              : "border-slate-700 text-slate-500"
                          }`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>

                  <label className="block text-xs text-slate-400">
                    Cooldown between contacts (sec)
                    <input
                      type="number"
                      min={15}
                      max={600}
                      value={cooldownDraft[p.id]}
                      onChange={(e) =>
                        setCooldownDraft((d) => ({ ...d, [p.id]: e.target.value }))
                      }
                      onBlur={() => {
                        const n = Number(cooldownDraft[p.id]);
                        const sec = Number.isFinite(n) ? Math.max(15, Math.min(600, Math.round(n))) : 45;
                        setCooldownDraft((d) => ({ ...d, [p.id]: String(sec) }));
                        if (sec !== (sch?.cooldown_sec ?? 45)) {
                          void saveSchedule(p.id, { cooldown_sec: sec });
                        }
                      }}
                      className="mt-1 block w-28 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                    />
                  </label>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={runningPersona === p.id}
                      onClick={() => void runNow(p.id)}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40"
                      title="Start this agent's Data Update queue immediately (does not wait for schedule)"
                    >
                      {runningPersona === p.id ? "Starting…" : `Run ${p.label} now`}
                    </button>
                    <span className="text-[11px] text-slate-500">
                      Status: {run?.status || "idle"}
                      {prog
                        ? ` · ${prog.done}/${prog.total} (ok ${prog.succeeded}, skip ${prog.skipped}, fail ${prog.failed})`
                        : ""}
                    </span>
                  </div>

                  {run?.current_label ? (
                    <p className="text-[11px] text-cyan-200/90 break-words">Now: {run.current_label}</p>
                  ) : null}

                  <DataUpdateActivityLog
                    liveLog={(run?.log as DataUpdateLogEntry[] | undefined) || []}
                    lastReport={run?.last_report as DataUpdateLastReport | null | undefined}
                    runHistory={
                      (run?.run_history as DataUpdateLastReport[] | undefined) || []
                    }
                    agentLabel={p.label}
                  />

                  {/* Per-agent queues */}
                  <div className="grid gap-2 pt-1">
                    <QueueLaneBlock
                      title={`Outreach (${outreach.length})`}
                      hint="Calling only — Start calling / dialer uses this list."
                      tasks={outreach}
                      selected={selected}
                      moving={moving}
                      onToggle={(id) => toggleSelect(p.id, id)}
                      onSelectAll={(on) => selectAllInLane(p.id, "outreach", on)}
                      moveTargets={otherLanes("outreach").map((lane) => ({
                        lane,
                        label: `→ ${LANE_LABEL[lane]}`,
                        onMoveOne: (id: number) => void setLane(id, lane),
                        onBulkMove: () => void moveSelected(p.id, lane),
                      }))}
                    />
                    <QueueLaneBlock
                      title={`Data Update (${dataUpdate.length})`}
                      hint="Autopilot research — empty fields only. Same agent."
                      tasks={dataUpdate}
                      selected={selected}
                      moving={moving}
                      accent="cyan"
                      onToggle={(id) => toggleSelect(p.id, id)}
                      onSelectAll={(on) => selectAllInLane(p.id, "data_update", on)}
                      moveTargets={otherLanes("data_update").map((lane) => ({
                        lane,
                        label: `→ ${LANE_LABEL[lane]}`,
                        onMoveOne: (id: number) => void setLane(id, lane),
                        onBulkMove: () => void moveSelected(p.id, lane),
                      }))}
                    />
                    <QueueLaneBlock
                      title={`AI Auto Mode (${autoMode.length})`}
                      hint="Email templates / Auto Mode Start — only these contacts."
                      tasks={autoMode}
                      selected={selected}
                      moving={moving}
                      accent="violet"
                      onToggle={(id) => toggleSelect(p.id, id)}
                      onSelectAll={(on) => selectAllInLane(p.id, "auto_mode", on)}
                      moveTargets={otherLanes("auto_mode").map((lane) => ({
                        lane,
                        label: `→ ${LANE_LABEL[lane]}`,
                        onMoveOne: (id: number) => void setLane(id, lane),
                        onBulkMove: () => void moveSelected(p.id, lane),
                      }))}
                    />
                    <QueueLaneBlock
                      title={`Direct AI Call (${direct.length})`}
                      hint="Test calls from “Test call to your phone” — separate from the pipeline, not counted in Outreach."
                      tasks={direct}
                      selected={selected}
                      moving={moving}
                      accent="amber"
                      onToggle={(id) => toggleSelect(p.id, id)}
                      onSelectAll={(on) => selectAllInLane(p.id, "outreach", on)}
                      moveTargets={[]}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QueueLaneBlock({
  title,
  hint,
  tasks,
  selected,
  moving,
  accent,
  onToggle,
  onSelectAll,
  moveTargets,
}: {
  title: string;
  hint: string;
  tasks: AiSalesAgentTask[];
  selected: Set<number>;
  moving: boolean;
  accent?: "cyan" | "violet" | "amber";
  onToggle: (id: number) => void;
  onSelectAll: (on: boolean) => void;
  moveTargets: Array<{
    lane: QueueLane;
    label: string;
    onMoveOne: (id: number) => void;
    onBulkMove: () => void;
  }>;
}) {
  // Long lists start collapsed so Sara/Rayan cards stay short (e.g. old-clients dump).
  const [open, setOpen] = useState(() => tasks.length <= 12);
  const prevLenRef = useRef(tasks.length);
  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = tasks.length;
    // Auto-collapse when the list grows past a comfortable size.
    if (prev <= 12 && tasks.length > 12) setOpen(false);
  }, [tasks.length]);

  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id));
  const someSelected = tasks.some((t) => selected.has(t.id));
  const selectedInLane = [...selected].filter((id) => tasks.some((t) => t.id === id)).length;
  const borderClass =
    accent === "violet"
      ? "border-violet-700/40 bg-violet-950/20"
      : accent === "cyan"
        ? "border-cyan-700/40 bg-cyan-950/20"
        : accent === "amber"
          ? "border-amber-700/40 bg-amber-950/20"
          : "border-slate-800 bg-slate-950/40";
  const btnClass =
    accent === "violet"
      ? "border-violet-500/40 text-violet-200 hover:bg-violet-500/15"
      : accent === "amber"
        ? "border-amber-500/40 text-amber-200 hover:bg-amber-500/15"
        : "border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/15";
  const bulkClass =
    accent === "violet"
      ? "border-violet-500/40 bg-violet-500/10 text-violet-100 hover:bg-violet-500/20"
      : accent === "amber"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
        : "border-cyan-500/40 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20";
  return (
    <div className={`min-w-0 overflow-hidden rounded-md border p-2 ${borderClass}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-start gap-2 text-left min-w-0 flex-1 hover:opacity-90"
          title={open ? "Collapse list" : "Expand list"}
          aria-expanded={open}
        >
          <span className="text-slate-400 text-xs shrink-0 pt-0.5 w-3">{open ? "▾" : "▸"}</span>
          <span className="min-w-0">
            <h5 className="text-xs font-semibold text-slate-100">{title}</h5>
            <p className="text-[10px] text-slate-500">{hint}</p>
            {!open && tasks.length > 0 ? (
              <p className="text-[10px] text-slate-400 mt-0.5">
                {tasks.length.toLocaleString()} contact{tasks.length === 1 ? "" : "s"} hidden — click to
                open
                {selectedInLane > 0 ? ` · ${selectedInLane} selected` : ""}
              </p>
            ) : null}
          </span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {tasks.length > 0 ? (
            <label
              className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                className="accent-cyan-500"
                checked={allSelected}
                onChange={(e) => onSelectAll(e.target.checked)}
              />
              Select all
            </label>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800"
            title={open ? "Collapse list" : "Expand list"}
          >
            {open ? "Close" : "Open"}
          </button>
        </div>
      </div>
      {open ? (
        <>
          <ul className="space-y-1 max-h-48 overflow-y-auto overflow-x-hidden text-xs mt-1 min-w-0">
            {tasks.length === 0 ? (
              <li className="text-slate-600 px-1 py-1">Empty</li>
            ) : (
              tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start gap-2 rounded border border-slate-800/80 px-2 py-1.5 min-w-0"
                >
                  <input
                    type="checkbox"
                    className="accent-cyan-500 shrink-0 mt-0.5"
                    checked={selected.has(t.id)}
                    onChange={() => onToggle(t.id)}
                  />
                  <span className="text-slate-200 break-words whitespace-normal flex-1 min-w-0">
                    {t.company_name || t.contact_name || `#${t.buyer_id}`}
                  </span>
                  <span className="flex shrink-0 flex-wrap gap-1 justify-end max-w-[46%]">
                    {moveTargets.map((mt) => (
                      <button
                        key={mt.lane}
                        type="button"
                        disabled={moving}
                        onClick={() => mt.onMoveOne(t.id)}
                        className={`text-[10px] px-1.5 py-0.5 rounded border disabled:opacity-40 ${btnClass}`}
                      >
                        {mt.label}
                      </button>
                    ))}
                  </span>
                </li>
              ))
            )}
          </ul>
          {someSelected ? (
            <div className="mt-2 flex flex-col gap-1">
              {moveTargets.map((mt) => (
                <button
                  key={mt.lane}
                  type="button"
                  disabled={moving}
                  onClick={mt.onBulkMove}
                  className={`w-full text-[11px] px-2 py-1.5 rounded-lg border disabled:opacity-40 ${bulkClass}`}
                >
                  Move selected {mt.label} ({selectedInLane})
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : someSelected ? (
        <div className="mt-2 flex flex-col gap-1">
          {moveTargets.map((mt) => (
            <button
              key={mt.lane}
              type="button"
              disabled={moving}
              onClick={mt.onBulkMove}
              className={`w-full text-[11px] px-2 py-1.5 rounded-lg border disabled:opacity-40 ${bulkClass}`}
            >
              Move selected {mt.label} ({selectedInLane})
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
