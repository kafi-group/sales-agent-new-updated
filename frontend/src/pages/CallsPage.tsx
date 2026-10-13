import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  type CallConfig,
  type CallHistoryItem,
  type DialableCountryNow,
  type DialableLeadRow,
  type DialablePhoneOption,
} from "../api/client";
import { CallLeadButton } from "../components/CallLeadButton";
import { CallManualDialer } from "../components/CallManualDialer";
import { CallPhonePicker } from "../components/CallPhonePicker";
import { CallRemarksForm } from "../components/CallRemarksForm";
import { CallRecordingPanel } from "../components/CallRecordingPanel";
import { CallRecommendationBadge } from "../components/CallRecommendationBadge";
import { CountrySelect } from "../components/CountrySelect";
import { Pagination } from "../components/Pagination";
import { ActionButton } from "../components/ui/ActionButton";
import { IconPhone, IconRefresh, IconX } from "../components/icons/AppIcons";
import { type CallOutcome, callOutcomeBadge, callOutcomeLabel, callOutcomeListNotice } from "../utils/callOutcomes";
import { pushNumberToFloatingDialpad } from "../utils/dialpadEvents";
import { autocorrectText } from "../utils/spelling";
import { useCallQueue } from "../hooks/useCallQueue";
import {
  CALL_BATCH_SIZE_OPTIONS,
  getCallBatchSize,
  setCallBatchSize,
  type CallBatchSize,
} from "../utils/callBatchSize";

interface CallsPageProps {
  onError: (message: string) => void;
  onSelectLead?: (leadId: number) => void;
  onCallFollowUpSaved?: (outcome: string | null | undefined) => void;
}

const POLL_INTERVAL_MS = 15_000;
const RECENT_CALLS_PAGE_SIZE = 10;
const RECENT_CALLS_SINCE_DAYS = 30;
const QUICK_DIAL_PAGE_SIZE = 25;

type ValidNowFilter = "" | "yes" | "no";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}

function statusBadge(status: string | null | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (value === "completed") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (value === "busy" || value === "no-answer" || value === "failed" || value === "canceled") {
    return "bg-red-500/15 text-red-300 border-red-500/30";
  }
  if (value === "in-progress" || value === "ringing" || value === "answered" || value === "initiated") {
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  }
  return "bg-slate-700/50 text-slate-300 border-slate-600";
}

