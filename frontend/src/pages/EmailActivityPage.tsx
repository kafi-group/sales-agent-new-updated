import { useCallback, useEffect, useState } from "react";
import {
  client,
  type EmailActivityEvent,
  type EmailActivityInsights,
  type EmailActivityModeStats,
} from "../api/client";
import { Pagination } from "../components/Pagination";
import { BulkResultsModal } from "../components/BulkResultsModal";
import { classifyWhatsAppFailure } from "../utils/whatsappFailure";
import { useAuth } from "../auth/AuthContext";

interface EmailActivityPageProps {
  onError: (message: string) => void;
  onUnreadChange?: (count: number) => void;
  /** email = Mail → Email Activity; whatsapp = WhatsApp → WhatsApp Activity */
  channel?: "email" | "whatsapp";
  /** Open a contact (lead profile) from a result row — used by "View results" and "Open contact". */
  onOpenLead?: (buyerId: number) => void;
}

const PAGE_SIZE = 25;
const POLL_MS = 12_000;

type InsightsPreset = 1 | 7 | 30 | 90 | null | "range";

function isoDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultRangeBounds(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  return { from: isoDateLocal(from), to: isoDateLocal(to) };
}

function severityClasses(severity: string) {
  switch (severity) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-100";
    default:
      return "border-slate-700 bg-slate-900 text-slate-200";
  }
}

function formatWhen(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const WHATSAPP_EVENT_LABELS: Record<string, string> = {
  sent: "Sent",
  send_failed: "Failed",
  bulk_started: "Bulk started",
  bulk_completed: "Bulk completed",
  bulk_partial: "Bulk partial",
  invalid_recipient: "Invalid recipient",
};

function activityEventLabel(event: EmailActivityEvent, isWhatsApp: boolean): string {
  if (!isWhatsApp) return event.event_label;
  // WhatsApp feed: never show email catalog labels — derive from event_type only.
  return WHATSAPP_EVENT_LABELS[event.event_type] ?? event.event_type.replace(/_/g, " ");
}

function detailStr(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function detailNum(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function isBulkCampaignEvent(event: EmailActivityEvent): boolean {
  const details = (event.details || {}) as Record<string, unknown>;
  if (event.event_type === "bulk_partial" || event.event_type === "bulk_completed") {
    return true;
  }
  if (event.event_type === "bulk_started") return true;
  if (
    event.event_type === "send_failed" &&
    (detailNum(details, "sent_count") != null ||
      detailNum(details, "failed_count") != null ||
      detailNum(details, "selected_count") != null)
  ) {
    return true;
  }
  return false;
}

function failureRowsFromDetails(
  details: Record<string, unknown>,
): Array<{ to_email: string | null; company_name: string | null; error: string | null }> {
  const raw = details.failures;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      to_email:
        typeof row.to_email === "string"
          ? row.to_email
          : typeof row.email === "string"
            ? row.email
            : null,
      company_name: typeof row.company_name === "string" ? row.company_name : null,
      error:
        typeof row.error === "string"
          ? row.error
          : typeof row.send_message === "string"
            ? row.send_message
            : typeof row.message === "string"
              ? row.message
              : null,
    }))
    .filter((row) => row.to_email || row.company_name);
}

function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  onClick,
  active,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "good" | "bad" | "accent";
  onClick?: () => void;
  active?: boolean;
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-100"
      : tone === "bad"
        ? "border-red-500/25 bg-red-500/10 text-red-100"
        : tone === "accent"
          ? "border-sky-500/25 bg-sky-500/10 text-sky-100"
          : "border-slate-700/80 bg-slate-950/60 text-slate-100";
  const interactive = Boolean(onClick);
  const className = `rounded-xl border px-3.5 py-3 text-left w-full ${toneClass} ${
    interactive
      ? "cursor-pointer hover:ring-1 hover:ring-emerald-400/40 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
      : ""
  } ${active ? "ring-2 ring-emerald-400/60" : ""}`;
  const body = (
    <>
      <p className="text-[11px] uppercase tracking-[0.12em] opacity-70">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs opacity-65">{hint}</p> : null}
      {interactive ? (
        <p className="mt-1.5 text-[10px] uppercase tracking-wide opacity-50">Click for list</p>
      ) : null}
    </>
  );
  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={className}
        title={`Show ${label.toLowerCase()} contacts and emails`}
      >
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

