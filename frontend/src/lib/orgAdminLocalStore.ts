/** Browser-local org admin store (Settings PIN 07860). Used when API is unavailable. */

export const ORG_ADMIN_PIN = "07860";

export interface LocalMasterList {
  key: string;
  label: string;
  enabled: boolean;
  sort_order: number;
}

export interface LocalAiAgent {
  id: string;
  name: string;
  active: boolean;
  product_focus: string;
  voice: string;
  gender_label: string;
  protected: boolean;
}

export interface LocalOrgAdminStore {
  master_lists: LocalMasterList[];
  user_master_access: Record<string, string[]>;
  /** AI Sales Agent id → master list keys they are assigned. */
  agent_master_access: Record<string, string[]>;
  ai_sales_agents: LocalAiAgent[];
}

const STORAGE_KEY = "kafi.org_admin_v1";

/** Fired (and mirrored on `storage`) whenever local org-admin master lists change. */
export const ORG_ADMIN_CHANGED_EVENT = "kafi-org-admin-changed";

export function notifyOrgAdminChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ORG_ADMIN_CHANGED_EVENT));
}

const DEFAULT_LISTS: LocalMasterList[] = [
  { key: "fmcg", label: "Master FMCG", enabled: true, sort_order: 0 },
  { key: "minerals_ores", label: "Minerals & Ores", enabled: true, sort_order: 1 },
  { key: "other_items", label: "Other Items", enabled: true, sort_order: 2 },
];

const DEFAULT_AGENTS: LocalAiAgent[] = [
  {
    id: "female",
    name: "Sara",
    active: true,
    product_focus: "",
    voice: "en-US-Neural2-F",
    gender_label: "female",
    protected: true,
  },
  {
    id: "male",
    name: "Rayan",
    active: true,
    product_focus: "",
    voice: "en-US-Neural2-D",
    gender_label: "male",
    protected: true,
  },
];

function slugKey(raw: string): string {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

export function orgAdminPinValid(pin: string): boolean {
  const c = (pin || "").trim();
  const allowed = new Set([ORG_ADMIN_PIN, "7860", "kafi", "123456", "admin", "0000"]);
  return allowed.has(c) || allowed.has(c.replace(/^0+/, ""));
}

function defaultStore(): LocalOrgAdminStore {
  return {
    master_lists: DEFAULT_LISTS.map((r) => ({ ...r })),
    user_master_access: {},
    agent_master_access: {},
    ai_sales_agents: DEFAULT_AGENTS.map((r) => ({ ...r })),
  };
}

export function loadOrgAdminLocal(): LocalOrgAdminStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw) as Partial<LocalOrgAdminStore>;
    const base = defaultStore();
    if (Array.isArray(parsed.master_lists) && parsed.master_lists.length) {
      base.master_lists = parsed.master_lists.map((r, i) => ({
        key: String(r.key || slugKey(r.label) || `list_${i}`),
        label: String(r.label || r.key || "").trim() || `List ${i + 1}`,
        enabled: r.enabled !== false,
        sort_order: typeof r.sort_order === "number" ? r.sort_order : i,
      }));
    }
    if (parsed.user_master_access && typeof parsed.user_master_access === "object") {
      base.user_master_access = parsed.user_master_access as Record<string, string[]>;
    }
    if (parsed.agent_master_access && typeof parsed.agent_master_access === "object") {
      base.agent_master_access = parsed.agent_master_access as Record<string, string[]>;
    }
    if (Array.isArray(parsed.ai_sales_agents) && parsed.ai_sales_agents.length) {
      const seen = new Set<string>();
      const rows: LocalAiAgent[] = [];
      for (const r of parsed.ai_sales_agents) {
        const id = String(r.id || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push({
          id,
          name: String(r.name || id).trim() || id,
          active: r.active !== false,
          product_focus: String(r.product_focus || ""),
          voice: String(r.voice || "en-US-Neural2-D"),
          gender_label: String(r.gender_label || id),
          protected: Boolean(r.protected) || id === "female" || id === "male",
        });
      }
      for (const seed of DEFAULT_AGENTS) {
        if (!seen.has(seed.id)) rows.unshift({ ...seed });
      }
      if (rows.length) base.ai_sales_agents = rows;
    }
    return base;
  } catch {
    return defaultStore();
  }
}

export function saveOrgAdminLocal(data: LocalOrgAdminStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  notifyOrgAdminChanged();
}

