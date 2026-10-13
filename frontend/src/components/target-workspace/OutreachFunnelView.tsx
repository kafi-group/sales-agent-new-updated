import React, { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { CallLeadButton } from "../CallLeadButton";
import { CallRecommendationBadge } from "../CallRecommendationBadge";
import { ClientHistoryPanel } from "../ClientHistoryPanel";
import { KnowYourCustomerModal } from "../KnowYourCustomerModal";
import { IconX } from "../icons/AppIcons";
import { BulkWhatsAppModal } from "../BulkWhatsAppModal";
import type { WhatsAppComposeTarget } from "../WhatsAppComposeLink";
import {
  LeadTelegramComposeModal,
  type TelegramComposeTarget,
} from "../TelegramComposeLink";
import { WhatsAppProofModal } from "./WhatsAppProofModal";
import { pushNumberToFloatingDialpad } from "../../utils/dialpadEvents";
import {
  client,
  type WorkspaceLeadItem,
  type WorkspaceLeadPhone,
  type DayCountryTarget,
  type WorkspaceReviewOptionItem,
  type AppUser,
  type LeadTableRow,
} from "../../api/client";

const DAYS_OF_WEEK = [
  { id: "monday", label: "Monday" },
  { id: "tuesday", label: "Tuesday" },
  { id: "wednesday", label: "Wednesday" },
  { id: "thursday", label: "Thursday" },
  { id: "friday", label: "Friday" },
  { id: "saturday", label: "Saturday" },
  { id: "sunday", label: "Sunday" },
];

interface OutreachFunnelViewProps {
  currentUser: AppUser | null;
  isAdmin: boolean;
  selectedDay: string;
  onSelectDay: (day: string) => void;
  /** Active Master List scope (fmcg / minerals_ores / other_items). */
  masterType?: string;
  onOpenCall?: (phone: string, companyName: string, leadId?: number) => void;
  onOpenEmailComposer?: (email: string, companyName: string, contactName?: string) => void;
  /** Jump to Assigned/Master table in edit mode for this lead. */
  onEditLead?: (leadId: number, companyName: string) => void;
  onError?: (message: string) => void;
}

function workspaceLeadPhones(lead: WorkspaceLeadItem): WorkspaceLeadPhone[] {
  if (Array.isArray(lead.phones) && lead.phones.length > 0) {
    return lead.phones;
  }
  if (lead.primary_phone?.trim()) {
    return [
      {
        index: 1,
        select_label: "#1",
        number: lead.primary_phone.trim(),
        field_label: "Primary phone",
        contact_id: lead.contact_id ?? null,
        contact_name: lead.contact_person,
      },
    ];
  }
  return [];
}

function workspaceLeadAsComposeRow(lead: WorkspaceLeadItem): LeadTableRow {
  return {
    id: lead.id,
    company_name: lead.company_name,
    contact_name: lead.contact_person,
    contact_id: lead.contact_id ?? null,
    contact_phone: lead.primary_phone,
    contact_email: lead.primary_email,
    country: lead.country,
  } as LeadTableRow;
}

function workspaceLeadAsKycRow(lead: WorkspaceLeadItem): LeadTableRow {
  const phones = workspaceLeadPhones(lead);
  const primary = phones[0]?.number || lead.primary_phone || null;
  const secondary = phones[1]?.number || null;
  return {
    id: lead.id,
    company_name: lead.company_name,
    country: lead.country,
    city: lead.city,
    industry: lead.industry ?? null,
    website_url: lead.website_url ?? null,
    company_grading: lead.company_grading ?? null,
    product_interest: lead.product_interest,
    contact_id: lead.contact_id ?? phones[0]?.contact_id ?? null,
    contact_name: lead.contact_person || phones[0]?.contact_name || null,
    contact_designation: lead.designation,
    contact_phone: primary,
    contact_primary_phone: primary,
    contact_secondary_phone: secondary,
    contact_secondary_mobile: secondary,
    contact_email: lead.primary_email,
    contact_secondary_email: null,
    remarks: lead.remarks ?? null,
    call_remarks: null,
    assigned_to: lead.assigned_to_name || "",
    assigned_to_user_id: lead.assigned_to_user_id,
    follow_up_at: null,
    created_at: "",
    latest_score: null,
    score_reasoning: null,
    scored_at: null,
    call_recommended: lead.call_recommended ?? null,
    call_local_time: lead.call_local_time ?? null,
    call_timezone: null,
    call_reason: lead.call_reason ?? null,
    linkedin_company_url: null,
    facebook_company_url: null,
    instagram_company_url: null,
    source: null,
    legacy_serial_no: null,
    address: null,
    market_role: null,
    market_role_reasoning: null,
    producer_tier: null,
    producer_conversion_pct: null,
    producer_tier_reasoning: null,
  };
}

export const OutreachFunnelView: React.FC<OutreachFunnelViewProps> = ({
  currentUser,
  isAdmin,
  selectedDay,
  onSelectDay,
  masterType = "fmcg",
  onOpenCall: _onOpenCall,
  onOpenEmailComposer,
  onEditLead,
  onError,
}) => {
  const [selectedStage, setSelectedStage] = useState<string>("fresh");
  const [targetCountries, setTargetCountries] = useState<DayCountryTarget[]>([]);
  const [leads, setLeads] = useState<WorkspaceLeadItem[]>([]);
  const [counts, setCounts] = useState({ fresh: 0, needs_follow_up: 0, not_interested: 0, no_response: 0, total: 0 });
  const [reviewOptions, setReviewOptions] = useState<WorkspaceReviewOptionItem[]>([]);
  const [newCountryInput, setNewCountryInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [countryMenuOpen, setCountryMenuOpen] = useState(false);
  const countryMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [proofModalLead, setProofModalLead] = useState<WorkspaceLeadItem | null>(null);
  const [remarksLead, setRemarksLead] = useState<WorkspaceLeadItem | null>(null);
  const [kycLead, setKycLead] = useState<WorkspaceLeadItem | null>(null);
  const [kycRow, setKycRow] = useState<LeadTableRow | null>(null);
  const [kycLoading, setKycLoading] = useState(false);
  const [kycError, setKycError] = useState<string | null>(null);
  const [whatsappTarget, setWhatsappTarget] = useState<WhatsAppComposeTarget | null>(null);
  const [telegramTarget, setTelegramTarget] = useState<TelegramComposeTarget | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  /** leadId -> selected phone number for Call / WhatsApp */
  const [selectedPhoneByLead, setSelectedPhoneByLead] = useState<Record<number, string>>({});

  // Quick action states for changing reasons inline
  const [editingLeadId, setEditingLeadId] = useState<number | null>(null);
  const [inlineReason, setInlineReason] = useState("");
  const [inlineAction, setInlineAction] = useState("call");
  const [inlineRemarks, setInlineRemarks] = useState("");

  useEffect(() => {
    if (!remarksLead) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRemarksLead(null);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [remarksLead]);

  const currentFormattedDate = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }, []);

  // Load target countries and review options
  const loadTargetsAndOptions = async () => {
    try {
      const [targetsRes, optionsRes] = await Promise.all([
        client.getTargetWorkspaceTargets(selectedDay),
        client.getWorkspaceReviewOptions(),
      ]);
      setTargetCountries(targetsRes.targets);
      setReviewOptions(optionsRes.options);
    } catch (err: any) {
      console.error("Failed to load targets/options:", err);
    }
  };

  // Load leads based on selected day, stage, country, and search
  const loadLeads = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await client.getWorkspaceLeads({
        day: selectedDay,
        stage: selectedStage,
        country: selectedCountries.length > 0 ? selectedCountries.join(",") : undefined,
        search: searchQuery.trim() || undefined,
        master_type: masterType || "fmcg",
        user_id: isAdmin ? undefined : currentUser?.id,
        limit: 100,
      });
      setLeads(res.leads);
      setCounts(res.counts);
    } catch (err: any) {
      setError(err?.message || "Failed to load workspace leads.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadTargetsAndOptions();
  }, [selectedDay]);

  useEffect(() => {
    const allowed = new Set(targetCountries.map((t) => t.country));
    setSelectedCountries((prev) => prev.filter((c) => allowed.has(c)));
  }, [targetCountries]);

  useEffect(() => {
    loadLeads();
  }, [selectedDay, selectedStage, selectedCountries, searchQuery, masterType]);

  useEffect(() => {
    if (!countryMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!countryMenuRef.current?.contains(event.target as Node)) {
        setCountryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [countryMenuOpen]);

  const toggleCountry = (country: string) => {
    setSelectedCountries((prev) =>
      prev.includes(country) ? prev.filter((c) => c !== country) : [...prev, country],
    );
  };

  async function openKnowYourCustomer(lead: WorkspaceLeadItem) {
    setKycLead(lead);
    setKycRow(workspaceLeadAsKycRow(lead));
    setKycLoading(true);
    setKycError(null);
    try {
      const res = await client.listLeadsTable({
        q: lead.company_name,
        page: 1,
        page_size: 50,
        master_type: masterType || "fmcg",
        all_contacts: true,
      });
      const match =
        res.rows.find((row) => row.id === lead.id) ||
        res.rows.find(
          (row) =>
            row.company_name.trim().toLowerCase() === lead.company_name.trim().toLowerCase(),
        );
      if (match) {
        setKycRow(match);
      }
    } catch {
      // Workspace card already seeded a usable fallback profile.
    } finally {
      setKycLoading(false);
    }
  }

  function closeKnowYourCustomer() {
    setKycLead(null);
    setKycRow(null);
    setKycError(null);
    setKycLoading(false);
  }

  const countryFilterLabel = useMemo(() => {
    if (selectedCountries.length === 0) {
      return `All Target Countries (${targetCountries.length})`;
    }
    if (selectedCountries.length === 1) return selectedCountries[0];
    return `${selectedCountries.length} countries selected`;
  }, [selectedCountries, targetCountries.length]);

  // Add country target
  const handleAddCountry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCountryInput.trim()) return;
    try {
      await client.addDayCountryTarget({
        day_of_week: selectedDay,
        country: newCountryInput.trim(),
      });
      setNewCountryInput("");
      await loadTargetsAndOptions();
      await loadLeads();
    } catch (err: any) {
      alert(err?.message || "Failed to add country target.");
    }
  };

  // Remove country target
  const handleRemoveCountry = async (targetId: number) => {
    if (!confirm("Remove this country from today's target?")) return;
    try {
      await client.removeDayCountryTarget(targetId);
      await loadTargetsAndOptions();
      await loadLeads();
    } catch (err: any) {
      alert(err?.message || "Failed to remove country target.");
    }
  };

  // Update lead stage
  const handleUpdateStage = async (
    buyerId: number,
    newStage: string,
    extra: Partial<{
      not_interested_reason: string;
      not_interested_remarks: string;
      follow_up_reason: string;
      follow_up_action: string;
      whatsapp_call_tried: boolean;
      whatsapp_call_proof: string;
      searched_internet_email: boolean;
      searched_internet_phone: boolean;
      linkedin_request_sent: boolean;
      linkedin_msg_sent: boolean;
    }> = {}
  ) => {
    try {
      await client.updateWorkspaceLeadStatus({
        buyer_id: buyerId,
        stage: newStage,
        ...extra,
      });
      setEditingLeadId(null);
      await loadLeads();
    } catch (err: any) {
      alert(err?.message || "Failed to update lead stage.");
    }
  };

  // Handle WhatsApp Proof Save
  const handleSaveWhatsAppProof = async (data: {
    buyer_id: number;
    whatsapp_call_tried: boolean;
    whatsapp_call_proof: string;
  }) => {
    await client.updateWorkspaceLeadStatus({
      buyer_id: data.buyer_id,
      stage: "no_response",
      whatsapp_call_tried: data.whatsapp_call_tried,
      whatsapp_call_proof: data.whatsapp_call_proof,
    });
    await loadLeads();
  };

  // Filter options by category
  const followUpOptions = reviewOptions.filter(
    (o) => o.category === "follow_up" || o.category === "follow_up_reason"
  );
  const notInterestedOptions = reviewOptions.filter(
    (o) => o.category === "not_interested" || o.category === "not_interested_reason"
  );

  return (
    <div className="space-y-6">
      {/* ── Day & Target Countries Header Bar ── */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">📅</span>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Daily Sales Target & Country Workspace
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {selectedDay.toUpperCase()}
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-200 border border-slate-600">
                {masterType === "minerals_ores"
                  ? "Minerals & Ores"
                  : masterType === "other_items"
                    ? "Other Items"
                    : "Master FMCG"}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Active schedule: <strong className="text-slate-200">{currentFormattedDate}</strong> • Assigned targets & active outreach lifecycle
            </p>
          </div>

          {/* Day Selector Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto bg-slate-950 p-1.5 rounded-xl border border-slate-800">
            {DAYS_OF_WEEK.map((day) => {
              const isSelected = selectedDay.toLowerCase() === day.id;
              return (
                <button
                  key={day.id}
                  type="button"
                  onClick={() => {
                    onSelectDay(day.id);
                    setSelectedCountries([]);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap ${
                    isSelected
                      ? "bg-emerald-600 text-white font-semibold shadow-md shadow-emerald-950"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                  }`}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Target Countries for Selected Day */}
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Today's Target Countries:
            </span>
            {targetCountries.length === 0 ? (
              <span className="text-xs text-slate-500 italic">No target countries assigned yet.</span>
            ) : (
              targetCountries.map((tc) => (
                <span
                  key={tc.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-semibold bg-slate-800/90 text-slate-100 border border-slate-700 shadow-sm"
                >
                  <span>🌍 {tc.country}</span>
                  {tc.assigned_user_name && (
                    <span className="text-[10px] text-amber-400 font-normal">
                      ({tc.assigned_user_name})
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveCountry(tc.id)}
                    className="text-slate-500 hover:text-rose-400 transition ml-1"
                    title="Remove country"
                  >
                    ✕
                  </button>
                </span>
              ))
            )}
          </div>

          {/* Quick Add Country Input */}
          <form onSubmit={handleAddCountry} className="flex items-center gap-2">
            <input
              type="text"
              placeholder="+ Add Target Country (e.g. China, Tanzania)..."
              value={newCountryInput}
              onChange={(e) => setNewCountryInput(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 w-64"
            />
            <button
              type="submit"
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold transition"
            >
              Add
            </button>
          </form>
        </div>
      </div>

      {/* ── 4 Outreach Funnel Stage Tabs ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Stage 1: Fresh */}
        <button
          type="button"
          onClick={() => setSelectedStage("fresh")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "fresh"
              ? "bg-gradient-to-br from-emerald-950/60 to-slate-900 border-emerald-500/80 ring-2 ring-emerald-500/20 shadow-lg shadow-emerald-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              1. Fresh / Untouched
            </span>
            <span className="text-lg">🌱</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.fresh}</div>
            <div className="text-[11px] text-slate-400">Never contacted leads in today's countries</div>
          </div>
        </button>

        {/* Stage 2: Needs Follow Up */}
        <button
          type="button"
          onClick={() => setSelectedStage("needs_follow_up")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "needs_follow_up"
              ? "bg-gradient-to-br from-amber-950/60 to-slate-900 border-amber-500/80 ring-2 ring-amber-500/20 shadow-lg shadow-amber-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
              2. Needs Follow Up
            </span>
            <span className="text-lg">🕒</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.needs_follow_up}</div>
            <div className="text-[11px] text-slate-400">Approval pending, callback, quotation needed</div>
          </div>
        </button>

        {/* Stage 3: Not Interested */}
        <button
          type="button"
          onClick={() => setSelectedStage("not_interested")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "not_interested"
              ? "bg-gradient-to-br from-purple-950/60 to-slate-900 border-purple-500/80 ring-2 ring-purple-500/20 shadow-lg shadow-purple-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-purple-400">
              3. Not Interested
            </span>
            <span className="text-lg">💡</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.not_interested}</div>
            <div className="text-[11px] text-slate-400">Objections with Actionable TO DO Strategy</div>
          </div>
        </button>

        {/* Stage 4: No Response */}
        <button
          type="button"
          onClick={() => setSelectedStage("no_response")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "no_response"
              ? "bg-gradient-to-br from-rose-950/60 to-slate-900 border-rose-500/80 ring-2 ring-rose-500/20 shadow-lg shadow-rose-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-rose-400">
              4. No Response / Dead Meter
            </span>
            <span className="text-lg">🔕</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.no_response}</div>
            <div className="text-[11px] text-slate-400">Audit WhatsApp proof & Drip replacement</div>
          </div>
        </button>
      </div>

      {/* ── Search and Secondary Filters ── */}
      {actionNotice ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
          {actionNotice}
        </div>
      ) : null}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Search company, contact person, email, phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:w-80 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
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

        <div className="flex items-center gap-3 self-end sm:self-auto text-xs relative" ref={countryMenuRef}>
          <span className="text-slate-400 font-medium">Filter Country:</span>
          <button
            type="button"
            onClick={() => setCountryMenuOpen((open) => !open)}
            className="min-w-[12rem] max-w-[18rem] truncate text-left bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 hover:border-emerald-500 focus:outline-none focus:border-emerald-500"
            title={
              selectedCountries.length > 0
                ? selectedCountries.join(", ")
                : targetCountries.map((t) => t.country).join(", ")
            }
          >
            {countryFilterLabel}
            <span className="float-right text-slate-500 ml-2">{countryMenuOpen ? "▴" : "▾"}</span>
          </button>
          {countryMenuOpen ? (
            <div className="absolute right-0 top-full mt-1 z-30 w-64 max-h-72 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 shadow-xl p-2 space-y-1">
              <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-900 cursor-pointer text-slate-200">
                <input
                  type="checkbox"
                  checked={selectedCountries.length === 0}
                  onChange={() => setSelectedCountries([])}
                  className="rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                />
                <span>All Target Countries</span>
              </label>
              <div className="border-t border-slate-800 my-1" />
              {targetCountries.map((tc) => {
                const checked = selectedCountries.includes(tc.country);
                return (
                  <label
                    key={tc.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-900 cursor-pointer text-slate-200"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCountry(tc.country)}
                      className="rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                    />
                    <span>{tc.country}</span>
                  </label>
                );
              })}
              {selectedCountries.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSelectedCountries([])}
                  className="w-full mt-1 text-[11px] text-emerald-300 hover:text-emerald-200 px-2 py-1 text-left"
                >
                  Clear selection
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Leads Content Area ── */}
      {isLoading ? (
        <div className="py-20 text-center text-slate-400 flex flex-col items-center gap-2">
          <span className="animate-spin text-2xl">⏳</span>
          <p className="text-xs">Loading target workspace leads...</p>
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs">
          {error}
        </div>
      ) : leads.length === 0 ? (
        <div className="py-16 text-center rounded-2xl border border-slate-800 bg-slate-900/30 p-8">
          <div className="text-3xl mb-2">📋</div>
          <h4 className="text-base font-semibold text-slate-200">No leads in this stage</h4>
          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
            {selectedStage === "fresh"
              ? "All contacts for today's target countries have been engaged. Check 'Needs Follow Up' or 'No Response' to continue outreach."
              : "No contacts are currently in this funnel stage."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {leads.map((lead) => (
            <div
              key={lead.id}
              className={`rounded-2xl border p-4 transition duration-150 ${
                lead.is_dead_lead_meter_red
                  ? "bg-slate-900/90 border-rose-900/80 shadow-md shadow-rose-950/20"
                  : "bg-slate-900/80 border-slate-800/90 hover:border-slate-700"
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                {/* Left Section: Company & Contact details */}
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className="text-base font-bold text-slate-50 tracking-tight">
                      <button
                        type="button"
                        onClick={() => void openKnowYourCustomer(lead)}
                        className="text-left hover:text-emerald-300 hover:underline decoration-emerald-500/50 transition"
                        title="Know Your Customer"
                      >
                        {lead.company_name}
                      </button>
                    </h3>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-800 text-slate-200 border border-slate-600">
                      🌍 {lead.country || "Global"} {lead.city ? `• ${lead.city}` : ""}
                    </span>
                    {lead.product_interest && (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                        📦 {lead.product_interest}
                      </span>
                    )}
                    {lead.assigned_to_name && (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-indigo-950/60 text-indigo-300 border border-indigo-800/60">
                        👤 Rep: {lead.assigned_to_name}
                      </span>
                    )}
                    <CallRecommendationBadge
                      recommended={
                        lead.call_recommended === undefined ? null : lead.call_recommended
                      }
                      localTime={lead.call_local_time ?? null}
                      reason={lead.call_reason ?? null}
                    />
                    {onEditLead ? (
                      <button
                        type="button"
                        onClick={() => onEditLead(lead.id, lead.company_name)}
                        className="px-2.5 py-0.5 rounded-md text-[11px] font-semibold bg-slate-800 text-slate-100 border border-slate-600 hover:border-emerald-500/50 hover:text-emerald-200 transition"
                        title="Open this contact in the leads table to edit any field"
                      >
                        ✎ Edit
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void openKnowYourCustomer(lead)}
                      className="px-2.5 py-0.5 rounded-md text-[11px] font-semibold bg-teal-950/70 text-teal-200 border border-teal-600/50 hover:border-teal-400/70 hover:bg-teal-900/50 transition"
                      title="Know Your Customer — view contact and company details before or during a call"
                    >
                      👤 KYC
                    </button>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-slate-300 flex-wrap">
                    <div>
                      <span className="text-slate-500">Contact:</span>{" "}
                      <strong className="text-slate-100">{lead.contact_person || "Not specified"}</strong>
                      {lead.designation && <span className="text-slate-400"> ({lead.designation})</span>}
                    </div>
                    {lead.primary_email && (
                      <div>
                        <span className="text-slate-500">Email:</span>{" "}
                        <span className="font-mono text-cyan-400">{lead.primary_email}</span>
                      </div>
                    )}
                  </div>

                  {lead.remarks?.trim() ? (
                    <button
                      type="button"
                      onClick={() => setRemarksLead(lead)}
                      className="mt-2 w-full text-left rounded-xl border border-slate-700/80 bg-slate-950/60 px-3 py-2 hover:border-amber-500/40 transition"
                      title="View and edit client remarks history"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-300/90">
                          Latest remarks
                        </span>
                        <span className="text-[10px] text-slate-500">
                          History{(lead.remarks_history_count ?? 0) > 0
                            ? ` (${lead.remarks_history_count})`
                            : ""}{" "}
                          · Open
                        </span>
                      </div>
                      <p className="text-xs text-slate-200 line-clamp-2 whitespace-pre-wrap break-words">
                        {lead.remarks}
                      </p>
                    </button>
                  ) : null}

                  {(() => {
                    const phones = workspaceLeadPhones(lead);
                    if (phones.length === 0) return null;
                    const selected =
                      selectedPhoneByLead[lead.id] || phones[0]?.number || "";
                    return (
                      <div className="mt-2 space-y-1.5">
                        <div className="text-[11px] text-slate-400 font-medium">
                          Phone numbers — select one, then Call / WhatsApp
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {phones.map((p) => {
                            const isSelected = selected === p.number;
                            return (
                              <label
                                key={`${lead.id}-${p.index}-${p.number}`}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs cursor-pointer transition ${
                                  isSelected
                                    ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-100"
                                    : "border-slate-700 bg-slate-950/70 text-slate-300 hover:border-slate-500"
                                }`}
                                title={p.field_label}
                              >
                                <input
                                  type="radio"
                                  name={`workspace-phone-${lead.id}`}
                                  checked={isSelected}
                                  onChange={() =>
                                    setSelectedPhoneByLead((prev) => ({
                                      ...prev,
                                      [lead.id]: p.number,
                                    }))
                                  }
                                  className="accent-emerald-500"
                                />
                                <span className="font-bold text-emerald-300">{p.select_label}</span>
                                <span className="font-mono">{p.number}</span>
                                {phones.length > 1 ? (
                                  <span className="text-[10px] text-slate-500 hidden sm:inline">
                                    ({p.field_label})
                                  </span>
                                ) : null}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Stage-Specific Context Banners & Matrices ── */}

                  {/* Stage 2: Needs Follow Up Specific Details */}
                  {selectedStage === "needs_follow_up" && (
                    <div className="mt-2 p-2.5 rounded-xl bg-amber-950/30 border border-amber-800/50 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-amber-400 font-semibold">📌 Follow-up Reason:</span>
                        <span className="px-2 py-0.5 rounded bg-amber-900/60 text-amber-200 font-medium">
                          {lead.follow_up_reason || "Call back later"}
                        </span>
                        <span className="text-slate-400 font-semibold">Action:</span>
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-mono uppercase text-[10px]">
                          {lead.follow_up_action || "Call"}
                        </span>
                      </div>
                      <div className="text-[11px] text-amber-300/80">
                        Scheduled: {lead.follow_up_date ? new Date(lead.follow_up_date).toLocaleDateString() : "Pending"}
                      </div>
                    </div>
                  )}

                  {/* Stage 3: Not Interested - Actionable TO DO Matrix */}
                  {selectedStage === "not_interested" && (
                    <div className="mt-2 p-3 rounded-xl bg-purple-950/40 border border-purple-800/60 text-xs space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-purple-300 font-bold">Objection Category:</span>
                        <span className="px-2.5 py-0.5 rounded-md bg-purple-900/70 text-purple-200 font-semibold">
                          {lead.not_interested_reason || "General Objection"}
                        </span>
                        {lead.not_interested_remarks && (
                          <span className="text-slate-400 italic">"{lead.not_interested_remarks}"</span>
                        )}
                      </div>
                      {/* TO DO Strategy Guidance */}
                      <div className="p-2.5 rounded-lg bg-slate-950/80 border border-purple-700/50 flex items-start gap-2">
                        <span className="text-sm">🎯</span>
                        <div>
                          <strong className="text-purple-300 block">Actionable TO DO Strategy:</strong>
                          <p className="text-slate-200 text-[11px] mt-0.5">
                            {lead.todo_action_hint ||
                              "Re-evaluate requirements, check competitor pricing, and offer custom sample package."}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Stage 4: No Response - Dead Meter & WhatsApp Proof & Internet Research */}
                  {selectedStage === "no_response" && (
                    <div className="mt-2 space-y-2">
                      {/* Dead Lead Meter */}
                      <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-3">
                          <span className="text-slate-400 font-semibold">Outreach Stats:</span>
                          <span className="text-slate-300">
                            Calls Attempted: <strong className="text-emerald-400">{lead.calls_made_count}</strong>
                          </span>
                          <span className="text-slate-300">
                            Emails Sent:{" "}
                            <strong className={lead.emails_sent_count >= 20 ? "text-rose-400 font-bold" : "text-cyan-400"}>
                              {lead.emails_sent_count} / 20
                            </strong>
                          </span>
                          <span className="text-slate-300">
                            Silence:{" "}
                            <strong className={lead.days_since_last_response >= 30 ? "text-rose-400 font-bold" : "text-amber-400"}>
                              {lead.days_since_last_response}d
                            </strong>
                          </span>
                        </div>

                        {/* Meter Indicator */}
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-slate-400">Dead Lead Meter:</span>
                          {lead.is_dead_lead_meter_red ? (
                            <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold animate-pulse">
                              🔴 CRITICAL DEAD LEAD (Shift to Drip)
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-semibold">
                              🟡 Active Retry Window
                            </span>
                          )}
                        </div>
                      </div>

                      {/* WhatsApp Proof and Research Checkboxes */}
                      <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
                        {/* WhatsApp Proof Indicator */}
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400 font-medium">WhatsApp Call Proof:</span>
                          <button
                            type="button"
                            onClick={() => setProofModalLead(lead)}
                            className={`px-2.5 py-1 rounded-lg font-semibold text-[11px] transition flex items-center gap-1 ${
                              lead.whatsapp_call_tried
                                ? "bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/30"
                                : "bg-slate-800 text-slate-400 border border-slate-700 hover:text-slate-200"
                            }`}
                          >
                            <span>{lead.whatsapp_call_tried ? "✓ Logged (Yes)" : "✕ Not Logged (No)"}</span>
                            <span className="text-[10px] text-slate-400 underline ml-1">
                              {isAdmin ? "Audit Proof" : "Edit Proof"}
                            </span>
                          </button>
                        </div>

                        {/* Internet Research Trackers */}
                        <div className="flex items-center gap-3 text-[11px] text-slate-300 flex-wrap">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.searched_internet_email}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  searched_internet_email: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0 cursor-pointer"
                            />
                            <span>🌐 Searched New Email</span>
                          </label>

                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.searched_internet_phone}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  searched_internet_phone: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0 cursor-pointer"
                            />
                            <span>📞 Searched New Phone</span>
                          </label>

                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.linkedin_request_sent}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  linkedin_request_sent: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-indigo-500 focus:ring-0 cursor-pointer"
                            />
                            <span>🔗 LinkedIn Req</span>
                          </label>

                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.linkedin_msg_sent}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  linkedin_msg_sent: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-indigo-500 focus:ring-0 cursor-pointer"
                            />
                            <span>💬 LinkedIn Msg</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right Section: Action Controls */}
                <div className="flex flex-col sm:flex-row lg:flex-col items-end gap-2 shrink-0">
                  {/* Direct Contact — stay on this page (no Master Table hop) */}
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {(() => {
                      const phones = workspaceLeadPhones(lead);
                      const selectedPhone =
                        selectedPhoneByLead[lead.id] || phones[0]?.number || lead.primary_phone || "";
                      const selectedMeta =
                        phones.find((p) => p.number === selectedPhone) || phones[0] || null;
                      if (!selectedPhone) return null;
                      return (
                        <>
                          <CallLeadButton
                            leadId={lead.id}
                            phone={selectedPhone}
                            contactId={selectedMeta?.contact_id ?? lead.contact_id ?? undefined}
                            contactName={
                              selectedMeta?.contact_name ||
                              lead.contact_person ||
                              lead.company_name
                            }
                            assignedToUserId={lead.assigned_to_user_id}
                            assignedTo={lead.assigned_to_name}
                            compact
                            onError={(msg) => {
                              onError?.(msg);
                              setError(msg);
                            }}
                            onSuccess={() => {
                              pushNumberToFloatingDialpad({
                                phone: selectedPhone,
                                contactName:
                                  selectedMeta?.contact_name ||
                                  lead.contact_person ||
                                  lead.company_name,
                                countryHint: lead.country,
                              });
                              setActionNotice(
                                `Calling ${selectedMeta?.select_label || "#1"} ${selectedPhone}…`,
                              );
                              window.setTimeout(() => setActionNotice(null), 4000);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setWhatsappTarget({
                                row: workspaceLeadAsComposeRow(lead),
                                phone: selectedPhone,
                              })
                            }
                            className="px-3 py-1.5 rounded-xl bg-[#128C7E] hover:bg-[#0e6f64] text-white text-xs font-semibold shadow-md shadow-emerald-950/40 transition flex items-center gap-1"
                            title="Send WhatsApp to the selected number"
                          >
                            💬 WhatsApp
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setTelegramTarget({
                                row: workspaceLeadAsComposeRow(lead),
                                phone: selectedPhone,
                              })
                            }
                            className="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-950/40 transition flex items-center gap-1"
                            title="Send Telegram to the selected number"
                          >
                            ✈️ Telegram
                          </button>
                        </>
                      );
                    })()}
                    {lead.primary_email ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenEmailComposer?.(
                            lead.primary_email!,
                            lead.company_name,
                            lead.contact_person || undefined,
                          )
                        }
                        className="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-950 transition flex items-center gap-1"
                        title="Compose Email"
                      >
                        ✉️ Email
                      </button>
                    ) : null}
                  </div>

                  {/* Promote / Demote Stage Change Dropdown or Modal Trigger */}
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <button
                      type="button"
                      onClick={() => void openKnowYourCustomer(lead)}
                      className="px-2.5 py-1 rounded-lg bg-teal-500/10 text-teal-200 border border-teal-500/40 hover:bg-teal-500/20 text-xs font-medium transition"
                      title="Know Your Customer — view contact and company details"
                    >
                      👤 Know Your Customer
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemarksLead(lead)}
                      className="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-200 border border-amber-500/40 hover:bg-amber-500/20 text-xs font-medium transition"
                      title="View / add client remarks and history"
                    >
                      📝 {lead.remarks?.trim() ? "Remarks" : "Add remarks"}
                      {(lead.remarks_history_count ?? 0) > 1
                        ? ` (${lead.remarks_history_count})`
                        : ""}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleUpdateStage(lead.id, "interested")}
                      className="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/20 text-xs font-medium transition"
                      title="Move to Interested/Potential deals pipeline"
                    >
                      ❤️ Interested
                    </button>

                    {selectedStage !== "needs_follow_up" && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingLeadId(lead.id);
                          setInlineReason("Need approval from HO");
                          setInlineAction("call");
                        }}
                        className="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 text-xs font-medium transition"
                      >
                        🕒 Move to Follow Up
                      </button>
                    )}

                    {selectedStage !== "not_interested" && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingLeadId(lead.id);
                          setInlineReason("Price high");
                          setInlineRemarks("");
                        }}
                        className="px-2.5 py-1 rounded-lg bg-purple-500/10 text-purple-200 border border-purple-500/40 hover:bg-purple-500/20 text-xs font-medium transition"
                      >
                        💡 Not Interested
                      </button>
                    )}

                    {selectedStage !== "no_response" && (
                      <button
                        type="button"
                        onClick={() => handleUpdateStage(lead.id, "no_response")}
                        className="px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-200 border border-rose-500/40 hover:bg-rose-500/20 text-xs font-medium transition"
                      >
                        🔕 No Response
                      </button>
                    )}

                    {selectedStage !== "fresh" && (
                      <button
                        type="button"
                        onClick={() => handleUpdateStage(lead.id, "fresh")}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-medium transition"
                      >
                        ↩️ Reset to Fresh
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Inline Action Selector for Move to Follow-up / Not-interested */}
              {editingLeadId === lead.id && (
                <div className="mt-3 p-3 rounded-xl bg-slate-950 border border-slate-700 animate-in fade-in duration-150 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-bold text-white">Select Reason & Strategy for {lead.company_name}</span>
                    <button
                      type="button"
                      onClick={() => setEditingLeadId(null)}
                      className="text-slate-400 hover:text-slate-200 text-xs"
                    >
                      ✕ Cancel
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-slate-400 mb-1">Reason / Category:</label>
                      <select
                        value={inlineReason}
                        onChange={(e) => setInlineReason(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                      >
                        <optgroup label="Needs Follow-up Scenarios">
                          {followUpOptions.map((o) => (
                            <option key={o.id} value={o.label}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Not Interested Scenarios">
                          {notInterestedOptions.map((o) => (
                            <option key={o.id} value={o.label}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">Action Type:</label>
                      <select
                        value={inlineAction}
                        onChange={(e) => setInlineAction(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                      >
                        <option value="call">Call Back</option>
                        <option value="email">Send Email / Proposal</option>
                        <option value="quotation">Send CNF/FOB Quotation</option>
                        <option value="whatsapp">WhatsApp Outreach</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 text-xs mb-1">Remarks / TO DO Note:</label>
                    <input
                      type="text"
                      placeholder="e.g. Client requested competitor price comparison / will discuss on Monday..."
                      value={inlineRemarks}
                      onChange={(e) => setInlineRemarks(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500"
                    />
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const isNotInt = notInterestedOptions.some((o) => o.label === inlineReason);
                        if (isNotInt) {
                          handleUpdateStage(lead.id, "not_interested", {
                            not_interested_reason: inlineReason,
                            not_interested_remarks: inlineRemarks,
                          });
                        } else {
                          handleUpdateStage(lead.id, "needs_follow_up", {
                            follow_up_reason: inlineReason,
                            follow_up_action: inlineAction,
                          });
                        }
                      }}
                      className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition"
                    >
                      ✓ Save & Apply Strategy
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Modals ── */}
      <WhatsAppProofModal
        lead={proofModalLead}
        isOpen={Boolean(proofModalLead)}
        isAdmin={isAdmin}
        onClose={() => setProofModalLead(null)}
        onSave={handleSaveWhatsAppProof}
      />
      {whatsappTarget ? (
        <BulkWhatsAppModal
          buyerIds={[whatsappTarget.row.id]}
          toPhone={whatsappTarget.phone}
          onClose={() => setWhatsappTarget(null)}
          onError={(msg) => {
            onError?.(msg);
            setError(msg);
          }}
          onCreated={(result) => {
            const sent = result.sent_count ?? 0;
            const failed = result.failed_count ?? 0;
            const deliveryErr =
              result.delivery_error ||
              result.created?.find((c) => c.send_message)?.send_message ||
              "";
            if (sent === 0) {
              const reason = result.skipped?.[0]?.reason;
              const msg =
                failed > 0
                  ? `WhatsApp delivery failed${deliveryErr ? `: ${deliveryErr}` : ""}.`
                  : reason
                    ? `WhatsApp was not sent: ${reason}.`
                    : "WhatsApp message was not sent.";
              onError?.(msg);
              setError(msg);
              return;
            }
            setActionNotice(`WhatsApp sent to ${whatsappTarget.row.company_name}.`);
            window.setTimeout(() => setActionNotice(null), 5000);
          }}
        />
      ) : null}

      {telegramTarget ? (
        <LeadTelegramComposeModal
          target={telegramTarget}
          onClose={() => setTelegramTarget(null)}
          onError={(msg) => {
            onError?.(msg);
            setError(msg);
          }}
          onSent={(message) => {
            setActionNotice(message);
            setTelegramTarget(null);
            window.setTimeout(() => setActionNotice(null), 5000);
          }}
        />
      ) : null}

      {remarksLead
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60"
              onClick={() => setRemarksLead(null)}
              role="presentation"
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={`Client remarks for ${remarksLead.company_name}`}
                className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-slate-100 truncate">
                      Remarks · {remarksLead.company_name}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Latest remark by default — open History for prior versions
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRemarksLead(null)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                    aria-label="Close remarks"
                  >
                    <IconX size="sm" />
                  </button>
                </div>
                <div className="p-4">
                  <ClientHistoryPanel
                    buyerId={remarksLead.id}
                    companyName={remarksLead.company_name}
                    onError={(msg) => {
                      onError?.(msg);
                      setError(msg);
                    }}
                    onRemarksSaved={(text) => {
                      const nextText = text.trim();
                      setLeads((prev) =>
                        prev.map((row) => {
                          if (row.id !== remarksLead.id) return row;
                          const prevText = (row.remarks || "").trim();
                          const bumped =
                            nextText && nextText !== prevText
                              ? (row.remarks_history_count ?? 0) + 1
                              : Math.max(row.remarks_history_count ?? 0, nextText ? 1 : 0);
                          return {
                            ...row,
                            remarks: nextText || null,
                            remarks_history_count: bumped,
                          };
                        }),
                      );
                      setRemarksLead((current) => {
                        if (!current || current.id !== remarksLead.id) return current;
                        const prevText = (current.remarks || "").trim();
                        const bumped =
                          nextText && nextText !== prevText
                            ? (current.remarks_history_count ?? 0) + 1
                            : Math.max(current.remarks_history_count ?? 0, nextText ? 1 : 0);
                        return {
                          ...current,
                          remarks: nextText || null,
                          remarks_history_count: bumped,
                        };
                      });
                    }}
                  />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      <KnowYourCustomerModal
        open={Boolean(kycLead)}
        onClose={closeKnowYourCustomer}
        companyName={kycLead?.company_name}
        row={kycRow}
        buyerId={kycLead?.id ?? null}
        loading={kycLoading}
        error={kycError}
      />
    </div>
  );
};
