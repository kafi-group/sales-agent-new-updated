export type ResearchPatience = "fast" | "normal" | "patient";

export const RESEARCH_PATIENCE_STORAGE_KEY = "kafi_research_patience";

export const RESEARCH_PATIENCE: Record<
  ResearchPatience,
  { label: string; timeoutMs: number; expectedSec: number }
> = {
  fast: { label: "Fast", timeoutMs: 60_000, expectedSec: 45 },
  normal: { label: "Normal", timeoutMs: 90_000, expectedSec: 70 },
  patient: { label: "Patient", timeoutMs: 120_000, expectedSec: 95 },
};

export function isResearchPatience(value: string): value is ResearchPatience {
  return value === "fast" || value === "normal" || value === "patient";
}

export function loadResearchPatience(): ResearchPatience {
  try {
    const stored = localStorage.getItem(RESEARCH_PATIENCE_STORAGE_KEY);
    if (stored && isResearchPatience(stored)) return stored;
  } catch {
    // Ignore private-mode / blocked storage.
  }
  return "fast";
}

export function saveResearchPatience(value: ResearchPatience): void {
  try {
    localStorage.setItem(RESEARCH_PATIENCE_STORAGE_KEY, value);
  } catch {
    // Ignore private-mode / blocked storage.
  }
}
