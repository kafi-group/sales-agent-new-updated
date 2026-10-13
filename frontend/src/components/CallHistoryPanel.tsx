import { useCallback, useEffect, useState } from "react";
import { client, type CallHistoryItem } from "../api/client";
import { type CallOutcome, callOutcomeBadge, callOutcomeLabel, callOutcomeListNotice } from "../utils/callOutcomes";
import { CallRemarksForm } from "./CallRemarksForm";
import { CallRecordingPanel } from "./CallRecordingPanel";

interface CallHistoryPanelProps {
  leadId: number;
  onError: (message: string) => void;
  onCallFollowUpSaved?: (outcome: string | null | undefined) => void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}

function statusBadge(status: string | null | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (value === "completed") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (value === "busy" || value === "no-answer" || value === "failed" || value === "canceled") {
    return "bg-red-500/15 text-red-300 border-red-500/30";
  }
  if (value === "in-progress" || value === "ringing" || value === "answered") {
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  }
  return "bg-slate-700/50 text-slate-300 border-slate-600";
}

export function CallHistoryPanel({
  leadId,
  onError,
  onCallFollowUpSaved,
}: CallHistoryPanelProps) {
  const [calls, setCalls] = useState<CallHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState("");
  const [outcomeDraft, setOutcomeDraft] = useState<CallOutcome | "">("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [trainingId, setTrainingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCalls = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.listLeadCalls(leadId, { page: 1, page_size: 20 });
      setCalls(result.rows);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load call history");
    } finally {
      setLoading(false);
    }
  }, [leadId, onError]);

  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  async function saveFollowUp(interactionId: number) {
    setSaving(true);
    try {
      const updated = await client.updateCallFollowUp(interactionId, {
        notes: remarksDraft,
        call_outcome: outcomeDraft || null,
      });
      setCalls((prev) => prev.map((c) => (c.id === interactionId ? updated : c)));
      setEditingId(null);
      onCallFollowUpSaved?.(updated.call_outcome);
      const outcomeNotice = callOutcomeListNotice(updated.call_outcome);
      if (outcomeNotice) {
        setNotice(outcomeNotice);
        setTimeout(() => setNotice(null), 4000);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save call remarks");
    } finally {
      setSaving(false);
    }
  }

  function startEditing(call: CallHistoryItem) {
    setEditingId(call.id);
    setRemarksDraft(call.notes ?? "");
    setOutcomeDraft((call.call_outcome as CallOutcome | undefined) ?? "");
  }

  async function toggleTrainSaraRayan(call: CallHistoryItem, next: boolean) {
    setTrainingId(call.id);
    try {
      const updated = await client.setCallTrainingFlag(call.id, next);
      setCalls((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setNotice(
        next
          ? "Marked for Sara & Rayan training — appears in Call Center → AI Sales Agent."
          : "Removed from Sara & Rayan training set.",
      );
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update training flag");
    } finally {
      setTrainingId(null);
    }
  }

  async function deleteCall(call: CallHistoryItem) {
    const label = call.contact_name ?? call.company_name ?? "this call";
    if (!window.confirm(`Delete call log for ${label}? This cannot be undone.`)) return;

    setDeletingId(call.id);
    try {
      await client.deleteCallLog(call.id);
      setCalls((prev) => prev.filter((c) => c.id !== call.id));
      if (editingId === call.id) setEditingId(null);
      if (call.call_outcome) {
        onCallFollowUpSaved?.(null);
      }
      setNotice("Call log deleted.");
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete call log");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h3 className="text-sm font-medium text-slate-300">Call history</h3>
        <p className="text-sm text-slate-500 mt-2">Loading…</p>
      </section>
    );
  }

  if (calls.length === 0) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h3 className="text-sm font-medium text-slate-300">Call history</h3>
        <p className="text-sm text-slate-500 mt-2">No calls logged yet. Use Call on a contact above.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-300">Call history</h3>
        <button
          type="button"
          onClick={() => void loadCalls()}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Refresh
        </button>
      </div>
      {notice && (
        <p className="text-xs text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          {notice}
        </p>
      )}
      <ul className="space-y-3">
        {calls.map((call) => (
          <li key={call.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm text-slate-200">
                  {call.contact_name ?? "Contact"}
                  {call.lead_phone || call.contact_phone ? (
                    <span className="text-slate-500"> · {call.lead_phone ?? call.contact_phone}</span>
                  ) : null}
                </p>
                <p className="text-xs text-slate-500">{formatDate(call.created_at)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <label
                  className="flex items-center gap-1.5 cursor-pointer select-none rounded border border-violet-500/35 bg-violet-500/10 px-2 py-0.5"
                  title="Tick to send this call’s recording + captions to Train Sara & Rayan"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(call.ai_training_selected)}
                    disabled={trainingId === call.id}
                    onChange={(e) => void toggleTrainSaraRayan(call, e.target.checked)}
                    className="rounded border-slate-600 bg-slate-900 text-violet-500 focus:ring-violet-500"
                  />
                  <span className="text-xs font-medium text-violet-200 whitespace-nowrap">
                    {trainingId === call.id ? "Saving…" : "Train Sara & Rayan"}
                  </span>
                </label>
                {call.call_outcome && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded border ${callOutcomeBadge(call.call_outcome)}`}
                  >
                    {callOutcomeLabel(call.call_outcome)}
                  </span>
                )}
                {call.call_status && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded border ${statusBadge(call.call_status)}`}
                  >
                    {call.call_status}
                    {call.call_duration_seconds
                      ? ` · ${formatDuration(call.call_duration_seconds)}`
                      : ""}
                  </span>
                )}
              </div>
            </div>
            {call.notes && editingId !== call.id && (
              <p className="text-sm text-slate-400 whitespace-pre-wrap">{call.notes}</p>
            )}
            <CallRecordingPanel
              call={call}
              compact
              onError={onError}
              onUpdated={(updated) => {
                setCalls((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
              }}
            />
            {editingId === call.id ? (
              <div className="space-y-2">
                <CallRemarksForm
                  remarks={remarksDraft}
                  outcome={outcomeDraft}
                  onRemarksChange={setRemarksDraft}
                  onOutcomeChange={setOutcomeDraft}
                  onSave={() => void saveFollowUp(call.id)}
                  saving={saving}
                  saveLabel="Save remarks"
                  compact
                />
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => startEditing(call)}
                  className="text-xs text-sky-400 hover:text-sky-300"
                >
                  {call.notes || call.call_outcome ? "Edit remarks" : "Add remarks"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteCall(call)}
                  disabled={deletingId === call.id}
                  className="text-xs text-red-300 hover:text-red-200 disabled:opacity-50"
                >
                  {deletingId === call.id ? "Deleting…" : "Delete"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
