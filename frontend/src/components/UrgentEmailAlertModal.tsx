import { useMemo, useState } from "react";
import type { UrgentEmailItem } from "../api/client";

interface UrgentEmailAlertModalProps {
  urgentEmails: UrgentEmailItem[];
  onOpenAndReply: (email: UrgentEmailItem) => void;
  onDismiss: () => void;
}

export function isGenuineNewInquiry(item: UrgentEmailItem): boolean {
  if (!item) return false;

  const folder = (item.folder || "").toLowerCase();
  if (/(spam|junk|trash|deleted|\bbin\b)/.test(folder)) {
    return false;
  }

  // 1. "Urgent means 1 single email of inquiry or asking quotation."
  // Continuation of conversation must NOT appear in urgent!
  if (item.message_count != null && item.message_count > 1) {
    return false;
  }

  const subj = (item.subject || "").toLowerCase().trim();
  const from = `${item.from_name || ""} ${item.from_email || ""}`.toLowerCase().trim();
  const prev = (item.preview || "").toLowerCase().trim();
  const fullText = `${subj} ${prev}`;

  // 2. Exclude all automated bounces, mailer daemons, delivery failures
  const bounceTerms = [
    "mailer-daemon",
    "mail delivery",
    "delivery failed",
    "delivery failure",
    "undeliver",
    "failure notice",
    "postmaster",
    "returned message",
    "returning message to sender",
    "hostnsurf",
    "no-reply",
    "noreply",
    "auto-reply",
    "automatic reply",
    "out of office",
    "security alert",
    "verify your",
    "newsletter",
    "notification@",
    "notifications@",
    "alert@",
  ];
  if (bounceTerms.some((term) => from.includes(term) || subj.includes(term))) {
    return false;
  }

  // 3. Exclude HR / job applicants / resumes
  const hrTerms = [
    "indeed",
    "job application",
    "resume",
    "curriculum vitae",
    "cv",
    "applying for",
    "vacancy",
    "hiring",
    "candidate",
    "interview",
    "application for",
  ];
  if (hrTerms.some((term) => subj.includes(term) || from.includes(term))) {
    return false;
  }

  // 4. Exclude banking / statements / payments / receipts
  const financeTerms = [
    "mt103",
    "mt 103",
    "swift transfer",
    "bank statement",
    "remittance",
    "payment confirmation",
    "payment receipt",
    "receipt of payment",
  ];
  if (financeTerms.some((term) => fullText.includes(term))) {
    return false;
  }

  // 5. Must explicitly be an inquiry asking for quotation, price, rates, order, or products
  const inquiryTerms = [
    "quotation",
    "quote",
    "pricing",
    "price list",
    "rate list",
    "rates",
    "rfq",
    "price inquiry",
    "price enquiry",
    "c&f",
    "cnf",
    "fob",
    "order inquiry",
    "order enquiry",
    "purchase order",
    "place order",
    "placing order",
    "confirm order",
    "order requirement",
    "buying requirement",
    "want to buy",
    "looking to buy",
    "inquiry",
    "enquiry",
    "specification",
    "sample request",
    "catalogue request",
    "catalog request",
    "can you provide",
    "can you supply",
    "please quote",
    "interested in purchasing",
    "interested to buy",
  ];

  return inquiryTerms.some((term) => fullText.includes(term));
}

