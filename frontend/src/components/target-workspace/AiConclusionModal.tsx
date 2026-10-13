import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type AiConclusionItem,
  type AiConclusionOverviewResponse,
  type AppUser,
} from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const DAYS = [
  { id: "monday", label: "Monday" },
  { id: "tuesday", label: "Tuesday" },
  { id: "wednesday", label: "Wednesday" },
  { id: "thursday", label: "Thursday" },
  { id: "friday", label: "Friday" },
  { id: "saturday", label: "Saturday" },
  { id: "sunday", label: "Sunday" },
];

interface AiConclusionModalProps {
  open: boolean;
  onClose: () => void;
  onError?: (message: string) => void;
  /** When set, jump straight to this company. */
  initialBuyerId?: number | null;
  selectedDay?: string;
}

function companyLabel(item: AiConclusionItem): string {
  const name = (item.company_name || "").trim();
  if (name) return name;
  const country = (item.country || "").trim();
  if (country) return `${country} lead #${item.buyer_id}`;
  return `Company #${item.buyer_id}`;
}

function EngagementTable({ item }: { item: AiConclusionItem }) {
  const rows: Array<{ label: string; key: keyof AiConclusionItem["engagement"]["7d"] }> = [
    { label: "Calls", key: "calls" },
    { label: "Emails", key: "emails" },
    { label: "WhatsApp", key: "whatsapp" },
    { label: "Telegram", key: "telegram" },
    { label: "Quotations", key: "quotations" },
    { label: "Follow-ups pending", key: "follow_ups_pending" },
  ];
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-950/80">
      <table className="w-full text-base text-left">
        <thead>
          <tr className="border-b border-slate-800 text-slate-400">
            <th className="px-4 py-3 font-semibold">Channel</th>
            <th className="px-4 py-3 font-semibold text-center">7 Days</th>
            <th className="px-4 py-3 font-semibold text-center">30 Days</th>
            <th className="px-4 py-3 font-semibold text-center">90 Days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-slate-800/80 last:border-0">
              <td className="px-4 py-3 text-slate-200">{row.label}</td>
              <td className="px-4 py-3 text-center text-slate-100 font-semibold text-lg">
                {item.engagement["7d"][row.key]}
              </td>
              <td className="px-4 py-3 text-center text-slate-100 font-semibold text-lg">
                {item.engagement["30d"][row.key]}
              </td>
              <td className="px-4 py-3 text-center text-slate-100 font-semibold text-lg">
                {item.engagement["90d"][row.key]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConclusionFields({ item }: { item: AiConclusionItem }) {
  const fields: Array<[string, string]> = [
    ["Buyer status", item.buyer_status],
    ["Last contact", item.last_contact],
    ["Pending action", item.pending_action],
    ["Responsible person", item.responsible_person],
    ["Next action", item.next_action],
    ["Management attention", item.management_attention],
  ];
  const attentionRequired =
    /required/i.test(item.management_attention) &&
    !/not required/i.test(item.management_attention);

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-5 space-y-3">
      <p className="text-sm font-bold uppercase tracking-wider text-violet-300">AI conclusion</p>
      {fields.map(([label, value]) => (
        <div key={label} className="flex flex-wrap gap-x-3 gap-y-1 text-base leading-relaxed">
          <span className="text-slate-400 font-semibold min-w-[11rem]">{label}:</span>
          <span
            className={
              label === "Management attention"
                ? attentionRequired
                  ? "text-amber-300 font-bold text-lg"
                  : "text-emerald-300 font-bold text-lg"
                : "text-slate-50 font-medium"
            }
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function buildOverviewFromItems(
  items: AiConclusionItem[],
  day: string | null,
): AiConclusionOverviewResponse {
  const byUser = new Map<string, { companies: number; attention_required: number }>();
  let attentionRequired = 0;
  for (const item of items) {
    const name = item.responsible_person || "Unassigned";
    const bucket = byUser.get(name) || { companies: 0, attention_required: 0 };
    bucket.companies += 1;
    const attn =
      /required/i.test(item.management_attention) &&
      !/not required/i.test(item.management_attention);
    if (attn) {
      bucket.attention_required += 1;
      attentionRequired += 1;
    }
    byUser.set(name, bucket);
  }
  return {
    day_of_week: day,
    companies_scanned: items.length,
    attention_required: attentionRequired,
    by_user: [...byUser.entries()]
      .map(([responsible_person, counts]) => ({ responsible_person, ...counts }))
      .sort(
        (a, b) =>
          b.attention_required - a.attention_required ||
          a.responsible_person.localeCompare(b.responsible_person),
      ),
    items,
  };
}

export function AiConclusionModal({
  open,
  onClose,
  onError,
  initialBuyerId = null,
  selectedDay: _selectedDay,
}: AiConclusionModalProps) {
  const { isAdmin } = useAuth();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<AiConclusionItem[]>([]);
  const [selected, setSelected] = useState<AiConclusionItem | null>(null);
  const [overview, setOverview] = useState<AiConclusionOverviewResponse | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);

  // Draft filters (what the user is editing)
  const [searchInput, setSearchInput] = useState("");
  const [filterUserId, setFilterUserId] = useState<string>("");
  const [filterDay, setFilterDay] = useState("");
  const [filterAttention, setFilterAttention] = useState("");

  // Applied server filters (only change on Refresh / day-user-attention apply)
  const [appliedDay, setAppliedDay] = useState("");
  const [appliedUserId, setAppliedUserId] = useState("");
  const [appliedAttention, setAppliedAttention] = useState("");
  const [appliedServerSearch, setAppliedServerSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (initialBuyerId) {
        const one = await client.getBuyerAiConclusion(initialBuyerId);
        setItems([one]);
        setSelected(one);
        setOverview(null);
        return;
      }
      const list = await client.listAiConclusions({
        user_id: isAdmin && appliedUserId ? Number(appliedUserId) : undefined,
        company: appliedServerSearch.trim() || undefined,
        day: appliedDay || undefined,
        attention: appliedAttention || undefined,
        limit: 100,
      });
      setItems(list.items || []);
      if (isAdmin) {
        setOverview(buildOverviewFromItems(list.items || [], appliedDay || null));
      } else {
        setOverview(null);
      }
      setSelected((prev) => {
        const nextItems = list.items || [];
        if (prev && nextItems.some((i) => i.buyer_id === prev.buyer_id)) {
          return nextItems.find((i) => i.buyer_id === prev.buyer_id) || nextItems[0] || null;
        }
        return nextItems[0] || null;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load AI conclusions";
      setLoadError(msg);
      setItems([]);
      setSelected(null);
      setOverview(null);
      onErrorRef.current?.(msg);
    } finally {
      setLoading(false);
    }
  }, [appliedAttention, appliedDay, appliedServerSearch, appliedUserId, initialBuyerId, isAdmin]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open || !isAdmin) return;
    void client
      .listUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [open, isAdmin]);

  // Reset draft filters when reopening (always start All days — no forced Tue).
  useEffect(() => {
    if (!open) return;
    setSearchInput("");
    setFilterDay("");
    setFilterUserId("");
    setFilterAttention("");
    setAppliedDay("");
    setAppliedUserId("");
    setAppliedAttention("");
    setAppliedServerSearch("");
  }, [open]);

  function applyFilters() {
    setAppliedDay(filterDay);
    setAppliedUserId(filterUserId);
    setAppliedAttention(filterAttention);
    // Server search only when user explicitly refreshes with a query (deep search).
    setAppliedServerSearch(searchInput.trim());
  }

  // Instant local filter over whatever is already loaded.
  const visibleItems = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const hay = [
        item.company_name,
        item.country,
        item.responsible_person,
        item.buyer_status,
        item.stage,
        String(item.buyer_id),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, searchInput]);

  const visibleOverview = useMemo(() => {
    if (!isAdmin || initialBuyerId) return null;
    return buildOverviewFromItems(visibleItems, appliedDay || null);
  }, [appliedDay, initialBuyerId, isAdmin, visibleItems]);

  useEffect(() => {
    if (!visibleItems.length) {
      setSelected(null);
      return;
    }
    setSelected((prev) => {
      if (prev && visibleItems.some((i) => i.buyer_id === prev.buyer_id)) return prev;
      return visibleItems[0];
    });
  }, [visibleItems]);

  const title = useMemo(() => {
    if (initialBuyerId && selected) return `AI Conclusion — ${companyLabel(selected)}`;
    return isAdmin ? "AI Conclusion — Team overview" : "AI Conclusion — My companies";
  }, [initialBuyerId, isAdmin, selected]);

  if (!open) return null;

  const displayOverview = visibleOverview || overview;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-3 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-7xl lg:max-w-[92vw] h-[96vh] sm:h-[92vh] overflow-hidden flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-conclusion-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 sm:p-6 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0 bg-slate-950/50">
          <div className="min-w-0">
            <h2
              id="ai-conclusion-title"
              className="text-xl sm:text-2xl font-bold text-white flex items-center gap-2.5"
            >
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600/30 text-violet-200 text-sm font-black border border-violet-500/40">
                AI
              </span>
              <span className="truncate">{title}</span>
            </h2>
            <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">
              Search filters this list instantly. Change day / user / attention, then click{" "}
              <strong className="text-slate-300">Apply filters</strong> to reload from the server.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white text-2xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {!initialBuyerId && (
          <div className="px-5 sm:px-6 py-3.5 border-b border-slate-800 flex flex-wrap gap-2.5 items-center shrink-0 bg-slate-950/30">
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search company, country, or sales person…"
              className="rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-base text-slate-200 placeholder-slate-500 min-w-[14rem] flex-1"
              autoComplete="off"
            />
            <select
              value={filterDay}
              onChange={(e) => setFilterDay(e.target.value)}
              className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-base text-slate-200 min-w-[9rem]"
              title="Filter by target weekday"
            >
              <option value="">All days</option>
              {DAYS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <select
              value={filterAttention}
              onChange={(e) => setFilterAttention(e.target.value)}
              className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-base text-slate-200"
            >
              <option value="">All attention</option>
              <option value="required">Attention required</option>
              <option value="not_required">Not required</option>
            </select>
            {isAdmin && (
              <select
                value={filterUserId}
                onChange={(e) => setFilterUserId(e.target.value)}
                className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-base text-slate-200 min-w-[10rem]"
              >
                <option value="">All users</option>
                {users.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.full_name || u.username}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => applyFilters()}
              disabled={loading}
              className="px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-base font-semibold disabled:opacity-50"
            >
              {loading ? "Loading…" : "Apply filters"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="px-4 py-2.5 rounded-xl border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-100 text-base font-semibold disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5 text-base">
          {isAdmin && displayOverview && !initialBuyerId && (
            <div className="grid sm:grid-cols-3 gap-4">
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">Companies shown</p>
                <p className="text-3xl font-bold text-white mt-1">{visibleItems.length}</p>
              </div>
              <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4">
                <p className="text-xs uppercase tracking-wider text-amber-400/80">Attention required</p>
                <p className="text-3xl font-bold text-amber-200 mt-1">
                  {displayOverview.attention_required}
                </p>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500 mb-2">By sales person</p>
                <ul className="space-y-1 max-h-28 overflow-y-auto text-sm text-slate-300">
                  {(displayOverview.by_user || []).slice(0, 10).map((row) => (
                    <li key={row.responsible_person} className="flex justify-between gap-2">
                      <span className="truncate">{row.responsible_person}</span>
                      <span className="text-amber-300 shrink-0 font-semibold">
                        {row.attention_required}/{row.companies}
                      </span>
                    </li>
                  ))}
                  {(displayOverview.by_user || []).length === 0 && (
                    <li className="text-slate-500">No rows yet</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {loadError ? (
            <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 p-5 text-center space-y-3">
              <p className="text-base text-rose-200">{loadError}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold"
              >
                Try again
              </button>
            </div>
          ) : loading && items.length === 0 ? (
            <p className="text-base text-slate-400 text-center py-16">Building AI conclusions…</p>
          ) : visibleItems.length === 0 ? (
            <p className="text-base text-slate-500 text-center py-16 max-w-lg mx-auto leading-relaxed">
              No companies match this search
              {appliedDay ? ` for ${appliedDay}` : ""}. Clear the search box, set day to{" "}
              <strong className="text-slate-300">All days</strong>, then click{" "}
              <strong className="text-slate-300">Apply filters</strong>.
            </p>
          ) : (
            <div className="grid lg:grid-cols-[300px_1fr] gap-5">
              {!initialBuyerId && (
                <ul className="space-y-1.5 max-h-[min(60vh,36rem)] overflow-y-auto pr-1">
                  {visibleItems.map((item) => {
                    const active = selected?.buyer_id === item.buyer_id;
                    const attn =
                      /required/i.test(item.management_attention) &&
                      !/not required/i.test(item.management_attention);
                    return (
                      <li key={item.buyer_id}>
                        <button
                          type="button"
                          onClick={() => setSelected(item)}
                          className={`w-full text-left rounded-xl border px-3.5 py-2.5 transition ${
                            active
                              ? "border-violet-500/60 bg-violet-500/15 text-white"
                              : "border-slate-800 bg-slate-950/50 text-slate-300 hover:border-slate-600"
                          }`}
                        >
                          <p className="text-base font-semibold truncate">{companyLabel(item)}</p>
                          <p className="text-xs text-slate-500 truncate mt-0.5">
                            {[item.country, item.responsible_person].filter(Boolean).join(" · ")}
                            {attn ? " · Attention" : ""}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {selected && (
                <div className="space-y-5 min-w-0">
                  <div>
                    <h3 className="text-xl sm:text-2xl font-bold text-white">
                      {companyLabel(selected)}
                    </h3>
                    <p className="text-sm text-slate-500 mt-1">
                      {[selected.country, selected.stage?.replace(/_/g, " "), selected.responsible_person]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <EngagementTable item={selected} />
                  <ConclusionFields item={selected} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
