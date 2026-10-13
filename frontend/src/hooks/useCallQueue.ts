import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { client } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { autocorrectText } from "../utils/spelling";
import {
  confirmAssignmentCallProceed,
  getAssignmentCallWarning,
} from "../utils/assignmentCallGuard";
import { getCallBatchSize, type CallBatchSize } from "../utils/callBatchSize";
import { phonesMatch, useTwilioVoice } from "./useTwilioVoice";

/** @deprecated use getCallBatchSize() — kept for imports that expect a constant default */
export const BATCH_SIZE = 10;

export type QueueStatus = "idle" | "running" | "between" | "paused" | "completed";

export interface QueueEntry {
  leadId: number;
  contactId?: number;
  companyName: string;
  contactName?: string | null;
  phone: string;
  country?: string | null;
  assignedToUserId?: number | null;
  assignedTo?: string | null;
  /** Numbers already dialed for this lead in the current bulk batch stop. */
  triedPhones?: string[];
}

export interface QueueResult {
  leadId: number;
  companyName: string;
  interactionId?: number;
  callStatus?: string | null;
  outcome?: string | null;
  notes?: string;
  skipped?: boolean;
  error?: string;
}

export interface CallQueueState {
  queue: QueueEntry[];
  currentIndex: number;
  status: QueueStatus;
  results: QueueResult[];
  gapSecondsLeft: number | null;
  batchNumber: number;
  totalBatches: number;
  indexInBatch: number;
  batchSize: number;
  pendingOutcome: string | null;
  pendingNotes: string;
  savingRemarks: boolean;
  setPendingOutcome: (v: string | null) => void;
  setPendingNotes: (v: string) => void;
  /** Save remarks for the current lead, then dial the next (or finish if last). */
  savePendingAndContinue: () => Promise<void>;
  /** Advance queue without outcome/remarks (logs as skipped). */
  skipWithoutRemarks: () => Promise<void>;
  start: (leads: QueueEntry[]) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  panelHidden: boolean;
  panelMinimized: boolean;
  hidePanel: () => void;
  showPanel: () => void;
  toggleMinimize: () => void;
  /**
   * End the CURRENT call only and open remarks for that same lead.
   * Never advances the queue and never finishes the batch.
   */
  skipCurrent: () => void;
  /** Redial the current lead on a different number without saving remarks. */
  redialAlternatePhone: (phone: string, contactId?: number) => void;
}

const CallQueueContext = createContext<CallQueueState | null>(null);

