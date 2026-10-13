import { useCallback, useEffect, useState } from "react";
import {
  client,
  type BuyerProfile as BuyerProfileData,
  type CrossSellRecommendation,
  type Lead,
  type LeadScore,
} from "../api/client";
import { ScoreBadge } from "../components/ScoreBadge";
import { MarketRoleBadge } from "../components/MarketRoleBadge";
import { ConversionBar, ProducerTierBadge } from "../components/ProducerTierBadge";
import { CallHistoryPanel } from "../components/CallHistoryPanel";
import { ClientHistoryPanel } from "../components/ClientHistoryPanel";
import { ContactsPanel } from "../components/ContactsPanel";
import { DiscoverLeadsPanel } from "../components/DiscoverLeadsPanel";
import { WhatsAppChatPreviewPanel } from "../components/WhatsAppChatPreviewPanel";
import { ActionButton } from "../components/ui/ActionButton";
import {
  IconSearch,
  IconSparkles,
  IconUsers,
  IconX,
} from "../components/icons/AppIcons";

interface BuyerProfileProps {
  leadId: number;
  onBack: () => void;
  onError: (message: string) => void;
  onCallFollowUpSaved?: (outcome: string | null | undefined) => void;
  /** Open WhatsApp inbox focused on a contact's full thread. */
  onOpenWhatsAppChat?: (contactId: number) => void;
  /** Admin-only: show Find similar / Discover Leads panel. */
  canDiscover?: boolean;
}

