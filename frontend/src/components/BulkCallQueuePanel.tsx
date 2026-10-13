import { useEffect, useState } from "react";
import { type CallQueueState } from "../hooks/useCallQueue";
import { CALL_OUTCOMES } from "../utils/callOutcomes";
import {
  autocorrectText,
  capitalizeFirstLetter,
  spellingInputProps,
} from "../utils/spelling";
import { CallingCard } from "./CallingCard";
import { DraggableFloat } from "./DraggableFloat";
import { TryAnotherNumberButtons } from "./TryAnotherNumberButtons";

interface BulkCallQueuePanelProps {
  queue: CallQueueState;
  onClose: () => void;
  onError?: (message: string) => void;
}

function statusDot(
  index: number,
  currentIndex: number,
  status: CallQueueState["status"],
  results: CallQueueState["results"],
) {
  const result = results[index];
  if (index < currentIndex || (index === currentIndex && status === "completed")) {
    if (result?.error && !result?.outcome)
      return <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title={result.error} />;
    if (result?.outcome || result?.notes)
      return <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="Logged" />;
    if (result?.callStatus === "completed")
      return <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="Completed" />;
    return <span className="w-2 h-2 rounded-full bg-slate-600 shrink-0" title="Done" />;
  }
  if (index === currentIndex) {
    if (status === "running")
      return (
        <span
          className="w-2 h-2 rounded-full bg-sky-400 shrink-0 animate-pulse"
          title="Calling…"
        />
      );
    if (status === "between")
      return (
        <span
          className="w-2 h-2 rounded-full bg-amber-400 shrink-0 animate-pulse"
          title="Add remarks"
        />
      );
    if (status === "paused")
      return <span className="w-2 h-2 rounded-full bg-slate-400 shrink-0" title="Paused" />;
  }
  return <span className="w-2 h-2 rounded-full border border-slate-600 shrink-0" title="Queued" />;
}

