import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  client,
  type AiModeLifecycleListResponse,
  type AiModeLifecycleRow,
} from "../../api/client";

const PIPELINE_STAGES = [
  { key: "new_lead", label: "New Lead (Queries)", icon: "📥", color: "from-blue-600 to-indigo-600" },
  { key: "quotation_sent", label: "Quotation Sent", icon: "📄", color: "from-pink-600 to-rose-600" },
  { key: "negotiation", label: "Negotiation", icon: "🤝", color: "from-purple-600 to-indigo-600" },
  { key: "won", label: "Won", icon: "🏆", color: "from-emerald-500 to-green-600" },
  { key: "lost", label: "Lost", icon: "💀", color: "from-rose-700 to-red-800" },
];

/** Advance dropdown includes Interested/Potential (landing from Outreach Funnel). */
const STAGE_OPTIONS = [
  { key: "interested", label: "Interested / Potential", icon: "❤️" },
  ...PIPELINE_STAGES,
];

interface InboundDealsViewProps {
  onOpenEmailComposer?: (email: string, companyName: string, contactName?: string) => void;
}

export const InboundDealsView: React.FC<InboundDealsViewProps> = ({
  onOpenEmailComposer,
}) => {
  const [selectedStage, setSelectedStage] = useState<string>("interested");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [lifecycleData, setLifecycleData] = useState<AiModeLifecycleListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movingBuyerId, setMovingBuyerId] = useState<number | null>(null);
  const loadSeq = useRef(0);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchQuery]);

  const loadDeals = useCallback(
    async (opts?: { soft?: boolean; stageOverride?: string }) => {
      const stage = opts?.stageOverride ?? selectedStage;
      const seq = ++loadSeq.current;
      const soft = Boolean(opts?.soft) || hasLoadedRef.current;
      if (soft) setIsRefreshing(true);
      else setIsLoading(true);
      setError(null);
      try {
        const res = await client.listAiModeLifecycle({
          stage: stage !== "all" ? stage : undefined,
          search: debouncedSearch || undefined,
          limit: 100,
          light: true,
        });
        if (seq !== loadSeq.current) return;
        setLifecycleData(res);
        hasLoadedRef.current = true;
      } catch (err: unknown) {
        if (seq !== loadSeq.current) return;
        setError(err instanceof Error ? err.message : "Failed to load deals lifecycle.");
      } finally {
        if (seq === loadSeq.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [selectedStage, debouncedSearch],
  );

  useEffect(() => {
    void loadDeals({ soft: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on stage/search only
  }, [selectedStage, debouncedSearch]);

  const handleStageChange = async (buyerId: number, newStage: string) => {
    const prev = lifecycleData;
    const stageLabel =
      STAGE_OPTIONS.find((s) => s.key === newStage)?.label || newStage;
    setMovingBuyerId(buyerId);
    // Optimistic: update row / remove if filtered away; bump pipeline counts.
    if (prev) {
      const oldRow = prev.rows.find((r) => r.buyer_id === buyerId);
      const oldStage = oldRow?.stage;
      let nextRows = prev.rows.map((r) =>
        r.buyer_id === buyerId
          ? ({
              ...r,
              stage: newStage,
              stage_label: stageLabel,
              stage_entered_at: new Date().toISOString(),
            } as AiModeLifecycleRow)
          : r,
      );
      if (selectedStage !== "all" && selectedStage !== newStage) {
        nextRows = nextRows.filter((r) => r.buyer_id !== buyerId);
      }
      const pipeline = { ...(prev.pipeline || {}) };
      if (oldStage && oldStage in pipeline) {
        pipeline[oldStage] = Math.max(0, (pipeline[oldStage] || 0) - 1);
      }
      pipeline[newStage] = (pipeline[newStage] || 0) + 1;
      setLifecycleData({ ...prev, rows: nextRows, pipeline });
    }
    try {
      await client.updateAiModeLifecycle(buyerId, { stage: newStage });
      // Follow the contact into New Lead (etc.) so the move feels instant.
      if (
        PIPELINE_STAGES.some((s) => s.key === newStage) &&
        selectedStage !== newStage
      ) {
        setSelectedStage(newStage);
      } else {
        await loadDeals({ soft: true, stageOverride: selectedStage });
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to update deal stage.");
      await loadDeals({ soft: true });
    } finally {
      setMovingBuyerId(null);
    }
  };

  const pipeline = lifecycleData?.pipeline || {};
  const rows = lifecycleData?.rows || [];
  const showInitialSpinner = isLoading && !lifecycleData;

  return (
    <div className="space-y-6">
      {/* ── Header Banner ── */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">⚡</span>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Interested / Potential Pipeline
              </h2>
              {isRefreshing ? (
                <span className="text-[10px] text-amber-300/90 font-medium">Updating…</span>
              ) : null}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Leads marked Interested from Outreach Funnel, plus inbound queries and active deal stages.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadDeals({ soft: true })}
            disabled={isRefreshing}
            className="self-start sm:self-auto px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition flex items-center gap-1.5 disabled:opacity-50"
          >
            <span>🔄</span> Refresh Pipeline
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          {PIPELINE_STAGES.map((st) => {
            const count = pipeline[st.key] ?? 0;
            const isSelected = selectedStage === st.key;
            return (
              <button
                key={st.key}
                type="button"
                onClick={() => setSelectedStage(isSelected ? "interested" : st.key)}
                className={`p-2.5 rounded-xl border text-left transition flex flex-col justify-between ${
                  isSelected
                    ? "bg-slate-800 border-emerald-500 ring-2 ring-emerald-500/20 shadow-md shadow-emerald-950"
                    : "bg-slate-950/70 border-slate-800/80 hover:border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>{st.icon}</span>
                  <span
                    className={`font-bold px-1.5 py-0.2 rounded ${
                      count > 0 ? "bg-emerald-500/20 text-emerald-300" : "text-slate-500"
                    }`}
                  >
                    {count}
                  </span>
                </div>
                <div className="mt-2">
                  <div className="text-[11px] font-semibold text-slate-200 truncate" title={st.label}>
                    {st.label}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2 w-full sm:w-80">
          <input
            type="text"
            placeholder="Search deals, companies, countries..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-slate-400">Filtered Stage:</span>
          <span className="font-semibold text-emerald-400">
            {selectedStage === "all"
              ? "All Stages (Full Pipeline)"
              : selectedStage === "interested"
                ? "Interested / Potential"
                : PIPELINE_STAGES.find((s) => s.key === selectedStage)?.label}
          </span>
          {selectedStage !== "interested" && (
            <button
              type="button"
              onClick={() => setSelectedStage("interested")}
              className="text-xs text-emerald-400 underline hover:text-emerald-300 ml-1"
            >
              Interested / Potential
            </button>
          )}
          {selectedStage !== "all" && (
            <button
              type="button"
              onClick={() => setSelectedStage("all")}
              className="text-xs text-slate-400 underline hover:text-slate-200 ml-1"
            >
              Show All
            </button>
          )}
        </div>
      </div>

      {showInitialSpinner ? (
        <div className="py-20 text-center text-slate-400 flex flex-col items-center gap-2">
          <span className="animate-spin text-2xl">⏳</span>
          <p className="text-xs">Loading inbound deals & client lifecycle...</p>
        </div>
      ) : error && !lifecycleData ? (
        <div className="p-4 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center rounded-2xl border border-slate-800 bg-slate-900/30 p-8">
          <div className="text-3xl mb-2">📥</div>
          <h4 className="text-base font-semibold text-slate-200">No client deals found</h4>
          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
            New inquiry emails received via IMAP/AI Mode or converted contacts will automatically populate here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl relative">
          {isRefreshing ? (
            <div className="absolute top-2 right-3 z-10 text-[10px] text-amber-200/90 bg-slate-950/80 px-2 py-0.5 rounded">
              Syncing…
            </div>
          ) : null}
          <table className="w-full text-left text-xs text-slate-200">
            <thead className="bg-slate-950/80 text-[11px] uppercase font-bold text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">#</th>
                <th className="py-3 px-4">Company Name</th>
                <th className="py-3 px-4">Country</th>
                <th className="py-3 px-4">Stage</th>
                <th className="py-3 px-4">Stage Entered</th>
                <th className="py-3 px-4">Advance Funnel</th>
                <th className="py-3 px-4 text-right">Quick Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {rows.map((row, idx) => {
                const isMoving = movingBuyerId === row.buyer_id;
                const stageMeta =
                  STAGE_OPTIONS.find((s) => s.key === row.stage) ||
                  PIPELINE_STAGES.find((s) => s.key === row.stage);
                return (
                  <tr key={row.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3.5 px-4 text-slate-500 font-mono text-[11px]">{idx + 1}</td>
                    <td className="py-3.5 px-4 font-semibold text-white">
                      <div>{row.company_name || `Buyer #${row.buyer_id}`}</div>
                      {row.notes && (
                        <div className="text-[11px] text-slate-400 font-normal italic mt-0.5">
                          {row.notes}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[11px]">
                        🌍 {row.country || "Global"}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-slate-800 text-slate-100 border border-slate-700">
                        <span>{stageMeta?.icon || "🏷️"}</span>
                        <span>{row.stage_label || row.stage}</span>
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 text-[11px]">
                      {row.stage_entered_at
                        ? new Date(row.stage_entered_at).toLocaleDateString()
                        : "Recent"}
                    </td>
                    <td className="py-3.5 px-4">
                      <select
                        disabled={isMoving}
                        value={row.stage}
                        onChange={(e) => void handleStageChange(row.buyer_id, e.target.value)}
                        className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
                      >
                        {STAGE_OPTIONS.map((st) => (
                          <option key={st.key} value={st.key}>
                            {st.icon} {st.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenEmailComposer?.("", row.company_name || "")}
                          className="px-2.5 py-1 rounded-lg bg-sky-600/20 text-sky-300 border border-sky-500/30 hover:bg-sky-600/30 text-xs font-semibold transition"
                        >
                          ✉️ Email
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
