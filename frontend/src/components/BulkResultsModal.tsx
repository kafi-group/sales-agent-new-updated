import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { client, type EmailActivityBulkResults } from "../api/client";
import { classifyWhatsAppFailure } from "../utils/whatsappFailure";

interface BulkResultsModalProps {
  eventId: number;
  onClose: () => void;
  onError: (message: string) => void;
  /** Opens the contact (lead profile, where it can be edited). */
  onOpenLead?: (buyerId: number) => void;
}

type StatusFilter = "all" | "sent" | "failed" | "skipped" | "unknown";

const STATUS_STYLE: Record<string, string> = {
  sent: "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-200 border-red-500/30",
  skipped: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  unknown: "bg-slate-500/15 text-slate-300 border-slate-500/30",
};

const STATUS_LABEL: Record<string, string> = {
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
  unknown: "Unknown",
};

export function BulkResultsModal({ eventId, onClose, onError, onOpenLead }: BulkResultsModalProps) {
  const titleId = useId();
  const [data, setData] = useState<EmailActivityBulkResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [reasonFilter, setReasonFilter] = useState<string>("all");

  useEffect(() => {
    let active = true;
    setLoading(true);
    client
      .getEmailActivityBulkResults(eventId)
      .then((res) => {
        if (!active) return;
        setData(res);
        // Open on the problems first when there are any.
        setFilter(res.counts.failed > 0 ? "failed" : "all");
      })
      .catch((e) => {
        if (active) onError(e instanceof Error ? e.message : "Could not load the campaign results");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [eventId, onError]);

  const isWhatsApp = data?.channel === "whatsapp";

  // Failed contacts grouped by reason (WhatsApp only), e.g. "Healthy ecosystem engagement · 3".
  const reasonCounts = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    if (!isWhatsApp) return [] as Array<[string, { label: string; count: number }]>;
    for (const r of data?.results ?? []) {
      if (r.status !== "failed") continue;
      const info = classifyWhatsAppFailure(r.message);
      const cur = map.get(info.key);
      map.set(info.key, { label: info.label, count: (cur?.count ?? 0) + 1 });
    }
    return Array.from(map.entries());
  }, [data, isWhatsApp]);

  const rows = useMemo(() => {
    const all = data?.results ?? [];
    const byStatus = filter === "all" ? all : all.filter((r) => r.status === filter);
    if (reasonFilter === "all" || !isWhatsApp) return byStatus;
    return byStatus.filter(
      (r) => r.status === "failed" && classifyWhatsAppFailure(r.message).key === reasonFilter,
    );
  }, [data, filter, reasonFilter, isWhatsApp]);

  const chips: Array<[StatusFilter, string, number]> = data
    ? [
        ["all", "All", data.results.length],
        ["sent", "Sent", data.counts.sent],
        ["failed", "Failed", data.counts.failed],
        ["skipped", "Skipped", data.counts.skipped],
        ...(data.counts.unknown > 0 ? ([["unknown", "Unknown", data.counts.unknown]] as Array<[StatusFilter, string, number]>) : []),
      ]
    : [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-medium text-slate-100 truncate">
              {data?.title || "Campaign results"}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Per-contact results — open any contact to correct its phone number or details.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-2.5 py-1 rounded-md text-xs border border-slate-700 text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        </div>

        <div className="px-5 pt-3 flex flex-wrap items-center gap-2">
          {chips.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setFilter(key);
                setReasonFilter("all");
              }}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                filter === key
                  ? "bg-slate-100 text-slate-900 border-slate-100"
                  : "border-slate-700 text-slate-300 hover:bg-slate-800"
              }`}
            >
              {label} · {count}
            </button>
          ))}
        </div>

        {filter === "failed" && reasonCounts.length > 0 ? (
          <div className="px-5 pt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">Reason</span>
            <button
              type="button"
              onClick={() => setReasonFilter("all")}
              className={`px-2.5 py-0.5 rounded-full text-xs border ${
                reasonFilter === "all"
                  ? "bg-red-200 text-red-950 border-red-200"
                  : "border-red-500/30 text-red-200 hover:bg-red-950/40"
              }`}
            >
              All failed · {data?.counts.failed ?? 0}
            </button>
            {reasonCounts.map(([key, info]) => (
              <button
                key={key}
                type="button"
                onClick={() => setReasonFilter(key)}
                className={`px-2.5 py-0.5 rounded-full text-xs border ${
                  reasonFilter === key
                    ? "bg-red-200 text-red-950 border-red-200"
                    : "border-red-500/30 text-red-200 hover:bg-red-950/40"
                }`}
              >
                {info.label} · {info.count}
              </button>
            ))}
          </div>
        ) : null}

        {data?.reconstructed ? (
          <p className="mx-5 mt-3 rounded-lg border border-amber-500/20 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/90">
            This send was made before per-contact results were saved, so this list was rebuilt from
            the messages created during that campaign. New bulk sends save the exact results.
          </p>
        ) : null}

        <div className="px-5 py-3 overflow-y-auto min-h-[120px]">
          {loading ? (
            <p className="text-sm text-slate-400">Loading results…</p>
          ) : !data || data.results.length === 0 ? (
            <p className="text-sm text-slate-400">
              No per-contact detail is available for this event.
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing in this filter.</p>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {rows.map((row, idx) => (
                <li key={`${row.buyer_id ?? "x"}-${idx}`} className="py-2.5 flex items-start gap-3">
                  <span
                    className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-full text-[11px] border ${
                      STATUS_STYLE[row.status] || STATUS_STYLE.unknown
                    }`}
                  >
                    {STATUS_LABEL[row.status] || row.status}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-100 truncate">
                      {row.company_name || row.email || "Unknown company"}
                    </p>
                    <p className="text-xs text-slate-400 truncate">
                      {[row.contact_name, row.phone || row.email].filter(Boolean).join(" · ") ||
                        "No contact details on record"}
                    </p>
                    {row.message ? (
                      <p
                        className={`text-xs mt-0.5 ${
                          row.status === "failed" ? "text-red-300/90" : "text-slate-500"
                        }`}
                      >
                        {row.message}
                      </p>
                    ) : null}
                    {isWhatsApp && row.status === "failed"
                      ? (() => {
                          const info = classifyWhatsAppFailure(row.message);
                          return (
                            <p className="text-xs mt-1 text-slate-400">
                              <span className="inline-block mr-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-red-200">
                                {info.label}
                              </span>
                              {info.hint}
                            </p>
                          );
                        })()
                      : null}
                  </div>
                  {row.buyer_id != null && onOpenLead ? (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenLead(row.buyer_id as number);
                        onClose();
                      }}
                      className="shrink-0 px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-medium text-white"
                      title="Open this contact to edit it"
                    >
                      Open contact
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
