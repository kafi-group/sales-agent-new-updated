import { useEffect, useState } from "react";
import {
  client,
  type BuyerProfile,
  type Contact,
  type Lead,
} from "../api/client";
import { useTwilioVoiceOptional } from "../hooks/useTwilioVoice";

const DTMF_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

export interface CallingCardFallback {
  companyName?: string | null;
  contactName?: string | null;
  country?: string | null;
  phone?: string | null;
}

interface CallingCardProps {
  leadId: number;
  /** Shown immediately while lead/profile load. */
  fallback?: CallingCardFallback;
  /** Optional close — e.g. dismiss for this call only. */
  onDismiss?: () => void;
  className?: string;
}

function productFitLabel(score: number | null | undefined): string {
  if (score == null || score <= 0) return "Not researched yet";
  if (score >= 70) return `Strong fit · ${score}`;
  if (score >= 40) return `Moderate fit · ${score}`;
  return `Low fit · ${score}`;
}

function productFitTone(score: number | null | undefined): string {
  if (score == null || score <= 0) return "text-slate-400 border-slate-700 bg-slate-950/50";
  if (score >= 70) return "text-emerald-200 border-emerald-500/40 bg-emerald-500/10";
  if (score >= 40) return "text-amber-100 border-amber-500/40 bg-amber-500/10";
  return "text-rose-200 border-rose-500/40 bg-rose-500/10";
}