export function UrgentEmailAlertModal({
  urgentEmails,
  onOpenAndReply,
  onDismiss,
}: UrgentEmailAlertModalProps) {
  const [selectedUserFilter, setSelectedUserFilter] = useState<string>("all");
  const [currentIndex, setCurrentIndex] = useState(0);

  // Filter incoming emails strictly for genuine new single-email inquiries
  const genuineInquiries = useMemo(() => {
    return (urgentEmails || []).filter(isGenuineNewInquiry);
  }, [urgentEmails]);

  // Group emails by mailbox (marketing / info / essence) when available
  const userCategories = useMemo(() => {
    const map = new Map<string, { label: string; email: string; count: number }>();
    for (const item of genuineInquiries) {
      const mailbox = (item.mailbox_email || "").trim().toLowerCase();
      const key = mailbox || (item.user_id ? String(item.user_id) : "default");
      const label =
        item.mailbox_email ||
        item.user_full_name ||
        item.user_name ||
        "My Inbox";
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, { label, email: item.mailbox_email || "", count: 1 });
      }
    }
    return Array.from(map.entries()).map(([key, data]) => ({
      key,
      ...data,
    }));
  }, [genuineInquiries]);

  // Filtered list based on selected category pill
  const filteredList = useMemo(() => {
    if (selectedUserFilter === "all") return genuineInquiries;
    return genuineInquiries.filter((item) => {
      const mailbox = (item.mailbox_email || "").trim().toLowerCase();
      const key = mailbox || (item.user_id ? String(item.user_id) : "default");
      return key === selectedUserFilter;
    });
  }, [genuineInquiries, selectedUserFilter]);

  if (!genuineInquiries || genuineInquiries.length === 0) return null;

  const activeIndex = Math.min(currentIndex, Math.max(0, filteredList.length - 1));
  const currentEmail = filteredList[activeIndex] || filteredList[0] || genuineInquiries[0];
  const totalInFilter = filteredList.length;
  const globalTotal = genuineInquiries.length;

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-5 animate-in fade-in duration-200">
      <div className="relative w-[92vw] max-w-5xl max-h-[92vh] rounded-2xl border-2 border-red-500 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-5 sm:p-6 shadow-2xl shadow-red-950/90 text-slate-100 space-y-3 sm:space-y-3.5">
        
        {/* Glow Header */}
        <div className="flex items-center justify-between border-b border-red-500/30 pb-2.5">
          <div className="flex items-center gap-3.5">
            <div className="relative flex h-11 w-11 sm:h-12 sm:w-12 shrink-0 items-center justify-center rounded-xl bg-red-600/25 border border-red-500 text-2xl sm:text-3xl shadow-lg shadow-red-600/50">
              <span className="animate-bounce">🚨</span>
              <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500"></span>
              </span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-lg sm:text-xl font-black text-red-100 tracking-wide">
                  NEW INQUIRY EMAIL REQUIRES REPLY
                </h2>
                {globalTotal > 1 && (
                  <span className="rounded-full bg-red-600 px-3 py-0.5 text-xs font-black text-white shadow-md shadow-red-600/50">
                    {activeIndex + 1} of {totalInFilter} {selectedUserFilter !== "all" ? `(Total ${globalTotal})` : ""}
                  </span>
                )}
              </div>
              <p className="text-xs text-red-300/90 mt-0.5 font-medium">
                New inquiry email from prospect/buyer awaiting your response. Alert remains active until an email reply is sent.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-slate-400 hover:text-white p-1.5 rounded-xl hover:bg-slate-800 transition text-xl cursor-pointer"
            title="Dismiss for current session"
          >
            ✕
          </button>
        </div>

        {/* User Category Filter Tabs (For Admin & Multi-User Breakdown) */}
        {userCategories.length > 1 && (
          <div className="space-y-1.5 rounded-xl bg-slate-900/90 border border-slate-800 p-2.5 sm:p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-extrabold uppercase tracking-wider text-slate-300">
                Filter by Assigned Sales Profile / Mailbox:
              </span>
              <span className="text-slate-400 font-medium">
                {userCategories.length} user mailboxes active
              </span>
            </div>
            <div className="flex flex-wrap gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => {
                  setSelectedUserFilter("all");
                  setCurrentIndex(0);
                }}
                className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-2 cursor-pointer ${
                  selectedUserFilter === "all"
                    ? "bg-red-600 text-white shadow-md shadow-red-600/50 border border-red-300"
                    : "bg-slate-800/90 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700"
                }`}
              >
                <span>👥 All Profiles</span>
                <span className="rounded-full bg-black/60 px-2 py-0.2 text-xs font-mono font-bold">
                  {globalTotal}
                </span>
              </button>

              {userCategories.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => {
                    setSelectedUserFilter(cat.key);
                    setCurrentIndex(0);
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition flex items-center gap-2 cursor-pointer ${
                    selectedUserFilter === cat.key
                      ? "bg-amber-600 text-white shadow-md shadow-amber-600/50 border border-amber-300 font-bold"
                      : "bg-slate-800/90 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700"
                  }`}
                >
                  <span>👤 {cat.label}</span>
                  {cat.email && (
                    <span className="text-[11px] opacity-75 hidden md:inline font-mono">
                      ({cat.email})
                    </span>
                  )}
                  <span className="rounded-full bg-black/60 px-2 py-0.2 text-xs font-mono font-bold">
                    {cat.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Assigned Rep & Mailbox Information Banner */}
        <div className="flex flex-wrap items-center justify-between rounded-xl bg-slate-800/90 border border-slate-700/80 px-4 py-2 text-xs sm:text-sm gap-2">
          <div className="flex flex-wrap items-center gap-2.5 text-slate-200">
            <span className="text-amber-400 font-bold">👤 Assigned User:</span>
            <span className="font-extrabold text-white">
              {currentEmail.user_full_name || currentEmail.user_name || "Sales Agent"}
            </span>
            {currentEmail.mailbox_email && (
              <span className="text-slate-300">
                · 📬 <code className="text-sky-300 bg-sky-950/80 px-2 py-0.5 rounded-lg border border-sky-700/60 font-mono text-xs">{currentEmail.mailbox_email}</code>
              </span>
            )}
          </div>
          <span className="text-xs text-slate-300 font-medium">
            Status: <span className="text-rose-400 font-bold uppercase tracking-wider">Awaiting Immediate Response</span>
          </span>
        </div>

        {/* Overdue Alert Banner */}
        <div className="flex items-center justify-between rounded-xl bg-red-950/85 border border-red-600/80 px-4 py-2 shadow-inner">
          <div className="flex items-center gap-2.5 text-xs sm:text-sm font-black text-red-100">
            <span className="text-base sm:text-lg">⚠️</span>
            <span>
              {currentEmail.days_ago > 0
                ? `Received ${currentEmail.days_ago} ${currentEmail.days_ago === 1 ? "day" : "days"} ago (${currentEmail.hours_ago} hrs) — OVERDUE FOR REPLY!`
                : `Received ${currentEmail.hours_ago} hours ago — Immediate Response Needed`}
            </span>
          </div>
          <span className="text-[11px] font-mono font-black px-2.5 py-0.5 rounded-lg bg-red-900 border border-red-500 text-red-100 uppercase tracking-wider">
            {currentEmail.inquiry_type || currentEmail.triage_label || "New Inquiry"}
          </span>
        </div>

        {/* Email Details Card */}
        <div className="rounded-xl border border-slate-700/80 bg-slate-900/95 p-3.5 sm:p-4 space-y-2.5 shadow-xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs sm:text-sm">
            <div>
              <span className="block text-[11px] uppercase font-bold text-slate-400 mb-0.5 tracking-wider">
                Sender / Client Name &amp; Email
              </span>
              <span className="font-extrabold text-slate-100 text-base sm:text-lg block leading-snug">
                {currentEmail.from_name || currentEmail.from_email}
              </span>
              {currentEmail.from_name && (
                <span className="text-sky-300 text-xs truncate block font-mono">
                  &lt;{currentEmail.from_email}&gt;
                </span>
              )}
            </div>

            <div>
              <span className="block text-[11px] uppercase font-bold text-slate-400 mb-0.5 tracking-wider">
                Date &amp; Time Received
              </span>
              <span className="text-slate-200 text-xs sm:text-sm font-semibold block mt-0.5">
                {currentEmail.latest_date
                  ? new Date(currentEmail.latest_date).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "Recent"}
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800">
            <span className="block text-[11px] uppercase font-bold text-slate-400 mb-1 tracking-wider">
              Subject Line
            </span>
            <div className="text-sm sm:text-base font-black text-emerald-300 flex flex-wrap items-center gap-2">
              <span className="px-2 py-0.5 rounded-lg bg-red-950 text-red-200 border border-red-600 text-[11px] font-black tracking-wide">
                {currentEmail.inquiry_type || "🚨 INQUIRY AWAITING REPLY"}
              </span>
              <span className="truncate">{currentEmail.subject}</span>
            </div>
          </div>

          {/* Description of what the inquiry is about */}
          {currentEmail.inquiry_description && (
            <div className="pt-2 border-t border-slate-800">
              <span className="block text-[11px] uppercase font-bold text-amber-400 mb-1 tracking-wider flex items-center gap-1.5">
                <span>📋</span>
                <span>Inquiry Summary &amp; Requirement:</span>
              </span>
              <div className="text-xs sm:text-sm leading-relaxed text-amber-100 bg-amber-950/40 p-2.5 sm:p-3 rounded-xl border border-amber-500/40 font-medium shadow-inner">
                {currentEmail.inquiry_description}
              </div>
            </div>
          )}

          {currentEmail.preview && (
            <div className="pt-2 border-t border-slate-800">
              <span className="block text-[11px] uppercase font-bold text-slate-400 mb-1 tracking-wider">
                Message Preview
              </span>
              <p className="text-xs sm:text-sm leading-relaxed text-slate-200 bg-slate-950/90 p-2.5 sm:p-3 rounded-xl border border-slate-800 font-sans line-clamp-3 shadow-inner">
                {currentEmail.preview}
              </p>
            </div>
          )}
        </div>

        {/* Carousel pagination if multiple */}
        {totalInFilter > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-slate-200 px-1">
            <button
              type="button"
              disabled={activeIndex === 0}
              onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-bold flex items-center gap-1.5 border border-slate-600 shadow-sm cursor-pointer text-xs"
            >
              ← Previous
            </button>
            <span className="font-bold text-slate-200 text-xs sm:text-sm">
              Showing {activeIndex + 1} of {totalInFilter} urgent enquiries
            </span>
            <button
              type="button"
              disabled={activeIndex === totalInFilter - 1}
              onClick={() => setCurrentIndex((prev) => Math.min(totalInFilter - 1, prev + 1))}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-bold flex items-center gap-1.5 border border-slate-600 shadow-sm cursor-pointer text-xs"
            >
              Next →
            </button>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2.5 border-t border-slate-800">
          <p className="text-[11px] sm:text-xs text-slate-400 italic">
            * Alert re-appears on login/refresh until an email reply is sent.
          </p>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              type="button"
              onClick={onDismiss}
              className="flex-1 sm:flex-none px-4 sm:px-5 py-2 rounded-xl border border-slate-600 bg-slate-800/90 hover:bg-slate-700 text-xs sm:text-sm font-bold text-slate-200 transition cursor-pointer"
            >
              Dismiss For Now
            </button>
            <button
              type="button"
              onClick={() => onOpenAndReply(currentEmail)}
              className="flex-1 sm:flex-none px-5 sm:px-7 py-2 rounded-xl bg-gradient-to-r from-red-600 via-rose-600 to-red-600 hover:from-red-500 hover:to-rose-500 text-xs sm:text-sm font-black text-white shadow-xl shadow-red-600/50 flex items-center justify-center gap-2 transition cursor-pointer scale-100 hover:scale-102"
            >
              <span>✉️ Open &amp; Reply Now</span>
              <span>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