function useCallQueueController(): CallQueueState {
  const { user } = useAuth();
  const { placeCall, hangUp, pendingFollowUp, clearPendingFollowUp, setBulkModeActive } =
    useTwilioVoice();

  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState<QueueStatus>("idle");
  const [results, setResults] = useState<QueueResult[]>([]);
  const [pendingOutcome, setPendingOutcome] = useState<string | null>(null);
  const [pendingNotes, setPendingNotes] = useState("");
  const [savingRemarks, setSavingRemarks] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [panelMinimized, setPanelMinimized] = useState(false);
  const [batchSize, setBatchSizeState] = useState<CallBatchSize>(() => getCallBatchSize());

  const statusRef = useRef<QueueStatus>("idle");
  const currentIndexRef = useRef(0);
  const queueRef = useRef<QueueEntry[]>([]);
  const resultsRef = useRef<QueueResult[]>([]);
  const pendingInteractionIdRef = useRef<number | undefined>(undefined);
  const pendingOutcomeRef = useRef<string | null>(null);
  const pendingNotesRef = useRef("");
  const handledInteractionIdsRef = useRef<Set<number>>(new Set());
  /** Bumped to cancel in-flight placeCall/connect after End call / advance. */
  const dialGenerationRef = useRef(0);
  const saveLockRef = useRef(false);

  const syncStatus = useCallback((next: QueueStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const syncIndex = useCallback((next: number) => {
    currentIndexRef.current = next;
    setCurrentIndex(next);
  }, []);

  const setPendingOutcomeSafe = useCallback((v: string | null) => {
    pendingOutcomeRef.current = v;
    setPendingOutcome(v);
  }, []);
  const setPendingNotesSafe = useCallback((v: string) => {
    pendingNotesRef.current = v;
    setPendingNotes(v);
  }, []);

  const clearRemarksFields = useCallback(() => {
    pendingInteractionIdRef.current = undefined;
    setPendingOutcomeSafe(null);
    setPendingNotesSafe("");
  }, [setPendingNotesSafe, setPendingOutcomeSafe]);

  /** Open remarks for the lead at currentIndex — never changes index or completes. */
  const enterRemarksStep = useCallback(() => {
    setPendingOutcomeSafe(null);
    setPendingNotesSafe("");
    syncStatus("between");
  }, [setPendingNotesSafe, setPendingOutcomeSafe, syncStatus]);

  const bindInteraction = useCallback((index: number, interactionId: number) => {
    pendingInteractionIdRef.current = interactionId;
    setResults((prev) => {
      const next = prev.map((r, i) => (i === index ? { ...r, interactionId } : r));
      resultsRef.current = next;
      return next;
    });
  }, []);

  const dialEntry = useCallback(
    (index: number) => {
      const entry = queueRef.current[index];
      if (!entry) return;

      const assignmentWarning = getAssignmentCallWarning(
        entry.assignedToUserId,
        entry.assignedTo,
        user?.id,
      );
      if (assignmentWarning && !confirmAssignmentCallProceed(assignmentWarning)) {
        enterRemarksStep();
        return;
      }

      const generation = ++dialGenerationRef.current;

      placeCall(entry.leadId, entry.contactId, entry.phone)
        .then((prep) => {
          // Cancelled by End call / Stop / newer dial.
          if (dialGenerationRef.current !== generation) {
            hangUp();
            return;
          }
          if (statusRef.current !== "running") {
            hangUp();
            return;
          }
          if (currentIndexRef.current !== index) {
            hangUp();
            return;
          }
          if (prep?.id != null) {
            bindInteraction(index, prep.id);
          }
        })
        .catch((err) => {
          if (dialGenerationRef.current !== generation) return;
          if (currentIndexRef.current !== index) return;
          setResults((prev) => {
            const next = prev.map((r, i) =>
              i === index
                ? { ...r, error: err instanceof Error ? err.message : "Call failed" }
                : r,
            );
            resultsRef.current = next;
            return next;
          });
          // Stay on this lead for remarks — do not advance or finish the batch.
          enterRemarksStep();
        });
    },
    [bindInteraction, enterRemarksStep, hangUp, placeCall, user?.id],
  );

  /** Drop stale bulk-queue UI after bulk finished/paused; keep single-call follow-up. */
  const resetStaleQueueShell = useCallback(() => {
    if (statusRef.current !== "completed" && statusRef.current !== "paused") return;
    dialGenerationRef.current += 1;
    queueRef.current = [];
    resultsRef.current = [];
    handledInteractionIdsRef.current = new Set();
    setQueue([]);
    setResults([]);
    syncIndex(0);
    syncStatus("idle");
    clearRemarksFields();
    setSavingRemarks(false);
    setBulkModeActive(false);
  }, [
    clearRemarksFields,
    setBulkModeActive,
    syncIndex,
    syncStatus,
  ]);

  // Natural / End-call hang-up → remarks for CURRENT lead only (bulk queue).
  // When status is idle/completed/paused, a single call ended — PostCallRemarksModal
  // handles follow-up; never clear pendingFollowUp here (caused instant modal flash).
  useEffect(() => {
    if (!pendingFollowUp) return;
    if (
      statusRef.current === "idle" ||
      statusRef.current === "completed" ||
      statusRef.current === "paused"
    ) {
      resetStaleQueueShell();
      return;
    }

    const interactionId = pendingFollowUp.interactionId;
    if (handledInteractionIdsRef.current.has(interactionId)) {
      clearPendingFollowUp();
      return;
    }

    const idx = currentIndexRef.current;
    const currentResult = resultsRef.current[idx];
    if (
      currentResult?.interactionId != null &&
      currentResult.interactionId !== interactionId &&
      pendingInteractionIdRef.current != null &&
      pendingInteractionIdRef.current !== interactionId
    ) {
      clearPendingFollowUp();
      return;
    }

    bindInteraction(idx, interactionId);
    clearPendingFollowUp();

    // Already collecting remarks (End call pressed) — keep index.
    if (statusRef.current === "between") {
      return;
    }
    if (statusRef.current === "running") {
      enterRemarksStep();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFollowUp]);

  /**
   * End CURRENT call → remarks for that lead.
   * Does NOT move to the next client. Does NOT finish the batch.
   */
  const skipCurrent = useCallback(() => {
    if (statusRef.current !== "running") return;
    // Invalidate any in-flight connect so a late placeCall cannot keep ringing.
    dialGenerationRef.current += 1;
    hangUp();
    enterRemarksStep();
  }, [enterRemarksStep, hangUp]);

  const redialAlternatePhone = useCallback(
    (phone: string, contactId?: number) => {
      if (statusRef.current !== "between") return;
      const idx = currentIndexRef.current;
      const entry = queueRef.current[idx];
      if (!entry) return;

      dialGenerationRef.current += 1;
      hangUp();
      clearRemarksFields();

      const tried = [...(entry.triedPhones ?? [])];
      if (entry.phone && !tried.some((t) => phonesMatch(t, entry.phone))) {
        tried.push(entry.phone);
      }

      const updatedQueue = queueRef.current.map((e, i) =>
        i === idx
          ? {
              ...e,
              phone,
              contactId: contactId ?? e.contactId,
              triedPhones: tried,
            }
          : e,
      );
      queueRef.current = updatedQueue;
      setQueue(updatedQueue);
      syncStatus("running");
      dialEntry(idx);
    },
    [clearRemarksFields, dialEntry, hangUp, syncStatus],
  );

  const advanceAfterCurrent = useCallback(
    async (idx: number, patch: Partial<QueueResult>) => {
      const leads = queueRef.current;
      setResults((prev) => {
        const next = prev.map((r, i) => (i === idx ? { ...r, ...patch } : r));
        resultsRef.current = next;
        return next;
      });
      clearPendingFollowUp();
      const nextIndex = idx + 1;
      clearRemarksFields();
      if (nextIndex >= leads.length) {
        syncIndex(nextIndex);
        syncStatus("completed");
        setBulkModeActive(false);
        return;
      }
      syncIndex(nextIndex);
      syncStatus("running");
      dialEntry(nextIndex);
    },
    [clearPendingFollowUp, clearRemarksFields, dialEntry, setBulkModeActive, syncIndex, syncStatus],
  );

  const skipWithoutRemarks = useCallback(async () => {
    if (statusRef.current !== "between") return;
    if (saveLockRef.current) return;
    const leads = queueRef.current;
    if (!leads.length) return;
    const idx = currentIndexRef.current;
    if (idx < 0 || idx >= leads.length) return;

    saveLockRef.current = true;
    setSavingRemarks(true);
    try {
      hangUp();
      dialGenerationRef.current += 1;
      const interactionId =
        pendingInteractionIdRef.current ?? resultsRef.current[idx]?.interactionId;
      if (interactionId != null) {
        handledInteractionIdsRef.current.add(interactionId);
        try {
          await flushRemarks(interactionId, null, "Skipped — no remarks logged");
        } catch {
          /* best-effort */
        }
      }
      await advanceAfterCurrent(idx, { skipped: true, notes: "Skipped" });
    } finally {
      saveLockRef.current = false;
      setSavingRemarks(false);
    }
  }, [advanceAfterCurrent, hangUp]);

  const savePendingAndContinue = useCallback(async () => {
    if (statusRef.current !== "between") return;
    if (saveLockRef.current) return;

    const leads = queueRef.current;
    if (!leads.length) return;

    const idx = currentIndexRef.current;
    if (idx < 0 || idx >= leads.length) return;

    const outcome = pendingOutcomeRef.current;
    const notes = autocorrectText(pendingNotesRef.current, "prose");
    const interactionId =
      pendingInteractionIdRef.current ?? resultsRef.current[idx]?.interactionId;

    saveLockRef.current = true;
    setSavingRemarks(true);

    try {
      hangUp();
      dialGenerationRef.current += 1;

      if (interactionId != null) {
        handledInteractionIdsRef.current.add(interactionId);
      }
      await flushRemarks(interactionId, outcome, notes);

      await advanceAfterCurrent(idx, {
        interactionId: interactionId ?? undefined,
        outcome: outcome || undefined,
        notes: notes || undefined,
        skipped: false,
      });
    } finally {
      saveLockRef.current = false;
      setSavingRemarks(false);
    }
  }, [advanceAfterCurrent, hangUp]);

  const start = useCallback(
    (leads: QueueEntry[]) => {
      if (!leads.length) return;
      const size = getCallBatchSize();
      setBatchSizeState(size);

      // Snapshot a fresh copy so later page reloads cannot shrink the queue.
      const snapshot = leads.map((l) => ({ ...l }));
      const initialResults: QueueResult[] = snapshot.map((l) => ({
        leadId: l.leadId,
        companyName: l.companyName,
      }));

      dialGenerationRef.current += 1;
      saveLockRef.current = false;
      handledInteractionIdsRef.current = new Set();
      queueRef.current = snapshot;
      resultsRef.current = initialResults;

      setQueue(snapshot);
      setResults(initialResults);
      syncIndex(0);
      syncStatus("running");
      clearRemarksFields();
      setSavingRemarks(false);
      setBulkModeActive(true);
      setPanelHidden(false);
      setPanelMinimized(false);
      dialEntry(0);
    },
    [clearRemarksFields, dialEntry, setBulkModeActive, syncIndex, syncStatus],
  );

  const hidePanel = useCallback(() => {
    if (statusRef.current === "running") {
      dialGenerationRef.current += 1;
      hangUp();
    }
    if (statusRef.current === "running" || statusRef.current === "between") {
      syncStatus("paused");
    }
    setPanelHidden(true);
    setPanelMinimized(false);
  }, [hangUp, syncStatus]);

  const showPanel = useCallback(() => {
    setPanelHidden(false);
    setPanelMinimized(false);
  }, []);

  const toggleMinimize = useCallback(() => {
    setPanelMinimized((prev) => !prev);
    setPanelHidden(false);
  }, []);

  const pause = useCallback(() => {
    if (statusRef.current !== "running" && statusRef.current !== "between") return;
    dialGenerationRef.current += 1;
    hangUp();
    syncStatus("paused");
  }, [hangUp, syncStatus]);

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return;
    if (pendingInteractionIdRef.current != null || resultsRef.current[currentIndexRef.current]?.interactionId != null) {
      enterRemarksStep();
      return;
    }
    syncStatus("running");
    dialEntry(currentIndexRef.current);
  }, [dialEntry, enterRemarksStep, syncStatus]);

  const stop = useCallback(() => {
    dialGenerationRef.current += 1;
    saveLockRef.current = false;
    hangUp();
    clearPendingFollowUp();
    queueRef.current = [];
    resultsRef.current = [];
    handledInteractionIdsRef.current = new Set();
    setQueue([]);
    setResults([]);
    syncIndex(0);
    syncStatus("idle");
    clearRemarksFields();
    setSavingRemarks(false);
    setBulkModeActive(false);
    setPanelHidden(false);
    setPanelMinimized(false);
  }, [
    clearPendingFollowUp,
    clearRemarksFields,
    hangUp,
    setBulkModeActive,
    syncIndex,
    syncStatus,
  ]);

  const batchNumber = Math.floor(currentIndex / batchSize) + 1;
  const totalBatches = Math.ceil(queue.length / batchSize) || 0;
  const indexInBatch = currentIndex % batchSize;

  return {
    queue,
    currentIndex,
    status,
    results,
    gapSecondsLeft: null,
    batchNumber,
    totalBatches,
    indexInBatch,
    batchSize,
    panelHidden,
    panelMinimized,
    pendingOutcome,
    pendingNotes,
    savingRemarks,
    setPendingOutcome: setPendingOutcomeSafe,
    setPendingNotes: setPendingNotesSafe,
    savePendingAndContinue,
    skipWithoutRemarks,
    start,
    pause,
    resume,
    stop,
    skipCurrent,
    redialAlternatePhone,
    hidePanel,
    showPanel,
    toggleMinimize,
  };
}

async function flushRemarks(
  interactionId: number | undefined,
  outcome: string | null,
  notes: string,
) {
  if (!interactionId) return;
  try {
    await client.updateCallFollowUp(interactionId, {
      notes,
      call_outcome: outcome || null,
    });
  } catch {
    // Non-blocking
  }
}

export function CallQueueProvider({ children }: { children: ReactNode }) {
  const value = useCallQueueController();
  return createElement(CallQueueContext.Provider, { value }, children);
}

export function useCallQueue(): CallQueueState {
  const ctx = useContext(CallQueueContext);
  if (!ctx) {
    throw new Error("useCallQueue must be used within CallQueueProvider");
  }
  return ctx;
}

export function useCallQueueOptional(): CallQueueState | null {
  return useContext(CallQueueContext);
}
