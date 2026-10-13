import { useCallback, useEffect, useState } from "react";
import { client, type AiSalesProcess } from "../api/client";

interface AiSalesProcessesPanelProps {
  onError: (message: string) => void;
  /** Scroll / focus helper when Schedule is clicked from Auto Mode. */
  highlightId?: string;
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

const EMPTY_DRAFT: Omit<AiSalesProcess, "id"> = {
  name: "",
  persona: "female",
  enabled: true,
  schedule: { kind: "daily", time: "09:45", weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  actions: { call: false, email: true, whatsapp: true },
  buyer_ids: [],
};

export function AiSalesProcessesPanel({ onError }: AiSalesProcessesPanelProps) {
  const [processes, setProcesses] = useState<AiSalesProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [buyerIdsRaw, setBuyerIdsRaw] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.listAiSalesProcesses();
      setProcesses(res.processes || []);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load processes");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT, name: `Process ${(processes.length || 0) + 1}` });
    setBuyerIdsRaw("");
    setShowForm(true);
  }

  function openEdit(proc: AiSalesProcess) {
    setEditingId(proc.id);
    setDraft({
      name: proc.name,
      persona: proc.persona,
      enabled: proc.enabled,
      schedule: {
        kind: proc.schedule?.kind || "daily",
        time: proc.schedule?.time || "09:45",
        weekdays: proc.schedule?.weekdays?.length
          ? [...proc.schedule.weekdays]
          : ["mon", "tue", "wed", "thu", "fri"],
      },
      actions: {
        call: Boolean(proc.actions?.call),
        email: Boolean(proc.actions?.email),
        whatsapp: Boolean(proc.actions?.whatsapp),
      },
      buyer_ids: [...(proc.buyer_ids || [])],
    });
    setBuyerIdsRaw((proc.buyer_ids || []).join(" "));
    setShowForm(true);
  }

  async function handleSave() {
    const ids = buyerIdsRaw
      .split(/[\s,;]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!draft.name.trim()) {
      onError("Process name is required.");
      return;
    }
    if (!ids.length) {
      onError("Paste at least one Master Table lead ID (S. No / buyer ID).");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const payload = {
        ...draft,
        name: draft.name.trim(),
        buyer_ids: ids,
        schedule: {
          ...draft.schedule,
          weekdays:
            draft.schedule.kind === "daily"
              ? ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
              : draft.schedule.weekdays,
        },
      };
      if (editingId) {
        await client.updateAiSalesProcess(editingId, payload);
        setNotice("Process updated.");
      } else {
        await client.createAiSalesProcess({ ...payload, name: payload.name });
        setNotice("Process created.");
      }
      setShowForm(false);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save process");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this recurring process?")) return;
    try {
      await client.deleteAiSalesProcess(id);
      setNotice("Process deleted.");
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete process");
    }
  }

  async function handleToggleEnabled(proc: AiSalesProcess) {
    try {
      await client.updateAiSalesProcess(proc.id, { enabled: !proc.enabled });
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update process");
    }
  }

  async function handleRunNow(id: string) {
    setRunningId(id);
    setNotice(null);
    try {
      const res = await client.runAiSalesProcessNow(id);
      const r = res.result || {};
      setNotice(
        `Started: assigned ${r.assigned ?? 0}, email ${r.email_sent ?? 0}, WhatsApp ${r.whatsapp_sent ?? 0}` +
          (r.call_started ? ", calling started" : "") +
          ".",
      );
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to start process");
    } finally {
      setRunningId(null);
    }
  }