export function BulkCallQueuePanel({ queue, onClose, onError }: BulkCallQueuePanelProps) {
  const {
    status,
    currentIndex,
    results,
    batchNumber,
    totalBatches,
    pendingOutcome,
    pendingNotes,
    savingRemarks,
    setPendingOutcome,
    setPendingNotes,
    savePendingAndContinue,
    pause,
    resume,
    stop,
    skipCurrent,
    redialAlternatePhone,
    skipWithoutRemarks,
    toggleMinimize,
    batchSize,
    queue: entries,
  } = queue;

  const currentEntry = entries[currentIndex] ?? null;
  const [dismissedLeadId, setDismissedLeadId] = useState<number | null>(null);

  useEffect(() => {
    setDismissedLeadId(null);
  }, [currentEntry?.leadId]);

  if (status === "idle") return null;

  const totalCalls = entries.length;
  const completedCount = results.filter(
    (r, i) => i < currentIndex || Boolean(r.outcome || r.notes),
  ).length;
  const progressPct = totalCalls > 0 ? Math.round((completedCount / totalCalls) * 100) : 0;

  const currentResult = results[currentIndex] ?? null;
  const showRemarksForm = Boolean(currentEntry) && status === "between";
  const showCallingCard =
    Boolean(currentEntry) &&
    (status === "running" || status === "between" || status === "paused") &&
    dismissedLeadId !== currentEntry?.leadId;

  const batchStart = (batchNumber - 1) * batchSize;
  const batchEnd = Math.min(batchStart + batchSize, totalCalls);
  const batchEntries = entries.slice(batchStart, batchEnd);

  return (
    <>
    {showCallingCard && currentEntry && (
      <DraggableFloat storageKey="kafi_calling_card_pos">
        <CallingCard
          leadId={currentEntry.leadId}
          fallback={{
            companyName: currentEntry.companyName,
            contactName: currentEntry.contactName,
            country: currentEntry.country,
            phone: currentEntry.phone,
          }}
          onDismiss={() => setDismissedLeadId(currentEntry.leadId)}
        />
      </DraggableFloat>
    )}
    <div className="rounded-xl border border-sky-800/50 bg-slate-900 overflow-hidden shadow-xl">
      <div className="px-4 py-3 bg-sky-950/60 border-b border-sky-800/40 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {status === "running" && (
            <span className="w-2.5 h-2.5 rounded-full bg-sky-400 animate-pulse shrink-0" />
          )}
          {status === "between" && (
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
          )}
          {status === "paused" && (
            <span className="w-2.5 h-2.5 rounded-full bg-slate-400 shrink-0" />
          )}
          {status === "completed" && (
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-100 truncate">
              {status === "completed"
                ? `Bulk call finished · ${totalCalls} calls`
                : status === "paused"
                  ? "Bulk call paused"
                  : status === "between"
                    ? `Add remarks for ${currentEntry?.companyName ?? "this call"}`
                    : `Calling ${currentEntry?.companyName ?? "…"}`}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {status === "completed"
                ? `Finished all ${totalCalls} call${totalCalls === 1 ? "" : "s"}`
                : `Call ${Math.min(currentIndex + 1, totalCalls)} of ${totalCalls}${
                    currentIndex < totalCalls - 1
                      ? ` · ${totalCalls - currentIndex - 1} still waiting`
                      : " · last in queue"
                  }`}
              {status !== "completed" ? (
                <span className="text-slate-500">
                  {" "}
                  · Batch size {batchSize}
                  {totalBatches > 1 ? ` (${batchNumber}/${totalBatches})` : ""} — next batch after
                  remarks
                </span>
              ) : null}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {status === "running" && (
            <>
              <button
                type="button"
                onClick={skipCurrent}
                className="px-2.5 py-1.5 rounded-lg bg-amber-900/50 hover:bg-amber-900/70 border border-amber-700/40 text-amber-200 text-xs"
                title="End this call only, then add remarks. Does not stop the bulk queue."
              >
                End call
              </button>
              <button
                type="button"
                onClick={pause}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs"
              >
                Pause
              </button>
            </>
          )}
          {status === "between" && (
            <>
              <button
                type="button"
                onClick={() => void skipWithoutRemarks()}
                disabled={savingRemarks}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs disabled:opacity-60"
                title="Skip remarks for this lead and dial the next"
              >
                Skip & next
              </button>
              <button
                type="button"
                onClick={() => void savePendingAndContinue()}
                disabled={savingRemarks}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 border border-emerald-600 text-white text-xs font-medium"
              >
                {savingRemarks ? "Saving…" : "Save & next"}
              </button>
            </>
          )}
          {status === "paused" && (
            <button
              type="button"
              onClick={resume}
              className="px-2.5 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 border border-sky-600 text-white text-xs"
            >
              Resume
            </button>
          )}
          {status !== "completed" && (
            <>
              <button
                type="button"
                onClick={toggleMinimize}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs"
                title="Minimize to a small chip"
              >
                Minimize
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs"
                title="Hide panel (pauses queue — resume from Call Center)"
              >
                Hide panel
              </button>
              <button
                type="button"
                onClick={stop}
                disabled={savingRemarks}
                className="px-2.5 py-1.5 rounded-lg bg-red-900/50 hover:bg-red-900/70 border border-red-700/40 text-red-200 text-xs disabled:opacity-60"
                title="Stop the entire bulk queue and discard remaining calls"
              >
                Stop all (end batch)
              </button>
            </>
          )}
          {status === "completed" && (
            <button
              type="button"
              onClick={onClose}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {status !== "completed" && (
        <div className="h-1 bg-slate-800">
          <div
            className="h-1 bg-sky-500 transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-800">
        <div className="max-h-[220px] overflow-y-auto divide-y divide-slate-800/60">
          {batchEntries.map((entry, relIdx) => {
            const absIdx = batchStart + relIdx;
            const res = results[absIdx];
            const isCurrent = absIdx === currentIndex && status !== "completed";

            return (
              <div
                key={`${entry.leadId}-${absIdx}`}
                className={`flex items-center gap-3 px-4 py-2.5 ${isCurrent ? "bg-sky-950/40" : ""}`}
              >
                {statusDot(absIdx, currentIndex, status, results)}
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm truncate ${isCurrent ? "text-sky-200 font-medium" : "text-slate-300"}`}
                  >
                    {entry.companyName}
                  </p>
                  {entry.contactName && (
                    <p className="text-xs text-slate-500 truncate">{entry.contactName}</p>
                  )}
                </div>
                {res?.outcome && (
                  <span className="text-xs text-emerald-300/80 shrink-0">
                    {CALL_OUTCOMES.find((o) => o.value === res.outcome)?.label ?? res.outcome}
                  </span>
                )}
                {isCurrent && status === "between" && !res?.outcome && (
                  <span className="text-xs text-amber-300/80 shrink-0">Add remarks</span>
                )}
                {isCurrent && status === "running" && (
                  <span className="text-xs text-sky-300/80 shrink-0">Calling</span>
                )}
                {res?.error && absIdx < currentIndex && !res?.outcome && (
                  <span className="text-xs text-red-300/70 shrink-0" title={res.error}>
                    Failed
                  </span>
                )}
              </div>
            );
          })}

          {totalBatches > 1 && batchNumber < totalBatches && (
            <div className="px-4 py-2 text-xs text-slate-500">
              +{totalCalls - batchEnd} more leads in {totalBatches - batchNumber} remaining batch
              {totalBatches - batchNumber === 1 ? "" : "es"}
            </div>
          )}
        </div>

        <div className="p-4 space-y-3">
          {status === "running" && currentEntry && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">Active call</p>
              <p className="text-sm text-sky-200 font-medium">{currentEntry.companyName}</p>
              {currentEntry.contactName && (
                <p className="text-xs text-slate-400">{currentEntry.contactName}</p>
              )}
              <p className="text-xs text-slate-500">{currentEntry.phone}</p>
              <p className="text-xs text-slate-500 mt-3 leading-relaxed">
                Click <span className="text-amber-200">End call</span> when finished with this
                client. That only ends this call — the rest of the bulk queue stays waiting. Then
                add outcome + remarks and click Save & next to dial the next client.
              </p>
              <button
                type="button"
                onClick={skipCurrent}
                className="px-3 py-1.5 rounded-lg bg-amber-900/50 hover:bg-amber-900/70 border border-amber-700/40 text-amber-200 text-xs"
              >
                End call — then add remarks
              </button>
            </div>
          )}

          {showRemarksForm && currentEntry && (
            <>
              <div className="space-y-0.5">
                <p className="text-xs text-slate-500">
                  Call ended — log this client before dialing the next
                </p>
                <p className="text-sm text-sky-200 font-medium">{currentEntry.companyName}</p>
                {currentEntry.contactName && (
                  <p className="text-xs text-slate-400">{currentEntry.contactName}</p>
                )}
                <p className="text-xs text-slate-500">{currentEntry.phone}</p>
                {currentResult?.error && (
                  <p className="text-xs text-red-300/90 mt-1">{currentResult.error}</p>
                )}
              </div>

              <TryAnotherNumberButtons
                buyerId={currentEntry.leadId}
                triedPhones={
                  currentEntry.triedPhones?.length
                    ? currentEntry.triedPhones
                    : currentEntry.phone
                      ? [currentEntry.phone]
                      : []
                }
                onError={onError ?? (() => undefined)}
                onBulkRedial={redialAlternatePhone}
                disabled={savingRemarks}
              />

              <div>
                <p className="text-xs text-slate-500 mb-1">Outcome</p>
                <div className="flex flex-wrap gap-2">
                  {CALL_OUTCOMES.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() =>
                        setPendingOutcome(pendingOutcome === o.value ? null : o.value)
                      }
                      disabled={savingRemarks}
                      className={`px-2.5 py-1 rounded-lg border text-xs transition disabled:opacity-60 ${
                        pendingOutcome === o.value
                          ? "bg-emerald-600/30 border-emerald-500/50 text-emerald-200"
                          : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <textarea
                value={pendingNotes}
                onChange={(e) => setPendingNotes(capitalizeFirstLetter(e.target.value))}
                onBlur={(e) => setPendingNotes(autocorrectText(e.target.value, "prose"))}
                rows={3}
                placeholder="Call remarks…"
                disabled={savingRemarks}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-200 placeholder-slate-600 resize-none disabled:opacity-60"
                {...spellingInputProps("prose")}
              />

              <button
                type="button"
                onClick={() => void savePendingAndContinue()}
                disabled={savingRemarks}
                className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 border border-emerald-600 text-white text-xs font-medium"
              >
                {savingRemarks ? "Saving…" : "Save remarks & next"}
              </button>
              <p className="text-xs text-slate-500">
                Saves outcome and remarks for this client, then dials the next call in the batch.
              </p>
            </>
          )}

          {status === "paused" && (
            <div className="space-y-1">
              <p className="text-sm text-slate-300">Queue paused.</p>
              <p className="text-xs text-slate-500">
                Press Resume to continue. If the call already ended, you will add remarks next.
              </p>
            </div>
          )}

          {status === "completed" && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-emerald-300">All calls completed!</p>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-slate-800 p-2">
                  <p className="text-lg font-bold text-emerald-400">
                    {results.filter((r) => r.outcome || r.notes).length}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">With remarks</p>
                </div>
                <div className="rounded-lg bg-slate-800 p-2">
                  <p className="text-lg font-bold text-red-400">
                    {results.filter((r) => r.error).length}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">Failed dials</p>
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Outcomes can be updated later from call history.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