function formatCategory(category: string): string {
  return category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function BuyerProfile({
  leadId,
  onBack,
  onError,
  onCallFollowUpSaved,
  onOpenWhatsAppChat,
  canDiscover = false,
}: BuyerProfileProps) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [profile, setProfile] = useState<BuyerProfileData | null>(null);
  const [score, setScore] = useState<LeadScore | null>(null);
  const [crossSell, setCrossSell] = useState<CrossSellRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const [leadData, crossSellData] = await Promise.all([
        client.getLead(leadId),
        client.getCrossSell(leadId).catch(() => [] as CrossSellRecommendation[]),
      ]);
      setLead(leadData);
      setCrossSell(crossSellData);

      try {
        setScore(await client.getLatestScore(leadId));
      } catch {
        setScore(null);
      }

      try {
        setProfile(await client.getLeadProfile(leadId));
      } catch {
        setProfile(null);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load buyer");
    } finally {
      setLoading(false);
    }
  }, [leadId, onError]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  async function handleResearch() {
    setResearching(true);
    try {
      const profileData = await client.researchLead(leadId);
      setProfile(profileData);
      setLead(await client.getLead(leadId));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Research failed");
    } finally {
      setResearching(false);
    }
  }

  async function handleScore() {
    setScoring(true);
    try {
      // Same path as table "Research & Score": enrich contacts/location → research → score
      await client.onboardLead(leadId);
      const [profileData, leadData, scoreData, crossSellData] = await Promise.all([
        client.getLeadProfile(leadId),
        client.getLead(leadId),
        client.getLatestScore(leadId),
        client.getCrossSell(leadId).catch(() => [] as CrossSellRecommendation[]),
      ]);
      setProfile(profileData);
      setScore(scoreData);
      setLead(leadData);
      setCrossSell(crossSellData);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Scoring failed");
    } finally {
      setScoring(false);
    }
  }

  if (loading) {
    return <p className="text-slate-400">Loading buyer profile…</p>;
  }

  if (!lead) {
    return <p className="text-slate-400">Buyer not found.</p>;
  }

  return (
    <div className="space-y-6 w-full min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-slate-400 hover:text-slate-200 mb-3"
          >
            ← Back to leads
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-xl font-semibold">{lead.company_name}</h2>
            {lead.company_grading && (
              <span
                className="inline-flex items-center rounded-full border border-slate-600 bg-slate-900 px-2.5 py-0.5 text-xs text-slate-300"
                title="Grade from Excel / spreadsheet import"
              >
                Excel: {lead.company_grading}
              </span>
            )}
            {score && (
              <span className="inline-flex items-center gap-1.5">
                <ScoreBadge score={score.score} />
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  AI grading
                </span>
              </span>
            )}
            <MarketRoleBadge role={profile?.market_role ?? lead.market_role ?? "unknown"} />
            {(profile?.producer_tier ?? lead.producer_tier) && (
              <ProducerTierBadge
                tier={profile?.producer_tier ?? lead.producer_tier}
                conversionPct={profile?.producer_conversion_pct ?? lead.producer_conversion_pct}
              />
            )}
          </div>
          <p className="text-sm text-slate-400 mt-1">
            {[lead.country, lead.industry].filter(Boolean).join(" · ") || "No location or industry"}
          </p>
          {lead.website_url && (
            <a
              href={lead.website_url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-emerald-400 hover:text-emerald-300 mt-1 inline-block"
            >
              {lead.website_url}
            </a>
          )}
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap sm:justify-end w-full sm:w-auto">
          {canDiscover && (
            <ActionButton
              icon={showDiscover ? IconX : IconUsers}
              onClick={() => setShowDiscover((v) => !v)}
              title={showDiscover ? "Hide discovery" : "Find similar"}
              className="flex-1 sm:flex-none"
            >
              {showDiscover ? "Hide discovery" : "Find similar"}
            </ActionButton>
          )}
          <ActionButton
            icon={IconSearch}
            onClick={handleResearch}
            disabled={researching || scoring}
            title="Research"
          >
            {researching ? "Researching…" : "Research"}
          </ActionButton>
          <ActionButton
            icon={IconSparkles}
            variant="primary"
            onClick={handleScore}
            disabled={researching || scoring}
            title="Research and Score"
          >
            {scoring ? "Scoring…" : "Research & Score"}
          </ActionButton>
        </div>
      </div>

      {canDiscover && showDiscover && lead && (
        <DiscoverLeadsPanel
          seedLead={lead}
          seedCategories={profile?.matched_categories ?? []}
          onImported={async () => {
            setShowDiscover(false);
          }}
          onError={onError}
          onCancel={() => setShowDiscover(false)}
        />
      )}

      <ContactsPanel leadId={leadId} onError={onError} />

      <CallHistoryPanel
        leadId={leadId}
        onError={onError}
        onCallFollowUpSaved={onCallFollowUpSaved}
      />

      <ClientHistoryPanel
        buyerId={leadId}
        companyName={lead.company_name}
        onError={onError}
      />

      <WhatsAppChatPreviewPanel
        buyerId={leadId}
        companyName={lead.company_name}
        onError={onError}
        onViewAllMessages={onOpenWhatsAppChat}
      />

      {score && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h3 className="text-sm font-medium text-slate-300 mb-2">AI company grading</h3>
          <p className="text-sm text-slate-400">{score.reasoning}</p>
          <p className="text-xs text-slate-500 mt-2">
            Scored {new Date(score.scored_at).toLocaleString()} · Independent of Excel grading
          </p>
        </section>
      )}

      {!profile && !score && (
        <section className="rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-6 text-center">
          <p className="text-slate-400 text-sm">
            No research on file yet. Run <strong className="text-slate-300">Research</strong> to
            analyze this buyer&apos;s website and product fit, or{" "}
            <strong className="text-slate-300">Research &amp; Score</strong> for an independent AI
            company grade (AAA / AA / A). It will not copy the Excel grading.
          </p>
        </section>
      )}

      {profile?.researched_at && (
        <p className="text-xs text-slate-500">
          Last researched {new Date(profile.researched_at).toLocaleString()}
          {profile.product_fit_score != null && profile.product_fit_score > 0 && (
            <> · Product fit score {profile.product_fit_score}</>
          )}
        </p>
      )}

      {profile && (
        <>
          {(profile.market_role_reasoning || profile.market_role) && (
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-2">Market role</h3>
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <MarketRoleBadge role={profile.market_role ?? "unknown"} />
                {profile.producer_tier && (
                  <ProducerTierBadge
                    tier={profile.producer_tier}
                    conversionPct={profile.producer_conversion_pct}
                  />
                )}
                {profile.market_role_confidence != null && (
                  <span className="text-xs text-slate-500">
                    {Math.round(profile.market_role_confidence * 100)}% role confidence
                  </span>
                )}
              </div>
              {profile.producer_tier === "weak" && profile.producer_conversion_pct != null && (
                <div className="mb-3 max-w-md">
                  <ConversionBar pct={profile.producer_conversion_pct} />
                  <p className="text-xs text-slate-500 mt-2">
                    Chance this narrow exporter will source additional Kafi ranges (pickles, rice,
                    sauces, salt, etc.) for resale under their brand or distribution.
                  </p>
                </div>
              )}
              {profile.producer_tier_reasoning && (
                <p className="text-sm text-slate-400 mb-2">{profile.producer_tier_reasoning}</p>
              )}
              {profile.market_role_reasoning && (
                <p className="text-sm text-slate-400">{profile.market_role_reasoning}</p>
              )}
              <p className="text-xs text-slate-500 mt-2">
                Strong exporters have a catalog close to Kafi&apos;s — competitors. Weak exporters
                specialize in few lines and may buy other ranges from you.
              </p>
            </section>
          )}

          {profile.website_summary && (
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-2">Website summary</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{profile.website_summary}</p>
            </section>
          )}

          {profile.relationship_context && (
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-2">Relationship history</h3>
              <p className="text-sm text-slate-400">{profile.relationship_context}</p>
            </section>
          )}

          {profile.matched_categories.length > 0 && (
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Kafi product fit</h3>
              <div className="flex flex-wrap gap-2">
                {profile.matched_categories.map((cat) => (
                  <span
                    key={cat}
                    className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-medium"
                  >
                    {formatCategory(cat)}
                  </span>
                ))}
              </div>
            </section>
          )}

          {profile.matched_products.length > 0 && (
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Matched ESSENCE products</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-slate-800">
                      <th className="py-2 pr-4">Product</th>
                      <th className="py-2 pr-4">Category</th>
                      <th className="py-2">Matched on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.matched_products.map((product) => (
                      <tr
                        key={`${product.name}-${product.category}`}
                        className="border-b border-slate-800/60"
                      >
                        <td className="py-2.5 pr-4 text-slate-200">{product.name}</td>
                        <td className="py-2.5 pr-4 text-slate-400">
                          {formatCategory(product.category)}
                        </td>
                        <td className="py-2.5 text-slate-500">
                          {product.matched_keyword ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {profile.signals.length > 0 && (
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Signals</h3>
              <ul className="space-y-1.5">
                {profile.signals.map((signal) => (
                  <li key={signal} className="text-sm text-slate-400 flex gap-2">
                    <span className="text-slate-600">•</span>
                    {signal}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {crossSell.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h3 className="text-sm font-medium text-slate-300 mb-3">Cross-sell opportunities</h3>
          <ul className="space-y-3">
            {crossSell.map((item) => (
              <li
                key={`${item.category}-${item.product_name}`}
                className="rounded-lg bg-slate-950 border border-slate-800 p-3"
              >
                <p className="text-sm font-medium text-slate-200">{item.product_name}</p>
                <p className="text-xs text-emerald-400/80 mt-0.5">{formatCategory(item.category)}</p>
                <p className="text-sm text-slate-500 mt-1">{item.rationale}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

    </div>
  );
}
