/** Pending "Find in list" handoff from AI Research log → contact table. */

const STORAGE_KEY = "kafi-ai-research-pending-find-v1";
const MAX_AGE_MS = 5 * 60 * 1000;

export type PendingAiResearchFind = {
  leadIds: number[];
  search: string;
  section?: string | null;
  at: number;
};

export function stashPendingAiResearchFind(
  leadIds: number[],
  search: string,
  section?: string | null,
): void {
  const ids = leadIds.filter((id) => id > 0);
  if (!ids.length) return;
  const payload: PendingAiResearchFind = {
    leadIds: ids,
    search: (search || String(ids[0])).trim() || String(ids[0]),
    section: section ?? null,
    at: Date.now(),
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function peekPendingAiResearchFind(): PendingAiResearchFind | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingAiResearchFind;
    if (!parsed?.leadIds?.length || !parsed.search) return null;
    if (Date.now() - (parsed.at || 0) > MAX_AGE_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function consumePendingAiResearchFind(): PendingAiResearchFind | null {
  const pending = peekPendingAiResearchFind();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return pending;
}
