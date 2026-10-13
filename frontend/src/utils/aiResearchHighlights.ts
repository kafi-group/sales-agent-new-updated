/** Persist which CRM fields AI Research filled — used to yellow-highlight table cells. */

import {
  AI_RESEARCH_FIELD_LABELS,
  type AiResearchFieldKey,
} from "./aiResearchUpdate";
import { listAiResearchLog } from "./aiResearchLog";

export type AiResearchHighlightEntry = {
  fields: AiResearchFieldKey[];
  at: string;
  /** Snapshot values after save — for searching the list later. */
  search?: {
    company_name?: string;
    contact_name?: string;
    phone?: string;
    email?: string;
  };
};

const STORAGE_KEY = "kafi-ai-research-highlights-v1";
/** Keep highlights for 30 days so reps can still spot filled cells. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Store = Record<string, AiResearchHighlightEntry>;

const LABEL_TO_FIELD = Object.fromEntries(
  (Object.entries(AI_RESEARCH_FIELD_LABELS) as Array<[AiResearchFieldKey, string]>).map(
    ([field, label]) => [label.toLowerCase(), field],
  ),
) as Record<string, AiResearchFieldKey>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const next: Store = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (!entry?.at || !Array.isArray(entry.fields)) continue;
      if (now - new Date(entry.at).getTime() > MAX_AGE_MS) continue;
      next[id] = entry;
    }
    return next;
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
}

export function listAiResearchHighlights(): Store {
  return readStore();
}

export function recordAiResearchHighlights(
  leadId: number,
  fields: AiResearchFieldKey[],
  search?: AiResearchHighlightEntry["search"],
): void {
  if (!leadId || !fields.length) return;
  const store = readStore();
  const prev = store[String(leadId)];
  const merged = Array.from(new Set([...(prev?.fields ?? []), ...fields]));
  store[String(leadId)] = {
    fields: merged,
    at: new Date().toISOString(),
    search: {
      ...(prev?.search ?? {}),
      ...(search ?? {}),
    },
  };
  writeStore(store);
}

/** Rebuild yellow highlights from saved AI Research log entries (incl. older ones). */
export function syncAiResearchHighlightsFromLog(): Store {
  const store = readStore();
  for (const entry of listAiResearchLog()) {
    if (entry.action !== "saved") continue;
    for (const c of entry.contacts) {
      if (!c.id) continue;
      const fields = new Set<AiResearchFieldKey>(store[String(c.id)]?.fields ?? []);
      for (const ch of c.changes ?? []) {
        if (ch.field) fields.add(ch.field as AiResearchFieldKey);
      }
      for (const label of c.filled_fields ?? []) {
        const mapped = LABEL_TO_FIELD[label.toLowerCase()];
        if (mapped) fields.add(mapped);
      }
      if (!fields.size) continue;
      const prev = store[String(c.id)];
      store[String(c.id)] = {
        fields: Array.from(fields),
        at: entry.at || prev?.at || new Date().toISOString(),
        search: {
          ...(prev?.search ?? {}),
          company_name: c.after_company_name || c.company_name || prev?.search?.company_name,
          contact_name: c.after_contact_name || c.contact_name || prev?.search?.contact_name,
          phone: c.after_phone || c.phone || prev?.search?.phone,
          email: c.after_email || c.email || prev?.search?.email,
        },
      };
    }
  }
  writeStore(store);
  return store;
}

export function getAiResearchHighlightFields(leadId: number): AiResearchFieldKey[] {
  return readStore()[String(leadId)]?.fields ?? [];
}

export function isAiResearchFieldHighlighted(
  leadId: number,
  field: string,
  highlights?: Store,
): boolean {
  const entry = (highlights ?? readStore())[String(leadId)];
  if (!entry?.fields?.length) return false;
  return entry.fields.includes(field as AiResearchFieldKey);
}

/** Tailwind classes for AI-filled cells (yellow so they stand out in the list). */
export const AI_RESEARCH_HIGHLIGHT_TD =
  "bg-yellow-300/40 ring-1 ring-inset ring-yellow-400/70 text-yellow-950 dark:text-yellow-50";
