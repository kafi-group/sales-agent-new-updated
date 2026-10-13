import { useEffect, useState } from "react";
import { client, type AiConclusionItem } from "../api/client";

const ALL_MODES = [
  { id: "calls", label: "Call" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "emails", label: "Email" },
  { id: "telegram", label: "Telegram" },
] as const;

function modeActive(item: AiConclusionItem | null, id: string): boolean {
  if (!item?.modes_used?.length) return false;
  return item.modes_used.some((m) => m.id === id || m.label.toLowerCase() === id);
}

interface AiConclusionSidePanelProps {
  buyerId: number | null | undefined;
  className?: string;
}

export function AiConclusionSidePanel({ buyerId, className = "" }: AiConclusionSidePanelProps) {
  const [item, setItem] = useState<AiConclusionItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!buyerId) {
      setItem(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await client.getBuyerAiConclusion(buyerId);
        if (!cancelled) setItem(data);
      } catch (e) {
        if (!cancelled) {
          setItem(null);
          setError(e instanceof Error ? e.message : "Could not load AI Conclusion");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buyerId]);

  const attentionRequired =
    (item?.management_attention || "").toLowerCase().includes("required") &&
    !(item?.management_attention || "").toLowerCase().startsWith("not");

  return (
    <div
      className={`rounded-3xl border-2 border-violet-500/40 bg-slate-900 shadow-2xl overflow-hidden flex flex-col min-h-0 ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-6 py-4 bg-slate-950/80">
        <h3 className="text-xl font-extrabold tracking-wide text-violet-300">AI Conclusion</h3>
        {item?.stage_label ? (
          <span className="rounded-lg border border-violet-500/40 bg-violet-500/15 px-2.5 py-1 text-[11px] font-bold text-violet-200">
            {item.stage_label}
          </span>
        ) : null}
      </div>

      <div className="px-6 py-5 space-y-5 overflow-y-auto flex-1">
        {loading ? (
          <p className="text-sm text-slate-400 animate-pulse">Building insights…</p>
        ) : error ? (
          <p className="text-sm text-rose-300">{error}</p>
        ) : !item ? (
          <p className="text-sm text-slate-500">No conclusion available for this company.</p>
        ) : (
          <>
            <section className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-violet-300/90">
                Last contact
              </p>
              <p className="text-base font-semibold text-slate-100">
                {item.last_contact_at_display || item.last_contact || "No contact logged"}
              </p>
              {item.last_contact !== item.last_contact_at_display && item.last_contact_at_display ? (
                <p className="text-xs text-slate-500">{item.last_contact}</p>
              ) : null}
              {item.last_contact_mode ? (
                <p className="text-sm text-slate-300">
                  Mode: <span className="font-semibold text-violet-200">{item.last_contact_mode}</span>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-1">
                {ALL_MODES.map((mode) => {
                  const on = modeActive(item, mode.id);
                  return (
                    <span
                      key={mode.id}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold border ${
                        on
                          ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-200"
                          : "border-slate-700/80 bg-slate-950/50 text-slate-600"
                      }`}
                      title={on ? "Used for communication" : "Not used yet"}
                    >
                      {mode.label}
                    </span>
                  );
                })}
              </div>
            </section>

            <section className="space-y-1.5 border-t border-slate-800 pt-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-violet-300/90">
                Last user to contact
              </p>
              <p className="text-base font-semibold text-slate-100">
                {item.last_contact_user || item.responsible_person || "Unknown"}
              </p>
              {item.responsible_person &&
              item.last_contact_user &&
              item.responsible_person !== item.last_contact_user ? (
                <p className="text-xs text-slate-500">Assigned: {item.responsible_person}</p>
              ) : null}
            </section>

            <section className="space-y-2 border-t border-slate-800 pt-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-violet-300/90">
                Management attention
              </p>
              <span
                className={`inline-flex rounded-lg px-2.5 py-1 text-xs font-bold border ${
                  attentionRequired
                    ? "border-amber-500/50 bg-amber-500/20 text-amber-100"
                    : "border-slate-600 bg-slate-800/80 text-slate-300"
                }`}
              >
                {item.management_attention || "Not required"}
              </span>
              <p className="text-sm leading-relaxed text-slate-200">
                {item.management_insight ||
                  `Workspace status: ${item.stage_label || item.buyer_status}. Next: ${item.next_action}`}
              </p>
              <div className="rounded-xl border border-violet-500/25 bg-violet-500/10 px-3 py-2.5 space-y-1">
                <p className="text-[11px] font-bold uppercase tracking-wider text-violet-200">
                  Next steps
                </p>
                <p className="text-sm font-medium text-slate-100">{item.next_action}</p>
                {item.pending_action ? (
                  <p className="text-xs text-slate-400">Pending: {item.pending_action}</p>
                ) : null}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
