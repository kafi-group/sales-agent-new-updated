const STORAGE_KEY = "kafi_call_batch_size";
export const CALL_BATCH_SIZE_OPTIONS = [10, 25] as const;
export type CallBatchSize = (typeof CALL_BATCH_SIZE_OPTIONS)[number];

export function getCallBatchSize(): CallBatchSize {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : 10;
    return n === 25 ? 25 : 10;
  } catch {
    return 10;
  }
}

export function setCallBatchSize(size: CallBatchSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    /* ignore */
  }
}