export function CallsPage({ onError, onSelectLead, onCallFollowUpSaved }: CallsPageProps) {
  const [config, setConfig] = useState<CallConfig | null>(null);
  const [history, setHistory] = useState<CallHistoryItem[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [dialableLeads, setDialableLeads] = useState<DialableLeadRow[]>([]);
  const [dialableTotal, setDialableTotal] = useState(0);
  const [dialablePage, setDialablePage] = useState(1);
  const [dialableTotalPages, setDialableTotalPages] = useState(1);
  const [dialableCountries, setDialableCountries] = useState<string[]>([]);
  const [countriesValidNow, setCountriesValidNow] = useState<DialableCountryNow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState("");
  const [outcomeDraft, setOutcomeDraft] = useState<CallOutcome | "">("");
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [deletingCallId, setDeletingCallId] = useState<number | null>(null);
  const [countryFilter, setCountryFilter] = useState<string>("");
  const [validNowFilter, setValidNowFilter] = useState<ValidNowFilter>("");
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<number>>(new Set());
  const [phonePicker, setPhonePicker] = useState<{
    lead: DialableLeadRow;
    phones: DialablePhoneOption[];
  } | null>(null);
  const [selectingAllMatching, setSelectingAllMatching] = useState(false);
  const [callBatchSize, setCallBatchSizeLocal] = useState<CallBatchSize>(() => getCallBatchSize());
  const callQueue = useCallQueue();
  const pollRef = useRef<number | null>(null);

  const loadHistory = useCallback(
    async (page: number) => {
      const calls = await client.listCallHistory({
        page,
        page_size: RECENT_CALLS_PAGE_SIZE,
        since_days: RECENT_CALLS_SINCE_DAYS,
      });
      setHistory(calls.rows);
      setHistoryPage(calls.page);
      setHistoryTotal(calls.total);
      setHistoryTotalPages(calls.total_pages);
    },
    [],
  );

  const loadDialable = useCallback(
    async (page: number, country: string, validNow: ValidNowFilter) => {
      const table = await client.listDialableLeads({
        page,
        page_size: QUICK_DIAL_PAGE_SIZE,
        country: country || undefined,
        valid_now: validNow || undefined,
      });
      setDialableLeads(table.rows);
      setDialableTotal(table.total);
      setDialablePage(table.page);
      setDialableTotalPages(table.total_pages);
      setDialableCountries(table.countries);
      setCountriesValidNow(table.countries_valid_now);
    },
    [],
  );

  const loadData = useCallback(
    async (options?: {
      silent?: boolean;
      historyPage?: number;
      dialablePage?: number;
      country?: string;
      validNow?: ValidNowFilter;
    }) => {
      if (!options?.silent) setLoading(true);
      const nextHistoryPage = options?.historyPage ?? historyPage;
      const nextDialablePage = options?.dialablePage ?? dialablePage;
      const nextCountry = options?.country ?? countryFilter;
      const nextValidNow = options?.validNow ?? validNowFilter;
      try {
        const cfg = await client.getCallConfig();
        setConfig(cfg);
        await Promise.all([
          loadHistory(nextHistoryPage),
          loadDialable(nextDialablePage, nextCountry, nextValidNow),
        ]);
      } catch (e) {
        if (!options?.silent) {
          onError(e instanceof Error ? e.message : "Failed to load calls");
        }
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [countryFilter, dialablePage, historyPage, loadDialable, loadHistory, onError, validNowFilter],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!config?.configured) return;
    pollRef.current = window.setInterval(() => {
      void loadData({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [config?.configured, loadData]);

  const selectedCall = history.find((c) => c.id === selectedCallId) ?? null;

  const validNowCountryNames = useMemo(
    () => new Set(countriesValidNow.map((row) => row.country)),
    [countriesValidNow],
  );

  async function saveFollowUp() {
    if (!selectedCallId) return;
    setSavingFollowUp(true);
    try {
      const updated = await client.updateCallFollowUp(selectedCallId, {
        notes: autocorrectText(remarksDraft, "prose"),
        call_outcome: outcomeDraft || null,
      });
      setHistory((prev) => prev.map((c) => (c.id === selectedCallId ? updated : c)));
      onCallFollowUpSaved?.(updated.call_outcome);
      const outcomeNotice = callOutcomeListNotice(updated.call_outcome);
      setNotice(outcomeNotice ?? "Call remarks saved.");
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save call remarks");
    } finally {
      setSavingFollowUp(false);
    }
  }

  function selectCall(call: CallHistoryItem) {
    setSelectedCallId(call.id);
    setRemarksDraft(call.notes ?? "");
    setOutcomeDraft((call.call_outcome as CallOutcome | undefined) ?? "");
  }

  async function deleteCall(call: CallHistoryItem) {
    const label = call.company_name ?? call.contact_name ?? "this call";
    if (!window.confirm(`Delete call log for ${label}? This cannot be undone.`)) return;

    setDeletingCallId(call.id);
    try {
      await client.deleteCallLog(call.id);
      const nextHistory = history.filter((c) => c.id !== call.id);
      if (nextHistory.length === 0 && historyPage > 1) {
        const prevPage = historyPage - 1;
        setHistoryPage(prevPage);
        await loadData({ historyPage: prevPage, silent: true });
      } else {
        await loadData({ historyPage, silent: true });
      }
      if (selectedCallId === call.id) {
        setSelectedCallId(null);
        setRemarksDraft("");
        setOutcomeDraft("");
      }
      if (call.call_outcome) {
        onCallFollowUpSaved?.(null);
      }
      setNotice("Call log deleted.");
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete call log");
    } finally {
      setDeletingCallId(null);
    }
  }

  function toggleLeadSelect(leadId: number) {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedLeadIds(new Set(dialableLeads.map((l) => l.id)));
  }

  function clearSelection() {
    setSelectedLeadIds(new Set());
  }

  async function selectAllMatching() {
    if (dialableTotal <= 0) return;
    if (
      !window.confirm(
        `Select all ${dialableTotal.toLocaleString()} matching lead${dialableTotal === 1 ? "" : "s"}${countryFilter ? ` in ${countryFilter}` : ""}?`,
      )
    ) {
      return;
    }
    setSelectingAllMatching(true);
    try {
      const ids = new Set<number>();
      let pageNum = 1;
      let totalPages = 1;
      while (pageNum <= totalPages && pageNum <= 500) {
        const table = await client.listDialableLeads({
          page: pageNum,
          page_size: 100,
          country: countryFilter || undefined,
          valid_now: validNowFilter || undefined,
        });
        for (const row of table.rows) ids.add(row.id);
        totalPages = table.total_pages;
        pageNum += 1;
      }
      setSelectedLeadIds(ids);
      setNotice(`Selected ${ids.size} lead${ids.size === 1 ? "" : "s"}.`);
      window.setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not select all matching leads");
    } finally {
      setSelectingAllMatching(false);
    }
  }

  function changeCallBatchSize(size: CallBatchSize) {
    setCallBatchSize(size);
    setCallBatchSizeLocal(size);
  }

  async function startBulkCall() {
    const ids = [...selectedLeadIds];
    if (!ids.length) return;

    const byId = new Map<number, DialableLeadRow>();
    for (const row of dialableLeads) {
      if (selectedLeadIds.has(row.id)) byId.set(row.id, row);
    }
    if (byId.size < ids.length) {
      let pageNum = 1;
      let totalPages = 1;
      while (byId.size < ids.length && pageNum <= totalPages && pageNum <= 500) {
        const table = await client.listDialableLeads({
          page: pageNum,
          page_size: 100,
          country: countryFilter || undefined,
          valid_now: validNowFilter || undefined,
        });
        for (const row of table.rows) {
          if (selectedLeadIds.has(row.id)) byId.set(row.id, row);
        }
        totalPages = table.total_pages;
        pageNum += 1;
      }
    }

    const selected = ids.map((id) => byId.get(id)).filter((r): r is DialableLeadRow => Boolean(r));
    const missingContact = selected.filter(
      (l) => l.missing_contact_name || !(l.contact_name || "").trim(),
    );
    if (missingContact.length > 0) {
      const proceed = window.confirm(
        `${missingContact.length} selected lead${missingContact.length === 1 ? "" : "s"} ha${missingContact.length === 1 ? "s" : "ve"} no contact person name. Fix the contact first for cleaner call logs.\n\nStart bulk call anyway?`,
      );
      if (!proceed) return;
    }

    const leads = selected
      .map((l) => {
        const phones = l.phones?.length ? l.phones : [];
        const primary = phones[0];
        return {
          leadId: l.id,
          companyName: l.company_name ?? String(l.id),
          contactName: l.contact_name ?? null,
          phone: primary?.phone ?? l.contact_phone ?? "",
          country: l.country ?? null,
          contactId: primary?.contact_id ?? l.contact_id ?? undefined,
        };
      })
      .filter((l) => l.phone.trim());
    if (!leads.length) return;
    clearSelection();
    callQueue.start(leads);
  }

  function openPhonePicker(lead: DialableLeadRow) {
    const phones =
      lead.phones && lead.phones.length > 0
        ? lead.phones
        : lead.contact_phone
          ? [
              {
                index: 1,
                label: "Main",
                phone: lead.contact_phone,
                contact_id: lead.contact_id,
              },
            ]
          : [];
    if (phones.length <= 1) return;
    setPhonePicker({ lead, phones });
  }

  function applyCountryFilter(next: string) {
    setCountryFilter(next);
    setDialablePage(1);
    setSelectedLeadIds(new Set());
  }

  function applyValidNowFilter(next: ValidNowFilter) {
    setValidNowFilter(next);
    setDialablePage(1);
    setSelectedLeadIds(new Set());
  }

  if (!loading && config && !config.configured) {
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-medium text-slate-100">Call Center</h2>
        <div className="p-6 rounded-xl border border-amber-800/50 bg-amber-900/20 text-amber-100 text-sm space-y-3">
          <p className="font-medium">Twilio not connected yet.</p>
          <p className="text-amber-200/80">
            Call clients <strong>directly from your browser</strong> — no personal phone number
            needed. Human-initiated only (click to call).
          </p>
          <p className="text-amber-200/80 text-xs">
            1. Twilio account + Voice number
            <br />
            2. Create API Key + TwiML App (see backend/.env.example)
            <br />
            3. <code className="text-amber-100">ngrok http 8003</code> for local dev (match API_PORT)
            <br />
            4. Restart backend
          </p>
          <pre className="mt-2 p-3 rounded-lg bg-slate-950/60 border border-slate-800 text-xs text-slate-300 overflow-x-auto">
{`TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=+1234567890
TWILIO_API_KEY_SID=SKxxxxxxxx
TWILIO_API_KEY_SECRET=your_secret
TWILIO_TWIML_APP_SID=APxxxxxxxx
TWILIO_WEBHOOK_BASE_URL=https://abc123.ngrok-free.app`}
          </pre>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4 w-full min-w-0">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-medium text-slate-100">Call Center</h2>
          <p className="text-sm text-slate-500 mt-1">
            Browser calling via Twilio
            {config?.caller_id_masked ? ` · Caller ID ${config.caller_id_masked}` : ""}
          </p>
        </div>
        <ActionButton
          icon={IconRefresh}
          size="md"
          onClick={() => void loadData()}
          title="Refresh"
        >
          Refresh
        </ActionButton>
      </div>

      {config?.setup_message && (
        <div className="p-4 rounded-xl border border-amber-800/50 bg-amber-900/20 text-amber-100 text-sm">
          {config.setup_message}
        </div>
      )}

      {config?.browser_ready && (
        <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/60 text-xs text-slate-400 space-y-1 font-mono">
          <p className="text-slate-500 font-sans not-italic">
            Twilio diagnostics — must match Console Account SID + TwiML App Voice URL
          </p>
          <p>Account SID: {config.twilio_account_sid ?? "—"}</p>
          <p>TwiML App: {config.twilio_twiml_app_sid ?? "—"}</p>
          <p>Webhook base: {config.twilio_webhook_base_url ?? "—"}</p>
          <p>
            Validate signatures:{" "}
            {config.twilio_validate_webhooks === false ? "off" : "on"}
          </p>
        </div>
      )}

      {notice && (
        <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          {notice}
        </p>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-1 flex flex-col gap-4">
          <CallManualDialer
            onError={onError}
            onSuccess={(result) => {
              setNotice(result.message ?? "Connected — speak through your browser.");
              void loadData({ silent: true });
            }}
          />

          <div className="rounded-xl border border-slate-800 bg-slate-900 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-300">Quick dial</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    {dialableTotal.toLocaleString()} lead
                    {dialableTotal === 1 ? "" : "s"} with phone numbers
                  </p>
                </div>
                {(countryFilter || validNowFilter) && (
                  <button
                    type="button"
                    onClick={() => {
                      setCountryFilter("");
                      setValidNowFilter("");
                      setDialablePage(1);
                      setSelectedLeadIds(new Set());
                    }}
                    className="shrink-0 text-xs text-sky-400 hover:text-sky-300"
                  >
                    Clear filters
                  </button>
                )}
              </div>
              <CountrySelect
                value={countryFilter}
                onChange={applyCountryFilter}
                allowEmpty
                emptyLabel={`All countries (${dialableCountries.length || "…"})`}
              />
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["", "All times"],
                    ["yes", "Valid to call now"],
                    ["no", "Outside hours"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value || "all"}
                    type="button"
                    onClick={() => applyValidNowFilter(value)}
                    className={`px-2.5 py-1 rounded-md text-xs border ${
                      validNowFilter === value
                        ? "bg-emerald-600 border-emerald-500 text-white"
                        : "bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {countriesValidNow.length > 0 && (
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  In calling window now ({countriesValidNow.length}):{" "}
                  {countriesValidNow
                    .slice(0, 8)
                    .map((row) => `${row.country} (${row.local_time})`)
                    .join(" · ")}
                  {countriesValidNow.length > 8 ? " · …" : ""}
                </p>
              )}
              {(countryFilter || validNowFilter) && (
                <p className="text-xs text-slate-500">
                  Showing {dialableTotal.toLocaleString()} match
                  {dialableTotal === 1 ? "" : "es"}
                  {countryFilter ? ` in ${countryFilter}` : ""}
                  {validNowFilter === "yes" ? " · valid to call now" : ""}
                  {validNowFilter === "no" ? " · outside calling hours" : ""}
                  {countryFilter &&
                    dialableCountries.length > 0 &&
                    !dialableCountries.some(
                      (c) => c.toLowerCase() === countryFilter.toLowerCase(),
                    ) &&
                    !validNowCountryNames.has(countryFilter) &&
                    " (no leads with this country yet)"}
                </p>
              )}

              {dialableLeads.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <ActionButton
                    icon={selectedLeadIds.size > 0 ? IconX : IconPhone}
                    size="sm"
                    variant="ghost"
                    onClick={selectedLeadIds.size > 0 ? clearSelection : selectAllVisible}
                    title={
                      selectedLeadIds.size > 0 ? "Clear selection" : "Select leads on this page"
                    }
                    className="text-sky-300 border-sky-700/40"
                  >
                    {selectedLeadIds.size > 0
                      ? `Clear (${selectedLeadIds.size})`
                      : `Select this page (${dialableLeads.length})`}
                  </ActionButton>
                  {dialableTotal > dialableLeads.length && selectedLeadIds.size === 0 && (
                    <ActionButton
                      icon={IconPhone}
                      size="sm"
                      variant="ghost"
                      onClick={() => void selectAllMatching()}
                      disabled={selectingAllMatching || callQueue.status !== "idle"}
                      title={`Select all ${dialableTotal} matching leads`}
                      className="text-sky-300 border-sky-700/40"
                    >
                      {selectingAllMatching
                        ? "Selecting…"
                        : `Select all ${dialableTotal.toLocaleString()} matching`}
                    </ActionButton>
                  )}
                  <label className="text-xs text-slate-500 ml-auto flex items-center gap-1.5">
                    Batch size
                    <select
                      value={callBatchSize}
                      onChange={(e) =>
                        changeCallBatchSize(Number(e.target.value) === 25 ? 25 : 10)
                      }
                      className="rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200"
                    >
                      {CALL_BATCH_SIZE_OPTIONS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedLeadIds.size > 0 && (
                    <ActionButton
                      icon={IconPhone}
                      variant="sky"
                      onClick={() => void startBulkCall()}
                      disabled={callQueue.status !== "idle"}
                      title="Bulk call"
                    >
                      Bulk call ({selectedLeadIds.size})
                      {selectedLeadIds.size > callBatchSize
                        ? ` · ${Math.ceil(selectedLeadIds.size / callBatchSize)} batches`
                        : ""}
                    </ActionButton>
                  )}
                </div>
              )}
              {dialableTotal > 0 && (
                <p className="text-xs text-slate-500 pt-1">
                  Batch size {callBatchSize} — next batch starts after remarks for each group of{" "}
                  {callBatchSize}.
                </p>
              )}
            </div>
            <div className="max-h-[320px] overflow-y-auto divide-y divide-slate-800/80">
              {dialableLeads.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">
                  {dialableTotal === 0 && !countryFilter && !validNowFilter
                    ? "No leads with phone numbers yet."
                    : "No dialable leads match these filters."}
                </p>
              ) : (
                dialableLeads.map((lead) => (
                  <div
                    key={lead.id}
                    className={`px-3 py-3 flex items-center gap-2 ${
                      selectedLeadIds.has(lead.id) ? "bg-sky-950/30" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedLeadIds.has(lead.id)}
                      onChange={() => toggleLeadSelect(lead.id)}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-800 accent-sky-500 shrink-0 cursor-pointer"
                      aria-label={`Select ${lead.company_name}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (lead.contact_phone) {
                          pushNumberToFloatingDialpad({
                            phone: lead.contact_phone,
                            contactName: lead.contact_name ?? undefined,
                            countryHint: lead.country,
                          });
                        }
                        onSelectLead?.(lead.id);
                      }}
                      className="text-left min-w-0 flex-1"
                    >
                      <p className="text-sm text-slate-200 truncate flex flex-wrap items-center gap-1.5">
                        <span className="truncate">{lead.company_name}</span>
                        {lead.possible_duplicate && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                            Possible duplicate
                          </span>
                        )}
                        {(lead.missing_contact_name || !(lead.contact_name || "").trim()) && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">
                            No contact name
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        {(lead.contact_name || "").trim() || "—"} · {lead.contact_phone}
                        {lead.country ? ` · ${lead.country}` : ""}
                      </p>
                      <div className="mt-1">
                        <CallRecommendationBadge
                          recommended={lead.call_recommended}
                          localTime={lead.call_local_time}
                          reason={lead.call_reason}
                        />
                      </div>
                    </button>
                    {(lead.phones && lead.phones.length > 1) || (!lead.phones?.length && !lead.contact_phone) ? null : (
                      <CallLeadButton
                        leadId={lead.id}
                        phone={
                          (lead.phones && lead.phones.length === 1
                            ? lead.phones[0].phone
                            : lead.contact_phone) ?? undefined
                        }
                        contactId={
                          lead.phones && lead.phones.length === 1
                            ? lead.phones[0].contact_id ?? undefined
                            : lead.contact_id ?? undefined
                        }
                        compact
                        onError={onError}
                        onSuccess={(result) => {
                          setNotice(result.message ?? "Connected — speak through your browser.");
                          void loadData({ silent: true });
                        }}
                      />
                    )}
                    {lead.phones && lead.phones.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => openPhonePicker(lead)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-sky-600 hover:bg-sky-500 text-white"
                        title={`Choose from ${lead.phones.length} numbers`}
                      >
                        <IconPhone size="xs" />
                        Call ({lead.phones.length})
                      </button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            {dialableTotal > 0 && (
              <div className="px-3 pb-3 border-t border-slate-800">
                <Pagination
                  page={dialablePage}
                  totalPages={dialableTotalPages}
                  totalItems={dialableTotal}
                  pageSize={QUICK_DIAL_PAGE_SIZE}
                  disabled={loading}
                  onPageChange={(nextPage) => {
                    setDialablePage(nextPage);
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="xl:col-span-1 rounded-xl border border-slate-800 bg-slate-900 flex flex-col overflow-hidden self-start">
          <div className="px-4 py-3 border-b border-slate-800">
            <h3 className="text-sm font-medium text-slate-300">Recent calls</h3>
            <p className="text-xs text-slate-500 mt-1">
              Last {RECENT_CALLS_SINCE_DAYS} days · {historyTotal} call
              {historyTotal === 1 ? "" : "s"} · older logs are removed automatically
            </p>
          </div>
          <div className="divide-y divide-slate-800/80">
            {history.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No calls in the last month.</p>
            ) : (
              history.map((call) => (
                <div
                  key={call.id}
                  className={`flex items-stretch ${
                    selectedCallId === call.id ? "bg-slate-800/70" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectCall(call)}
                    className="flex-1 min-w-0 text-left px-4 py-3 hover:bg-slate-800/50 transition"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-200 truncate">
                          {call.company_name ?? call.contact_name ?? "Call"}
                        </p>
                        <p className="text-xs text-slate-500">{formatDate(call.created_at)}</p>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        {call.call_outcome && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded border ${callOutcomeBadge(call.call_outcome)}`}
                          >
                            {callOutcomeLabel(call.call_outcome)}
                          </span>
                        )}
                        {call.call_status && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded border ${statusBadge(call.call_status)}`}
                          >
                            {call.call_status}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteCall(call)}
                    disabled={deletingCallId === call.id}
                    title="Delete call log"
                    className="shrink-0 px-3 text-xs text-red-300 hover:text-red-200 hover:bg-red-900/30 border-l border-slate-800/80 disabled:opacity-50"
                  >
                    {deletingCallId === call.id ? "…" : "Delete"}
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="px-3 pb-3">
            <Pagination
              page={historyPage}
              totalPages={historyTotalPages}
              totalItems={historyTotal}
              pageSize={RECENT_CALLS_PAGE_SIZE}
              disabled={loading}
              onPageChange={(nextPage) => {
                setHistoryPage(nextPage);
                void loadData({ historyPage: nextPage });
              }}
            />
          </div>
        </div>

        <div className="xl:col-span-1 rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
          <h3 className="text-sm font-medium text-slate-300">Call detail</h3>
          {!selectedCall ? (
            <p className="text-sm text-slate-500">
              Select a call to add remarks and label the client outcome.
            </p>
          ) : (
            <>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-slate-500 text-xs">Lead</dt>
                  <dd className="text-slate-200">
                    {selectedCall.company_name ?? "—"}
                    {selectedCall.buyer_id && onSelectLead && (
                      <button
                        type="button"
                        onClick={() => onSelectLead(selectedCall.buyer_id!)}
                        className="ml-2 text-xs text-sky-400 hover:text-sky-300"
                      >
                        Open profile
                      </button>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 text-xs">Contact</dt>
                  <dd className="text-slate-200">
                    {selectedCall.contact_name ?? "—"}
                    {(selectedCall.lead_phone ?? selectedCall.contact_phone) && (
                      <span className="text-slate-500">
                        {" "}
                        · {selectedCall.lead_phone ?? selectedCall.contact_phone}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 text-xs">Status</dt>
                  <dd className="text-slate-200">
                    {selectedCall.call_status ?? "—"}
                    {selectedCall.call_duration_seconds
                      ? ` · ${formatDuration(selectedCall.call_duration_seconds)}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 text-xs">Outcome</dt>
                  <dd className="text-slate-200">
                    {selectedCall.call_outcome ? (
                      <span
                        className={`inline-flex text-xs px-2 py-0.5 rounded border ${callOutcomeBadge(selectedCall.call_outcome)}`}
                      >
                        {callOutcomeLabel(selectedCall.call_outcome)}
                      </span>
                    ) : (
                      "Not labeled yet"
                    )}
                  </dd>
                </div>
                {selectedCall.notes && (
                  <div>
                    <dt className="text-slate-500 text-xs">Saved remarks</dt>
                    <dd className="text-slate-300 text-sm whitespace-pre-wrap">{selectedCall.notes}</dd>
                  </div>
                )}
              </dl>
              <CallRecordingPanel
                call={selectedCall}
                onError={onError}
                onUpdated={(updated) => {
                  setHistory((prev) =>
                    prev.map((c) => (c.id === updated.id ? updated : c)),
                  );
                }}
              />
              <CallRemarksForm
                remarks={remarksDraft}
                outcome={outcomeDraft}
                onRemarksChange={setRemarksDraft}
                onOutcomeChange={setOutcomeDraft}
                onSave={() => void saveFollowUp()}
                saving={savingFollowUp}
                saveLabel="Save remarks"
              />
              <button
                type="button"
                onClick={() => void deleteCall(selectedCall)}
                disabled={deletingCallId === selectedCall.id}
                className="w-full px-3 py-2 rounded-lg bg-red-900/40 hover:bg-red-900/60 border border-red-800/50 text-sm text-red-200 disabled:opacity-50"
              >
                {deletingCallId === selectedCall.id ? "Deleting…" : "Delete call log"}
              </button>
            </>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-600">
        How it works: click Call → allow microphone → talk to the client directly from your browser.
        They see your Twilio number as caller ID. Calls are recorded automatically — play, download,
        and read closed captions (CC) in the call detail panel after the call ends.
      </p>
      {phonePicker ? (
        <CallPhonePicker
          leadId={phonePicker.lead.id}
          companyName={phonePicker.lead.company_name ?? `Lead #${phonePicker.lead.id}`}
          phones={phonePicker.phones}
          onClose={() => setPhonePicker(null)}
          onError={onError}
        />
      ) : null}
    </section>
  );
}