function ModeBlock({
  title,
  subtitle,
  stats,
  showBatches,
  showOpens = true,
  sendMode,
  activeEventType,
  onStatClick,
}: {
  title: string;
  subtitle: string;
  stats: EmailActivityModeStats;
  showBatches?: boolean;
  /** Email open-pixel stats — hide for WhatsApp. */
  showOpens?: boolean;
  sendMode: "individual" | "bulk";
  activeEventType: string | null;
  onStatClick?: (
    eventType: "sent" | "failed" | "opened" | "replied",
    sendMode: "individual" | "bulk",
  ) => void;
}) {
  const activeMode = activeEventType?.startsWith(`${sendMode}:`)
    ? activeEventType.slice(sendMode.length + 1)
    : null;
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-medium text-slate-100">{title}</h4>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {showBatches ? (
          <StatTile
            label="Batches"
            value={stats.batches ?? 0}
            hint={`${stats.batches_partial ?? 0} partial · ${stats.batches_failed ?? 0} failed`}
            tone="accent"
          />
        ) : null}
        <StatTile
          label="Sent"
          value={stats.sent}
          hint={`${stats.success_rate_pct}% success`}
          tone="good"
          active={activeMode === "sent"}
          onClick={onStatClick ? () => onStatClick("sent", sendMode) : undefined}
        />
        <StatTile
          label="Failed"
          value={stats.failed}
          tone="bad"
          active={activeMode === "failed"}
          onClick={onStatClick ? () => onStatClick("failed", sendMode) : undefined}
        />
        {showOpens ? (
          <>
            <StatTile
              label="Opened"
              value={stats.opened}
              hint={`${stats.open_rate_pct}% of sent`}
              tone="accent"
              active={activeMode === "opened"}
              onClick={onStatClick ? () => onStatClick("opened", sendMode) : undefined}
            />
            <StatTile
              label="Replies"
              value={stats.replied ?? 0}
              hint={`${stats.reply_rate_pct ?? 0}% of sent`}
              tone="good"
              active={activeMode === "replied"}
              onClick={onStatClick ? () => onStatClick("replied", sendMode) : undefined}
            />
            <StatTile label="Not opened" value={stats.not_opened} />
          </>
        ) : null}
        <StatTile label="Attempted" value={stats.attempted} />
      </div>
    </div>
  );
}

