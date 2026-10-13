import { useEffect, useState, type MouseEvent } from "react";
import { client } from "../api/client";
import { CreateLeadForm } from "../components/CreateLeadForm";
import { DiscoverLeadsPanel } from "../components/DiscoverLeadsPanel";
import { Pagination } from "../components/Pagination";
import { ScoreBadge } from "../components/ScoreBadge";
import { useLeads } from "../hooks/useLeads";

const PAGE_SIZE = 20;

interface LeadsPageProps {
  onError: (message: string) => void;
  onSelectLead: (leadId: number) => void;
  onTotalChange?: (total: number) => void;
}

export function LeadsPage({ onError, onSelectLead, onTotalChange }: LeadsPageProps) {
  const { leads, loading, refresh, page, total, totalPages, goToPage, pageSize } =
    useLeads(PAGE_SIZE);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [onboardResult, setOnboardResult] = useState<
    Record<number, { score: string; reasoning: string }>
  >({});
  const [onboarding, setOnboarding] = useState<number | null>(null);

  useEffect(() => {
    onTotalChange?.(total);
  }, [onTotalChange, total]);

  async function handleOnboard(leadId: number, event: MouseEvent) {
    event.stopPropagation();
    setOnboarding(leadId);
    try {
      const result = await client.onboardLead(leadId);
      setOnboardResult((prev) => ({
        ...prev,
        [leadId]: { score: result.score, reasoning: result.reasoning },
      }));
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Onboard failed");
    } finally {
      setOnboarding(null);
    }
  }

  async function handleLeadCreated(leadId: number) {
    setShowCreateForm(false);
    await refresh();
    onSelectLead(leadId);
  }

  if (loading && leads.length === 0) return <p className="text-slate-400">Loading leads…</p>;

  return (
    <section className="space-y-4 w-full min-w-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Searched by AI</h2>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            New prospects found via web discovery or manual add. Old clients stay in the{" "}
            <span className="text-slate-300">Old clients</span> table and never appear here.
            Saved discoveries also land in the Leads table.
          </p>
          <p className="text-sm text-slate-500 mt-2">
            {total} discovery lead{total === 1 ? "" : "s"}
          </p>
        </div>
        {!showCreateForm && (
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowDiscover((v) => !v);
                setShowCreateForm(false);
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
            >
              {showDiscover ? "Hide discovery" : "Discover leads"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreateForm(true);
                setShowDiscover(false);
              }}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
            >
              + Add lead
            </button>
          </div>
        )}
      </div>

      {showDiscover && (
        <DiscoverLeadsPanel
          onImported={async (ids) => {
            await refresh();
            if (ids.length === 1) onSelectLead(ids[0]);
          }}
          onError={onError}
          onCancel={() => setShowDiscover(false)}
        />
      )}

      {showCreateForm && (
        <CreateLeadForm
          onSuccess={handleLeadCreated}
          onCancel={() => setShowCreateForm(false)}
          onError={onError}
          onOpenExisting={(leadId) => {
            setShowCreateForm(false);
            onSelectLead(leadId);
          }}
        />
      )}

      {total === 0 && !showCreateForm && (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center">
          <p className="text-slate-400 text-sm">No leads yet.</p>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="mt-3 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
          >
            Add your first lead
          </button>
        </div>
      )}

      <div className={loading ? "opacity-60 pointer-events-none space-y-4" : "space-y-4"}>
        {leads.map((lead) => {
          const result = onboardResult[lead.id];
          const scoreLabel = result?.score ?? lead.latest_score ?? null;
          const scoreReasoning = result?.reasoning ?? lead.score_reasoning ?? null;
          return (
            <div
              key={lead.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectLead(lead.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelectLead(lead.id);
              }}
              className="rounded-xl border border-slate-800 bg-slate-900 p-4 flex items-center justify-between gap-4 cursor-pointer hover:border-slate-700 hover:bg-slate-900/80 transition"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-medium">{lead.company_name}</h3>
                  {scoreLabel ? (
                    <ScoreBadge score={scoreLabel} />
                  ) : (
                    <span className="px-2 py-0.5 rounded border text-xs font-medium bg-slate-700/30 text-slate-400 border-slate-600/40">
                      Unscored
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-400">
                  {[lead.country, lead.industry].filter(Boolean).join(" · ") || "—"}
                </p>
                {scoreReasoning && (
                  <p className="text-sm text-slate-500 mt-1 line-clamp-2">{scoreReasoning}</p>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => handleOnboard(lead.id, e)}
                disabled={onboarding === lead.id}
                className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm disabled:opacity-50"
              >
                {onboarding === lead.id ? "Scoring…" : "Re-score"}
              </button>
            </div>
          );
        })}
      </div>

      <Pagination
        page={page}
        totalPages={totalPages}
        totalItems={total}
        pageSize={pageSize}
        onPageChange={goToPage}
        disabled={loading}
      />
    </section>
  );
}
