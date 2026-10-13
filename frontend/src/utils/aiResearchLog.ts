/** Local activity log for AI Research & Update sessions. */

export type AiResearchLogFieldChange = {
  field: string;
  label: string;
  before: string;
  after: string;
};

export type AiResearchLogContact = {
  id: number;
  label: string;
  company_name?: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  /** Human labels of fields filled (legacy + summary). */
  filled_fields?: string[];
  /** Full before/after for View. */
  changes?: AiResearchLogFieldChange[];
  /** Values after save — for searching the contact list. */
  after_company_name?: string;
  after_contact_name?: string;
  after_phone?: string;
  after_email?: string;
  after_website?: string;
  after_address?: string;
  after_country?: string;
  after_designation?: string;
  after_industry?: string;
};

export type AiResearchLogEntry = {
  id: string;
  at: string;
  action: "opened" | "saved" | "returned";
  section?: string | null;
  contacts: AiResearchLogContact[];
  note?: string;
};

const STORAGE_KEY = "kafi-ai-research-log-v1";
const MAX_ENTRIES = 80;

function readRaw(): AiResearchLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiResearchLogEntry[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(entries: AiResearchLogEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* ignore quota */
  }
}

export function listAiResearchLog(): AiResearchLogEntry[] {
  return readRaw();
}

export function appendAiResearchLog(
  entry: Omit<AiResearchLogEntry, "id" | "at"> & { at?: string },
): AiResearchLogEntry {
  const full: AiResearchLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: entry.at || new Date().toISOString(),
    action: entry.action,
    section: entry.section ?? null,
    contacts: entry.contacts || [],
    note: entry.note,
  };
  const next = [full, ...readRaw()].slice(0, MAX_ENTRIES);
  writeRaw(next);
  return full;
}

export function clearAiResearchLog() {
  writeRaw([]);
}

export function formatAiResearchLogTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** One-line search blob: company · contact · phone · email · #id */
export function contactSearchText(c: AiResearchLogContact): string {
  const parts = [
    c.after_company_name || c.company_name,
    c.after_contact_name || c.contact_name,
    c.after_phone || c.phone,
    c.after_email || c.email,
    c.id > 0 ? `#${c.id}` : null,
  ].filter((p) => (p ?? "").toString().trim());
  return parts.join(" · ");
}