export function CallingCard({ leadId, fallback, onDismiss, className = "" }: CallingCardProps) {
  const voice = useTwilioVoiceOptional();
  const [lead, setLead] = useState<Lead | null>(null);
  const [profile, setProfile] = useState<BuyerProfile | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showKeypad, setShowKeypad] = useState(true);
  const [lastSentDtmf, setLastSentDtmf] = useState<string | null>(null);
  const [sentDtmfHistory, setSentDtmfHistory] = useState("");

  const handleSendDtmf = (digit: string) => {
    if (voice?.active) {
      voice.sendDigits(digit);
      setLastSentDtmf(digit);
      setSentDtmfHistory((prev) => `${prev}${digit}`);
      window.setTimeout(() => setLastSentDtmf((c) => (c === digit ? null : c)), 800);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLead(null);
    setProfile(null);
    setContact(null);

    void (async () => {
      try {
        const [leadRow, contacts] = await Promise.all([
          client.getLead(leadId),
          client.listLeadContacts(leadId).catch(() => [] as Contact[]),
        ]);
        if (cancelled) return;
        setLead(leadRow);

        const withPhone =
          contacts.find((c) => (c.phone || "").trim()) ?? contacts[0] ?? null;
        setContact(withPhone);

        try {
          const saved = await client.getLeadProfile(leadId);
          if (!cancelled) setProfile(saved);
        } catch {
          if (!cancelled) setProfile(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load calling card");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [leadId]);

  const companyName =
    lead?.company_name || fallback?.companyName || `Lead #${leadId}`;
  const ownerName =
    contact?.full_name || fallback?.contactName || "Contact not on file";
  const country = lead?.country || fallback?.country || "Country unknown";
  const phone = contact?.phone || fallback?.phone || null;
  const designation = contact?.designation;
  const websiteSummary = profile?.website_summary?.trim() || null;
  const fitScore = profile?.product_fit_score ?? null;
  const matchedCategories = profile?.matched_categories ?? [];
  const matchedProducts = profile?.matched_products ?? [];

  return (
    <aside
      className={`rounded-2xl border border-sky-700/40 bg-slate-950/95 shadow-2xl shadow-black/40 backdrop-blur-sm ${className}`}
      role="dialog"
      aria-label={`Calling card for ${companyName}`}
    >
      <div
        data-drag-handle
        className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-800/80 bg-sky-950/40 rounded-t-2xl cursor-grab active:cursor-grabbing"
        title="Drag to move"
      >
        <div className="min-w-0 flex items-start gap-2">
          <span
            className="mt-2 shrink-0 grid grid-cols-2 gap-0.5 opacity-50"
            aria-hidden
          >
            <span className="w-1 h-1 rounded-full bg-slate-400" />
            <span className="w-1 h-1 rounded-full bg-slate-400" />
            <span className="w-1 h-1 rounded-full bg-slate-400" />
            <span className="w-1 h-1 rounded-full bg-slate-400" />
            <span className="w-1 h-1 rounded-full bg-slate-400" />
            <span className="w-1 h-1 rounded-full bg-slate-400" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.14em] text-sky-300/80">
              Calling card · drag to move
            </p>
            <h3 className="mt-1 text-base font-semibold text-slate-50 truncate">
              {companyName}
            </h3>
            <p className="mt-0.5 text-sm text-slate-300 truncate">
              {ownerName}
              {designation ? ` · ${designation}` : ""}
            </p>
          </div>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 px-2 py-1 rounded-md text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            title="Hide for this call"
          >
            Hide
          </button>
        )}
      </div>

      <div className="px-4 py-3 space-y-3">
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-200">
            {country}
          </span>
          {phone && (
            <span className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-300 tabular-nums">
              {phone}
            </span>
          )}
          <span
            className={`rounded-md border px-2.5 py-1 ${productFitTone(fitScore)}`}
          >
            {productFitLabel(fitScore)}
          </span>
          {loading && (
            <span className="rounded-md border border-slate-700 px-2.5 py-1 text-slate-500">
              Loading…
            </span>
          )}
        </div>

        {error && (
          <p className="text-xs text-amber-200/90">{error}</p>
        )}

        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
            Website summary
          </p>
          <p className="text-sm text-slate-300 leading-relaxed max-h-28 overflow-y-auto whitespace-pre-wrap">
            {websiteSummary ||
              (loading
                ? "Loading research…"
                : "No website summary on file yet. Run Research on the buyer profile to fill this in.")}
          </p>
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
            Product fit
          </p>
          {matchedCategories.length > 0 || matchedProducts.length > 0 ? (
            <div className="space-y-2">
              {matchedCategories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {matchedCategories.slice(0, 8).map((cat) => (
                    <span
                      key={cat}
                      className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200"
                    >
                      {cat.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              )}
              {matchedProducts.length > 0 && (
                <ul className="text-xs text-slate-400 space-y-0.5 max-h-20 overflow-y-auto">
                  {matchedProducts.slice(0, 6).map((p, i) => (
                    <li key={`${p.name}-${i}`}>
                      {p.name}
                      {p.category ? (
                        <span className="text-slate-600"> · {p.category}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              {loading
                ? "Loading product fit…"
                : "No catalog matches yet — research this lead for fit signals."}
            </p>
          )}
        </div>

        {/* In-Call Keypad for IVR / Automated Operator Menus */}
        <div className="pt-2 border-t border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              In-Call Keypad (DTMF / IVR)
            </span>
            <button
              type="button"
              onClick={() => setShowKeypad((v) => !v)}
              className="text-[11px] text-sky-400 hover:text-sky-300 font-medium"
            >
              {showKeypad ? "Hide keypad" : "Show keypad (123)"}
            </button>
          </div>

          {showKeypad && (
            <div className="space-y-2 rounded-xl bg-slate-900/90 border border-slate-800 p-2.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Click digits for operator / IVR options:</span>
                {sentDtmfHistory && (
                  <span className="font-mono text-emerald-300 font-bold bg-slate-950 px-1.5 py-0.5 rounded border border-emerald-800/60">
                    Sent: {sentDtmfHistory}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-6 sm:grid-cols-12 gap-1">
                {DTMF_KEYS.map((key) => {
                  const isSent = lastSentDtmf === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSendDtmf(key)}
                      className={`h-9 rounded-lg font-bold text-sm border transition flex items-center justify-center ${
                        isSent
                          ? "border-emerald-400 bg-emerald-600 text-white scale-95 shadow-md shadow-emerald-950"
                          : "border-slate-700 bg-slate-950 text-slate-200 hover:bg-slate-800 active:bg-slate-700"
                      }`}
                      title={`Send ${key} to phone line`}
                    >
                      {key}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