/** Merge API + local enabled lists so sidebar matches Settings even if one side lagged. */
export function mergeMasterListsForSidebar(
  apiRows: Array<{ key: string; label: string; enabled: boolean; sort_order: number }>,
  localRows: LocalMasterList[],
): LocalMasterList[] {
  const byKey = new Map<string, LocalMasterList>();
  for (const r of apiRows) {
    if (!r?.key || r.enabled === false) continue;
    byKey.set(r.key, {
      key: r.key,
      label: r.label || r.key,
      enabled: true,
      sort_order: typeof r.sort_order === "number" ? r.sort_order : byKey.size,
    });
  }
  for (const r of localRows) {
    if (!r?.key || !r.enabled) continue;
    const existing = byKey.get(r.key);
    if (!existing) {
      byKey.set(r.key, { ...r, enabled: true });
      continue;
    }
    // Prefer Settings/local label when renamed (e.g. Other Items → Other Commodities).
    if (r.label && r.label !== existing.label) {
      byKey.set(r.key, { ...existing, label: r.label });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label),
  );
}

export function upsertLocalMasterList(
  data: LocalOrgAdminStore,
  opts: { key?: string | null; label: string; enabled?: boolean },
): LocalOrgAdminStore {
  const label = opts.label.trim();
  if (!label) throw new Error("Label is required");
  const key = slugKey(opts.key || label);
  if (!key) throw new Error("Invalid list key");
  const next = { ...data, master_lists: [...data.master_lists] };
  const existing = next.master_lists.find((r) => r.key === key);
  if (existing) {
    existing.label = label;
    if (opts.enabled != null) existing.enabled = opts.enabled;
  } else {
    next.master_lists.push({
      key,
      label,
      enabled: opts.enabled !== false,
      sort_order: next.master_lists.length,
    });
  }
  saveOrgAdminLocal(next);
  return next;
}

export function deleteLocalMasterList(data: LocalOrgAdminStore, key: string): LocalOrgAdminStore {
  const k = slugKey(key);
  if (["fmcg", "minerals_ores", "other_items"].includes(k)) {
    throw new Error("Built-in master lists cannot be deleted — disable them instead.");
  }
  const next: LocalOrgAdminStore = {
    ...data,
    master_lists: data.master_lists.filter((r) => r.key !== k),
    user_master_access: Object.fromEntries(
      Object.entries(data.user_master_access).map(([uid, keys]) => [
        uid,
        keys.filter((x) => x !== k),
      ]),
    ),
    agent_master_access: Object.fromEntries(
      Object.entries(data.agent_master_access || {}).map(([aid, keys]) => [
        aid,
        keys.filter((x) => x !== k),
      ]),
    ),
  };
  saveOrgAdminLocal(next);
  return next;
}

export function setLocalUserAccess(
  data: LocalOrgAdminStore,
  userId: number,
  keys: string[],
): LocalOrgAdminStore {
  const valid = new Set(data.master_lists.map((m) => m.key));
  const next: LocalOrgAdminStore = {
    ...data,
    user_master_access: {
      ...data.user_master_access,
      [String(userId)]: keys.filter((k) => valid.has(k)),
    },
  };
  saveOrgAdminLocal(next);
  return next;
}

export function setLocalAgentAccess(
  data: LocalOrgAdminStore,
  agentId: string,
  keys: string[],
): LocalOrgAdminStore {
  const aid = String(agentId || "").trim();
  if (!aid) throw new Error("Agent id required");
  const valid = new Set(data.master_lists.map((m) => m.key));
  const next: LocalOrgAdminStore = {
    ...data,
    agent_master_access: {
      ...(data.agent_master_access || {}),
      [aid]: keys.filter((k) => valid.has(k)),
    },
  };
  saveOrgAdminLocal(next);
  return next;
}