  function toggleWeekday(day: string) {
    setDraft((d) => {
      const set = new Set(d.schedule.weekdays);
      if (set.has(day)) set.delete(day);
      else set.add(day);
      return { ...d, schedule: { ...d.schedule, weekdays: [...set] } };
    });
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-700/80 bg-slate-900/40 p-4 text-sm text-slate-400">
        Loading recurring processes…
      </div>
    );
  }

  return (
    <div
      id="ai-sales-processes"
      className="rounded-xl border border-cyan-500/30 bg-slate-900/40 p-4 space-y-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Recurring processes</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Create multiple schedules for Sara / Rayan (e.g. daily 09:45 WhatsApp + email, or every
            Monday call/email). Times use Pakistan (Asia/Karachi).
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white"
        >
          + Add process
        </button>
      </div>

      {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}

      {!processes.length ? (
        <p className="text-sm text-slate-500">No processes yet. Add one to schedule outreach.</p>
      ) : (
        <div className="space-y-2">
          {processes.map((proc) => (
            <div
              key={proc.id}
              className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2.5 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-100 truncate">
                    {proc.name}{" "}
                    <span className="text-slate-500 font-normal">
                      ·{" "}
                      {proc.persona === "both"
                        ? "Sara + Rayan"
                        : proc.persona === "female"
                          ? "Sara"
                          : "Rayan"}
                    </span>
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {proc.schedule?.kind === "weekly" ? "Weekly" : "Daily"} at {proc.schedule?.time}{" "}
                    ({(proc.schedule?.weekdays || []).join(", ")}) ·{" "}
                    {[
                      proc.actions?.call ? "Call" : null,
                      proc.actions?.email ? "Email" : null,
                      proc.actions?.whatsapp ? "WhatsApp" : null,
                    ]
                      .filter(Boolean)
                      .join(" + ") || "No actions"}{" "}
                    · {proc.buyer_ids?.length || 0} contact(s)
                    {proc.last_run_at
                      ? ` · Last run ${new Date(proc.last_run_at).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleToggleEnabled(proc)}
                    className={`px-2 py-1 text-[11px] rounded-md border ${
                      proc.enabled
                        ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                        : "border-slate-600 text-slate-400"
                    }`}
                  >
                    {proc.enabled ? "Scheduled ON" : "Scheduled OFF"}
                  </button>
                  <button
                    type="button"
                    disabled={runningId === proc.id}
                    onClick={() => void handleRunNow(proc.id)}
                    className="px-2 py-1 text-[11px] rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                  >
                    {runningId === proc.id ? "Starting…" : "Start now"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(proc)}
                    className="px-2 py-1 text-[11px] rounded-md border border-slate-600 text-slate-200 hover:bg-slate-800"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(proc.id)}
                    className="px-2 py-1 text-[11px] rounded-md border border-rose-500/40 text-rose-300 hover:bg-rose-950/40"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm ? (
        <div className="rounded-lg border border-cyan-500/40 bg-cyan-950/20 p-3 space-y-3">
          <h4 className="text-sm font-medium text-slate-100">
            {editingId ? "Edit process" : "New process"}
          </h4>
          <label className="block text-xs text-slate-400">
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block text-xs text-slate-400">
              Agent
              <select
                value={draft.persona}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    persona: e.target.value as AiSalesProcess["persona"],
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
              >
                <option value="female">Sara</option>
                <option value="male">Rayan</option>
                <option value="both">Sara + Rayan</option>
              </select>
            </label>
            <label className="block text-xs text-slate-400">
              Schedule
              <select
                value={draft.schedule.kind}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    schedule: {
                      ...d.schedule,
                      kind: e.target.value as "daily" | "weekly",
                    },
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly (pick days)</option>
              </select>
            </label>
            <label className="block text-xs text-slate-400">
              Time (PKT)
              <input
                type="time"
                value={draft.schedule.time}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    schedule: { ...d.schedule, time: e.target.value },
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          {draft.schedule.kind === "weekly" ? (
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleWeekday(d.id)}
                  className={`px-2 py-1 text-[11px] rounded-md border ${
                    draft.schedule.weekdays.includes(d.id)
                      ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-100"
                      : "border-slate-700 text-slate-400"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3 text-sm text-slate-200">
            {(
              [
                ["call", "Call"],
                ["email", "Bulk / personal email"],
                ["whatsapp", "WhatsApp personal msg"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.actions[key]}
                  onChange={() =>
                    setDraft((d) => ({
                      ...d,
                      actions: { ...d.actions, [key]: !d.actions[key] },
                    }))
                  }
                />
                {label}
              </label>
            ))}
          </div>
          <label className="block text-xs text-slate-400">
            Assigned contact lead IDs (from table # / S. No)
            <textarea
              rows={2}
              value={buyerIdsRaw}
              onChange={(e) => setBuyerIdsRaw(e.target.value)}
              placeholder="e.g. 1204 1205 3692"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 font-mono"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
            >
              {saving ? "Saving…" : editingId ? "Save changes" : "Create process"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-600 text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
