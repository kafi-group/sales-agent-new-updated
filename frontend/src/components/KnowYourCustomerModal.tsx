import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LeadTableRow } from "../api/client";
import { AiConclusionSidePanel } from "./AiConclusionSidePanel";

export function KnowYourCustomerDetail({ row }: { row: LeadTableRow }) {
  const contactName = row.contact_name?.trim() || "";
  const designation =
    (
      row.contact_designation ||
      (row as unknown as { designation?: string }).designation
    )?.trim() || "";
  const phone = (row.contact_phone || row.contact_primary_phone)?.trim() || "";
  const secondaryPhone =
    (row.contact_secondary_mobile || row.contact_secondary_phone)?.trim() || "";
  const email = row.contact_email?.trim() || "";
  const secondaryEmail = row.contact_secondary_email?.trim() || "";

  return (
    <div className="space-y-6 text-left">
      <div className="rounded-2xl border border-emerald-500/40 bg-slate-950/90 p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">👤</span>
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Primary Contact Person
            </span>
          </div>
          {designation ? (
            <span className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 text-xs font-semibold text-emerald-300">
              {designation}
            </span>
          ) : null}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Contact Name
            </label>
            <p className="text-xl font-bold text-slate-100 mt-0.5">
              {contactName || "General Contact / Not specified"}
            </p>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Designation / Role
            </label>
            <p className="text-lg font-semibold text-emerald-300 mt-0.5">
              {designation || "Not specified"}
            </p>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Primary Mobile Number
            </label>
            <p className="text-base font-mono font-bold text-sky-400 mt-0.5">
              {phone || "—"}
            </p>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Secondary Mobile / Phone
            </label>
            <p className="text-base font-mono font-medium text-slate-300 mt-0.5">
              {secondaryPhone || "—"}
            </p>
          </div>

          <div className="sm:col-span-2">
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Email Address
            </label>
            <p className="text-sm font-medium text-slate-200 mt-0.5">
              {email || "—"} {secondaryEmail ? `· ${secondaryEmail}` : ""}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 space-y-3">
        <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
          <span className="text-xl">🏢</span>
          <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Company & Market Information
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-xs text-slate-400 block">Country / Location</span>
            <span className="font-semibold text-slate-200">
              {[row.city, row.country].filter(Boolean).join(", ") || "—"}
            </span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">Business Type / Industry</span>
            <span className="font-semibold text-slate-200">{row.industry || "—"}</span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">Company Grading</span>
            <span className="font-semibold text-amber-300">{row.company_grading || "—"}</span>
          </div>
          {row.product_interest ? (
            <div className="col-span-2 sm:col-span-3">
              <span className="text-xs text-slate-400 block">Product interest</span>
              <span className="font-semibold text-emerald-300">{row.product_interest}</span>
            </div>
          ) : null}
          {row.website_url ? (
            <div className="col-span-2 sm:col-span-3">
              <span className="text-xs text-slate-400 block">Website</span>
              <a
                href={
                  row.website_url.startsWith("http")
                    ? row.website_url
                    : `https://${row.website_url}`
                }
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline break-all"
              >
                {row.website_url}
              </a>
            </div>
          ) : null}
        </div>
      </div>

      {row.score_reasoning ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-5 space-y-2">
          <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
            <span className="text-lg">🤖</span>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
              AI Research & Scoring Notes
            </span>
          </div>
          <p className="text-sm sm:text-base leading-relaxed text-slate-200 break-words whitespace-pre-wrap">
            {row.score_reasoning}
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface KnowYourCustomerModalProps {
  open: boolean;
  onClose: () => void;
  companyName?: string | null;
  row: LeadTableRow | null;
  /** When set, show AI Conclusion panel beside KYC. */
  buyerId?: number | null;
  loading?: boolean;
  error?: string | null;
  footer?: ReactNode;
}

export function KnowYourCustomerModal({
  open,
  onClose,
  companyName,
  row,
  buyerId = null,
  loading = false,
  error = null,
  footer,
}: KnowYourCustomerModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const titleName = row?.company_name || companyName || "Customer";
  const resolvedBuyerId = buyerId ?? row?.id ?? null;
  const showAi = Boolean(resolvedBuyerId);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-md"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`w-full ${showAi ? "max-w-6xl" : "max-w-4xl"} flex flex-col lg:flex-row gap-4 max-h-[92vh]`}
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Know Your Customer"
          className="flex-1 min-w-0 rounded-3xl border-2 border-emerald-500/40 bg-slate-900 shadow-2xl overflow-hidden flex flex-col"
        >
          <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-6 sm:px-8 py-4 sm:py-5 bg-slate-950/80 shrink-0">
            <h3 className="text-xl sm:text-2xl font-extrabold tracking-wide text-emerald-400">
              Know Your Customer
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-5 py-2.5 text-base font-bold text-slate-200 hover:bg-slate-800 hover:text-white bg-slate-800/80 border border-slate-700 transition"
            >
              Close
            </button>
          </div>
          <div className="px-6 sm:px-8 py-6 sm:py-8 overflow-y-auto space-y-6 flex-1">
            <h4 className="text-base font-semibold text-slate-300">{titleName}</h4>
            {loading ? (
              <p className="text-sm text-slate-400">Loading customer profile…</p>
            ) : error ? (
              <p className="text-sm text-rose-300">{error}</p>
            ) : row ? (
              <KnowYourCustomerDetail row={row} />
            ) : (
              <p className="text-sm text-slate-500">No profile details available.</p>
            )}
            {footer}
          </div>
        </div>

        {showAi ? (
          <AiConclusionSidePanel
            buyerId={resolvedBuyerId}
            className="w-full lg:w-[380px] xl:w-[420px] shrink-0 max-h-[50vh] lg:max-h-[92vh]"
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