export function EmailActivityPage({
  onError,
  onUnreadChange,
  channel = "email",
  onOpenLead,
}: EmailActivityPageProps) {
  const { isAdmin } = useAuth();
  const isWhatsApp = channel === "whatsapp";
  const [resultsEventId, setResultsEventId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<EmailActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  // Insights open by default for email so mailer + in-app sends are easy to review.
  const [showInsights, setShowInsights] = useState(channel === "email");
  const [insightsPeriod, setInsightsPeriod] = useState<InsightsPreset>(30);
  const [rangeFrom, setRangeFrom] = useState(() => defaultRangeBounds().from);
  const [rangeTo, setRangeTo] = useState(() => defaultRangeBounds().to);
  const [insights, setInsights] = useState<EmailActivityInsights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  /** e.g. individual:sent | bulk:opened — filters the feed below. */
  const [insightDrillKey, setInsightDrillKey] = useState<string | null>(null);
  const [aiPanel, setAiPanel] = useState<{
    title: string;
    content: string;
  } | null>(null);
  const [aiLoading, setAiLoading] = useState<"analysis" | "suggestions" | null>(null);

  const drillSendMode = insightDrillKey?.split(":")[0] as "individual" | "bulk" | undefined;
  const drillEventType = insightDrillKey?.split(":")[1] || undefined;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const windowParams =
        insightDrillKey && insightsPeriod === "range"
          ? { date_from: rangeFrom || undefined, date_to: rangeTo || undefined }
          : insightDrillKey && insightsPeriod != null && insightsPeriod !== "range"
            ? { days: insightsPeriod }
            : {};
      const result = await client.listEmailActivity({
        page,
        page_size: PAGE_SIZE,
        channel,
        event_type: drillEventType,
        send_mode: drillSendMode,
        ...windowParams,
      });
      setRows(result.rows);
      setTotal(result.total);
      setTotalPages(result.total_pages);
      setUnreadCount(result.unread_count);
      onUnreadChange?.(result.unread_count);
    } catch (e) {
      onError(
        e instanceof Error
          ? e.message
          : isWhatsApp
            ? "Failed to load WhatsApp activity"
            : "Failed to load email activity",
      );
    } finally {
      setLoading(false);
    }
  }, [
    channel,
    drillEventType,
    drillSendMode,
    insightDrillKey,
    insightsPeriod,
    isWhatsApp,
    onError,
    onUnreadChange,
    page,
    rangeFrom,
    rangeTo,
  ]);

  const refreshInsights = useCallback(async () => {
    if (insightsPeriod === "range" && !rangeFrom && !rangeTo) {
      return;
    }
    setInsightsLoading(true);
    try {
      const result =
        insightsPeriod === "range"
          ? await client.getEmailActivityInsights({
              date_from: rangeFrom || undefined,
              date_to: rangeTo || undefined,
              channel,
            })
          : await client.getEmailActivityInsights({
              days: insightsPeriod,
              channel,
            });
      setInsights(result);
    } catch (e) {
      onError(
        e instanceof Error
          ? e.message
          : isWhatsApp
            ? "Failed to load WhatsApp insights"
            : "Failed to load email insights",
      );
    } finally {
      setInsightsLoading(false);
    }
  }, [channel, insightsPeriod, isWhatsApp, onError, rangeFrom, rangeTo]);

  useEffect(() => {
    setPage(1);
    setInsights(null);
    setInsightDrillKey(null);
    // Email keeps insights open by default; WhatsApp starts collapsed until clicked.
    setShowInsights(channel === "email");
  }, [channel]);

  function handleInsightStatClick(
    eventType: "sent" | "failed" | "opened" | "replied",
    sendMode: "individual" | "bulk",
  ) {
    const key = `${sendMode}:${eventType}`;
    setInsightDrillKey((prev) => (prev === key ? null : key));
    setPage(1);
    setShowInsights(true);
    // Scroll feed into view so users see the contact/email list.
    window.setTimeout(() => {
      document.getElementById("email-activity-feed")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 50);
  }

  function insightsAiParams() {
    if (insightsPeriod === "range") {
      return { date_from: rangeFrom || undefined, date_to: rangeTo || undefined };
    }
    if (insightsPeriod == null) return { days: null as number | null };
    return { days: insightsPeriod };
  }

  async function runAiAnalysis() {
    setAiLoading("analysis");
    try {
      const result = await client.analyzeEmailActivity(insightsAiParams());
      setAiPanel({ title: result.title || "AI analysis", content: result.content });
    } catch (e) {
      onError(e instanceof Error ? e.message : "AI analysis failed");
    } finally {
      setAiLoading(null);
    }
  }

  async function runImproveSuggestions() {
    setAiLoading("suggestions");
    try {
      const result = await client.suggestEmailActivityImprovements(insightsAiParams());
      setAiPanel({
        title: result.title || "Suggestion to improve email",
        content: result.content,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Suggestions failed");
    } finally {
      setAiLoading(null);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!showInsights) return;
    void refreshInsights();
  }, [showInsights, refreshInsights]);

  async function markAllRead() {
    try {
      await client.markEmailActivityRead({ mark_all: true, channel });
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to mark notifications read");
    }
  }

  async function markOneRead(eventId: number) {
    if (eventId < 0) return;
    try {
      await client.markEmailActivityRead({ event_ids: [eventId], channel });
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to mark notification read");
    }
  }

  return (
    <section className="space-y-5 w-full min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-slate-100">
            {isWhatsApp ? "WhatsApp Activity" : "Email Activity"}
          </h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            {isWhatsApp
              ? isAdmin
                ? "Outbound WhatsApp for all users — replies, templates, and bulk campaigns. Use Insights for sent / failed (individual vs bulk)."
                : "Your outbound WhatsApp — replies, templates, and bulk campaigns. Use Insights for sent / failed (individual vs bulk)."
              : isAdmin
                ? "Outbound email for all users — compose, bulk mailer, and in-app sends. Use Insights for sent / failed / opened (individual vs bulk)."
                : "Your outbound email — compose, bulk mailer, and in-app sends. Use Insights for sent / failed / opened (individual vs bulk)."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowInsights((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm border ${
              showInsights
                ? "bg-sky-600 border-sky-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {showInsights ? "Hide insights" : "Insights"}
          </button>
          {!isWhatsApp ? (
            <>
              <button
                type="button"
                onClick={() => void runAiAnalysis()}
                disabled={aiLoading !== null}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-300 disabled:opacity-40"
              >
                {aiLoading === "analysis" ? "Analyzing…" : "AI analysis"}
              </button>
              <button
                type="button"
                onClick={() => void runImproveSuggestions()}
                disabled={aiLoading !== null}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-300 disabled:opacity-40"
              >
                {aiLoading === "suggestions" ? "Working…" : "Suggestion to improve email"}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void refresh();
              if (showInsights) void refreshInsights();
            }}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className={`flex flex-wrap gap-3 text-sm ${isWhatsApp ? "hidden" : ""}`}>
        <span className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-slate-300">
          {total} event{total === 1 ? "" : "s"}
        </span>
        <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-200">
          {unreadCount} unread
        </span>
        {unreadCount > 0 ? (
          <button
            type="button"
            onClick={() => void markAllRead()}
            className="rounded-lg border border-slate-700 px-3 py-2 text-slate-300 hover:bg-slate-800"
            title={
              isAdmin
                ? "Clear the unread count for ALL users (events stay in the list)"
                : "Clear your unread count (events stay in the list)"
            }
          >
            Mark all read
          </button>
        ) : null}
      </div>

      {showInsights && (
        <div className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-slate-100">
                {isWhatsApp ? "WhatsApp insights" : "Email insights"}
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-xl">
                {isWhatsApp
                  ? "Sent vs failed WhatsApp messages, split by individual replies and bulk template campaigns."
                  : "Sent vs failed, opened, replies — split by individual and bulk outreach."}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex flex-wrap justify-end gap-1.5">
                {(
                  [
                    [1, "Daily"],
                    [7, "7d"],
                    [30, "30d"],
                    [90, "90d"],
                    [null, "All"],
                    ["range", "Range"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      if (value === "range") {
                        const bounds = defaultRangeBounds();
                        setRangeFrom((prev) => prev || bounds.from);
                        setRangeTo((prev) => prev || bounds.to);
                      }
                      setInsightsPeriod(value);
                    }}
                    className={`px-2.5 py-1 rounded-md text-xs border ${
                      insightsPeriod === value
                        ? "bg-sky-600 border-sky-500 text-white"
                        : "bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {insightsPeriod === "range" ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>From</span>
                    <input
                      type="date"
                      value={rangeFrom}
                      max={rangeTo || undefined}
                      onChange={(e) => setRangeFrom(e.target.value)}
                      className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>To</span>
                    <input
                      type="date"
                      value={rangeTo}
                      min={rangeFrom || undefined}
                      onChange={(e) => setRangeTo(e.target.value)}
                      className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </div>

          {insightsLoading && !insights ? (
            <p className="text-sm text-slate-400">Loading insights…</p>
          ) : insights ? (
            <>
              <div
                className={`grid gap-2.5 sm:grid-cols-2 ${
                  isWhatsApp ? "lg:grid-cols-3" : "lg:grid-cols-6"
                }`}
              >
                <StatTile label="Total sent" value={insights.totals.sent} tone="good" />
                <StatTile label="Total failed" value={insights.totals.failed} tone="bad" />
                {!isWhatsApp ? (
                  <>
                    <StatTile
                      label="Opened"
                      value={insights.totals.opened}
                      hint={`${insights.totals.open_rate_pct}% open rate`}
                      tone="accent"
                    />
                    <StatTile
                      label="Replies"
                      value={insights.totals.replied ?? 0}
                      hint={`${insights.totals.reply_rate_pct ?? 0}% reply rate`}
                      tone="good"
                    />
                    <StatTile label="Not opened" value={insights.totals.not_opened} />
                  </>
                ) : null}
                <StatTile
                  label="Success rate"
                  value={`${insights.totals.success_rate_pct}%`}
                  hint={`${insights.totals.attempted} attempted`}
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <ModeBlock
                  title={isWhatsApp ? "Individual WhatsApp" : "Individual emails"}
                  subtitle={
                    isWhatsApp
                      ? "One-off replies and personal messages"
                      : "One-off sends — click Sent / Failed / Opened / Replies for the list"
                  }
                  stats={insights.individual}
                  showOpens={!isWhatsApp}
                  sendMode="individual"
                  activeEventType={insightDrillKey}
                  onStatClick={handleInsightStatClick}
                />
                <ModeBlock
                  title={isWhatsApp ? "Bulk WhatsApp" : "Bulk emails"}
                  subtitle={
                    isWhatsApp
                      ? "Template campaigns from Leads / WhatsApp compose"
                      : "Multi-recipient campaigns — click Sent / Failed / Opened / Replies for the list"
                  }
                  stats={insights.bulk}
                  showBatches
                  showOpens={!isWhatsApp}
                  sendMode="bulk"
                  activeEventType={insightDrillKey}
                  onStatClick={handleInsightStatClick}
                />
              </div>

              {insightDrillKey ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-emerald-200/90 border border-emerald-500/25 bg-emerald-500/10 rounded-lg px-3 py-2">
                  <span>
                    Showing{" "}
                    <strong className="uppercase">{drillEventType}</strong> ·{" "}
                    <strong>{drillSendMode}</strong> ({total}{" "}
                    {drillSendMode === "bulk" && drillEventType === "failed"
                      ? "campaigns / failed addresses"
                      : drillSendMode === "bulk" && drillEventType === "sent"
                        ? "batch/events"
                        : "in list"}
                    {insightsPeriod === "range"
                      ? ` · ${rangeFrom || "…"} → ${rangeTo || "…"}`
                      : insightsPeriod
                        ? ` · last ${insightsPeriod}d`
                        : " · all time"}
                    )
                  </span>
                  <button
                    type="button"
                    className="underline decoration-dotted hover:text-white"
                    onClick={() => {
                      setInsightDrillKey(null);
                      setPage(1);
                    }}
                  >
                    Clear filter
                  </button>
                </div>
              ) : null}

              {isWhatsApp ? (
                <p className="text-xs text-slate-500">
                  Counts Meta Cloud API sends recorded in this feed (free-text inside the 24h
                  window and approved templates). Failed includes invalid numbers, template
                  rejections, and API errors.
                </p>
              ) : !insights.tracking_enabled ? (
                <p className="text-xs text-amber-200/80 border border-amber-500/20 bg-amber-500/10 rounded-lg px-3 py-2">
                  Open tracking needs a public API URL on Railway (`PUBLIC_API_BASE_URL` or
                  `TWILIO_WEBHOOK_BASE_URL`). Opens will stay at 0 until that is configured.
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Opens count when the tracking pixel loads (after a short grace period so
                  Gmail’s image proxy doesn’t mark every delivery as opened). Replies are
                  detected from your Inbox when the sender matches someone you emailed.
                  Self-tests to your own addresses often inflate opens — both messages can
                  load pixels when you view the thread.
                  {insights.tracking_base_url ? (
                    <>
                      {" "}
                      Pixel host:{" "}
                      <span className="text-slate-400 font-mono">{insights.tracking_base_url}</span>
                      .
                    </>
                  ) : null}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-400">No insight data yet.</p>
          )}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-slate-400">
          {isWhatsApp ? "Loading WhatsApp activity…" : "Loading email activity…"}
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center">
          <p className="text-slate-300 font-medium">
            {isWhatsApp ? "No WhatsApp activity yet" : "No email activity yet"}
          </p>
          <p className="text-sm text-slate-500 mt-2">
            {isWhatsApp
              ? "Send a WhatsApp template campaign or reply — results show up here."
              : "Send from Leads (Send emails / mailer) or Mail compose — successful and failed sends appear here and in Insights."}
          </p>
        </div>
      ) : (
        <ul id="email-activity-feed" className="space-y-3">
          {rows.map((event) => {
            const unread = !event.read_at;
            const details = (event.details || {}) as Record<string, unknown>;
            const toEmail =
              detailStr(details, "to_email") || detailStr(details, "recipient");
            const company = detailStr(details, "company_name");
            const subject = detailStr(details, "subject");
            const mailboxEmail = detailStr(details, "mailbox_email");
            const source = detailStr(details, "source") || detailStr(details, "mode");
            const sentCount = detailNum(details, "sent_count");
            const failedCount = detailNum(details, "failed_count");
            const selectedCount = detailNum(details, "selected_count");
            const bulkCampaign = isBulkCampaignEvent(event);
            const failureRows = failureRowsFromDetails(details);
            return (
              <li
                key={event.id}
                className={`rounded-xl border p-4 ${severityClasses(event.severity)} ${
                  unread ? "ring-1 ring-emerald-500/20" : "opacity-90"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] uppercase tracking-wide text-white/80">
                        {activityEventLabel(event, isWhatsApp)}
                      </span>
                      {bulkCampaign ? (
                        <span className="text-[10px] uppercase tracking-wide rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-100">
                          Campaign summary
                        </span>
                      ) : null}
                      {unread && (
                        <span className="text-[10px] uppercase tracking-wide rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-200">
                          New
                        </span>
                      )}
                      {isAdmin && (event.user_full_name || event.user_username) ? (
                        <span className="text-[10px] uppercase tracking-wide rounded bg-slate-950/40 px-1.5 py-0.5 opacity-80">
                          {event.user_full_name || event.user_username}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm font-medium mt-1">{event.title}</p>
                    {bulkCampaign ? (
                      <div className="mt-2 space-y-1 text-xs text-slate-300">
                        <p>
                          This is a <strong>bulk campaign rollup</strong>
                          {source ? ` (${source})` : ""} — not a single recipient.
                          {selectedCount != null
                            ? ` ${selectedCount} leads selected`
                            : ""}
                          {sentCount != null || failedCount != null
                            ? ` · ${sentCount ?? 0} sent · ${failedCount ?? 0} failed`
                            : ""}
                          .
                        </p>
                        {event.id > 0 ? (
                          <button
                            type="button"
                            onClick={() => setResultsEventId(event.id)}
                            className="mt-1 inline-flex items-center rounded-lg bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-medium text-white"
                            title="See which contacts were sent, failed or skipped"
                          >
                            View results
                          </button>
                        ) : null}
                        {mailboxEmail ? (
                          <p>
                            From:{" "}
                            <span className="font-mono text-cyan-200/90">{mailboxEmail}</span>
                          </p>
                        ) : (
                          <p className="text-slate-500">
                            From mailbox was not stored on this older event (sender:{" "}
                            {event.user_full_name || event.user_username || "unknown"}).
                          </p>
                        )}
                        {subject ? (
                          <p className="truncate" title={subject}>
                            Subject: <span className="text-slate-200">{subject}</span>
                          </p>
                        ) : null}
                        {failureRows.length > 0 ? (
                          <div className="mt-2 rounded-lg border border-red-500/20 bg-red-950/30 px-2.5 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-red-200/80 mb-1">
                              Failed recipients
                            </p>
                            <ul className="space-y-1">
                              {failureRows.slice(0, 8).map((row, idx) => (
                                <li key={`${row.to_email || row.company_name}-${idx}`}>
                                  {row.company_name ? (
                                    <strong className="text-red-100">{row.company_name}</strong>
                                  ) : null}
                                  {row.company_name && row.to_email ? " · " : null}
                                  {row.to_email ? (
                                    <span className="font-mono text-red-100/90">
                                      {row.to_email}
                                    </span>
                                  ) : null}
                                  {row.error ? (
                                    <span className="text-slate-400"> — {row.error}</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                            {failureRows.length > 8 ? (
                              <p className="mt-1 text-slate-500">
                                +{failureRows.length - 8} more
                              </p>
                            ) : null}
                          </div>
                        ) : failedCount != null && failedCount > 0 ? (
                          <p className="text-amber-200/80">
                            {failedCount} address(es) failed in this campaign, but per-address
                            detail was not stored for this older send. New bulk sends will list
                            each failed email here.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        {(company || toEmail || mailboxEmail) && (
                          <div className="mt-1 space-y-0.5 text-sm">
                            {(company || toEmail) && (
                              <p className="text-cyan-200/90">
                                {company ? <strong>{company}</strong> : null}
                                {company && toEmail ? " · " : null}
                                {toEmail ? (
                                  <span className="font-mono text-xs">{toEmail}</span>
                                ) : null}
                              </p>
                            )}
                            {mailboxEmail ? (
                              <p className="text-xs text-slate-400">
                                From:{" "}
                                <span className="font-mono text-slate-300">{mailboxEmail}</span>
                              </p>
                            ) : null}
                          </div>
                        )}
                        {subject ? (
                          <p className="text-xs text-slate-300 mt-1 truncate" title={subject}>
                            Subject: {subject}
                          </p>
                        ) : null}
                      </>
                    )}
                    {!bulkCampaign ? (
                      <p className="text-sm opacity-90 mt-1 whitespace-pre-wrap">{event.message}</p>
                    ) : null}
                    {isWhatsApp && !bulkCampaign && event.event_type === "send_failed"
                      ? (() => {
                          const info = classifyWhatsAppFailure(event.message);
                          if (info.key === "other") return null;
                          return (
                            <p className="mt-1.5 text-xs text-slate-400">
                              <span className="inline-block mr-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-red-200">
                                {info.label}
                              </span>
                              {info.hint}
                            </p>
                          );
                        })()
                      : null}
                    {!bulkCampaign && event.buyer_id && onOpenLead ? (
                      <button
                        type="button"
                        onClick={() => onOpenLead(event.buyer_id as number)}
                        className="mt-2 inline-flex items-center rounded-lg bg-sky-600/80 hover:bg-sky-500 px-3 py-1 text-xs font-medium text-white"
                        title="Open this contact to edit it"
                      >
                        Open contact
                      </button>
                    ) : null}
                    <p className="text-xs opacity-60 mt-2">{formatWhen(event.created_at)}</p>
                  </div>
                  {!isWhatsApp && unread && event.id > 0 && (
                    <button
                      type="button"
                      onClick={() => void markOneRead(event.id)}
                      className="shrink-0 px-2 py-1 rounded bg-black/20 hover:bg-black/30 text-xs"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {resultsEventId != null ? (
        <BulkResultsModal
          eventId={resultsEventId}
          onClose={() => setResultsEventId(null)}
          onError={onError}
          onOpenLead={onOpenLead}
        />
      ) : null}

      {aiPanel ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setAiPanel(null)}
          role="presentation"
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="email-activity-ai-title"
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <h3 id="email-activity-ai-title" className="text-base font-medium text-slate-100">
                {aiPanel.title}
              </h3>
              <button
                type="button"
                onClick={() => setAiPanel(null)}
                className="px-2 py-1 rounded-md text-xs border border-slate-700 text-slate-400 hover:text-slate-200"
              >
                Close
              </button>
            </div>
            <pre className="whitespace-pre-wrap text-sm text-slate-300 font-sans leading-relaxed">
              {aiPanel.content}
            </pre>
          </div>
        </div>
      ) : null}

      {total > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          disabled={loading}
        />
      )}
    </section>
  );
}