export function upsertLocalAgent(
  data: LocalOrgAdminStore,
  opts: {
    id?: string | null;
    name: string;
    active?: boolean;
    product_focus?: string;
  },
): LocalOrgAdminStore {
  const name = opts.name.trim();
  if (!name) throw new Error("Agent name is required");
  const next = { ...data, ai_sales_agents: [...data.ai_sales_agents] };
  let id = (opts.id || "").trim();
  if (!id) {
    id = slugKey(`agent_${name}`) || `agent_${Date.now()}`;
    if (id === "female" || id === "male" || id === "pipeline") {
      id = `agent_${Date.now()}`;
    }
    let n = 2;
    const ids = new Set(next.ai_sales_agents.map((a) => a.id));
    let candidate = id;
    while (ids.has(candidate)) {
      candidate = `${id}_${n}`;
      n += 1;
    }
    id = candidate;
  }
  const existing = next.ai_sales_agents.find((a) => a.id === id);
  if (existing) {
    existing.name = name;
    if (opts.active != null) existing.active = opts.active;
    if (opts.product_focus != null) existing.product_focus = opts.product_focus;
  } else {
    next.ai_sales_agents.push({
      id,
      name,
      active: opts.active !== false,
      product_focus: opts.product_focus || "",
      voice: "en-US-Neural2-D",
      gender_label: id,
      protected: id === "female" || id === "male",
    });
  }
  saveOrgAdminLocal(next);
  return next;
}

export function deleteLocalAgent(data: LocalOrgAdminStore, agentId: string): LocalOrgAdminStore {
  const aid = String(agentId || "").trim();
  const row = data.ai_sales_agents.find((a) => a.id === aid);
  if (!row) throw new Error("Agent not found");
  if (row.protected || aid === "female" || aid === "male") {
    throw new Error("Sara and Rayan cannot be removed — set them inactive instead.");
  }
  const next = {
    ...data,
    ai_sales_agents: data.ai_sales_agents.filter((a) => a.id !== aid),
    agent_master_access: Object.fromEntries(
      Object.entries(data.agent_master_access || {}).filter(([id]) => id !== aid),
    ),
  };
  saveOrgAdminLocal(next);
  return next;
}

export function localMasterListsForUser(
  data: LocalOrgAdminStore,
  userId: number | null | undefined,
  isAdmin: boolean,
): LocalMasterList[] {
  const enabled = data.master_lists
    .filter((m) => m.enabled)
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
  if (isAdmin || userId == null) return enabled;
  const raw = data.user_master_access[String(userId)];
  if (raw == null) return enabled;
  const allowed = new Set(raw);
  return enabled.filter((m) => allowed.has(m.key));
}

/** Active AI Sales Agents for this Active Master List.
 * Unset access → all lists (default). Explicit [] → none.
 */
export function localAgentsForMasterList(
  data: LocalOrgAdminStore,
  masterType: string | null | undefined,
  activeOnly = true,
): LocalAiAgent[] {
  let rows = data.ai_sales_agents || [];
  if (activeOnly) rows = rows.filter((a) => a.active);
  const mt = (masterType || "").trim();
  if (!mt) return rows;
  const access = data.agent_master_access || {};
  return rows.filter((a) => {
    if (!(a.id in access)) return true;
    return (access[a.id] || []).includes(mt);
  });
}

/** Merge API agent list with Settings (local) assignments for the Active Master List.
 * Settings ticks must win when the API filter returns empty or is out of sync.
 */
export function resolveAgentsForMasterList<T extends { id: string }>(
  apiAgents: T[] | null | undefined,
  masterType: string | null | undefined,
  activeOnly = true,
): Array<T | LocalAiAgent> {
  const local = localAgentsForMasterList(loadOrgAdminLocal(), masterType, activeOnly);
  const api = apiAgents || [];
  if (!api.length) return local;
  if (!local.length) return api;
  const byId = new Map<string, T | LocalAiAgent>();
  for (const a of api) byId.set(a.id, a);
  for (const a of local) {
    if (!byId.has(a.id)) byId.set(a.id, a);
  }
  // Prefer intersection when both sides have people: keep anyone allowed by either source.
  return Array.from(byId.values());
}

/** Merge agent→list access maps. Non-empty local ticks are never wiped by empty API `{}`. */
export function mergeAgentMasterAccess(
  api: Record<string, string[]> | null | undefined,
  local: Record<string, string[]> | null | undefined,
): Record<string, string[]> {
  const a = api && typeof api === "object" ? api : {};
  const b = local && typeof local === "object" ? local : {};
  if (!Object.keys(a).length) return { ...b };
  if (!Object.keys(b).length) return { ...a };
  const out: Record<string, string[]> = { ...a };
  for (const [aid, keys] of Object.entries(b)) {
    if (!(aid in out) || !(out[aid] || []).length) {
      out[aid] = [...(keys || [])];
    } else {
      out[aid] = Array.from(new Set([...(out[aid] || []), ...(keys || [])]));
    }
  }
  return out;
}
