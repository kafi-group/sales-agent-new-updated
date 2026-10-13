/**
 * Single API client for the FastAPI backend.
 * All pages/hooks must call through here — never scatter fetch() elsewhere.
 *
 * Auth: httpOnly cookie `kafi_session` (credentials: include) via same-origin /api
 * proxy on Vercel. Optional legacy Bearer from localStorage during migration.
 */

import { clearSession, getStoredToken } from "../auth/session";

/**
 * Prefer relative `/api` (Vercel rewrite / Vite proxy) so cookies stay same-site.
 * Normalizes common misconfigs like a bare hostname without https:// which the
 * browser would treat as a path on the current origin (causing 405 on login).
 */
function resolveApiBase(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value || value === "/" || value === "/api" || value === "/api/") {
    return "/api";
  }
  // Bare host → absolute https URL
  let base = value;
  if (!/^https?:\/\//i.test(base) && !base.startsWith("/")) {
    base = `https://${base.replace(/^\/+/, "")}`;
  }
  // Absolute Railway (or other) host without /api suffix
  if (/^https?:\/\//i.test(base)) {
    const trimmed = base.replace(/\/+$/, "");
    if (!/\/api$/i.test(trimmed)) {
      return `${trimmed}/api`;
    }
    return trimmed;
  }
  // Relative path — keep leading slash, drop trailing
  const rel = base.startsWith("/") ? base : `/${base}`;
  return rel.replace(/\/+$/, "") || "/api";
}

const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL);

/** Session gate for AI Sales Agent module (cleared when browser tab closes). */
export const AI_SALES_AGENT_CODE_KEY = "kafi_ai_sales_agent_code";

export function getAiSalesAgentAccessCode(): string | null {
  try {
    return sessionStorage.getItem(AI_SALES_AGENT_CODE_KEY);
  } catch {
    return null;
  }
}

export function setAiSalesAgentAccessCode(code: string): void {
  sessionStorage.setItem(AI_SALES_AGENT_CODE_KEY, code);
}

export function isTransientApiError(message: string): boolean {
  return /502|503|504|networkerror|fetch failed|timeout/i.test(message);
}

function aiSalesAgentHeaders(): HeadersInit {
  const code = getAiSalesAgentAccessCode();
  return code ? { "X-AI-Sales-Agent-Code": code } : {};
}

/** External quotation agent (separate app). */
const _quotationAgentEnv = String(import.meta.env.VITE_QUOTATION_AGENT_URL || "").trim();
export const QUOTATION_AGENT_URL =
  _quotationAgentEnv && !_quotationAgentEnv.includes("bank-recon-demo")
    ? _quotationAgentEnv
    : "https://kafiai-agents.vercel.app/cnf";

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = getStoredToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function parseErrorDetail(text: string, fallback: string): string {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (Array.isArray(parsed.detail)) {
      return parsed.detail
        .map((item) => (typeof item === "object" && item && "msg" in item ? String((item as { msg: unknown }).msg) : String(item)))
        .join("; ");
    }
  } catch {
    /* plain text */
  }
  return text;
}

/** Shown instead of raw 500 / "Internal Server Error" copy. */
export const HARD_RESTART_MESSAGE =
  "Please hard restart the screen (Ctrl + Shift + R) and wait 10 seconds before trying again.";

function looksLikeInternalServerError(message: string): boolean {
  return /internal\s*server\s*error/i.test(message);
}

/** Rewrite server-fault copy for UI — never surface "Internal Server Error". */
export function sanitizeUserFacingError(message: unknown): string {
  let str = "";
  if (typeof message === "string") {
    str = message;
  } else if (message && typeof message === "object") {
    if ("message" in message && typeof (message as { message?: unknown }).message === "string") {
      str = (message as { message: string }).message;
    } else if ("detail" in message) {
      const detail = (message as { detail?: unknown }).detail;
      if (typeof detail === "string") str = detail;
      else if (Array.isArray(detail)) {
        str = detail.map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d))).join("; ");
      } else str = JSON.stringify(detail);
    } else {
      str = JSON.stringify(message);
    }
  } else {
    str = String(message || "");
  }

  const trimmed = (str || "").trim();
  if (!trimmed || trimmed === "[object Object]") return HARD_RESTART_MESSAGE;
  if (looksLikeInternalServerError(trimmed)) return HARD_RESTART_MESSAGE;
  if (/^upstream\s*500\b/i.test(trimmed) || /^error\s*500\b/i.test(trimmed)) {
    return HARD_RESTART_MESSAGE;
  }
  return trimmed;
}

function messageForHttpError(status: number, text: string, statusText: string): string {
  if (status === 500) return HARD_RESTART_MESSAGE;
  if (status === 413) {
    return (
      "File is too large for the upload gateway. Keep each attachment under 24 MB " +
      "(Gmail and most mailboxes reject messages around 25 MB total)."
    );
  }
  const parsed = parseErrorDetail(text, statusText || `Request failed (${status})`);
  return sanitizeUserFacingError(parsed);
}

/** Direct Railway API — used for small single-shot uploads when same-origin proxy is fine to skip. */
const RAILWAY_API_BASE = "https://kafi-sales-agent-production.up.railway.app/api";

/** Email providers reject ~25 MB total messages; keep each file under this. */
export const EMAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Chunk size for uploads through the Vercel /api rewrite (~4.5 MB body limit). */
const ATTACHMENT_CHUNK_BYTES = 2.5 * 1024 * 1024;

/** Per-chunk / single-shot upload timeout (large files on slow links need headroom). */
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 180_000;

export interface VoiceEngineSettings {
  vapi_enabled: boolean;
  vapi_key_configured: boolean;
  elevenlabs_enabled: boolean;
  elevenlabs_key_masked: string | null;
  has_elevenlabs_key: boolean;
}

export interface OrgAdminMasterList {
  key: string;
  label: string;
  enabled: boolean;
  sort_order: number;
}

export interface OrgAdminUserRow {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
}

export interface OrgAdminAiSalesAgent {
  id: string;
  name: string;
  active: boolean;
  product_focus: string;
  voice: string;
  gender_label: string;
  protected: boolean;
}

export interface OrgAdminSnapshot {
  master_lists: OrgAdminMasterList[];
  user_master_access: Record<string, string[]>;
  agent_master_access?: Record<string, string[]>;
  ai_sales_agents: OrgAdminAiSalesAgent[];
}

export interface AiTrainingData {
  last_trained_at: string | null;
  total_calls_analyzed: number;
  selected_calls_used?: number;
  last_train_source?: string | null;
  learned_insights: string;
  custom_rules: string;
}

export interface AiTrainingSelectedCall {
  id: number;
  buyer_id?: number | null;
  company_name?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  subject?: string | null;
  call_outcome?: string | null;
  notes?: string | null;
  created_at?: string | null;
  recording_available?: boolean;
  transcript_status?: string | null;
  persona?: "male" | "female" | null;
  ai_training_selected?: boolean;
}

export interface AiTrainingSelectedCallsResponse {
  total: number;
  rows: AiTrainingSelectedCall[];
}

export interface EnrichmentColumnAnalysis {
  field_key: string;
  field_label: string;
  db_populated_count: number;
  db_missing_count: number;
  file_populated_count: number;
  new_fill_count: number;
  protected_count: number;
}

export interface SampleFillPreview {
  company_name: string;
  field_name: string;
  new_value: string;
}

export interface EnrichmentComparisonReport {
  user_name: string;
  table_source: string;
  filename: string;
  db_total_contacts: number;
  uploaded_file_contacts: number;
  matched_contacts_count: number;
  unmatched_contacts_count: number;
  total_potential_new_fills: number;
  column_analysis: EnrichmentColumnAnalysis[];
  sample_fills: SampleFillPreview[];
}

export interface SafeMergeResult {
  status: string;
  contacts_updated: number;
  total_fields_filled: number;
  protected_fields_count: number;
  message: string;
}

export interface MissingRowDetail {
  id: number;
  legacy_serial_no: number;
  company_name: string;
  assigned_to: string;
  company_grading: string;
  country: string;
  city: string;
  missing_column_key: string;
  missing_column_label: string;
  website_url: string;
  contact_person: string;
  primary_phone: string;
  primary_email: string;
}

export interface MissingDataReport {
  section: string;
  section_label: string;
  column_key: string;
  column_label: string;
  user_id: number | null;
  user_name: string;
  total_contacts: number;
  missing_count: number;
  populated_count: number;
  missing_percentage: number;
  available_columns: { key: string; label: string }[];
  missing_rows: MissingRowDetail[];
}

/**
 * Timeouts must stay above Railway pool waits + Vercel→Railway hop.
 * A 12s abort used to fire while Postgres pool_timeout (15s) was still waiting,
 * which looked like "API unreachable" even though the backend was alive.
 */
const FETCH_TIMEOUT_MS = 30_000;
const AUTH_FETCH_TIMEOUT_MS = 20_000;
const HEAVY_FETCH_TIMEOUT_MS = 60_000;
/** Large folder / ZIP uploads to Smart Data Clean & Merge. */
const SYNTHESIS_UPLOAD_TIMEOUT_MS = 600_000;
/** Research / onboard: enrichment + website fetch + scoring often exceeds 30s. */
const LEAD_ONBOARD_TIMEOUT_MS = 90_000;
const RETRY_BACKOFF_MS = [600, 1_800, 3_500] as const;

export type ApiRequestOptions = RequestInit & {
  /** Override the path-based client abort timeout. */
  timeoutMs?: number;
  /** Skip GET retries (use for session bootstrap so splash cannot hang). */
  noRetry?: boolean;
  /**
   * Absolute API root (e.g. Railway production). Used when the Vercel /api
   * rewrite still points at a stale host missing newer routes like Auto Trash.
   */
  apiBase?: string;
};

function timeoutForPath(path: string): number {
  if (path.startsWith("/auth/")) return AUTH_FETCH_TIMEOUT_MS;
  if (
    path.startsWith("/leads/table/dedupe") ||
    path.startsWith("/leads/table/cleanup-sparse") ||
    path.startsWith("/leads/table/repair-location-names") ||
    path.startsWith("/leads/table/clean-company-fields") ||
    path.startsWith("/leads/table/unassign") ||
    path.startsWith("/leads/table/cleanup") ||
    path.startsWith("/leads/table/remove-old-client-overlaps")
  ) {
    return 300_000; // bulk repair jobs can take a few minutes under lock waits
  }
  if (
    path.startsWith("/whatsapp-personal/status") ||
    path.startsWith("/whatsapp-personal/team-status") ||
    path.startsWith("/whatsapp-personal/qr") ||
    path.startsWith("/whatsapp-personal/session")
  ) {
    return 10_000;
  }
  if (path.startsWith("/whatsapp-personal/disconnect")) {
    return 12_000;
  }
  if (/^\/leads\/\d+\/(onboard|research|score)(\?|$)/.test(path)) {
    return LEAD_ONBOARD_TIMEOUT_MS;
  }
  if (
    path.startsWith("/email/attachments/chunk") ||
    path.startsWith("/email/attachments/chunk-init") ||
    path.startsWith("/email/attachments/chunk-complete")
  ) {
    return 120_000;
  }
  if (path.startsWith("/data-synthesis/start")) {
    return SYNTHESIS_UPLOAD_TIMEOUT_MS;
  }
  if (
    path.startsWith("/leads/table") ||
    path.startsWith("/leads/discover") ||
    path.startsWith("/leads/import-jobs") ||
    path.startsWith("/data-synthesis") ||
    path.startsWith("/inbox") ||
    path.startsWith("/email") ||
    path.startsWith("/whatsapp") ||
    path.startsWith("/calls")
  ) {
    return HEAVY_FETCH_TIMEOUT_MS;
  }
  return FETCH_TIMEOUT_MS;
}

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function networkErrorMessage(isTimeout: boolean): string {
  if (isTimeout) {
    return "Internet slow, wait a few seconds and refresh again.";
  }
  return "Cannot reach the API right now. Check your connection, then refresh. If this keeps happening, Railway may be restarting.";
}

async function request<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  const {
    timeoutMs: timeoutOverride,
    apiBase: apiBaseOverride,
    noRetry = false,
    ...fetchOptions
  } = options ?? {};
  const headers = new Headers(authHeaders({ "Content-Type": "application/json" }));
  if (fetchOptions.headers) {
    const extra = new Headers(fetchOptions.headers);
    extra.forEach((value, key) => headers.set(key, value));
  }

  const method = (fetchOptions.method || "GET").toUpperCase();
  const canRetry = !noRetry && (method === "GET" || method === "HEAD");
  const timeoutMs = timeoutOverride ?? timeoutForPath(path);
  const maxAttempts = canRetry ? RETRY_BACKOFF_MS.length + 1 : 1;
  const base = (apiBaseOverride || API_BASE).replace(/\/+$/, "");
  let lastNetworkError: Error | null = null;
  let lastWasTimeout = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        ...fetchOptions,
        headers,
        credentials: "include",
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);

      if (isRetryableStatus(res.status) && canRetry && attempt < maxAttempts - 1) {
        lastNetworkError = new Error(`Upstream ${res.status}`);
        lastWasTimeout = false;
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 3_500));
        continue;
      }

      if (res.status === 401 && path !== "/auth/login") {
        clearSession();
        if (!window.location.hash.includes("login")) {
          window.dispatchEvent(new Event("kafi:auth-expired"));
        }
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(messageForHttpError(res.status, text, res.statusText));
      }
      if (res.status === 204) {
        return undefined as T;
      }
      const text = await res.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    } catch (err) {
      window.clearTimeout(timeoutId);
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const message = err instanceof Error ? err.message : String(err);
      const isNetwork =
        isAbort ||
        err instanceof TypeError ||
        /failed to fetch|networkerror|load failed|fetch failed/i.test(message);
      if (isNetwork && canRetry && attempt < maxAttempts - 1) {
        lastNetworkError = err instanceof Error ? err : new Error(message);
        lastWasTimeout = isAbort;
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 3_500));
        continue;
      }
      if (isNetwork) {
        throw new Error(networkErrorMessage(isAbort || lastWasTimeout));
      }
      throw err;
    }
  }

  throw lastNetworkError ?? new Error(networkErrorMessage(lastWasTimeout));
}

export interface InboxMailboxStatus {
  provider: "gmail" | "outlook" | string;
  email: string | null;
  configured: boolean;
}

export interface InboxStatus {
  configured: boolean;
  email: string | null;
  emails: string[];
  mailboxes: InboxMailboxStatus[];
  unread_count: number;
  showing_since: string | null;
}

export interface InboxMessageSummary {
  uid: string;
  folder?: string;
  provider?: string | null;
  subject: string;
  from_email: string | null;
  from_name: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  date: string | null;
  preview: string;
  unread: boolean;
  has_attachments: boolean;
  message_id: string | null;
  in_reply_to?: string | null;
  references?: string | null;
  direction?: "inbound" | "outbound" | string;
}

export interface InboxAttachment {
  filename: string | null;
  size: number | null;
  content_type: string | null;
}

export interface InboxMessageDetail extends InboxMessageSummary {
  to: string[];
  cc: string[];
  bcc?: string[];
  body_text: string | null;
  body_html: string | null;
  attachments: InboxAttachment[];
}

export interface InboxThreadListResponse {
  items: InboxThreadSummary[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export interface InboxMessageListResponse {
  items: InboxMessageSummary[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export interface InboxMailAiQueryResponse {
  answer: string;
  suggested_threads: InboxThreadSummary[];
  unread_count: number;
}

export interface UrgentEmailItem {
  thread_id: string;
  subject: string;
  from_name: string;
  from_email: string;
  latest_date: string;
  days_ago: number;
  hours_ago: number;
  is_overdue: boolean;
  preview: string;
  inquiry_type?: string;
  inquiry_description?: string;
  triage_category: string;
  triage_label: string;
  unread_count: number;
  message_count: number;
  user_id?: number;
  user_name?: string;
  user_full_name?: string;
  mailbox_email?: string;
  folder?: string | null;
}

export interface UrgentEmailsResponse {
  urgent_threads: UrgentEmailItem[];
  count: number;
  error?: string;
}

export interface InboxThreadSummary {
  thread_id: string;
  subject: string;
  participants: string[];
  message_count: number;
  unread_count: number;
  latest_date: string | null;
  latest_preview: string;
  latest_from_email: string | null;
  latest_from_name: string | null;
  has_attachments: boolean;
  provider?: string | null;
  triage_category?: string | null;
  triage_label?: string | null;
}

export interface InboxThreadDetail extends InboxThreadSummary {
  messages: InboxMessageDetail[];
}

export interface InboxReplyResponse {
  status: string;
  message: string;
  to: string | null;
  subject: string | null;
}

export interface InboxComposeResponse {
  status: string;
  message: string;
  to?: string | null;
  subject?: string | null;
  from_email?: string | null;
}

export type MailFolderKey = "inbox" | "sent" | "trash" | "junk" | "archive";

export interface InboxFolderInfo {
  key: MailFolderKey | string;
  imap_name: string | null;
  available: boolean;
  count: number;
  unread_count: number;
}

export interface InboxFoldersResponse {
  configured: boolean;
  folders: InboxFolderInfo[];
}

export interface InboxMoveResponse {
  status: string;
  message: string;
  from_folder?: string | null;
  to_folder?: string | null;
  to_folder_key?: string | null;
  moved_count?: number;
}

export interface InboxEmptyTrashResponse {
  status: string;
  message: string;
  deleted_count: number;
}

export interface AutoTrashSettings {
  user_id: number;
  enabled: boolean;
  last_scan_at: string | null;
  updated_at: string | null;
  profile_ready: boolean;
  samples_seen: number;
  last_learned_at: string | null;
  can_auto_trash: boolean;
}

export interface AutoTrashDailyLogUser {
  user_id: number;
  username: string;
  full_name: string | null;
  mailbox_email: string | null;
  count: number;
}

export interface AutoTrashDailyLogDay {
  date: string;
  total: number;
  users: AutoTrashDailyLogUser[];
}

export interface AutoTrashDailyLogResponse {
  days: AutoTrashDailyLogDay[];
  since: string;
}

export interface AutoTrashLearnResponse {
  ok: boolean;
  ready: boolean;
  samples_seen: number;
  senders?: number;
  domains?: number;
  mailboxes?: Array<{ user_id: number; email: string; trash_sampled: number }>;
  errors?: string[];
  last_learned_at?: string | null;
}

export interface InboxAnalyzeResponse {
  summary: string;
  draft_reply: string;
  suggested_subject: string | null;
  to: string | null;
  source: string;
}

export interface AppUser {
  id: number;
  username: string;
  full_name: string;
  role: "admin" | "user" | string;
  is_active: boolean;
  mailbox_email?: string | null;
  mailbox_display_name?: string | null;
  mailbox_enabled?: boolean;
  mailbox_configured?: boolean;
}

export interface KpiCounts {
  calls_logged: number;
  companies_called?: number;
  outcomes_interested: number;
  outcomes_follow_up?: number;
  outcomes_not_interested: number;
  outcomes_not_received_call: number;
  call_remarks: number;
  leads_imported: number;
  table_edits: number;
  email_templates_created: number;
  personal_emails_sent?: number;
  emails_after_calls?: number;
  emails_other_personal?: number;
  bulk_emails_sent: number;
  personal_whatsapp_sent?: number;
  bulk_whatsapp_sent?: number;
  inbox_replies: number;
  brand_assistant_sessions: number;
}

export interface KpiActivityItem {
  id: number;
  user_id: number;
  username: string | null;
  full_name: string | null;
  activity_type: string;
  title: string;
  summary: string;
  quantity: number;
  entity_type: string | null;
  entity_id: number | null;
  details: Record<string, unknown> | null;
  created_at: string;
  company_name?: string | null;
  contact_name?: string | null;
  contact_designation?: string | null;
  country?: string | null;
  phone?: string | null;
  outcome?: string | null;
  remarks?: string | null;
  duration_seconds?: number | null;
}

export interface KpiPerUserSummary {
  user: {
    id: number;
    username: string;
    full_name: string;
    role: string;
  } | null;
  counts: KpiCounts;
  activity_count: number;
}

export type KpiPeriod = "day" | "week" | "month";

export interface KpiScorecardCell {
  key: string;
  actual: number;
  target: number | null;
  percent: number | null;
  grade: string | null;
}

export interface KpiScorecard {
  period: string;
  date: string;
  date_start: string;
  date_end: string;
  timezone: string;
  /** Working days elapsed in the period (targets are per day). */
  working_days: number;
  bands: Array<{ grade: string; min: number }>;
  pointers: Array<{
    key: string;
    label: string;
    note: string;
    source: "auto" | "manual";
    target_per_day: number;
  }>;
  users: Array<{
    user: { id: number; username: string; full_name: string };
    overall_percent: number | null;
    overall_grade: string | null;
    pointers: KpiScorecardCell[];
  }>;
  team: {
    overall_percent: number | null;
    overall_grade: string | null;
    pointers: KpiScorecardCell[];
  };
}

export interface KpiScorecardConfig {
  pointers: Array<{
    key: string;
    label: string;
    metric: string;
    target: number;
    weight: number;
    enabled: boolean;
    note: string;
  }>;
  user_targets: Record<string, Record<string, number>>;
  grade_bands: Record<string, number>;
  working_days: number[];
}

export interface KpiScorecardConfigPayload {
  config: KpiScorecardConfig;
  metrics: Array<{ key: string; label: string; source: "auto" | "manual" }>;
  users: Array<{ id: number; username: string; full_name: string }>;
  grade_order: string[];
}
export type ManualKpiPeriod = "day" | "week" | "month" | "year";

export interface ManualKpiEntry {
  id: number;
  user_id: number;
  username: string | null;
  full_name: string | null;
  activity_date: string;
  person_name: string | null;
  company: string | null;
  country: string | null;
  contact_type: string | null;
  follow_up_type: string | null;
  wechat_contacts: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManualKpiListResponse {
  items: ManualKpiEntry[];
  total: number;
  period: string;
  date_start: string;
  date_end: string;
  timezone: string;
  scope: string;
}

export interface DailyKpiReport {
  date: string;
  period: KpiPeriod | string;
  date_start?: string | null;
  date_end?: string | null;
  timezone: string;
  scope: "user" | "team" | string;
  user: {
    id: number;
    username: string;
    full_name: string;
    role: string;
  } | null;
  counts: KpiCounts;
  email_attribution_note?: string | null;
  per_user: KpiPerUserSummary[];
  activities: KpiActivityItem[];
  activity_count: number;
}

export interface KpiSummaryResponse {
  summary: string;
  source: string;
  subject: string;
  report: DailyKpiReport;
}

export interface LoginResponse {
  token: string;
  user: AppUser;
}

export interface Lead {
  id: number;
  company_name: string;
  website_url: string | null;
  country: string | null;
  industry: string | null;
  source: string | null;
  company_grading?: string | null;
  market_role?: string;
  market_role_reasoning?: string | null;
  market_role_confidence?: number | null;
  producer_tier?: string | null;
  producer_conversion_pct?: number | null;
  producer_tier_reasoning?: string | null;
  created_at: string;
  latest_score?: string | null;
  score_reasoning?: string | null;
}

export interface LeadListResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  rows: Lead[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  provider: string;
  model: string;
}

export interface ChatbotStatus {
  gemini: boolean;
  openai: boolean;
  anthropic: boolean;
}

export type SalesAssistantAction = Record<string, unknown>;

export interface SalesAssistantHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SalesAssistantStatus {
  enabled: boolean;
}

export interface SalesAssistantChatResponse {
  reply: string;
  actions: SalesAssistantAction[];
  provider: string;
  model: string;
}

export interface InterestedFollowUp {
  id: string;
  buyer_id: number;
  company_name: string;
  contact_name: string | null;
  interested_at: string;
  weeks_since_placement: number;
  days_since_placement?: number;
  due_at: string;
  call_outcome?: string | null;
  table_section?: string | null;
}

export interface BuyerProfile {
  buyer_id: number;
  company_name: string;
  website_url: string | null;
  country: string | null;
  industry: string | null;
  website_summary: string | null;
  relationship_context: string | null;
  signals: string[];
  matched_categories: string[];
  matched_products: Array<{
    name: string;
    category: string;
    type_key?: string;
    matched_keyword?: string;
  }>;
  product_fit_score?: number;
  market_role?: string;
  market_role_reasoning?: string | null;
  market_role_confidence?: number | null;
  producer_tier?: string | null;
  producer_conversion_pct?: number | null;
  producer_tier_reasoning?: string | null;
  researched_at?: string | null;
}

export interface LeadScore {
  id: number;
  buyer_id: number;
  score: string;
  reasoning: string;
  scored_at: string;
}

export interface CrossSellRecommendation {
  category: string;
  product_name: string;
  rationale: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  storage_path?: string;
}

export interface DraftInteraction {
  id: number;
  contact_id: number;
  channel: string;
  direction?: string;
  subject: string | null;
  content: string;
  status: string;
  created_at: string;
  company_name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  template_name?: string | null;
  wa_status?: string | null;
  wa_send_error?: string | null;
  attachments?: EmailAttachment[];
}

export interface CallConfig {
  configured: boolean;
  webhooks_ready: boolean;
  browser_ready: boolean;
  caller_id_masked?: string | null;
  setup_message?: string | null;
  missing_env?: string[];
  twilio_account_sid?: string | null;
  twilio_twiml_app_sid?: string | null;
  twilio_webhook_base_url?: string | null;
  twilio_validate_webhooks?: boolean;
}

export interface TwilioBalance {
  configured: boolean;
  caller_id_masked?: string | null;
  twilio_account_sid?: string | null;
  ok: boolean;
  balance?: number | null;
  currency?: string | null;
  message?: string | null;
  fetched_at?: string | null;
  hangup_after_fourth_ring?: boolean;
  ring_timeout_seconds?: number;
  max_ring_attempts?: number;
}

export interface VoiceToken {
  token: string;
  identity: string;
}

export interface CallInitiateResult extends DraftInteraction {
  call_sid?: string | null;
  call_status?: string | null;
  lead_phone?: string | null;
  message?: string | null;
  buyer_id?: number | null;
}

export interface CallHistoryItem {
  id: number;
  contact_id: number;
  buyer_id?: number | null;
  company_name?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  channel: string;
  direction: string;
  subject?: string | null;
  content?: string | null;
  status: string;
  created_at: string;
  call_sid?: string | null;
  call_status?: string | null;
  call_duration_seconds?: number | null;
  lead_phone?: string | null;
  notes?: string | null;
  call_outcome?: string | null;
  recording_available?: boolean;
  recording_sid?: string | null;
  recording_duration_seconds?: number | null;
  recording_url?: string | null;
  download_url?: string | null;
  transcript?: string | null;
  transcript_status?: string | null;
  transcript_error?: string | null;
  ai_training_selected?: boolean;
}

export interface CallHistoryListResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  since_days?: number | null;
  rows: CallHistoryItem[];
}

export interface DialablePhoneOption {
  index: number;
  label: string;
  phone: string;
  contact_id: number | null;
}

export interface DialableLeadRow {
  id: number;
  company_name: string;
  country: string | null;
  call_recommended: boolean | null;
  call_local_time: string | null;
  call_timezone: string | null;
  call_reason: string | null;
  contact_id: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  phones?: DialablePhoneOption[];
  possible_duplicate?: boolean;
  missing_contact_name?: boolean;
}

export interface DialableCountryNow {
  country: string;
  local_time: string;
  timezone: string;
}

export interface DialableLeadsResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  rows: DialableLeadRow[];
  countries: string[];
  countries_valid_now: DialableCountryNow[];
}

export interface ApproveDraftResult {
  interaction: DraftInteraction;
  sent: boolean;
  send_status: string | null;
  send_message: string | null;
}

export interface EmailTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
  attachments?: EmailAttachment[];
  created_at: string;
  updated_at: string;
}

export interface WhatsAppPersonalTemplate {
  id: number;
  name: string;
  body: string;
  created_by_user_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramPersonalTemplate {
  id: number;
  name: string;
  body: string;
  created_by_user_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface AvailablePhoneOption {
  phone: string;
  raw?: string;
  label: string;
  contact_name?: string | null;
  is_dialed: boolean;
  type: "mobile" | "landline" | "unknown";
  is_landline: boolean;
  wa_supported: boolean;
}

export interface AvailableEmailOption {
  email: string;
  label: string;
  contact_name?: string | null;
  contact_id?: number | null;
  is_primary?: boolean;
}

export interface PersonalizedFollowupDraft {
  id: number;
  interaction_id: number;
  buyer_id: number;
  company_name: string | null;
  country: string | null;
  contact_id: number | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  available_phones?: AvailablePhoneOption[];
  selected_phone?: string | null;
  available_emails?: AvailableEmailOption[];
  selected_email?: string | null;
  created_by_user_id: number | null;
  call_outcome: string;
  call_context?: string | null;
  call_context_label?: string | null;
  status: string;
  subject: string | null;
  email_body: string | null;
  whatsapp_body: string | null;
  transcript_excerpt: string | null;
  generation_error: string | null;
  email_send_status: string | null;
  whatsapp_send_status: string | null;
  whatsapp_personal_send_status?: string | null;
  email_send_message: string | null;
  whatsapp_send_message: string | null;
  whatsapp_personal_send_message?: string | null;
  sent_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  transcript?: string | null;
  transcript_status?: string | null;
  recording_available?: boolean;
  ai_training_selected?: boolean;
}

export interface PersonalizedFollowupListResponse {
  total: number;
  pending_count: number;
  rows: PersonalizedFollowupDraft[];
}

export interface PersonalizedFollowupSendPayload {
  channels?: string;
  target_phone?: string;
  target_email?: string;
  subject?: string;
  email_body?: string;
  whatsapp_body?: string;
  template_name?: string;
  template_language?: string;
  template_variables?: string[];
  attachments?: EmailAttachment[];
}

export interface PersonalizedFollowupSendResponse {
  draft: PersonalizedFollowupDraft;
  email_sent: boolean;
  whatsapp_sent: boolean;
  needs_whatsapp_template?: boolean;
  email_invalid?: boolean;
  failed_email?: string | null;
  available_emails?: AvailableEmailOption[];
  message: string;
}

export interface MailLabel {
  id: number;
  name: string;
  color: string;
  match_query?: string | null;
  match_keyword?: string | null;
  count: number;
  /** Built-in Flagged mailbox — not a user-created routing label. */
  is_system?: boolean;
}

export interface MailLabelMessageKey {
  folder: string;
  message_uid: string;
  message_id: string | null;
  thread_id: string | null;
  from_email: string | null;
  subject_key: string | null;
  mailbox_user_id?: number | null;
}

export interface MailComposeDraft {
  id: number;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplatePreview {
  subject: string;
  body: string;
  company_name: string;
  contact_email: string;
}

export interface PictureLibraryImage {
  id: string;
  url: string;
  filename: string;
  content_type?: string;
  size?: number;
  caption?: string;
  uploaded_by?: string;
  created_at?: string;
}

export interface PictureLibraryGroup {
  id: string;
  name: string;
  created_at?: string;
  created_by?: string;
  images: PictureLibraryImage[];
}

export interface PictureLibrary {
  groups: PictureLibraryGroup[];
}


export interface BulkEmailDraftResponse {
  created_count: number;
  skipped_count: number;
  sent_count?: number;
  failed_count?: number;
  created: Array<{
    buyer_id: number;
    company_name: string;
    interaction_id: number;
    contact_id: number;
    sent?: boolean;
    send_status?: string | null;
    send_message?: string | null;
  }>;
  skipped: Array<{
    buyer_id: number;
    company_name?: string | null;
    reason: string;
  }>;
}

export interface BulkEmailOverlapCheckResponse {
  has_overlap: boolean;
  overlapping_count?: number;
  overlapping_buyer_ids?: number[];
  run_in_progress?: boolean;
  minutes_ago?: number;
  minutes_remaining?: number;
  message?: string | null;
}

export interface ManualEmailSendResult {
  interaction: DraftInteraction;
  sent: boolean;
  send_status: string | null;
  send_message: string | null;
}

export interface EmailActivityEvent {
  id: number;
  event_type: string;
  event_label: string;
  severity: string;
  title: string;
  message: string;
  user_id: number | null;
  user_username: string | null;
  user_full_name: string | null;
  buyer_id: number | null;
  contact_id: number | null;
  interaction_id: number | null;
  details: Record<string, unknown>;
  read_at: string | null;
  created_at: string | null;
}

export interface EmailActivityBulkResultRow {
  buyer_id: number | null;
  company_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email?: string | null;
  status: "sent" | "failed" | "skipped" | "unknown" | string;
  message: string | null;
}

export interface EmailActivityBulkResults {
  event_id: number;
  title: string;
  channel: "email" | "whatsapp";
  created_at: string | null;
  selected_count: number | null;
  /** True when rebuilt from messages (older sends did not store per-contact results). */
  reconstructed: boolean;
  counts: { sent: number; failed: number; skipped: number; unknown: number };
  results: EmailActivityBulkResultRow[];
}

export interface EmailActivityListResponse {
  total: number;
  unread_count: number;
  page: number;
  page_size: number;
  total_pages: number;
  rows: EmailActivityEvent[];
}

export interface EmailActivityCatalogItem {
  event_type: string;
  label: string;
  description: string;
  severity: string;
}

export interface EmailActivityModeStats {
  attempted: number;
  sent: number;
  failed: number;
  opened: number;
  replied?: number;
  not_opened: number;
  open_rate_pct: number;
  reply_rate_pct?: number;
  success_rate_pct: number;
  batches?: number | null;
  batches_partial?: number | null;
  batches_failed?: number | null;
}

export interface EmailActivityInsights {
  period_days: number | null;
  since: string | null;
  until?: string | null;
  tracking_enabled: boolean;
  tracking_base_url?: string | null;
  tracking_pixel_path?: string | null;
  totals: EmailActivityModeStats;
  individual: EmailActivityModeStats;
  bulk: EmailActivityModeStats;
  event_count: number;
}

export interface EmailActivityAiResponse {
  kind: string;
  title: string;
  content: string;
  stats?: EmailActivityInsights | null;
}

export interface BulkApproveResponse {
  processed: number;
  sent_count: number;
  failed_count: number;
  results: Array<{
    interaction_id: number;
    status: string;
    sent: boolean;
    send_status?: string | null;
    send_message?: string | null;
  }>;
}

export interface BulkEmailSettings {
  batch_size: number;
  message_delay_seconds: number;
  batch_pause_seconds: number;
  max_per_request: number;
  gmail_daily_limit_hint: number;
  recommendation: string;
}

export interface ConsentSummary {
  total: number;
  unknown: number;
  granted: number;
  denied: number;
  with_birthday: number;
}

export interface ComplianceContact {
  id: number;
  buyer_id: number;
  company_name: string;
  country: string | null;
  full_name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  nationality: string | null;
  consent_status: string;
  preferred_language: string | null;
  birthday_outreach_ok: boolean;
  whatsapp_opt_in: boolean;
}

export interface ProductType {
  type_key: string;
  name: string;
  category: string;
}

export interface OnboardResult {
  buyer_id: number;
  score: string;
  reasoning: string;
  next_actions: string[];
  enrichment?: {
    buyer_id?: number;
    filled_fields?: string[];
    website_url?: string | null;
    source_detail?: string | null;
    error?: string;
  } | null;
}

export interface LeadCreate {
  company_name: string;
  website_url?: string;
  country?: string;
  industry?: string;
  source?: string;
}

export interface CompanyNameSuggestion {
  id: number;
  company_name: string;
  country: string | null;
  industry: string | null;
  source: string | null;
}

export interface CompanyNameSuggestionsResponse {
  q: string;
  rows: CompanyNameSuggestion[];
}

export interface DialableContactSuggestion {
  buyer_id: number;
  contact_id: number | null;
  company_name: string;
  contact_name: string;
  phone: string;
  country: string | null;
  designation?: string | null;
  grading?: string | null;
  label: string;
}

export interface DialableContactSuggestionsResponse {
  q: string;
  section?: string | null;
  country?: string | null;
  grade?: string | null;
  designation?: string | null;
  rows: DialableContactSuggestion[];
}

export interface CallFilterSectionOption {
  id: string;
  label: string;
  count?: number;
  icon?: string;
}

export interface CallFilterOptionsResponse {
  sections?: CallFilterSectionOption[];
  countries: string[];
  grades: string[];
  designations: string[];
}

export interface Contact {
  id: number;
  buyer_id: number;
  full_name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
  preferred_language: string | null;
  consent_status: string;
  whatsapp_opt_in: boolean;
  wa_id?: string | null;
  within_session_window?: boolean;
  window_expires_at?: string | null;
}

export interface ContactCreate {
  buyer_id: number;
  full_name: string;
  designation?: string;
  email?: string;
  phone?: string;
  preferred_language?: string;
  consent_status?: string;
  whatsapp_opt_in?: boolean;
}

export interface ContactUpdate {
  full_name?: string;
  designation?: string;
  email?: string;
  secondary_email?: string;
  phone?: string;
  preferred_language?: string;
  consent_status?: string;
  whatsapp_opt_in?: boolean;
}

export interface DiscoveryCandidate {
  candidate_id: string;
  company_name: string;
  website_url: string | null;
  contact_name: string | null;
  email: string;
  phone: string;
  facebook_url: string;
  instagram_url: string;
  linkedin_url: string;
  country: string | null;
  industry: string | null;
  legacy_serial_no?: number | null;
  company_grading?: string | null;
  designation?: string | null;
  secondary_mobile?: string | null;
  primary_phone?: string | null;
  secondary_phone?: string | null;
  secondary_email?: string | null;
  product_interest?: string | null;
  city?: string | null;
  address?: string | null;
  remarks?: string | null;
  source: string;
  source_detail: string;
  match_reason: string;
  already_exists: boolean;
  is_valid_business?: boolean;
  invalid_reason?: string | null;
}

export interface DiscoveryRegion {
  code: string;
  label: string;
  group: string;
  gl_code: string;
}

export interface DiscoveryRegionsResponse {
  max_regions: number;
  regions: DiscoveryRegion[];
}

export interface DiscoverLeadsRequest {
  seed_lead_id?: number;
  region_codes?: string[];
  industry?: string;
  industries?: string[];
  categories?: string[];
  limit?: number;
  use_web_search?: boolean;
  use_website_links?: boolean;
  skip_enrichment?: boolean;
}

export const MAX_DISCOVERY_BATCH = 15;

export interface DiscoverLeadsResponse {
  candidates: DiscoveryCandidate[];
  sources_used: string[];
  messages: string[];
  search_query: string | null;
  import_parser?: string | null;
}

export interface DiscoverImportRequest {
  candidates: Array<{
    company_name: string;
    website_url?: string;
    contact_name?: string;
    email?: string;
    phone?: string;
    facebook_url?: string;
    instagram_url?: string;
    linkedin_url?: string;
    country?: string;
    industry?: string;
    legacy_serial_no?: number | null;
    company_grading?: string;
    designation?: string;
    secondary_mobile?: string;
    primary_phone?: string;
    secondary_phone?: string;
    secondary_email?: string;
    product_interest?: string;
    city?: string;
    address?: string;
    remarks?: string;
    source?: string;
  }>;
  auto_onboard?: boolean;
  replace_duplicates?: boolean;
  skip_enrichment?: boolean;
}

export interface DiscoverImportResponse {
  created_count: number;
  skipped_count: number;
  replaced_count?: number;
  created: Lead[];
  skipped: Array<{ company_name: string; reason: string }>;
  replaced?: Array<{ company_name: string; replaced_id: number; reason: string }>;
  onboard_results: Array<Record<string, unknown>>;
}

export interface ImportJobStart {
  job_id: string;
  total: number;
}

export interface ImportJobStatus {
  job_id: string;
  status: "queued" | "running" | "committing" | "verifying" | "completed" | "failed";
  phase_label: string;
  total: number;
  processed: number;
  created_count: number;
  skipped_count: number;
  replaced_count: number;
  current_company: string | null;
  error: string | null;
  import_source: string | null;
  /** Rows in the DB with this source after commit — proof leads landed in the table. */
  verified_source_total: number | null;
  created: Array<{ id: number; company_name: string }> | null;
  skipped: Array<{ company_name: string; reason: string }> | null;
  replaced: Array<{ company_name: string; replaced_id?: number; reason: string }> | null;
  skip_reason_counts?: Record<string, number> | null;
  elapsed_seconds: number;
}

export interface SynthesisJobStart {
  job_id: string;
  file_count: number;
  upload_count?: number;
}

export interface SynthesisJobStatus {
  job_id: string;
  status: string;
  phase?: string;
  phase_label: string;
  total: number;
  processed: number;
  percent: number;
  raw_rows: number;
  output_rows: number;
  merged_duplicates: number;
  skipped_existing: number;
  sheets_processed: number;
  files_processed: number;
  current_company: string | null;
  messages: string[];
  error: string | null;
  output_filename: string | null;
  elapsed_seconds: number;
}

export interface LeadTableDedupeResponse {
  removed_count: number;
  kept_count: number;
  groups: Array<{
    company_name: string;
    kept_id: number;
    removed_ids: number[];
    removed_names: string[];
  }>;
}

export interface RemoveOldClientOverlapsResponse {
  removed_count: number;
  kept_count: number;
  old_clients_count: number;
  groups: Array<{
    company_name: string;
    kept_id: number;
    removed_ids: number[];
    removed_names: string[];
  }>;
}

export interface LeadTableCleanupResponse {
  removed_count: number;
  removed: Array<{ id: number; company_name: string }>;
}

export interface LeadTableNameRepairResponse {
  scanned: number;
  location_name_candidates: number;
  repaired_with_name: number;
  relocated_name_empty: number;
  skipped: number;
  dry_run: boolean;
  samples: Array<Record<string, unknown>>;
}

export interface LeadTableCompanyCleanResponse {
  scanned: number;
  changed: number;
  by_rule: Record<string, number>;
  dry_run: boolean;
  samples: Array<Record<string, unknown>>;
}

export interface PostImportCleanSummary {
  emails_fixed: number;
  company_fields_fixed: number;
  names_fixed: number;
  junk_rows_removed: number;
  empty_rows_removed: number;
  duplicates_removed: number;
}

export interface PostImportCleanResponse {
  summary: PostImportCleanSummary;
  emails: Record<string, unknown>;
  company_fields: Record<string, unknown>;
  names: Record<string, unknown>;
  junk_removed: Record<string, unknown>;
  sparse_removed: Record<string, unknown>;
  dedupe: Record<string, unknown>;
}

export interface LeadTableSectionCountsResponse {
  all: number;
  old_clients: number;
  interested_clients: number;
  sales_interested_clients?: number;
  not_interested_clients: number;
  not_received_call_clients: number;
  master?: number;
  by_assignee?: Record<string, number>;
  hyperstore_targeted?: number;
  targeted_distributor?: number;
  targeted_client?: number;
  schedule_meeting?: number;
  khalid_focused_sales?: number;
  incomplete_archives?: number;
  my_assigned?: number;
  all_contacts?: number;
  testing?: number;
  /** Custom list keys (e.g. new_salt_data_sep_2026) and any other section badges. */
  [key: string]: number | Record<string, number> | undefined;
}

export interface LeadTableBulkDeleteResponse {
  deleted_count: number;
  deleted_ids: number[];
}

export interface LeadTableBulkAssignResponse {
  assigned_count: number;
  assigned_ids: number[];
  assigned_to_user_id: number | null;
  assigned_to: string;
  transfer_message?: string | null;
}

export interface LeadTableRow {
  id: number;
  company_name: string;
  country: string | null;
  call_recommended: boolean | null;
  call_local_time: string | null;
  call_timezone: string | null;
  call_reason: string | null;
  industry: string | null;
  website_url: string | null;
  linkedin_company_url: string | null;
  facebook_company_url: string | null;
  instagram_company_url: string | null;
  source: string | null;
  legacy_serial_no: number | null;
  company_grading: string | null;
  product_interest: string | null;
  city: string | null;
  address: string | null;
  remarks: string | null;
  remarks_03?: string | null;
  remarks_04?: string | null;
  /** Prior remarks entries with timestamps (oldest → newest). */
  remarks_history?: Array<{
    text: string;
    at: string;
    by?: string | null;
    source?: string | null;
  }> | null;
  /** Post-call notes from the latest phone call (Follow up / Not interested / Did not receive). */
  call_remarks: string | null;
  assigned_to: string;
  assigned_to_user_id: number | null;
  follow_up_at: string | null;
  created_at: string;
  latest_score: string | null;
  score_reasoning: string | null;
  scored_at: string | null;
  contact_id: number | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_designation: string | null;
  contact_secondary_mobile: string | null;
  contact_primary_phone: string | null;
  contact_secondary_phone: string | null;
  contact_secondary_email: string | null;
  market_role: string | null;
  market_role_reasoning: string | null;
  producer_tier: string | null;
  producer_conversion_pct: number | null;
  producer_tier_reasoning: string | null;
  meeting_status?: string | null;
  meeting_at?: string | null;
  meeting_location?: string | null;
  meeting_notes?: string | null;
  meeting_priority?: number | null;
  /** CRM keys filled by AI Sales Agent Data Update — yellow highlight in lists. */
  ai_data_update_fields?: string[] | null;
}

export interface LeadTableRowUpdate {
  company_name?: string;
  country?: string;
  industry?: string;
  website_url?: string;
  linkedin_company_url?: string | null;
  facebook_company_url?: string | null;
  instagram_company_url?: string | null;
  legacy_serial_no?: number | null;
  company_grading?: string | null;
  product_interest?: string | null;
  city?: string | null;
  address?: string | null;
  remarks?: string | null;
  remarks_03?: string | null;
  remarks_04?: string | null;
  assigned_to?: string | null;
  assigned_to_user_id?: number | null;
  contact_id?: number;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  contact_designation?: string | null;
  contact_secondary_mobile?: string | null;
  contact_primary_phone?: string | null;
  contact_secondary_phone?: string | null;
  contact_secondary_email?: string | null;
  /** AI fills only — never wipe existing CRM columns. */
  fill_missing_only?: boolean;
}

export interface LeadTableResponse {
  total: number;
  filtered_count: number;
  page: number;
  page_size: number;
  total_pages: number;
  rows: LeadTableRow[];
}

export interface LeadTableIdsResponse {
  filtered_count: number;
  ids: number[];
}

export interface ClientHistoryEntry {
  id: string;
  buyer_id: number;
  company_name: string;
  country?: string | null;
  assigned_to?: string | null;
  assigned_to_user_id?: number | null;
  text: string;
  at?: string | null;
  by?: string | null;
  source?: string;
}

export interface ClientHistoryFeedResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  rows: ClientHistoryEntry[];
}

export interface ClientHistoryDetailEntry {
  text: string;
  at?: string | null;
  by?: string | null;
  source?: string;
  current?: boolean;
}

export interface ClientHistoryDetailResponse {
  buyer_id: number;
  company_name: string;
  remarks?: string | null;
  remarks_updated_at?: string | null;
  remarks_updated_by?: string | null;
  entries: ClientHistoryDetailEntry[];
}

export interface DraftListResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  rows: DraftInteraction[];
}

export interface LeadTableFilters {
  countries: string[];
  industries: string[];
  sources: string[];
  scores: string[];
  market_roles: string[];
  company_gradings: string[];
  products: string[];
  cities: string[];
}

export interface LeadTableQuery {
  score?: string;
  country?: string;
  industry?: string;
  company_grading?: string;
  product_interest?: string;
  city?: string;
  call_recommended?: string;
  source?: string;
  exclude_source?: string;
  call_outcome?: string;
  in_interested_clients?: boolean;
  market_role?: string;
  q?: string;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  page?: number;
  page_size?: number;
  assigned_to_user_id?: number;
  my_assigned?: boolean;
  master?: boolean;
  intake_method?: string;
  new_search_lead_only?: boolean;
  master_type?: string;
  all_contacts?: boolean;
}

export type LeadTableSectionScope = Pick<
  LeadTableQuery,
  "source" | "exclude_source" | "assigned_to_user_id" | "my_assigned" | "master"
>;

export interface WhatsAppConfig {
  configured: boolean;
  webhook_configured: boolean;
  phone_number_id_set: boolean;
  business_account_id_set: boolean;
  app_secret_set?: boolean;
  display_number?: string | null;
  missing_env: string[];
  meta_api_ok?: boolean | null;
  meta_api_message?: string | null;
  webhook_callback_url?: string | null;
  webhook_verify_token_set?: boolean;
  ready_for_two_way?: boolean;
  cloud_sending_enabled?: boolean;
  cloud_sending_paused_message?: string | null;
  phone_number_id_mismatch?: string | null;
  webhook_phone_number_id?: string | null;
  webhook_display_phone_number?: string | null;
}

export interface WhatsAppTestSendResult {
  status: string;
  message: string;
  to?: string | null;
  provider_message_id?: string | null;
}

export interface WhatsAppTemplate {
  id: number;
  meta_template_id: string | null;
  name: string;
  category: string | null;
  language: string;
  status: "approved" | "pending" | "rejected" | "paused" | "disabled" | string;
  body_text: string | null;
  variable_count: number;
  submitted_by_user_id?: number | null;
  rejection_reason?: string | null;
  synced_at: string;
}

export interface WhatsAppTemplateCreatePayload {
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  body: string;
  footer?: string | null;
}

export interface WhatsAppTemplateCreateResult {
  template: WhatsAppTemplate;
  message: string;
  meta_status: string;
}

export interface WhatsAppTemplateResubmitPayload {
  body: string;
  footer?: string | null;
  category?: WhatsAppTemplateCreatePayload["category"];
}

export interface WhatsAppTemplateNotification {
  id: number;
  template_id: number;
  event_type: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

export interface WhatsAppTemplateNotificationsResponse {
  unread_count: number;
  rows: WhatsAppTemplateNotification[];
}

export interface WhatsAppTemplateSyncResult {
  status: string;
  message: string;
  synced_count: number;
}

export interface WhatsAppCampaignDraftResponse {
  created_count: number;
  skipped_count: number;
  sent_count: number;
  failed_count: number;
  delivery_error?: string | null;
  created: Array<{
    buyer_id: number;
    company_name: string;
    interaction_id: number;
    contact_id: number;
    sent?: boolean;
    send_status?: string | null;
    send_message?: string | null;
  }>;
  skipped: Array<{
    buyer_id: number;
    company_name?: string | null;
    reason: string;
  }>;
}

export interface WhatsAppConversation {
  contact_id: number;
  buyer_id: number;
  company_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  whatsapp_opt_in: boolean;
  within_session_window: boolean;
  window_expires_at: string | null;
  last_message: string | null;
  last_message_at: string | null;
    last_direction: string | null;
  unread_count?: number;
}

export interface WhatsAppConversationListResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  rows: WhatsAppConversation[];
}

export interface WhatsAppBuyerPreview {
  buyer_id: number;
  contact_id: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  within_session_window: boolean;
  total_messages: number;
  messages: DraftInteraction[];
}

export interface WhatsAppReplyResponse {
  interaction: DraftInteraction;
  sent: boolean;
  send_status?: string | null;
  send_message?: string | null;
  needs_template?: boolean;
}

export const client = {
  health: () => request<{ status: string }>("/health"),

  /** Admin: dispose DB pool and verify Postgres (fixes overnight SSL 503s). */
  reconnectDatabase: () =>
    request<{
      ok: boolean;
      pool_disposed: boolean;
      database: string;
      checked_at: string;
      note?: string;
    }>("/system/reconnect-db", { method: "POST" }),

  /**
   * Admin emergency: restart Railway via Vercel (works even when Railway is 502).
   * Calls same-origin /ops/restart-backend (Vercel function; not the Railway /api proxy).
   */
  restartRailwayBackend: async (pin: string, mode: "restart" | "redeploy" = "restart") => {
    const res = await fetch("/ops/restart-backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, mode }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      action?: string;
      configured?: Record<string, boolean>;
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Railway restart failed (${res.status})`);
    }
    return data as { ok: true; message: string; action?: string };
  },

  /** Single short wake — never block session bootstrap on health retries. */
  wakeBackend: async (): Promise<boolean> => {
    try {
      await request<{ status: string }>("/health", { timeoutMs: 6_000, noRetry: true });
      return true;
    } catch {
      return false;
    }
  },

  login: (data: { username: string; password: string }) =>
    request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  impersonateUser: (userId: number) =>
    request<LoginResponse>(`/auth/impersonate/${userId}`, {
      method: "POST",
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  getMe: (opts?: { timeoutMs?: number }) =>
    request<AppUser>("/auth/me", {
      timeoutMs: opts?.timeoutMs,
      noRetry: opts?.timeoutMs != null,
    }),
  listUsers: () => request<AppUser[]>("/auth/users"),
  listAssignees: () => request<AppUser[]>("/auth/assignees"),
  createUser: (data: {
    username: string;
    full_name: string;
    password: string;
    mailbox_email?: string;
    mailbox_password?: string;
    mailbox_display_name?: string;
  }) =>
    request<AppUser>("/auth/users", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  setUserActive: (userId: number, isActive: boolean) =>
    request<AppUser>(`/auth/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: isActive }),
    }),
  updateUser: (
    userId: number,
    data: {
      username?: string;
      full_name?: string;
      password?: string;
      is_active?: boolean;
      mailbox_email?: string | null;
      mailbox_password?: string;
      mailbox_display_name?: string | null;
      mailbox_enabled?: boolean;
      clear_mailbox_password?: boolean;
    },
  ) =>
    request<AppUser>(`/auth/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteUser: (userId: number) =>
    request<void>(`/auth/users/${userId}`, { method: "DELETE" }),

  listLeads: (params: { page?: number; page_size?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.page_size) search.set("page_size", String(params.page_size));
    const query = search.toString();
    return request<LeadListResponse>(`/leads${query ? `?${query}` : ""}`);
  },
  listLeadTableFilters: (params: { source?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.source) search.set("source", params.source);
    const query = search.toString();
    return request<LeadTableFilters>(`/leads/table/filters${query ? `?${query}` : ""}`);
  },
  listLeadsTable: (params: LeadTableQuery = {}) => {
    const search = new URLSearchParams();
    if (params.score) search.set("score", params.score);
    if (params.country) search.set("country", params.country);
    if (params.industry) search.set("industry", params.industry);
    if (params.company_grading) search.set("company_grading", params.company_grading);
    if (params.product_interest) search.set("product_interest", params.product_interest);
    if (params.city) search.set("city", params.city);
    if (params.call_recommended) search.set("call_recommended", params.call_recommended);
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.call_outcome) search.set("call_outcome", params.call_outcome);
    if (params.in_interested_clients) search.set("in_interested_clients", "true");
    if (params.market_role) search.set("market_role", params.market_role);
    if (params.q) search.set("q", params.q);
    if (params.sort_by) search.set("sort_by", params.sort_by);
    if (params.sort_dir) search.set("sort_dir", params.sort_dir);
    if (params.page) search.set("page", String(params.page));
    if (params.page_size) search.set("page_size", String(params.page_size));
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    if (params.intake_method) search.set("intake_method", params.intake_method);
    if (params.new_search_lead_only) search.set("new_search_lead_only", "true");
    if (params.master_type) search.set("master_type", params.master_type);
    if (params.all_contacts) search.set("all_contacts", "true");
    if (params.score) search.set("score", params.score);
    if (params.country) search.set("country", params.country);
    if (params.industry) search.set("industry", params.industry);
    if (params.company_grading) search.set("company_grading", params.company_grading);
    if (params.product_interest) search.set("product_interest", params.product_interest);
    if (params.city) search.set("city", params.city);
    if (params.call_recommended) search.set("call_recommended", params.call_recommended);
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.call_outcome) search.set("call_outcome", params.call_outcome);
    if (params.in_interested_clients) search.set("in_interested_clients", "true");
    if (params.market_role) search.set("market_role", params.market_role);
    if (params.q) search.set("q", params.q);
    if (params.sort_by) search.set("sort_by", params.sort_by);
    if (params.sort_dir) search.set("sort_dir", params.sort_dir);
    if (params.page) search.set("page", String(params.page));
    if (params.page_size) search.set("page_size", String(params.page_size));
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    if (params.intake_method) search.set("intake_method", params.intake_method);
    if (params.new_search_lead_only) search.set("new_search_lead_only", "true");
    if (params.master_type) search.set("master_type", params.master_type);

    // Pass additional column filters dynamically (designation, contact_person, email, etc.)
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "" && v !== false && !search.has(k)) {
        search.set(k, String(v));
      }
    });

    const query = search.toString();
    return request<LeadTableResponse>(`/leads/table${query ? `?${query}` : ""}`);
  },
  getLeadTableColumnValues: (
    field: string,
    params: Record<string, any> = {},
  ) => {
    const search = new URLSearchParams();
    search.set("field", field);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "" && v !== false) {
        search.set(k, String(v));
      }
    });
    const query = search.toString();
    return request<{
      field: string;
      total_matching: number;
      blank_count: number;
      unique_values: Array<{ value: string; count: number }>;
    }>(`/leads/table/column-values?${query}`);
  },
  moveLeadsToModule: (
    leadIds: number[],
    targetModule: string,
    expectedCount?: number,
  ) =>
    request<{
      updated_count: number;
      updated_ids?: number[];
      requested_count?: number;
      target_module: string;
      target_label: string;
    }>("/leads/table/move-to-module", {
      method: "POST",
      body: JSON.stringify({
        lead_ids: leadIds,
        target_module: targetModule,
        expected_count: expectedCount ?? leadIds.length,
      }),
    }),
  /** Admin: move leads to another master list (FMCG / Minerals & Ores / ...). Only that changes. */
  moveLeadsToMasterList: (
    leadIds: number[],
    targetMasterType: string,
    expectedCount?: number,
    /** Key of a user-created list to put the moved leads into (default: keep their section). */
    targetSection?: string,
  ) =>
    request<{
      updated_count: number;
      updated_ids: number[];
      requested_count: number;
      already_in_target: number;
      missing: number;
      target_master_type: string;
      target_label: string;
      target_section: string | null;
      target_section_label: string | null;
    }>("/master-list-move", {
      method: "POST",
      body: JSON.stringify({
        lead_ids: leadIds,
        target_master_type: targetMasterType,
        expected_count: expectedCount ?? leadIds.length,
        target_section: targetSection || undefined,
      }),
    }),
  suggestLeadMeeting: (leadId: number) =>
    request<{
      buyer_id: number;
      company_name: string;
      suggested_location: string | null;
      suggested_notes: string | null;
      caption: {
        interaction_id: number | null;
        transcript: string | null;
        call_notes: string | null;
        created_at: string | null;
      };
      current: {
        meeting_status: string | null;
        meeting_at: string | null;
        meeting_location: string | null;
        meeting_notes: string | null;
        meeting_priority: number | null;
      };
    }>(`/leads/table/${leadId}/meeting-suggest`),
  scheduleLeadMeeting: (
    leadId: number,
    payload: {
      meeting_at?: string | null;
      meeting_location?: string | null;
      meeting_notes?: string | null;
      meeting_priority?: number | null;
      country?: string | null;
      city?: string | null;
      confirm?: boolean;
    },
  ) =>
    request<LeadTableRow>(`/leads/table/${leadId}/meeting-schedule`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  listLeadsTableIds: (params: Omit<LeadTableQuery, "page" | "page_size"> = {}) => {
    const search = new URLSearchParams();
    if (params.score) search.set("score", params.score);
    if (params.country) search.set("country", params.country);
    if (params.industry) search.set("industry", params.industry);
    if (params.company_grading) search.set("company_grading", params.company_grading);
    if (params.product_interest) search.set("product_interest", params.product_interest);
    if (params.city) search.set("city", params.city);
    if (params.call_recommended) search.set("call_recommended", params.call_recommended);
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.call_outcome) search.set("call_outcome", params.call_outcome);
    if (params.in_interested_clients) search.set("in_interested_clients", "true");
    if (params.market_role) search.set("market_role", params.market_role);
    if (params.q) search.set("q", params.q);
    if (params.sort_by) search.set("sort_by", params.sort_by);
    if (params.sort_dir) search.set("sort_dir", params.sort_dir);
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    if (params.intake_method) search.set("intake_method", params.intake_method);
    if (params.new_search_lead_only) search.set("new_search_lead_only", "true");
    if (params.master_type) search.set("master_type", params.master_type);
    // Same as listLeadsTable — column filters (designation blanks, etc.) must apply to Select all.
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "" && v !== false && !search.has(k)) {
        search.set(k, String(v));
      }
    });
    const query = search.toString();
    return request<LeadTableIdsResponse>(`/leads/table/ids${query ? `?${query}` : ""}`);
  },
  listClientHistory: (params: {
    page?: number;
    page_size?: number;
    search?: string;
    buyer_id?: number;
    /** YYYY-MM-DD, inclusive. Same value for both = a single day. */
    date_from?: string;
    date_to?: string;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.page_size) search.set("page_size", String(params.page_size));
    if (params.search) search.set("search", params.search);
    if (params.buyer_id != null) search.set("buyer_id", String(params.buyer_id));
    if (params.date_from) search.set("date_from", params.date_from);
    if (params.date_to) search.set("date_to", params.date_to);
    const query = search.toString();
    return request<ClientHistoryFeedResponse>(
      `/leads/client-history${query ? `?${query}` : ""}`,
    );
  },
  getClientHistory: (buyerId: number) =>
    request<ClientHistoryDetailResponse>(`/leads/${buyerId}/client-history`),
  addClientHistoryRemark: (
    buyerId: number,
    data: { text: string; append_to_remarks?: boolean },
  ) =>
    request<ClientHistoryDetailResponse>(`/leads/${buyerId}/client-history`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateLeadTableRow: (
    leadId: number,
    data: LeadTableRowUpdate,
    options?: { fillMissingOnly?: boolean },
  ) =>
    request<LeadTableRow>(`/leads/table/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...data,
        ...(options?.fillMissingOnly || data.fill_missing_only
          ? { fill_missing_only: true }
          : {}),
      }),
    }),
  deleteLeadTableRow: (leadId: number) =>
    request<void>(`/leads/table/${leadId}`, { method: "DELETE" }),
  bulkDeleteLeadTableRows: (leadIds: number[]) =>
    request<LeadTableBulkDeleteResponse>("/leads/table/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ lead_ids: leadIds }),
    }),
  bulkAssignLeadTableRows: (leadIds: number[], assignedToUserId: number | null) =>
    request<LeadTableBulkAssignResponse>("/leads/table/bulk-assign", {
      method: "POST",
      body: JSON.stringify({
        lead_ids: leadIds,
        assigned_to_user_id: assignedToUserId,
      }),
    }),
  setTargetPool: (
    leadIds: number[],
    source: string,
    intakeMethod: "upload" | "discover" = "discover",
  ) =>
    request<{ updated_count: number; updated_ids: number[] }>(
      "/leads/table/set-target-pool",
      {
        method: "POST",
        body: JSON.stringify({
          lead_ids: leadIds,
          source,
          intake_method: intakeMethod,
        }),
      },
    ),
  populateTargetPool: (
    pool: string,
    fromSource: "old_clients" | "discover" | "discover_leads",
    limit = 50,
  ) =>
    request<{
      updated_count: number;
      updated_ids: number[];
      scanned: number;
      from_source: string;
      pool: string;
    }>("/leads/table/populate-target-pool", {
      method: "POST",
      body: JSON.stringify({
        pool,
        from_source: fromSource,
        limit,
      }),
    }),
  removeFromTargetPool: (leadIds: number[]) =>
    request<{ updated_count: number; updated_ids: number[] }>(
      "/leads/table/remove-from-target-pool",
      {
        method: "POST",
        body: JSON.stringify({ lead_ids: leadIds }),
      },
    ),
  removeFromScheduleMeeting: (leadIds: number[]) =>
    request<{ updated_count: number; updated_ids: number[] }>(
      "/leads/table/remove-from-schedule-meeting",
      {
        method: "POST",
        body: JSON.stringify({ lead_ids: leadIds }),
      },
    ),
  classifyTargetPoolsFromOldClients: (limitPerPool = 5000) =>
    request<{
      scanned: number;
      hyperstore_targeted: { updated_count: number; updated_ids: number[] };
      targeted_distributor: { updated_count: number; updated_ids: number[] };
    }>("/leads/table/classify-target-pools", {
      method: "POST",
      body: JSON.stringify({ limit_per_pool: limitPerPool }),
    }),
  promoteIncompleteArchives: (leadIds: number[]) =>
    request<{ promoted_count: number; promoted_ids: number[]; target: string }>(
      "/leads/table/promote-incomplete-archives",
      {
        method: "POST",
        body: JSON.stringify({ lead_ids: leadIds }),
      },
    ),
  setInterestedClientsMembership: (leadIds: number[], inList: boolean) =>
    request<{ updated_count: number; updated_ids: number[] }>(
      "/leads/table/interested-clients-membership",
      {
        method: "POST",
        body: JSON.stringify({ lead_ids: leadIds, in_list: inList }),
      },
    ),
  getLeadsTableSectionCounts: (masterType = "fmcg") =>
    request<LeadTableSectionCountsResponse>(
      `/leads/table/section-counts?master_type=${encodeURIComponent(masterType)}`,
    ),
  dedupeLeadsTable: (params: LeadTableSectionScope = {}) => {
    const search = new URLSearchParams();
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    const query = search.toString();
    return request<LeadTableDedupeResponse>(
      `/leads/table/dedupe${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
  },
  removeOldClientOverlaps: () =>
    request<RemoveOldClientOverlapsResponse>("/leads/table/remove-old-client-overlaps", {
      method: "POST",
    }),
  cleanupSparseCsvLeads: (params: LeadTableSectionScope = {}) => {
    const search = new URLSearchParams();
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    const query = search.toString();
    return request<LeadTableCleanupResponse>(
      `/leads/table/cleanup-sparse${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
  },
  repairLocationCompanyNames: (
    params: LeadTableSectionScope & { dry_run?: boolean; limit?: number } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    if (params.dry_run) search.set("dry_run", "true");
    if (params.limit != null) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<LeadTableNameRepairResponse>(
      `/leads/table/repair-location-names${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
  },
  cleanCompanyFields: (
    params: LeadTableSectionScope & { dry_run?: boolean; limit?: number } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    if (params.dry_run) search.set("dry_run", "true");
    if (params.limit != null) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<LeadTableCompanyCleanResponse>(
      `/leads/table/clean-company-fields${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
  },
  postImportClean: (params: LeadTableSectionScope = {}) => {
    const search = new URLSearchParams();
    if (params.source) search.set("source", params.source);
    if (params.exclude_source) search.set("exclude_source", params.exclude_source);
    if (params.assigned_to_user_id != null) {
      search.set("assigned_to_user_id", String(params.assigned_to_user_id));
    }
    if (params.my_assigned) search.set("my_assigned", "true");
    if (params.master) search.set("master", "true");
    const query = search.toString();
    return request<PostImportCleanResponse>(
      `/leads/table/post-import-clean${query ? `?${query}` : ""}`,
      { method: "POST", timeoutMs: 600_000 },
    );
  },
  getImportRollbackStatus: (source: string, opts?: { force?: boolean }) => {
    const q = new URLSearchParams();
    q.set("source", source);
    if (opts?.force) q.set("force", "true");
    return request<{
      available: boolean;
      source: string;
      batch_id?: number | null;
      created_count?: number;
      buyer_ids_count?: number;
      created_at?: string | null;
      expires_at?: string | null;
      remaining_seconds?: number;
      reason?: string;
      heuristic?: boolean;
    }>(`/leads/table/import-rollback?${q.toString()}`);
  },
  rollbackLastImport: (source: string, opts?: { force?: boolean }) =>
    request<{
      ok: boolean;
      source: string;
      removed_count: number;
      remaining_count: number;
      batch_id?: number | null;
      heuristic?: boolean;
    }>("/leads/table/import-rollback", {
      method: "POST",
      body: JSON.stringify({ source, force: Boolean(opts?.force) }),
      timeoutMs: 300_000,
    }),
  createLead: (data: LeadCreate) =>
    request<Lead>("/leads", { method: "POST", body: JSON.stringify(data) }),
  suggestCompanyNames: (q: string, limit = 12) => {
    const query = new URLSearchParams();
    query.set("q", q);
    if (limit) query.set("limit", String(limit));
    return request<CompanyNameSuggestionsResponse>(
      `/leads/company-suggestions?${query.toString()}`,
    );
  },
  suggestDialableContacts: (
    params:
      | string
      | {
          q?: string;
          section?: string;
          country?: string;
          grade?: string;
          designation?: string;
          limit?: number;
        },
    limit = 25,
  ) => {
    const query = new URLSearchParams();
    if (typeof params === "string") {
      if (params) query.set("q", params);
      if (limit) query.set("limit", String(limit));
    } else if (params) {
      if (params.q) query.set("q", params.q);
      if (params.section) query.set("section", params.section);
      if (params.country) query.set("country", params.country);
      if (params.grade) query.set("grade", params.grade);
      if (params.designation) query.set("designation", params.designation);
      query.set("limit", String(params.limit ?? limit));
    }
    return request<DialableContactSuggestionsResponse>(
      `/calls/contact-suggestions?${query.toString()}`,
    );
  },
  getCallFilterOptions: () => request<CallFilterOptionsResponse>("/calls/filter-options"),
  getLead: (id: number) => request<Lead>(`/leads/${id}`),
  getLeadProfile: (id: number) => request<BuyerProfile>(`/leads/${id}/profile`),
  researchLead: (id: number, opts?: { timeoutMs?: number }) =>
    request<BuyerProfile>(`/leads/${id}/research`, {
      method: "POST",
      timeoutMs: opts?.timeoutMs,
    }),
  getLatestScore: (id: number) => request<LeadScore>(`/leads/${id}/score`),
  scoreLead: (id: number, opts?: { timeoutMs?: number }) =>
    request<LeadScore>(`/leads/${id}/score`, {
      method: "POST",
      timeoutMs: opts?.timeoutMs,
    }),
  onboardLead: (id: number, opts?: { timeoutMs?: number }) =>
    request<OnboardResult>(`/leads/${id}/onboard`, {
      method: "POST",
      timeoutMs: opts?.timeoutMs,
    }),
  listLeadContacts: (leadId: number) =>
    request<Contact[]>(`/leads/${leadId}/contacts`),
  getLeadDialPhones: (leadId: number) =>
    request<{
      phones: Array<{
        index: number;
        label: string;
        phone: string;
        contact_id?: number;
      }>;
    }>(`/leads/${leadId}/dial-phones`),
  createContact: (data: ContactCreate) =>
    request<Contact>("/leads/contacts", { method: "POST", body: JSON.stringify(data) }),
  updateContact: (contactId: number, data: ContactUpdate) =>
    request<Contact>(`/leads/contacts/${contactId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteContact: (contactId: number) =>
    request<void>(`/leads/contacts/${contactId}`, { method: "DELETE" }),

  listDiscoveryRegions: () =>
    request<DiscoveryRegionsResponse>("/leads/discover/regions"),

  discoverLeads: (data: DiscoverLeadsRequest) =>
    request<DiscoverLeadsResponse>("/leads/discover", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  enrichDiscoveryCandidate: (candidate: DiscoveryCandidate) =>
    request<DiscoveryCandidate>("/leads/discover/enrich", {
      method: "POST",
      body: JSON.stringify(candidate),
    }),

  discoverLeadsFromCsv: async (
    file: File,
    defaultCountry?: string,
    forLeadsTable = false,
    importSource?: string,
  ) => {
    const form = new FormData();
    form.append("file", file);
    const params = new URLSearchParams();
    if (defaultCountry) params.set("default_country", defaultCountry);
    if (forLeadsTable) params.set("for_leads_table", "true");
    if (importSource) params.set("import_source", importSource);
    const query = params.toString();
    const res = await fetch(`${API_BASE}/leads/discover/csv${query ? `?${query}` : ""}`, {
      method: "POST",
      body: form,
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(messageForHttpError(res.status, text, res.statusText));
    }
    return res.json() as Promise<DiscoverLeadsResponse>;
  },

  importDiscoveredLeads: (data: DiscoverImportRequest) =>
    request<DiscoverImportResponse>("/leads/discover/import", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  startLeadsImportJob: (data: DiscoverImportRequest) =>
    request<ImportJobStart>("/leads/discover/import-async", {
      method: "POST",
      body: JSON.stringify(data),
      // Batched imports send ≤80 rows; give headroom on slow links.
      timeoutMs: 120_000,
    }),

  getLeadsImportJob: (jobId: string) =>
    request<ImportJobStatus>(`/leads/import-jobs/${jobId}`),

  startDataSynthesis: async (
    files: File[],
    options?: { baseline?: File | null; checkDb?: boolean },
  ) => {
    const form = new FormData();
    for (const file of files) {
      form.append("files", file);
    }
    if (options?.baseline) {
      form.append("baseline", options.baseline);
    }
    const params = new URLSearchParams();
    if (options?.checkDb === false) {
      params.set("check_db", "false");
    }
    const query = params.toString();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SYNTHESIS_UPLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/data-synthesis/start${query ? `?${query}` : ""}`,
        {
          method: "POST",
          body: form,
          headers: authHeaders(),
          credentials: "include",
          signal: controller.signal,
        },
      );
    } finally {
      window.clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(parseErrorDetail(text, res.statusText));
    }
    return res.json() as Promise<SynthesisJobStart>;
  },

  getSynthesisJob: (jobId: string) =>
    request<SynthesisJobStatus>(`/data-synthesis/jobs/${jobId}`),

  synthesisDownloadUrl: (jobId: string) =>
    `${API_BASE}/data-synthesis/jobs/${jobId}/download`,

  getCrossSell: (leadId: number) =>
    request<CrossSellRecommendation[]>(`/leads/${leadId}/cross-sell`),

  listProductTypes: () =>
    request<{ count: number; product_types: ProductType[] }>("/leads/product-types").then(
      (r) => r.product_types,
    ),

  listDrafts: (params: { page?: number; page_size?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.page_size) search.set("page_size", String(params.page_size));
    const query = search.toString();
    return request<DraftListResponse>(`/interactions/drafts${query ? `?${query}` : ""}`);
  },
  approveDraft: (
    id: number,
    content?: string,
    send = true,
    templateOptions?: {
      template_name?: string;
      template_language?: string;
      template_variables?: string[];
    },
  ) =>
    request<ApproveDraftResult>(`/interactions/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        content,
        approved_by: "dashboard_user",
        send,
        template_name: templateOptions?.template_name,
        template_language: templateOptions?.template_language ?? "en_US",
        template_variables: templateOptions?.template_variables ?? [],
      }),
    }),
  rejectDraft: (id: number) =>
    request<DraftInteraction>(`/interactions/${id}/reject`, { method: "POST" }),
  createBulkEmailDrafts: (
    templateId: number,
    buyerIds: number[],
    attachments: EmailAttachment[] = [],
    send = true,
    confirmOverlap = false,
  ) =>
    request<BulkEmailDraftResponse>("/interactions/bulk-email-drafts", {
      method: "POST",
      body: JSON.stringify({
        template_id: templateId,
        buyer_ids: buyerIds,
        attachments,
        send,
        confirm_overlap: confirmOverlap,
      }),
    }),
  createBulkManualEmailDrafts: (
    buyerIds: number[],
    subject: string,
    body: string,
    attachments: EmailAttachment[] = [],
    send = true,
    confirmOverlap = false,
  ) =>
    request<BulkEmailDraftResponse>("/interactions/bulk-manual-email-drafts", {
      method: "POST",
      body: JSON.stringify({
        buyer_ids: buyerIds,
        subject,
        body,
        attachments,
        send,
        confirm_overlap: confirmOverlap,
      }),
    }),
  checkBulkEmailOverlap: (buyerIds: number[]) =>
    request<BulkEmailOverlapCheckResponse>("/interactions/bulk-email-overlap-check", {
      method: "POST",
      body: JSON.stringify({ buyer_ids: buyerIds }),
    }),
  createManualEmailDraft: (data: {
    buyer_id: number;
    subject: string;
    body: string;
    contact_id?: number | null;
    attachments?: EmailAttachment[];
    send?: boolean;
  }) =>
    request<ManualEmailSendResult>("/interactions/manual-email-draft", {
      method: "POST",
      body: JSON.stringify({
        buyer_id: data.buyer_id,
        subject: data.subject,
        body: data.body,
        contact_id: data.contact_id ?? undefined,
        attachments: data.attachments ?? [],
        send: data.send ?? true,
      }),
    }),
  listEmailActivity: (
    params: {
      page?: number;
      page_size?: number;
      unread_only?: boolean;
      channel?: "email" | "whatsapp";
      event_type?: string;
      send_mode?: "individual" | "bulk" | string;
      days?: number | null;
      date_from?: string;
      date_to?: string;
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.page_size) search.set("page_size", String(params.page_size));
    if (params.unread_only) search.set("unread_only", "true");
    search.set("channel", params.channel || "email");
    if (params.event_type) search.set("event_type", params.event_type);
    if (params.send_mode) search.set("send_mode", params.send_mode);
    if (params.days != null && params.days > 0) search.set("days", String(params.days));
    if (params.date_from) search.set("date_from", params.date_from);
    if (params.date_to) search.set("date_to", params.date_to);
    const query = search.toString();
    return request<EmailActivityListResponse>(`/email-activity${query ? `?${query}` : ""}`);
  },
  getEmailActivityUnreadCount: (channel: "email" | "whatsapp" = "email") =>
    request<{ unread_count: number }>(`/email-activity/unread-count?channel=${channel}`),
  listEmailActivityCatalog: () =>
    request<EmailActivityCatalogItem[]>("/email-activity/catalog"),
  getEmailActivityInsights: (
    params?:
      | number
      | null
      | {
          days?: number | null;
          date_from?: string;
          date_to?: string;
          channel?: "email" | "whatsapp";
        },
    channelArg: "email" | "whatsapp" = "email",
  ) => {
    const search = new URLSearchParams();
    if (params != null && typeof params === "object") {
      if (params.date_from || params.date_to) {
        if (params.date_from) search.set("date_from", params.date_from);
        if (params.date_to) search.set("date_to", params.date_to);
      } else if (params.days === null) {
        search.set("days", "0");
      } else if (params.days != null) {
        search.set("days", String(params.days));
      }
      search.set("channel", params.channel ?? "email");
    } else {
      if (params === null) search.set("days", "0");
      else if (params != null) search.set("days", String(params));
      search.set("channel", channelArg);
    }
    const query = search.toString();
    return request<EmailActivityInsights>(`/email-activity/insights${query ? `?${query}` : ""}`);
  },
  getEmailActivityBulkResults: (eventId: number) =>
    request<EmailActivityBulkResults>(`/email-activity/events/${eventId}/results`),
  markEmailActivityRead: (data: {
    event_ids?: number[];
    mark_all?: boolean;
    channel?: "email" | "whatsapp";
  }) =>
    request<{ updated: number }>("/email-activity/mark-read", {
      method: "POST",
      body: JSON.stringify({
        event_ids: data.event_ids ?? [],
        mark_all: data.mark_all ?? false,
        channel: data.channel,
      }),
    }),
  analyzeEmailActivity: (params: {
    days?: number | null;
    date_from?: string;
    date_to?: string;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.date_from || params.date_to) {
      if (params.date_from) search.set("date_from", params.date_from);
      if (params.date_to) search.set("date_to", params.date_to);
    } else if (params.days === null) {
      search.set("days", "0");
    } else if (params.days != null) {
      search.set("days", String(params.days));
    }
    const query = search.toString();
    return request<EmailActivityAiResponse>(
      `/email-activity/ai-analysis${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
  },
  suggestEmailActivityImprovements: (params: {
    days?: number | null;
    date_from?: string;
    date_to?: string;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.date_from || params.date_to) {
      if (params.date_from) search.set("date_from", params.date_from);
      if (params.date_to) search.set("date_to", params.date_to);
    } else if (params.days === null) {
      search.set("days", "0");
    } else if (params.days != null) {
      search.set("days", String(params.days));
    }
    const query = search.toString();
    return request<EmailActivityAiResponse>(
      `/email-activity/improve-suggestions${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
  },
  bulkApproveDrafts: (interactionIds: number[], send = true) =>
    request<BulkApproveResponse>("/interactions/bulk-approve", {
      method: "POST",
      body: JSON.stringify({
        interaction_ids: interactionIds,
        approved_by: "dashboard_user",
        send,
      }),
    }),
  getBulkEmailSettings: () =>
    request<BulkEmailSettings>("/interactions/bulk-email-settings"),

  createMailerHandoff: (buyerIds: number[]) =>
    request<{
      url: string;
      token: string;
      expires_in_seconds: number;
      recipient_count: number;
      skipped_no_email: number;
    }>("/mailer/handoff", {
      method: "POST",
      body: JSON.stringify({ buyer_ids: buyerIds }),
    }),

  createMailerSession: () =>
    request<{
      url: string;
      code: string;
      expires_in_seconds: number;
    }>("/mailer/session", { method: "POST" }),

  getDailyKpi: (params: {
    date: string;
    period?: KpiPeriod | string;
    user_id?: number | null;
  }) => {
    const search = new URLSearchParams();
    search.set("date", params.date);
    if (params.period) search.set("period", params.period);
    if (params.user_id != null) search.set("user_id", String(params.user_id));
    return request<DailyKpiReport>(`/kpi/daily?${search.toString()}`);
  },
  /** What the customer's phone is doing during a dashboard call (ringing / answered / busy ...). */
  getCallLegStatus: (callSid: string) =>
    request<{ status: string; twilio_status: string | null; attempts: number }>(
      `/call-legs/status?call_sid=${encodeURIComponent(callSid)}`,
    ),
  /** Graded scorecard (targets vs. actual) for a day / week / month. */
  getKpiScorecard: (params: { date: string; period?: KpiPeriod | string; user_id?: number | null }) => {
    const search = new URLSearchParams();
    search.set("date", params.date);
    if (params.period) search.set("period", params.period);
    if (params.user_id != null) search.set("user_id", String(params.user_id));
    return request<KpiScorecard>(`/kpi/scorecard?${search.toString()}`);
  },
  /** Admin + password: read the scorecard targets / settings. */
  unlockKpiScorecardConfig: (pin: string) =>
    request<KpiScorecardConfigPayload>("/kpi/scorecard/config/unlock", {
      method: "POST",
      body: JSON.stringify({ pin }),
    }),
  /** Admin + password: save the scorecard targets / settings. */
  saveKpiScorecardConfig: (pin: string, config: KpiScorecardConfig) =>
    request<KpiScorecardConfigPayload>("/kpi/scorecard/config", {
      method: "PUT",
      body: JSON.stringify({ pin, config }),
    }),
  /** One row per contact behind a KPI box (personal/bulk email & WhatsApp, leads imported). */
  getKpiCardRows: (params: {
    card: string;
    date: string;
    period?: KpiPeriod | string;
    user_id?: number | null;
  }) => {
    const search = new URLSearchParams();
    search.set("card", params.card);
    search.set("date", params.date);
    if (params.period) search.set("period", params.period);
    if (params.user_id != null) search.set("user_id", String(params.user_id));
    return request<{ card: string; total: number; rows: KpiActivityItem[] }>(
      `/kpi/card-rows?${search.toString()}`,
    );
  },
  generateKpiSummary: (params: {
    date: string;
    period?: KpiPeriod | string;
    user_id?: number | null;
  }) =>
    request<KpiSummaryResponse>("/kpi/summary", {
      method: "POST",
      body: JSON.stringify({
        date: params.date,
        period: params.period ?? "day",
        user_id: params.user_id ?? null,
      }),
    }),

  listManualKpi: (params: {
    date: string;
    period?: ManualKpiPeriod | string;
    user_id?: number;
  }) => {
    const search = new URLSearchParams();
    search.set("date", params.date);
    if (params.period) search.set("period", params.period);
    if (params.user_id != null) search.set("user_id", String(params.user_id));
    return request<ManualKpiListResponse>(`/kpi/manual?${search}`);
  },
  createManualKpi: (payload: {
    activity_date: string;
    person_name?: string | null;
    company?: string | null;
    country?: string | null;
    contact_type?: string | null;
    follow_up_type?: string | null;
    wechat_contacts?: string | null;
    remarks?: string | null;
  }) =>
    request<ManualKpiEntry>("/kpi/manual", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateManualKpi: (
    entryId: number,
    payload: Partial<{
      activity_date: string;
      person_name: string | null;
      company: string | null;
      country: string | null;
      contact_type: string | null;
      follow_up_type: string | null;
      wechat_contacts: string | null;
      remarks: string | null;
    }>,
  ) =>
    request<ManualKpiEntry>(`/kpi/manual/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteManualKpi: (entryId: number) =>
    request<void>(`/kpi/manual/${entryId}`, { method: "DELETE" }),

  getInboxStatus: (mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxStatus>(`/inbox/status${qs}`);
  },
  listInboxSwitchableMailboxes: () =>
    request<{
      can_switch: boolean;
      mailboxes: Array<{
        user_id: number;
        email: string;
        display_name?: string | null;
        mailbox_enabled?: boolean;
      }>;
    }>("/inbox/switchable-mailboxes"),
  getUrgentUnrepliedEmails: () =>
    request<UrgentEmailsResponse>("/inbox/urgent-unreplied"),
  listInboxFolders: (mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxFoldersResponse>(`/inbox/folders${qs}`);
  },
  composeInboxMail: (
    payload: {
      to: string;
      subject?: string;
      body: string;
      cc?: string;
      bcc?: string;
      attachments?: Array<{ id: string; filename: string; content_type: string; size: number }>;
    },
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxComposeResponse>(`/inbox/compose${qs}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  resetInboxCutoff: (mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<{ showing_since: string }>(`/inbox/reset-cutoff${qs}`, { method: "POST" });
  },
  clearInboxCutoff: (mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<{ showing_since: string | null }>(`/inbox/clear-cutoff${qs}`, {
      method: "POST",
    });
  },
  clearAllInboxCutoffs: () =>
    request<{ status: string; cleared_count: number; showing_since: string | null }>(
      "/inbox/clear-all-cutoffs",
      { method: "POST" },
    ),
  getInboxUnreadCount: (mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<{ count: number }>(`/inbox/unread-count${qs}`);
  },
  listInboxThreads: (params: {
    limit?: number;
    offset?: number;
    unread_only?: boolean;
    q?: string;
    triage_category?: string;
    mailbox_user_id?: number | null;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.offset) search.set("offset", String(params.offset));
    if (params.unread_only) search.set("unread_only", "true");
    if (params.q) search.set("q", params.q);
    if (params.triage_category) search.set("triage_category", params.triage_category);
    if (params.mailbox_user_id != null && Number.isFinite(params.mailbox_user_id)) {
      search.set("mailbox_user_id", String(params.mailbox_user_id));
    }
    const query = search.toString();
    return request<InboxThreadListResponse>(`/inbox/threads${query ? `?${query}` : ""}`);
  },
  getHelpfulGuidance: (params: {
    months?: number;
    days?: number | null;
    date_from?: string;
    date_to?: string;
    channel?: "calls" | "emails" | "whatsapp" | "telegram" | string;
    user_id?: number | string;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.date_from || params.date_to) {
      if (params.date_from) search.set("date_from", params.date_from);
      if (params.date_to) search.set("date_to", params.date_to);
    } else if (params.days != null && params.days > 0) {
      search.set("days", String(params.days));
    } else if (params.months) {
      search.set("months", String(params.months));
    }
    if (params.channel) search.set("channel", params.channel);
    if (params.user_id != null) search.set("user_id", String(params.user_id));
    const query = search.toString();
    return request<Record<string, unknown>>(`/guidance/helpful${query ? `?${query}` : ""}`);
  },
  getInboxThread: (threadId: string, mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxThreadDetail>(
      `/inbox/threads/${encodeURIComponent(threadId)}${qs}`,
    );
  },
  replyInboxThread: (
    threadId: string,
    payload: {
      body: string;
      to?: string;
      subject?: string;
      cc?: string;
      bcc?: string;
      attachments?: Array<{ id: string; filename: string; content_type: string; size: number }>;
    },
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxReplyResponse>(
      `/inbox/threads/${encodeURIComponent(threadId)}/reply${qs}`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  },
  moveInboxThread: (
    threadId: string,
    toFolder: "inbox" | "trash" | "archive",
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxMoveResponse>(
      `/inbox/threads/${encodeURIComponent(threadId)}/move${qs}`,
      {
        method: "POST",
        body: JSON.stringify({ to_folder: toFolder }),
      },
    );
  },
  analyzeInboxThread: (
    threadId: string,
    payload: { goal?: string } = {},
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxAnalyzeResponse>(
      `/inbox/threads/${encodeURIComponent(threadId)}/analyze${qs}`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  },
  listInboxMessages: (
    params: {
      limit?: number;
      offset?: number;
      unread_only?: boolean;
      folder?: MailFolderKey | string;
      q?: string;
      mailbox_user_id?: number | null;
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.offset) search.set("offset", String(params.offset));
    if (params.unread_only) search.set("unread_only", "true");
    if (params.folder) search.set("folder", params.folder);
    if (params.q) search.set("q", params.q);
    if (params.mailbox_user_id != null && Number.isFinite(params.mailbox_user_id)) {
      search.set("mailbox_user_id", String(params.mailbox_user_id));
    }
    const query = search.toString();
    return request<InboxMessageListResponse>(`/inbox/messages${query ? `?${query}` : ""}`);
  },
  searchInboxMail: (
    payload: {
      query: string;
      scope: string;
      limit?: number;
      offset?: number;
    },
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxMessageListResponse>(`/inbox/search${qs}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  queryInboxMailAi: (
    payload: { question: string; unread_only?: boolean },
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxMailAiQueryResponse>(`/inbox/ai-query${qs}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getWhatsAppPersonalStatus: () =>
    request<Record<string, unknown>>("/whatsapp-personal/status"),
  getWhatsAppPersonalTeamStatus: () =>
    request<Array<Record<string, unknown>>>("/whatsapp-personal/team-status"),
  getWhatsAppPersonalQr: () => request<Record<string, unknown>>("/whatsapp-personal/qr"),
  getWhatsAppPersonalSession: () =>
    request<{ session_id: string }>("/whatsapp-personal/session"),
  disconnectWhatsAppPersonal: () =>
    request<Record<string, unknown>>("/whatsapp-personal/disconnect", { method: "POST" }),
  disconnectWhatsAppPersonalUser: (targetUserId: number) =>
    request<Record<string, unknown>>(`/whatsapp-personal/disconnect-user/${targetUserId}`, {
      method: "POST",
    }),
  pairWhatsAppPersonal: (opts?: { forceNew?: boolean }) => {
    const force = opts?.forceNew ? "?force=1" : "";
    return request<Record<string, unknown>>(`/whatsapp-personal/pair${force}`, {
      method: "POST",
    });
  },
  sendWhatsAppPersonal: (payload: { to_phone: string; message: string }) =>
    request<Record<string, unknown>>("/whatsapp-personal/send", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getTelegramPersonalStatus: () =>
    request<Record<string, unknown>>("/telegram-personal/status"),
  getTelegramPersonalSession: () =>
    request<{ session_id: string; bridge_configured: boolean }>("/telegram-personal/session"),
  startTelegramPersonalLogin: (phone: string) =>
    request<Record<string, unknown>>("/telegram-personal/start-login", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),
  startTelegramPersonalQrLogin: () =>
    request<Record<string, unknown>>("/telegram-personal/start-qr-login", {
      method: "POST",
    }),
  pollTelegramPersonalQrLogin: () =>
    request<Record<string, unknown>>("/telegram-personal/poll-qr-login", {
      method: "POST",
    }),
  confirmTelegramPersonalCode: (code: string) =>
    request<Record<string, unknown>>("/telegram-personal/confirm-code", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  confirmTelegramPersonalPassword: (password: string) =>
    request<Record<string, unknown>>("/telegram-personal/confirm-password", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  disconnectTelegramPersonal: () =>
    request<Record<string, unknown>>("/telegram-personal/disconnect", { method: "POST" }),
  sendTelegramPersonal: (to_phone: string, message: string) =>
    request<Record<string, unknown>>("/telegram-personal/send", {
      method: "POST",
      body: JSON.stringify({ to_phone, message }),
    }),
  sendTelegramPersonalBulk: (payload: { buyer_ids: number[]; message: string; phones?: string[] }) =>
    request<{
      sent_count: number;
      failed_count: number;
      skipped_count: number;
      results: Array<{ phone: string; status: string; error?: string; company?: string }>;
    }>("/telegram-personal/bulk-send", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listTelegramPersonalTemplates: () =>
    request<TelegramPersonalTemplate[]>("/telegram-personal/templates"),
  createTelegramPersonalTemplate: (data: { name: string; body: string }) =>
    request<TelegramPersonalTemplate>("/telegram-personal/templates", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateTelegramPersonalTemplate: (
    id: number,
    data: { name?: string; body?: string },
  ) =>
    request<TelegramPersonalTemplate>(`/telegram-personal/templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteTelegramPersonalTemplate: (id: number) =>
    request<{ ok: boolean }>(`/telegram-personal/templates/${id}`, {
      method: "DELETE",
    }),
  sendWhatsAppPersonalBulk: (payload: { buyer_ids: number[]; message: string; to_phone?: string }) =>
    request<WhatsAppCampaignDraftResponse>("/whatsapp-personal/bulk-send", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  rephraseWhatsAppMessage: (message: string) =>
    request<{ message: string }>("/whatsapp-personal/rephrase", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  listWhatsAppPersonalTemplates: () =>
    request<WhatsAppPersonalTemplate[]>("/whatsapp-personal/templates"),
  createWhatsAppPersonalTemplate: (data: { name: string; body: string }) =>
    request<WhatsAppPersonalTemplate>("/whatsapp-personal/templates", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateWhatsAppPersonalTemplate: (
    id: number,
    data: { name?: string; body?: string },
  ) =>
    request<WhatsAppPersonalTemplate>(`/whatsapp-personal/templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteWhatsAppPersonalTemplate: (id: number) =>
    request<{ ok: boolean }>(`/whatsapp-personal/templates/${id}`, {
      method: "DELETE",
    }),
  listWhatsAppPersonalConversations: (params: { page?: number; page_size?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.page_size) query.set("page_size", String(params.page_size));
    const qs = query.toString();
    return request<WhatsAppConversationListResponse>(
      `/whatsapp-personal/conversations${qs ? `?${qs}` : ""}`,
    );
  },
  listWhatsAppPersonalMessages: (contactId: number) =>
    request<DraftInteraction[]>(`/whatsapp-personal/conversations/${contactId}/messages`),
  replyWhatsAppPersonalConversation: (contactId: number, content: string) =>
    request<{ interaction: DraftInteraction; sent: boolean }>(
      `/whatsapp-personal/conversations/${contactId}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  getInboxMessage: (uid: string, folder = "INBOX", mailboxUserId?: number | null) => {
    const search = new URLSearchParams({ folder });
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    return request<InboxMessageDetail>(
      `/inbox/messages/${encodeURIComponent(uid)}?${search.toString()}`,
    );
  },
  /** Authenticated download of one attachment of a received message (index = its position in the list). */
  fetchInboxAttachmentBlob: async (
    uid: string,
    index: number,
    folder = "INBOX",
    mailboxUserId?: number | null,
  ) => {
    const search = new URLSearchParams({ folder });
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    const token = getStoredToken();
    const res = await fetch(
      `${API_BASE}/inbox/messages/${encodeURIComponent(uid)}/attachments/${index}?${search.toString()}`,
      { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (res.status === 401) {
      clearSession();
      window.dispatchEvent(new Event("kafi:auth-expired"));
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(messageForHttpError(res.status, text, res.statusText || "Failed to download attachment"));
    }
    return res.blob();
  },
  /** Copies a message's attachments into outgoing-email storage so a Forward can re-attach them. */
  stageInboxAttachmentsForForward: (uid: string, folder = "INBOX", mailboxUserId?: number | null) => {
    const search = new URLSearchParams({ folder });
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    return request<{ attachments: EmailAttachment[]; skipped: string[] }>(
      `/inbox/messages/${encodeURIComponent(uid)}/attachments/stage?${search.toString()}`,
      { method: "POST" },
    );
  },
  markInboxMessageRead: (uid: string, folder = "INBOX", mailboxUserId?: number | null) => {
    const search = new URLSearchParams({ folder });
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    return request<{ count: number }>(
      `/inbox/messages/${encodeURIComponent(uid)}/read?${search.toString()}`,
      { method: "POST" },
    );
  },
  moveInboxMessage: (
    uid: string,
    payload: { from_folder: string; to_folder: MailFolderKey | string },
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxMoveResponse>(`/inbox/messages/${encodeURIComponent(uid)}/move${qs}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  analyzeInboxMessage: (
    uid: string,
    payload: { goal?: string; folder?: string } = {},
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxAnalyzeResponse>(
      `/inbox/messages/${encodeURIComponent(uid)}/analyze${qs}`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  },
  emptyInboxTrash: (mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxEmptyTrashResponse>(`/inbox/trash/empty${qs}`, { method: "POST" });
  },
  getAutoTrashSettings: (mailboxUserId?: number | null) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    // Hit Railway production directly — stale Vercel rewrite host lacks these routes (404 Not Found).
    return request<AutoTrashSettings>(`/inbox/auto-trash/settings${qs}`, {
      apiBase: RAILWAY_API_BASE,
    });
  },
  updateAutoTrashSettings: (
    data: { enabled: boolean },
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<AutoTrashSettings>(`/inbox/auto-trash/settings${qs}`, {
      method: "PUT",
      body: JSON.stringify(data),
      apiBase: RAILWAY_API_BASE,
    });
  },
  getAutoTrashDailyLog: (days = 14) =>
    request<AutoTrashDailyLogResponse>(`/inbox/auto-trash/daily-log?days=${days}`, {
      apiBase: RAILWAY_API_BASE,
    }),
  runAutoTrashLearn: () =>
    request<AutoTrashLearnResponse>("/inbox/auto-trash/learn", {
      method: "POST",
      apiBase: RAILWAY_API_BASE,
    }),
  replyInboxMessage: (
    uid: string,
    payload: {
      body: string;
      to?: string;
      subject?: string;
      cc?: string;
      bcc?: string;
      folder?: string;
      attachments?: Array<{ id: string; filename: string; content_type: string; size: number }>;
    },
    mailboxUserId?: number | null,
  ) => {
    const qs =
      mailboxUserId != null && Number.isFinite(mailboxUserId)
        ? `?mailbox_user_id=${mailboxUserId}`
        : "";
    return request<InboxReplyResponse>(`/inbox/messages/${encodeURIComponent(uid)}/reply${qs}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  listMailLabels: (mailboxUserId?: number | null) => {
    const search = new URLSearchParams();
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    const q = search.toString();
    return request<MailLabel[]>(`/inbox/labels${q ? `?${q}` : ""}`);
  },
  createMailLabel: (data: {
    name: string;
    color?: string;
    match_query?: string | null;
    match_keyword?: string | null;
  }) =>
    request<MailLabel>("/inbox/labels", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  renameMailLabel: (labelId: number, payload: { name: string; color?: string }) =>
    request<MailLabel>(`/inbox/labels/${labelId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteMailLabel: (labelId: number) =>
    request<void>(`/inbox/labels/${labelId}`, { method: "DELETE" }),
  assignMailLabel: (payload: {
    label_id: number;
    folder?: string;
    message_uid: string;
    message_id?: string | null;
    thread_id?: string | null;
    from_email?: string | null;
    subject?: string | null;
    apply_similar?: boolean;
    mailbox_user_id?: number | null;
  }) =>
    request<{ assigned: number; similar_rule: number; label_id: number }>("/inbox/labels/assign", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  unassignMailLabel: (payload: {
    label_id: number;
    folder?: string;
    message_uid: string;
    mailbox_user_id?: number | null;
  }) =>
    request<{ removed: boolean }>("/inbox/labels/unassign", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listMailLabelMessages: (labelId: number, mailboxUserId?: number | null) => {
    const search = new URLSearchParams();
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    const q = search.toString();
    return request<MailLabelMessageKey[]>(
      `/inbox/labels/${labelId}/messages${q ? `?${q}` : ""}`,
    );
  },
  /** Flagged / exact assignments: one IMAP batch — avoids N parallel getInboxMessage hangs. */
  resolveMailLabelMessages: (labelId: number, mailboxUserId?: number | null) => {
    const search = new URLSearchParams({ resolve: "true" });
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    return request<{
      items: InboxMessageSummary[];
      total: number;
      keys: MailLabelMessageKey[];
    }>(`/inbox/labels/${labelId}/messages?${search.toString()}`);
  },
  mapMailLabelsByUids: (folder: string, uids: string[], mailboxUserId?: number | null) => {
    const search = new URLSearchParams();
    search.set("folder", folder);
    if (uids.length) search.set("uids", uids.join(","));
    if (mailboxUserId != null && Number.isFinite(mailboxUserId)) {
      search.set("mailbox_user_id", String(mailboxUserId));
    }
    return request<Record<string, MailLabel[]>>(`/inbox/labels/map/by-uids?${search.toString()}`);
  },
  listMailDrafts: () => request<MailComposeDraft[]>("/inbox/drafts"),
  getMailDraftCount: () => request<{ count: number }>("/inbox/drafts/count"),
  upsertMailDraft: (payload: {
    id?: number | null;
    to_addrs?: string;
    cc_addrs?: string;
    subject?: string;
    body?: string;
  }) =>
    request<MailComposeDraft>("/inbox/drafts", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteMailDraft: (draftId: number) =>
    request<void>(`/inbox/drafts/${draftId}`, { method: "DELETE" }),

  listPersonalizedFollowups: (params: { status?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.limit != null) search.set("limit", String(params.limit));
    const q = search.toString();
    return request<PersonalizedFollowupListResponse>(
      `/personalized-followups${q ? `?${q}` : ""}`,
    );
  },
  getPersonalizedFollowup: (id: number) =>
    request<PersonalizedFollowupDraft>(`/personalized-followups/${id}`),
  getPersonalizedFollowupByInteraction: (interactionId: number) =>
    request<PersonalizedFollowupDraft>(
      `/personalized-followups/by-interaction/${interactionId}`,
    ),
  updatePersonalizedFollowup: (
    id: number,
    data: Partial<{ subject: string; email_body: string; whatsapp_body: string }>,
  ) =>
    request<PersonalizedFollowupDraft>(`/personalized-followups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  regeneratePersonalizedFollowup: (id: number) =>
    request<PersonalizedFollowupDraft>(`/personalized-followups/${id}/regenerate`, {
      method: "POST",
    }),
  translatePersonalizedFollowup: (
    id: number,
    data: {
      language: string;
      subject?: string;
      email_body?: string;
      whatsapp_body?: string;
    },
  ) =>
    request<{
      language: string;
      language_label: string;
      subject: string;
      email_body: string;
      whatsapp_body: string;
    }>(`/personalized-followups/${id}/translate`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  sendPersonalizedFollowup: (
    id: number,
    payload: PersonalizedFollowupSendPayload = { channels: "both" },
  ) =>
    request<PersonalizedFollowupSendResponse>(`/personalized-followups/${id}/send`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  dismissPersonalizedFollowup: (id: number) =>
    request<PersonalizedFollowupDraft>(`/personalized-followups/${id}/dismiss`, {
      method: "POST",
    }),

  /** Call follow-ups for AI Agents: situation groups + drafts (setup only). */
  listCallFollowups: () =>
    request<{ groups: CallFollowupGroup[]; placeholders: string[]; mode: CallFollowupMode }>(
      "/call-followups",
    ),
  setCallFollowupMode: (mode: CallFollowupMode) =>
    request<{ mode: CallFollowupMode }>("/call-followups/mode", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    }),
  createCallFollowupGroup: (data: { name: string; description?: string; enabled?: boolean }) =>
    request<CallFollowupGroup>("/call-followups/groups", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateCallFollowupGroup: (
    id: number,
    data: Partial<{ name: string; description: string; enabled: boolean }>,
  ) =>
    request<CallFollowupGroup>(`/call-followups/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteCallFollowupGroup: (id: number) =>
    request<{ ok: boolean }>(`/call-followups/groups/${id}`, { method: "DELETE" }),
  createCallFollowupDraft: (
    groupId: number,
    data: {
      name: string;
      subject?: string;
      body?: string;
      whatsapp_text?: string;
      attachment_mode?: "none" | "auto" | "catalogue";
      catalogue_ids?: string[];
      enabled?: boolean;
    },
  ) =>
    request<CallFollowupDraft>(`/call-followups/groups/${groupId}/drafts`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateCallFollowupDraft: (
    id: number,
    data: Partial<{
      name: string;
      subject: string;
      body: string;
      whatsapp_text: string;
      attachment_mode: "none" | "auto" | "catalogue";
      catalogue_ids: string[];
      enabled: boolean;
    }>,
  ) =>
    request<CallFollowupDraft>(`/call-followups/drafts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteCallFollowupDraft: (id: number) =>
    request<{ ok: boolean }>(`/call-followups/drafts/${id}`, { method: "DELETE" }),

  listEmailTemplates: () => request<EmailTemplate[]>("/email-templates"),
  getEmailTemplatePlaceholders: () =>
    request<{ placeholders: string[]; usage: string }>("/email-templates/placeholders"),
  generateEmailTemplateFromTitle: (title: string) =>
    request<{ name: string; subject: string; body: string }>(
      "/email-templates/generate-from-title",
      {
        method: "POST",
        body: JSON.stringify({ title }),
      },
    ),
  createEmailTemplate: (data: {
    name: string;
    subject: string;
    body: string;
    attachments?: EmailAttachment[];
  }) =>
    request<EmailTemplate>("/email-templates", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateEmailTemplate: (
    id: number,
    data: Partial<{ name: string; subject: string; body: string; attachments: EmailAttachment[] }>,
  ) =>
    request<EmailTemplate>(`/email-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteEmailTemplate: (id: number) =>
    request<void>(`/email-templates/${id}`, { method: "DELETE" }),
  previewEmailTemplate: (templateId: number, buyerId: number) =>
    request<EmailTemplatePreview>(`/email-templates/${templateId}/preview/${buyerId}`),
  previewEmailText: (buyerId: number, subject: string, body: string) =>
    request<EmailTemplatePreview>("/email-templates/preview-text", {
      method: "POST",
      body: JSON.stringify({ buyer_id: buyerId, subject, body }),
    }),

  /** Shared mailer picture library (groups of hosted images). */
  listPictureLibrary: () =>
    request<{ groups: PictureLibraryGroup[] }>("/mailer/picture-library"),
  createPictureGroup: (name: string) =>
    request<{ ok: boolean; group: PictureLibraryGroup }>("/mailer/picture-library/groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renamePictureGroup: (groupId: string, name: string) =>
    request<{ ok: boolean; group: PictureLibraryGroup }>(
      `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/rename`,
      { method: "POST", body: JSON.stringify({ name }) },
    ),
  deletePictureGroup: (groupId: string) =>
    request<{ ok: boolean }>(
      `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/delete`,
      { method: "POST" },
    ),
  savePictureLibrary: (groups: PictureLibraryGroup[]) =>
    request<{ ok: boolean; library: { groups: PictureLibraryGroup[] } }>(
      "/mailer/picture-library/save",
      { method: "POST", body: JSON.stringify({ groups }) },
    ),
  updatePictureCaption: (groupId: string, mediaId: string, caption: string) =>
    request<{ ok: boolean; image: PictureLibraryImage }>(
      `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images/${encodeURIComponent(mediaId)}/caption`,
      { method: "POST", body: JSON.stringify({ caption }) },
    ),
  deletePictureFromGroup: (groupId: string, mediaId: string) =>
    request<{ ok: boolean }>(
      `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images/${encodeURIComponent(mediaId)}/delete`,
      { method: "POST" },
    ),
  uploadPictureToGroup: async (groupId: string, file: File): Promise<PictureLibraryImage> => {
    const form = new FormData();
    form.append("file", file);
    const headers = new Headers(authHeaders());
    const base = API_BASE.replace(/\/+$/, "");
    const res = await fetch(
      `${base}/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images`,
      { method: "POST", headers, credentials: "include", body: form },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(messageForHttpError(res.status, text, res.statusText));
    }
    let data: { image?: PictureLibraryImage } = {};
    try {
      data = text ? (JSON.parse(text) as { image?: PictureLibraryImage }) : {};
    } catch {
      throw new Error("Invalid upload response");
    }
    if (!data.image) throw new Error("Upload succeeded but no image returned");
    return data.image;
  },

  uploadEmailAttachment: async (
    file: File,
    options?: {
      onProgress?: (info: { percent: number; label: string }) => void;
    },
  ) => {
    const onProgress = options?.onProgress;
    const report = (percent: number, label: string) => {
      onProgress?.({
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        label,
      });
    };
    if (file.size > EMAIL_ATTACHMENT_MAX_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      throw new Error(
        `"${file.name}" is ${mb} MB. Keep each attachment under ${
          EMAIL_ATTACHMENT_MAX_BYTES / (1024 * 1024)
        } MB — email providers (Gmail, Outlook, etc.) reject messages around 25 MB total.`,
      );
    }

    // Large files: chunked upload direct to Railway (bypass Vercel rewrite), then fall back to /api.
    if (file.size > ATTACHMENT_CHUNK_BYTES) {
      const totalChunks = Math.ceil(file.size / ATTACHMENT_CHUNK_BYTES);
      const chunkBases = [RAILWAY_API_BASE, API_BASE].filter(
        (base, index, all) => all.indexOf(base) === index,
      );

      let lastError: Error | null = null;
      for (const base of chunkBases) {
        try {
          report(0, `Starting upload… ${file.name}`);
          const initHeaders = new Headers(authHeaders({ "Content-Type": "application/json" }));
          const initController = new AbortController();
          const initTimer = window.setTimeout(
            () => initController.abort(),
            ATTACHMENT_UPLOAD_TIMEOUT_MS,
          );
          let init: { upload_id: string; total_chunks: number };
          try {
            const initRes = await fetch(`${base}/email/attachments/chunk-init`, {
              method: "POST",
              headers: initHeaders,
              credentials: base === API_BASE ? "include" : "omit",
              signal: initController.signal,
              body: JSON.stringify({
                filename: file.name,
                content_type: file.type || null,
                size: file.size,
                total_chunks: totalChunks,
              }),
            });
            if (!initRes.ok) {
              const textBody = await initRes.text().catch(() => "");
              throw new Error(messageForHttpError(initRes.status, textBody, initRes.statusText));
            }
            init = (await initRes.json()) as { upload_id: string; total_chunks: number };
          } finally {
            window.clearTimeout(initTimer);
          }

          for (let index = 0; index < totalChunks; index++) {
            const startByte = index * ATTACHMENT_CHUNK_BYTES;
            const endByte = Math.min(file.size, startByte + ATTACHMENT_CHUNK_BYTES);
            const pct = (endByte / file.size) * 95;
            report(
              pct,
              `Uploading ${file.name}… ${Math.round(pct)}% (chunk ${index + 1}/${totalChunks})`,
            );
            const blob = file.slice(startByte, endByte);

            let chunkOk = false;
            let lastChunkErr: Error | null = null;
            for (let attempt = 0; attempt < 2 && !chunkOk; attempt++) {
              if (attempt > 0) {
                report(
                  pct,
                  `Retrying chunk ${index + 1}/${totalChunks}… ${Math.round(pct)}%`,
                );
                await new Promise((r) => window.setTimeout(r, 800));
              }
              const form = new FormData();
              form.append("upload_id", init.upload_id);
              form.append("index", String(index));
              form.append("file", blob, `${file.name}.part${index}`);

              const controller = new AbortController();
              const timer = window.setTimeout(
                () => controller.abort(),
                ATTACHMENT_UPLOAD_TIMEOUT_MS,
              );
              try {
                const res = await fetch(`${base}/email/attachments/chunk`, {
                  method: "POST",
                  body: form,
                  headers: authHeaders(),
                  credentials: base === API_BASE ? "include" : "omit",
                  signal: controller.signal,
                });
                if (!res.ok) {
                  const textBody = await res.text().catch(() => "");
                  throw new Error(messageForHttpError(res.status, textBody, res.statusText));
                }
                chunkOk = true;
              } catch (err) {
                const isAbort = err instanceof DOMException && err.name === "AbortError";
                lastChunkErr = isAbort
                  ? new Error(
                      `Upload timed out on chunk ${index + 1}/${totalChunks}. Close other upload tabs and try again.`,
                    )
                  : err instanceof Error
                    ? err
                    : new Error(String(err));
              } finally {
                window.clearTimeout(timer);
              }
            }
            if (!chunkOk) {
              throw lastChunkErr || new Error(`Chunk ${index + 1} failed`);
            }
          }

          report(98, `Finishing upload… ${file.name}`);
          const doneHeaders = new Headers(authHeaders({ "Content-Type": "application/json" }));
          const doneController = new AbortController();
          const doneTimer = window.setTimeout(
            () => doneController.abort(),
            ATTACHMENT_UPLOAD_TIMEOUT_MS,
          );
          try {
            const doneRes = await fetch(`${base}/email/attachments/chunk-complete`, {
              method: "POST",
              headers: doneHeaders,
              credentials: base === API_BASE ? "include" : "omit",
              signal: doneController.signal,
              body: JSON.stringify({ upload_id: init.upload_id }),
            });
            if (!doneRes.ok) {
              const textBody = await doneRes.text().catch(() => "");
              throw new Error(messageForHttpError(doneRes.status, textBody, doneRes.statusText));
            }
            report(100, `Uploaded ${file.name}`);
            return (await doneRes.json()) as EmailAttachment;
          } finally {
            window.clearTimeout(doneTimer);
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const msg = lastError.message || "";
          if (/too large|under \d+ MB|not allowed|empty/i.test(msg)) {
            throw lastError;
          }
          continue;
        }
      }
      throw lastError || new Error("Attachment upload failed");
    }

    // Small files: single POST (prefer Railway direct, fall back to same-origin /api).
    report(15, `Uploading ${file.name}…`);
    const endpoints = [RAILWAY_API_BASE, API_BASE].filter(
      (base, index, all) => all.indexOf(base) === index,
    );

    let lastError: Error | null = null;
    for (const base of endpoints) {
      const form = new FormData();
      form.append("file", file);
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), ATTACHMENT_UPLOAD_TIMEOUT_MS);
      try {
        report(40, `Uploading ${file.name}…`);
        const res = await fetch(`${base}/email/attachments`, {
          method: "POST",
          body: form,
          headers: authHeaders(),
          credentials: base === API_BASE ? "include" : "omit",
          signal: controller.signal,
        });
        if (!res.ok) {
          const textBody = await res.text().catch(() => "");
          throw new Error(messageForHttpError(res.status, textBody, res.statusText));
        }
        report(100, `Uploaded ${file.name}`);
        return (await res.json()) as EmailAttachment;
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        lastError = isAbort
          ? new Error("Upload timed out. Close other upload tabs and try again.")
          : err instanceof Error
            ? err
            : new Error(String(err));
        const msg = lastError.message || "";
        if (/too large|under \d+ MB|not allowed|empty|gateway/i.test(msg) && !isAbort) {
          throw lastError;
        }
        continue;
      } finally {
        window.clearTimeout(timer);
      }
    }
    throw lastError || new Error("Attachment upload failed");
  },

  compareEnrichmentFile: async (file: File, userId?: number, tableSource = "master_table", masterType = "fmcg") => {
    const form = new FormData();
    form.append("file", file);
    const params = new URLSearchParams({ table_source: tableSource, master_type: masterType });
    if (userId && !isNaN(userId) && userId > 0) params.set("user_id", String(userId));
    const res = await fetch(`${API_BASE}/leads/enrichment/compare?${params.toString()}`, {
      method: "POST",
      body: form,
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(messageForHttpError(res.status, text, res.statusText));
    }
    return res.json() as Promise<EnrichmentComparisonReport>;
  },

  safeMergeEnrichmentFile: async (file: File, userId?: number, tableSource = "master_table", masterType = "fmcg") => {
    const form = new FormData();
    form.append("file", file);
    const params = new URLSearchParams({ table_source: tableSource, master_type: masterType });
    if (userId && !isNaN(userId) && userId > 0) params.set("user_id", String(userId));
    const res = await fetch(`${API_BASE}/leads/enrichment/safe-merge?${params.toString()}`, {
      method: "POST",
      body: form,
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(messageForHttpError(res.status, text, res.statusText));
    }
    return res.json() as Promise<SafeMergeResult>;
  },

  getMissingDataReport: async (section = "master", columnKey = "contact_name", userId?: number, masterType = "fmcg") => {
    const params = new URLSearchParams({ section, column_key: columnKey, master_type: masterType });
    if (userId && !isNaN(userId) && userId > 0) params.set("user_id", String(userId));
    const res = await fetch(`${API_BASE}/leads/missing-data-report?${params.toString()}`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(messageForHttpError(res.status, text, res.statusText));
    }
    return res.json() as Promise<MissingDataReport>;
  },

  updateDraftAttachments: (interactionId: number, attachments: EmailAttachment[]) =>
    request<DraftInteraction>(`/interactions/${interactionId}/attachments`, {
      method: "PATCH",
      body: JSON.stringify({ attachments }),
    }),

  getConsentSummary: () => request<ConsentSummary>("/compliance/summary"),
  listComplianceContacts: (params: { consent?: string; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.consent) search.set("consent", params.consent);
    if (params.q) search.set("q", params.q);
    const query = search.toString();
    return request<ComplianceContact[]>(`/compliance/contacts${query ? `?${query}` : ""}`);
  },
  bulkUpdateConsent: (contactIds: number[], consentStatus: string) =>
    request<{ updated_count: number }>("/compliance/contacts/bulk", {
      method: "PATCH",
      body: JSON.stringify({ contact_ids: contactIds, consent_status: consentStatus }),
    }),
  updateComplianceContact: (
    contactId: number,
    data: {
      consent_status?: string;
      date_of_birth?: string;
      nationality?: string;
    },
  ) =>
    request<ComplianceContact>(`/compliance/contacts/${contactId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  getChatbotStatus: () => request<ChatbotStatus>("/chatbot/status"),
  sendChatbotMessage: async (payload: {
    message: string;
    image?: File;
    history?: ChatMessage[];
  }): Promise<ChatResponse> => {
    const form = new FormData();
    form.append("message", payload.message);
    form.append("history", JSON.stringify(payload.history ?? []));
    if (payload.image) form.append("image", payload.image);
    const res = await fetch(`${API_BASE}/chatbot/chat`, {
      method: "POST",
      body: form,
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(messageForHttpError(res.status, text, res.statusText));
    }
    return res.json() as Promise<ChatResponse>;
  },

  getSalesAssistantStatus: () =>
    request<SalesAssistantStatus>("/sales-assistant/status"),

  unlockSalesAssistant: (access_code: string) =>
    request<{ ok: boolean }>("/sales-assistant/unlock", {
      method: "POST",
      body: JSON.stringify({ access_code }),
    }),

  sendSalesAssistantMessage: (payload: {
    message: string;
    access_code: string;
    history?: SalesAssistantHistoryMessage[];
  }) =>
    request<SalesAssistantChatResponse>("/sales-assistant/chat", {
      method: "POST",
      body: JSON.stringify({
        message: payload.message,
        access_code: payload.access_code,
        history: payload.history ?? [],
      }),
    }),

  getCallConfig: () => request<CallConfig>("/calls/config"),
  getTwilioBalance: () => request<TwilioBalance>("/calls/twilio-balance"),
  toggleHangupAfterFourthRing: (enabled: boolean, maxRingAttempts?: number) =>
    request<{
      ok: boolean;
      hangup_after_fourth_ring: boolean;
      ring_timeout_seconds: number;
      max_ring_attempts?: number;
      message: string;
    }>("/calls/hangup-after-fourth-ring", {
      method: "POST",
      body: JSON.stringify({
        enabled,
        ...(maxRingAttempts != null ? { max_ring_attempts: maxRingAttempts } : {}),
      }),
    }),
  getVoiceEngineSettings: () => request<VoiceEngineSettings>("/calls/voice-engine-settings"),
  unlockVoiceSettings: (pin: string) =>
    request<VoiceEngineSettings>("/calls/unlock-voice-settings", {
      method: "POST",
      body: JSON.stringify({ pin }),
    }),
  unlockOrgAdmin: (pin: string) =>
    request<{ ok: boolean } & OrgAdminSnapshot>("/org-admin/unlock", {
      method: "POST",
      body: JSON.stringify({ pin }),
    }),
  getMyMasterLists: () =>
    request<{ master_lists: OrgAdminMasterList[] }>("/org-admin/master-lists"),
  getOrgAdminMasterListsAdmin: (pin: string) =>
    request<{
      master_lists: OrgAdminMasterList[];
      user_master_access: Record<string, string[]>;
      agent_master_access?: Record<string, string[]>;
      users: OrgAdminUserRow[];
    }>(`/org-admin/master-lists/admin?pin=${encodeURIComponent(pin)}`),
  upsertOrgMasterList: (data: {
    pin: string;
    key?: string | null;
    label: string;
    enabled?: boolean;
    sort_order?: number | null;
  }) =>
    request<{ ok: boolean; master_list: OrgAdminMasterList }>("/org-admin/master-lists", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteOrgMasterList: (pin: string, key: string) =>
    request<{ ok: boolean }>("/org-admin/master-lists/delete", {
      method: "POST",
      body: JSON.stringify({ pin, key }),
    }),
  setOrgUserMasterAccess: (pin: string, userId: number, masterListKeys: string[]) =>
    request<{ ok: boolean; user_id: number; master_list_keys: string[] }>(
      "/org-admin/master-lists/user-access",
      {
        method: "POST",
        body: JSON.stringify({ pin, user_id: userId, master_list_keys: masterListKeys }),
      },
    ),
  setOrgAgentMasterAccess: (pin: string, agentId: string, masterListKeys: string[]) =>
    request<{ ok: boolean; agent_id: string; master_list_keys: string[] }>(
      "/org-admin/master-lists/agent-access",
      {
        method: "POST",
        body: JSON.stringify({ pin, agent_id: agentId, master_list_keys: masterListKeys }),
      },
    ),
  listOrgAiSalesAgents: (activeOnly = false, masterType?: string | null) => {
    const params = new URLSearchParams();
    params.set("active_only", activeOnly ? "true" : "false");
    if (masterType) params.set("master_type", masterType);
    return request<{ agents: OrgAdminAiSalesAgent[]; master_type?: string | null }>(
      `/org-admin/ai-sales-agents?${params.toString()}`,
    );
  },
  upsertOrgAiSalesAgent: (data: {
    pin: string;
    id?: string | null;
    name: string;
    active?: boolean;
    product_focus?: string;
    voice?: string | null;
  }) =>
    request<{ ok: boolean; agent: OrgAdminAiSalesAgent }>("/org-admin/ai-sales-agents", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteOrgAiSalesAgent: (pin: string, id: string) =>
    request<{ ok: boolean }>("/org-admin/ai-sales-agents/delete", {
      method: "POST",
      body: JSON.stringify({ pin, id }),
    }),
  toggleVapiEngine: (pin: string, enabled: boolean) =>
    request<{ ok: boolean; vapi_enabled: boolean; message: string }>("/calls/toggle-vapi-engine", {
      method: "POST",
      body: JSON.stringify({ pin, enabled }),
    }),
  toggleElevenLabsEngine: (pin: string, enabled: boolean) =>
    request<{ ok: boolean; elevenlabs_enabled: boolean; message: string }>("/calls/toggle-elevenlabs-engine", {
      method: "POST",
      body: JSON.stringify({ pin, enabled }),
    }),
  updateElevenLabsKey: (pin: string, apiKey: string) =>
    request<{ ok: boolean; has_key: boolean; message: string }>("/calls/update-elevenlabs-key", {
      method: "POST",
      body: JSON.stringify({ pin, api_key: apiKey }),
    }),
  listInterestedFollowUps: () =>
    request<InterestedFollowUp[]>("/leads/interested-follow-ups"),
  acknowledgeInterestedFollowUp: (buyerId: number) =>
    request<{ buyer_id: number; interested_follow_up_ack_at: string; follow_up_at: null }>(
      `/leads/interested-follow-ups/${buyerId}/acknowledge`,
      { method: "POST" },
    ),
  scheduleInterestedFollowUp: (buyerId: number, followUpAt: string | null) =>
    request<{ buyer_id: number; follow_up_at: string | null }>(
      `/leads/interested-follow-ups/${buyerId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ follow_up_at: followUpAt }),
      },
    ),
  getVoiceToken: () => request<VoiceToken>("/calls/voice-token"),
  listDialableLeads: (
    params: {
      page?: number;
      page_size?: number;
      country?: string;
      valid_now?: "yes" | "no" | "";
    } = {},
  ) => {
    const search = new URLSearchParams();
    search.set("page", String(params.page ?? 1));
    search.set("page_size", String(params.page_size ?? 25));
    if (params.country) search.set("country", params.country);
    if (params.valid_now) search.set("valid_now", params.valid_now);
    return request<DialableLeadsResponse>(`/calls/dialable-leads?${search}`);
  },
  listCallHistory: (params: { page?: number; page_size?: number; since_days?: number } = {}) => {
    const search = new URLSearchParams();
    search.set("page", String(params.page ?? 1));
    search.set("page_size", String(params.page_size ?? 5));
    if (params.since_days != null) search.set("since_days", String(params.since_days));
    return request<CallHistoryListResponse>(`/calls/history?${search}`);
  },
  listLeadCalls: (
    leadId: number,
    params: { page?: number; page_size?: number; since_days?: number | null } = {},
  ) => {
    const search = new URLSearchParams();
    search.set("page", String(params.page ?? 1));
    search.set("page_size", String(params.page_size ?? 5));
    if (params.since_days != null) search.set("since_days", String(params.since_days));
    return request<CallHistoryListResponse>(`/leads/${leadId}/calls?${search}`);
  },
  getCallHistoryItem: (interactionId: number) =>
    request<CallHistoryItem>(`/calls/${interactionId}`),
  updateCallNotes: (interactionId: number, notes: string) =>
    request<CallHistoryItem>(`/calls/${interactionId}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    }),
  updateCallFollowUp: (
    interactionId: number,
    data: { notes?: string; call_outcome?: string | null },
  ) =>
    request<CallHistoryItem>(`/calls/${interactionId}/notes`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  setCallTrainingFlag: (interactionId: number, selected: boolean) =>
    request<CallHistoryItem>(`/calls/${interactionId}/training-flag`, {
      method: "PATCH",
      body: JSON.stringify({ selected }),
    }),
  deleteCallLog: (interactionId: number) =>
    request<void>(`/calls/${interactionId}`, { method: "DELETE" }),
  getCallRecordingUrl: (interactionId: number, download = false) =>
    `${API_BASE}/calls/${interactionId}/recording${download ? "?download=1" : ""}`,
  /** Authenticated fetch — prefers httpOnly cookie; Bearer only if legacy token remains. */
  fetchCallRecordingBlob: async (interactionId: number, download = false) => {
    const token = getStoredToken();
    const url = `${API_BASE}/calls/${interactionId}/recording${download ? "?download=1" : ""}`;
    const res = await fetch(url, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      clearSession();
      window.dispatchEvent(new Event("kafi:auth-expired"));
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(messageForHttpError(res.status, text, res.statusText || "Failed to load recording"));
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = /filename="?([^"]+)"?/i.exec(disposition);
    const filename = match?.[1] || `call-${interactionId}.mp3`;
    return { blob, filename, contentType: blob.type || "audio/mpeg" };
  },
  transcribeCall: (interactionId: number, wait = false) =>
    request<CallHistoryItem>(
      `/calls/${interactionId}/transcribe${wait ? "?wait=true" : ""}`,
      { method: "POST" },
    ),
  initiateLeadCall: (
    leadId: number,
    data: { contact_id?: number; phone?: string } = {},
  ) =>
    request<CallInitiateResult>(`/leads/${leadId}/call`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  initiateManualCall: (data: {
    phone: string;
    contact_name?: string;
    country?: string;
  }) =>
    request<CallInitiateResult>("/calls/dial", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getWhatsAppConfig: () => request<WhatsAppConfig>("/whatsapp/config"),
  testWhatsAppSend: (data: {
    phone: string;
    message?: string;
    template_name?: string;
    template_language?: string;
  }) =>
    request<WhatsAppTestSendResult>("/whatsapp/test-send", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 60_000,
    }),
  listWhatsAppTemplates: (approvedOnly = false) =>
    request<WhatsAppTemplate[]>(
      `/whatsapp/templates${approvedOnly ? "?approved_only=true" : ""}`,
    ),
  createWhatsAppTemplate: (data: WhatsAppTemplateCreatePayload) =>
    request<WhatsAppTemplateCreateResult>("/whatsapp/templates", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  resubmitWhatsAppTemplate: (templateId: number, data: WhatsAppTemplateResubmitPayload) =>
    request<WhatsAppTemplateCreateResult>(`/whatsapp/templates/${templateId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteWhatsAppTemplate: (templateId: number) =>
    request<{ status: string; message: string }>(`/whatsapp/templates/${templateId}`, {
      method: "DELETE",
    }),
  listWhatsAppTemplateNotifications: (params: { unreadOnly?: boolean; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.unreadOnly === false) query.set("unread_only", "false");
    if (params.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return request<WhatsAppTemplateNotificationsResponse>(
      `/whatsapp/templates/notifications${qs ? `?${qs}` : ""}`,
    );
  },
  markWhatsAppTemplateNotificationsRead: (notificationIds?: number[]) =>
    request<{ updated_count: number }>("/whatsapp/templates/notifications/read", {
      method: "POST",
      body: JSON.stringify({ notification_ids: notificationIds ?? null }),
    }),
  syncWhatsAppTemplates: () =>
    request<WhatsAppTemplateSyncResult>("/whatsapp/templates/sync", { method: "POST" }),
  createWhatsAppCampaignDrafts: (data: {
    template_id: number;
    buyer_ids: number[];
    template_variables?: string[];
    require_opt_in?: boolean;
    send?: boolean;
    /** Exact WhatsApp number for single-lead compose sends. */
    to_phone?: string;
  }) =>
    request<WhatsAppCampaignDraftResponse>("/whatsapp/campaign-drafts", {
      method: "POST",
      body: JSON.stringify({
        template_id: data.template_id,
        buyer_ids: data.buyer_ids,
        template_variables: data.template_variables ?? [],
        require_opt_in: data.require_opt_in ?? true,
        send: data.send ?? true,
        to_phone: data.to_phone || undefined,
      }),
      timeoutMs: 90_000,
    }),
  bulkUpdateWhatsAppOptIn: (contactIds: number[], optIn: boolean) =>
    request<{ updated_count: number }>("/whatsapp/contacts/bulk-opt-in", {
      method: "PATCH",
      body: JSON.stringify({ contact_ids: contactIds, opt_in: optIn }),
    }),
  listWhatsAppConversations: (params: { page?: number; page_size?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.page_size) query.set("page_size", String(params.page_size));
    const qs = query.toString();
    return request<WhatsAppConversationListResponse>(
      `/whatsapp/conversations${qs ? `?${qs}` : ""}`,
    );
  },
  getWhatsAppBuyerPreview: (buyerId: number, recent = 3) =>
    request<WhatsAppBuyerPreview>(
      `/whatsapp/buyers/${buyerId}/preview?recent=${encodeURIComponent(String(recent))}`,
    ),
  listWhatsAppConversationMessages: (contactId: number) =>
    request<DraftInteraction[]>(`/whatsapp/conversations/${contactId}/messages`),
  replyToWhatsAppConversation: (
    contactId: number,
    data: {
      content: string;
      send?: boolean;
      template_name?: string;
      template_language?: string;
      template_variables?: string[];
      to_phone?: string;
    },
  ) =>
    request<WhatsAppReplyResponse>(`/whatsapp/conversations/${contactId}/reply`, {
      method: "POST",
      body: JSON.stringify({
        content: data.content,
        send: data.send ?? true,
        template_name: data.template_name,
        template_language: data.template_language ?? "en_US",
        template_variables: data.template_variables ?? [],
        to_phone: data.to_phone || undefined,
      }),
    }),

  // ── AI Mode ────────────────────────────────────────────────────────────────
  getAiModeSettings: () => request<AiModeSettings>("/ai-mode/settings"),
  updateAiModeSettings: (data: Partial<AiModeSettingsUpdate>) =>
    request<AiModeSettings>("/ai-mode/settings", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  processAiModeEmails: () =>
    request<AiModeProcessResult>("/ai-mode/process-emails", { method: "POST" }),
  listAiModeAutoReplies: (limit = 50) =>
    request<{ rows: AiModeAutoReplyLogRow[] }>(
      `/ai-mode/auto-replies?limit=${limit}`,
    ),
  listAiModeQueries: (params: { limit?: number; refresh?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.refresh) query.set("refresh", "true");
    const qs = query.toString();
    return request<AiModeQueriesResponse>(
      `/ai-mode/queries${qs ? `?${qs}` : ""}`,
    );
  },
  scanAiModeQueries: () =>
    request<AiModeQueriesResponse>("/ai-mode/queries/scan", { method: "POST" }),
  getAiModeQueryMessage: (queryId: number) =>
    request<AiModeQueryMessageResponse>(`/ai-mode/queries/${queryId}`),
  generateAiModeQueryReply: (queryId: number) =>
    request<AiModeQueryReplyDraftResponse>(
      `/ai-mode/queries/${queryId}/generate-reply`,
      { method: "POST" },
    ),
  listAiModeLifecycle: (params: {
    stage?: string;
    search?: string;
    limit?: number;
    offset?: number;
    /** Target Workspace: skip heavy activity feeds (assignments, calls, etc.). */
    light?: boolean;
  } = {}) => {
    const query = new URLSearchParams();
    if (params.stage) query.set("stage", params.stage);
    if (params.search) query.set("search", params.search);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    if (params.light) query.set("light", "true");
    const qs = query.toString();
    return request<AiModeLifecycleListResponse>(
      `/ai-mode/lifecycle${qs ? `?${qs}` : ""}`,
    );
  },
  listAiModeAssignments: (limit = 100) =>
    request<AiModeAssignmentsResponse>(`/ai-mode/assignments?limit=${limit}`),
  listAiModeCallActivities: (limit = 100) =>
    request<AiModeCallActivitiesResponse>(
      `/ai-mode/call-activities?limit=${limit}`,
    ),
  listAiModeFollowUpActivities: (limit = 100) =>
    request<AiModeFollowUpActivitiesResponse>(
      `/ai-mode/follow-up-activities?limit=${limit}`,
    ),
  listAiModeInterestedActivities: (params: { limit?: number; after_id?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.after_id != null) query.set("after_id", String(params.after_id));
    const qs = query.toString();
    return request<AiModeInterestedActivitiesResponse>(
      `/ai-mode/interested-activities${qs ? `?${qs}` : ""}`,
    );
  },
  listAiModeNotInterestedActivities: (params: { limit?: number; after_id?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.after_id != null) query.set("after_id", String(params.after_id));
    const qs = query.toString();
    return request<AiModeNotInterestedActivitiesResponse>(
      `/ai-mode/not-interested-activities${qs ? `?${qs}` : ""}`,
    );
  },
  listAiModePotentialClients: (params: { search?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return request<AiModeInterestedLeadsResponse>(
      `/ai-mode/potential-clients${qs ? `?${qs}` : ""}`,
    );
  },
  /** @deprecated Use listAiModePotentialClients — same AA/AAA Scrapped Leads list. */
  listAiModeInterestedLeads: (params: { search?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return request<AiModeInterestedLeadsResponse>(
      `/ai-mode/interested-leads${qs ? `?${qs}` : ""}`,
    );
  },
  updateAiModeLifecycle: (
    buyerId: number,
    data: { stage: string; notes?: string | null },
  ) =>
    request<AiModeLifecycleRow>(`/ai-mode/lifecycle/${buyerId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  updateQuotationMeeting: (
    buyerId: number,
    data: {
      meeting_status: "not_scheduled" | "scheduled" | "done";
      meeting_at?: string | null;
    },
  ) =>
    request<QuotationMeetingScheduleResult>(
      `/ai-mode/quotation-sent/${buyerId}/meeting`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    ),
  listQuotationMeetingAlerts: () =>
    request<QuotationMeetingAlertsResponse>("/ai-mode/meeting-alerts"),
  ensureAiModeLifecycle: (buyerId: number) =>
    request<AiModeLifecycleRow>("/ai-mode/lifecycle/ensure", {
      method: "POST",
      body: JSON.stringify({ buyer_id: buyerId }),
    }),

  // ── AI Sales Agent ─────────────────────────────────────────────────────────
  unlockAiSalesAgent: (access_code: string) =>
    request<{ ok: boolean }>("/ai-sales-agent/unlock", {
      method: "POST",
      body: JSON.stringify({ access_code }),
      timeoutMs: 45_000,
    }),
  listAiSalesAgentRunners: () =>
    request<{ runners: AiSalesAgentRunner[] }>("/ai-sales-agent/runners", {
      headers: aiSalesAgentHeaders(),
    }),
  listAiSalesAgentTasks: (params: {
    persona?: string;
    status?: string;
    limit?: number;
  } = {}) => {
    const query = new URLSearchParams();
    if (params.persona) query.set("persona", params.persona);
    if (params.status) query.set("status", params.status);
    if (params.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return request<{ tasks: AiSalesAgentTask[] }>(
      `/ai-sales-agent/tasks${qs ? `?${qs}` : ""}`,
      { headers: aiSalesAgentHeaders() },
    );
  },
  assignAiSalesAgentTasks: (data: {
    persona: string;
    buyer_ids: number[];
    contact_ids?: (number | null)[];
  }) =>
    request<{
      tasks: AiSalesAgentTask[];
      skipped?: Array<{
        buyer_id: number;
        contact_id?: number | null;
        company_name?: string;
        reason?: string;
        other_task_id?: number;
      }>;
      notice?: string | null;
    }>("/ai-sales-agent/tasks/assign", {
      method: "POST",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify(data),
    }),
  queueAiSalesAgentSelfTest: (data: {
    persona: string;
    phone: string;
    contact_name?: string;
    language?: string;
    allowed_languages?: string[];
    dial_now?: boolean;
    voice_gender?: "female" | "male";
  }) =>
    request<{ task: AiSalesAgentTask; followup?: AiSalesAgentFollowup }>(
      "/ai-sales-agent/tasks/self-test",
      {
        method: "POST",
        headers: aiSalesAgentHeaders(),
        body: JSON.stringify(data),
        timeoutMs: 90_000,
      },
    ),
  deleteAiSalesAgentTask: (taskId: number) =>
    request<void>(`/ai-sales-agent/tasks/${taskId}`, {
      method: "DELETE",
      headers: aiSalesAgentHeaders(),
    }),
  skipAiSalesAgentTask: (taskId: number) =>
    request<AiSalesAgentTask>(`/ai-sales-agent/tasks/${taskId}/skip`, {
      method: "POST",
      headers: aiSalesAgentHeaders(),
    }),
  startAiSalesAgentRunner: (
    persona: string,
    opts?: { task_id?: number; sequence?: boolean; queue_lane?: "outreach" | "data_update" | "auto_mode" },
  ) =>
    request<AiSalesAgentRunner>("/ai-sales-agent/runners/start", {
      method: "POST",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify({
        persona,
        task_id: opts?.task_id,
        sequence: opts?.sequence ?? true,
        queue_lane: opts?.queue_lane,
      }),
    }),
  pauseAiSalesAgentRunner: (persona: string) =>
    request<AiSalesAgentRunner>("/ai-sales-agent/runners/pause", {
      method: "POST",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify({ persona }),
    }),
  endAiSalesAgentCall: (payload: { persona?: string; call_sid?: string; task_id?: number } = {}) =>
    request<{ ok: boolean; task?: AiSalesAgentTask; followup?: AiSalesAgentFollowup }>(
      "/ai-sales-agent/end-call",
      {
        method: "POST",
        headers: aiSalesAgentHeaders(),
        body: JSON.stringify(payload),
      },
    ),
  getAiSalesAgentBriefing: (buyerId: number, contactId?: number) => {
    const qs = contactId ? `?contact_id=${contactId}` : "";
    return request<AiSalesAgentBriefing>(
      `/ai-sales-agent/briefing/${buyerId}${qs}`,
      { headers: aiSalesAgentHeaders() },
    );
  },
  getAiTrainingInfo: () =>
    request<AiTrainingData>("/ai-sales-agent/training", {
      headers: aiSalesAgentHeaders(),
    }),
  listAiTrainingSelectedCalls: (limit = 80) =>
    request<AiTrainingSelectedCallsResponse>(
      `/ai-sales-agent/training/selected-calls?limit=${limit}`,
      { headers: aiSalesAgentHeaders() },
    ),
  trainAiFromHistory: (
    opts: {
      source?: "auto" | "curated" | "history" | "ids";
      interaction_ids?: number[];
    } = {},
  ) =>
    request<AiTrainingData>("/ai-sales-agent/train-from-history", {
      method: "POST",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify({
        source: opts.source || "auto",
        interaction_ids: opts.interaction_ids || [],
      }),
    }),
  updateAiSalesRules: (rules: string) =>
    request<AiTrainingData>("/ai-sales-agent/update-rules", {
      method: "POST",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify({ rules }),
    }),
  getAiSalesAutoMode: () =>
    request<AiSalesAutoModeSettings>("/ai-sales-agent/auto-mode"),
  updateAiSalesAutoMode: (data: Partial<AiSalesAutoModeSettings>) =>
    request<AiSalesAutoModeSettings>("/ai-sales-agent/auto-mode", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  scheduleAiSalesAutoModeStart: (data: { persona: "female" | "male"; run_at: string }) =>
    request<{ ok: boolean; schedule: AiSalesScheduledStart; message: string }>(
      "/ai-sales-agent/auto-mode/schedule-start",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  cancelAiSalesAutoModeStart: (scheduleId: string) =>
    request<{ ok: boolean; schedule: AiSalesScheduledStart }>(
      `/ai-sales-agent/auto-mode/schedule-start/${encodeURIComponent(scheduleId)}`,
      { method: "DELETE" },
    ),
  getWorkspaceAiAutopilot: () =>
    request<WorkspaceAiAutopilotSettings>("/ai-sales-agent/workspace-autopilot"),
  updateWorkspaceAiAutopilot: (data: Partial<WorkspaceAiAutopilotSettings>) =>
    request<WorkspaceAiAutopilotSettings>("/ai-sales-agent/workspace-autopilot", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  listAiSalesProcesses: () =>
    request<{ processes: AiSalesProcess[] }>("/ai-sales-agent/processes"),
  createAiSalesProcess: (data: Partial<AiSalesProcess> & { name: string }) =>
    request<AiSalesProcess>("/ai-sales-agent/processes", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAiSalesProcess: (id: string, data: Partial<AiSalesProcess>) =>
    request<AiSalesProcess>(`/ai-sales-agent/processes/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAiSalesProcess: (id: string) =>
    request<{ ok: boolean }>(`/ai-sales-agent/processes/${id}`, {
      method: "DELETE",
    }),
  runAiSalesProcessNow: (id: string) =>
    request<{ ok: boolean; result: Record<string, unknown>; process: AiSalesProcess }>(
      `/ai-sales-agent/processes/${id}/run-now`,
      { method: "POST" },
    ),

  setAiSalesTaskLane: (data: {
    task_ids: number[];
    queue_lane: "outreach" | "data_update" | "auto_mode";
  }) =>
    request<{ updated: number; queue_lane: string }>("/ai-sales-agent/tasks/set-lane", {
      method: "POST",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify(data),
    }),
  setAiSalesTaskPersona: (data: {
    task_ids: number[];
    persona: string;
  }) =>
    request<{ updated: number; skipped: number; persona: string; label: string }>(
      "/ai-sales-agent/tasks/set-persona",
      {
        method: "POST",
        headers: aiSalesAgentHeaders(),
        body: JSON.stringify(data),
      },
    ),
  bulkDeleteAiSalesAgentTasks: (taskIds: number[]) =>
    request<{ ok: boolean; removed: number }>("/ai-sales-agent/tasks/bulk-delete", {
      method: "POST",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify({ task_ids: taskIds }),
    }),
  getAiSalesDataUpdate: () =>
    request<AiSalesDataUpdateStatus>("/ai-sales-agent/data-update", {
      headers: aiSalesAgentHeaders(),
    }),
  updateAiSalesDataUpdateSchedule: (data: {
    persona: string;
    enabled?: boolean;
    time?: string;
    end_time?: string;
    stop_mode?: "until_done" | "until_end_time";
    weekdays?: string[];
    cooldown_sec?: number;
  }) =>
    request<AiSalesDataUpdateStatus>("/ai-sales-agent/data-update/schedule", {
      method: "PUT",
      headers: aiSalesAgentHeaders(),
      body: JSON.stringify(data),
    }),
  runAiSalesDataUpdateNow: (persona: string) =>
    request<{ ok: boolean; run_id: string; total: number; status: AiSalesDataUpdateStatus }>(
      `/ai-sales-agent/data-update/run-now?persona=${encodeURIComponent(persona)}`,
      { method: "POST", headers: aiSalesAgentHeaders() },
    ),
  listAiSalesAgentLogs: async (params: { limit?: number; event_kind?: "assign" | "run_start" } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.event_kind) qs.set("event_kind", params.event_kind);
    const q = qs.toString();
    try {
      return await request<AiSalesAgentLogsResponse>(
        `/ai-sales-agent/logs${q ? `?${q}` : ""}`,
        { headers: aiSalesAgentHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Older backends without /logs — return empty so the modal stays usable.
      if (/not found|404/i.test(msg)) {
        return {
          events: [],
          runs: [],
          summary: {
            total_assigned: 0,
            total_used: 0,
            total_difference: 0,
            total_runs: 0,
            by_user: [],
            by_date: [],
          },
        };
      }
      throw e;
    }
  },

  // ── Catalogues ─────────────────────────────────────────────────────────────
  listCatalogues: () => request<CatalogueItem[]>("/catalogues"),
  /** Admin: replace a catalogue's PDF (same id / name / links — only the file changes). */
  uploadCataloguePdf: async (catalogueId: string, file: File): Promise<CatalogueItem> => {
    const endpoints = [RAILWAY_API_BASE, API_BASE].filter(
      (base, index, all) => all.indexOf(base) === index,
    );
    let lastError: Error | null = null;
    for (const base of endpoints) {
      const form = new FormData();
      form.append("file", file);
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), ATTACHMENT_UPLOAD_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/catalogues/${encodeURIComponent(catalogueId)}/upload`, {
          method: "POST",
          body: form,
          headers: authHeaders(),
          credentials: base === API_BASE ? "include" : "omit",
          signal: controller.signal,
        });
        if (!res.ok) {
          const textBody = await res.text().catch(() => "");
          throw new Error(messageForHttpError(res.status, textBody, res.statusText));
        }
        return (await res.json()) as CatalogueItem;
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        lastError = isAbort
          ? new Error("Upload timed out. Check your connection and try again.")
          : err instanceof Error
            ? err
            : new Error(String(err));
        // A real answer from the server (not a network problem) will not change on retry.
        if (/not a pdf|empty|larger than|incomplete|admin|not found|could not/i.test(lastError.message)) {
          throw lastError;
        }
      } finally {
        window.clearTimeout(timer);
      }
    }
    throw lastError || new Error("Catalogue upload failed");
  },
  /** Admin: remove the uploaded replacement and go back to the original PDF. */
  restoreCatalogueOriginal: (catalogueId: string) =>
    request<CatalogueItem>(`/catalogues/${encodeURIComponent(catalogueId)}/upload`, {
      method: "DELETE",
    }),
  attachCatalogues: (catalogue_ids: string[]) =>
    request<EmailAttachment[]>("/catalogues/attach", {
      method: "POST",
      body: JSON.stringify({ catalogue_ids }),
    }),

  // ── Horeka B2B Price List ──────────────────────────────────────────────────
  listHorekaItems: (
    params: {
      category?: string;
      search?: string;
      stock_status?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.category) query.set("category", params.category);
    if (params.search) query.set("search", params.search);
    if (params.stock_status) query.set("stock_status", params.stock_status);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    const qs = query.toString();
    return request<HorekaListResponse>(`/horeka/items${qs ? `?${qs}` : ""}`);
  },
  updateHorekaItem: (itemId: number, data: Partial<HorekaLineItemData>) =>
    request<{ id: number; product_name: string; standard_price: number }>(
      `/horeka/items/${itemId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    ),
  createHorekaItem: (data: Partial<HorekaLineItemData>) =>
    request<HorekaLineItemData>("/horeka/items", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteHorekaItem: (itemId: number) =>
    request<{ ok: boolean }>(`/horeka/items/${itemId}`, {
      method: "DELETE",
    }),
  attachHorekaPriceList: (format = "excel") =>
    request<EmailAttachment>(`/horeka/attach?file_format=${format}`, {
      method: "POST",
    }),

  // ── Custom Lead Modules & Testing Lists ─────────────────────────────────────
  listCustomModules: (includeDisabled = true, masterType = "fmcg") =>
    request<CustomLeadModule[]>(
      `/leads/custom-modules?include_disabled=${includeDisabled}&master_type=${encodeURIComponent(masterType)}`,
    ),
  createCustomModule: (payload: CustomModuleCreatePayload) =>
    request<CustomLeadModule>("/leads/custom-modules", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateCustomModule: (key: string, payload: CustomModuleUpdatePayload) =>
    request<CustomLeadModule>(`/leads/custom-modules/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteCustomModule: (key: string) =>
    request<{ deleted: boolean; key: string; leads_reassigned_to_old_clients: number }>(
      `/leads/custom-modules/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
      },
    ),
  seedModuleStaff: (key: string) =>
    request<{ status: string; key: string; seeded_count: number; recipients: Array<{ id: number; name: string; status: string }> }>(
      `/leads/custom-modules/${encodeURIComponent(key)}/seed-staff`,
      {
        method: "POST",
      },
    ),
  addModuleRecipient: (key: string, payload: AddRecipientPayload) =>
    request<{ id: number; company_name: string; contact_person: string; email: string; primary_mobile: string; source: string }>(
      `/leads/custom-modules/${encodeURIComponent(key)}/add-recipient`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  // ── CNF / FOB Live Pricing & Cards Handshake (https://kafiai-agents.vercel.app) ──
  getLiveCnfPricing: (sku: string) =>
    request<CnfLivePricingResponse>(`/cnf-bridge/live-pricing?sku=${encodeURIComponent(sku)}`),
  getLiveCnfPriceCard: (sku: string, format = "image") =>
    request<CnfCardResponse>(
      `/cnf-bridge/live-card?sku=${encodeURIComponent(sku)}&format=${encodeURIComponent(format)}`,
    ),
  getLiveCnfQuotationCard: (id: string, format = "pdf") =>
    request<CnfCardResponse>(
      `/cnf-bridge/live-quotation-card?id=${encodeURIComponent(id)}&format=${encodeURIComponent(format)}`,
    ),
  attachCnfPriceCard: (sku: string, format = "image") =>
    request<EmailAttachment>("/cnf-bridge/attach-pricing-card", {
      method: "POST",
      body: JSON.stringify({ sku, format }),
    }),
  attachCnfQuotationCard: (quotationId: string, format = "pdf") =>
    request<EmailAttachment>("/cnf-bridge/attach-quotation-card", {
      method: "POST",
      body: JSON.stringify({ quotation_id: quotationId, format }),
    }),

  // ── Target and Workspace Module ──
  getTargetWorkspaceTargets: (day?: string, userId?: number) => {
    const search = new URLSearchParams();
    if (day) search.set("day", day);
    if (userId != null) search.set("user_id", String(userId));
    const query = search.toString();
    return request<{ day_of_week: string; targets: DayCountryTarget[] }>(
      `/target-workspace/targets${query ? `?${query}` : ""}`,
    );
  },
  addDayCountryTarget: (data: { day_of_week: string; country: string; assigned_user_id?: number | null }) =>
    request<{ success: boolean; target: DayCountryTarget }>("/target-workspace/targets", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  removeDayCountryTarget: (targetId: number) =>
    request<{ success: boolean }>(`/target-workspace/targets/${targetId}`, {
      method: "DELETE",
    }),
  getWorkspaceLeads: (params: {
    day?: string;
    country?: string;
    stage?: string;
    search?: string;
    master_type?: string;
    user_id?: number;
    page?: number;
    limit?: number;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.day) search.set("day", params.day);
    if (params.country) search.set("country", params.country);
    if (params.stage) search.set("stage", params.stage);
    if (params.search) search.set("search", params.search);
    if (params.master_type) search.set("master_type", params.master_type);
    if (params.user_id != null) search.set("user_id", String(params.user_id));
    if (params.page) search.set("page", String(params.page));
    if (params.limit) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<WorkspaceLeadListResponse>(`/target-workspace/workspace${query ? `?${query}` : ""}`);
  },
  updateWorkspaceLeadStatus: (data: {
    buyer_id: number;
    stage: string;
    not_interested_reason?: string | null;
    not_interested_remarks?: string | null;
    follow_up_reason?: string | null;
    follow_up_action?: string | null;
    follow_up_date?: string | null;
    whatsapp_call_tried?: boolean | null;
    whatsapp_call_proof?: string | null;
    searched_internet_email?: boolean | null;
    searched_internet_phone?: boolean | null;
    linkedin_request_sent?: boolean | null;
    linkedin_msg_sent?: boolean | null;
  }) =>
    request<{ success: boolean; lead_id: number; stage: string }>("/target-workspace/lead-status", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  replaceContactAndShiftToDrip: (data: {
    buyer_id: number;
    new_contact_name: string;
    new_email: string;
    new_phone?: string | null;
    new_designation?: string | null;
    product_type?: string;
    notes?: string | null;
  }) =>
    request<{
      success: boolean;
      drip_lead: DripCampaignLeadItem;
      message: string;
    }>("/target-workspace/replace-and-drip", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getDripCampaignLeads: (params: { search?: string; user_id?: number; page?: number; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.search) search.set("search", params.search);
    if (params.user_id != null) search.set("user_id", String(params.user_id));
    if (params.page) search.set("page", String(params.page));
    if (params.limit) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<DripCampaignResponse>(`/target-workspace/drip-campaign${query ? `?${query}` : ""}`);
  },
  getWorkspaceReviewOptions: (category?: string) => {
    const search = new URLSearchParams();
    if (category) search.set("category", category);
    const query = search.toString();
    return request<{ options: WorkspaceReviewOptionItem[] }>(
      `/target-workspace/review-options${query ? `?${query}` : ""}`,
    );
  },
  addWorkspaceReviewOption: (data: { category: string; label: string; action_hint?: string | null }) =>
    request<WorkspaceReviewOptionItem>("/target-workspace/review-options", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteWorkspaceReviewOption: (optionId: number) =>
    request<{ success: boolean }>(`/target-workspace/review-options/${optionId}`, {
      method: "DELETE",
    }),
  getBuyerAiConclusion: (buyerId: number) =>
    request<AiConclusionItem>(`/target-workspace/ai-conclusions/buyer/${buyerId}`),
  listAiConclusions: (params: {
    user_id?: number;
    buyer_id?: number;
    company?: string;
    day?: string;
    attention?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const query = new URLSearchParams();
    if (params.user_id != null) query.set("user_id", String(params.user_id));
    if (params.buyer_id != null) query.set("buyer_id", String(params.buyer_id));
    if (params.company) query.set("company", params.company);
    if (params.day) query.set("day", params.day);
    if (params.attention) query.set("attention", params.attention);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    const qs = query.toString();
    return request<AiConclusionListResponse>(
      `/target-workspace/ai-conclusions${qs ? `?${qs}` : ""}`,
    );
  },
  getAiConclusionsOverview: (day?: string) => {
    const query = new URLSearchParams();
    if (day) query.set("day", day);
    const qs = query.toString();
    return request<AiConclusionOverviewResponse>(
      `/target-workspace/ai-conclusions/overview${qs ? `?${qs}` : ""}`,
    );
  },
};

export interface DayCountryTarget {
  id: number;
  day_of_week: string;
  country: string;
  assigned_user_id: number | null;
  assigned_user_name?: string | null;
  created_by_user_id: number | null;
  created_at: string | null;
}

export interface WorkspaceLeadPhone {
  index: number;
  select_label: string;
  number: string;
  field_label: string;
  contact_id?: number | null;
  contact_name?: string | null;
}

export interface WorkspaceLeadItem {
  id: number;
  company_name: string;
  contact_person: string | null;
  contact_id?: number | null;
  designation: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  /** All distinct phone numbers on the contact list for this buyer. */
  phones?: WorkspaceLeadPhone[];
  country: string | null;
  city: string | null;
  product_interest: string | null;
  assigned_to_user_id: number | null;
  assigned_to_name: string | null;
  /** Local calling window — same badges as My Assigned table. */
  call_recommended?: boolean | null;
  call_local_time?: string | null;
  call_reason?: string | null;
  /** Latest client remarks (same field as contact list / profile). */
  remarks?: string | null;
  remarks_history_count?: number;
  industry?: string | null;
  website_url?: string | null;
  company_grading?: string | null;
  stage: "fresh" | "needs_follow_up" | "not_interested" | "no_response";
  not_interested_reason: string | null;
  not_interested_remarks: string | null;
  follow_up_reason: string | null;
  follow_up_action: string | null;
  follow_up_date: string | null;
  whatsapp_call_tried: boolean;
  whatsapp_call_proof: string | null;
  searched_internet_email: boolean;
  searched_internet_phone: boolean;
  linkedin_request_sent: boolean;
  linkedin_msg_sent: boolean;
  replacement_contact_name: string | null;
  replacement_email: string | null;
  replacement_phone: string | null;
  emails_sent_count: number;
  calls_made_count: number;
  last_contacted_at: string | null;
  days_since_last_response: number;
  is_dead_lead_meter_red: boolean;
  is_drip_candidate: boolean;
  todo_action_hint: string | null;
}

export interface WorkspaceLeadListResponse {
  day_of_week: string;
  target_countries: string[];
  counts: {
    fresh: number;
    needs_follow_up: number;
    not_interested: number;
    no_response: number;
    total: number;
  };
  total: number;
  page: number;
  limit: number;
  leads: WorkspaceLeadItem[];
}

export interface DripCampaignLeadItem {
  id: number;
  buyer_id: number;
  company_name: string;
  product_type: string;
  contact_person_name: string | null;
  contact_designation: string | null;
  email: string;
  phone: string | null;
  country: string | null;
  days_in_drip: number;
  drip_emails_sent_count: number;
  responses_received_count: number;
  status: string;
  notes: string | null;
  cadence_label: string;
  created_at: string | null;
}

export interface DripCampaignResponse {
  total: number;
  page: number;
  limit: number;
  leads: DripCampaignLeadItem[];
}

export interface WorkspaceReviewOptionItem {
  id: number;
  category: string;
  label: string;
  action_hint: string | null;
  is_system: boolean;
}

export interface AiConclusionEngagementBucket {
  calls: number;
  emails: number;
  whatsapp: number;
  telegram: number;
  quotations: number;
  follow_ups_pending: number;
}

export interface AiConclusionModeUsed {
  id: string;
  label: string;
  count: number;
}

export interface AiConclusionItem {
  buyer_id: number;
  company_name: string;
  country: string | null;
  stage: string;
  stage_label?: string;
  responsible_user_id?: number | null;
  buyer_status: string;
  last_contact: string;
  last_contact_at?: string | null;
  last_contact_at_display?: string | null;
  last_contact_mode?: string | null;
  modes_used?: AiConclusionModeUsed[];
  last_contact_user?: string;
  pending_action: string;
  responsible_person: string;
  next_action: string;
  management_attention: string;
  management_insight?: string;
  engagement: {
    "7d": AiConclusionEngagementBucket;
    "30d": AiConclusionEngagementBucket;
    "90d": AiConclusionEngagementBucket;
  };
  generated_at: string;
}

export interface AiConclusionListResponse {
  total: number;
  items: AiConclusionItem[];
  limit: number;
  offset: number;
}

export interface AiConclusionOverviewResponse {
  day_of_week: string | null;
  companies_scanned: number;
  attention_required: number;
  by_user: Array<{
    responsible_person: string;
    companies: number;
    attention_required: number;
  }>;
  items: AiConclusionItem[];
}

export interface CnfLivePricingResponse {
  productId?: string;
  sku: string;
  name: string;
  packaging?: string;
  pricePerUnit: number;
  unit: string;
  currency: string;
}

export interface CnfCardResponse {
  base64: string;
  mimeType: string;
}

export interface CustomLeadModule {
  id: number;
  key: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  is_builtin: boolean;
  is_enabled: boolean;
  order_index: number;
  count: number;
  created_at?: string | null;
}

export interface CustomModuleCreatePayload {
  name: string;
  key?: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface CustomModuleUpdatePayload {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  is_enabled?: boolean;
  order_index?: number;
}

export interface AddRecipientPayload {
  contact_name?: string;
  company_name?: string;
  email?: string;
  secondary_email?: string;
  primary_mobile?: string;
  designation?: string;
  country?: string;
  city?: string;
  remarks?: string;
}

export type CallFollowupMode = "off" | "test_only" | "all";

export interface CallFollowupDraft {
  id: number;
  group_id: number;
  name: string;
  subject: string;
  body: string;
  whatsapp_text: string;
  attachment_mode: "none" | "auto" | "catalogue";
  catalogue_ids: string[];
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CallFollowupGroup {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  drafts: CallFollowupDraft[];
}

export interface CatalogueItem {
  id: string;
  title: string;
  category: string;
  description: string;
  filename: string;
  badge: string;
  color: string;
  size: number;
  exists: boolean;
  download_url: string;
  /** True when the PDF was replaced from the dashboard (not the original that shipped). */
  custom?: boolean;
  updated_at?: string | null;
}

export interface HorekaLineItemData {
  id: number;
  sno: number;
  category: string;
  sub_category?: string | null;
  brand: string;
  item_code?: string | null;
  product_name: string;
  packaging: string;
  unit: string;
  standard_price: number;
  bulk_tier1_price?: number | null;
  bulk_tier2_price?: number | null;
  moq?: string | null;
  stock_status: string;
  notes?: string | null;
  updated_at?: string | null;
}

export interface HorekaListResponse {
  total: number;
  categories: string[];
  items: HorekaLineItemData[];
}

export interface AiSalesAgentRunner {
  persona: string;
  display_name: string;
  gender_label: string;
  app_username: string;
  voice: string;
  status: string;
  current_task_id: number | null;
  current_task: AiSalesAgentTask | null;
  pending_count: number;
  twilio_ready: boolean;
  sequence_mode?: boolean;
}

export interface AiSalesBulkEmailPersonaSettings {
  template_id: number | null;
  from_mailbox_email: string;
  cc: string;
  subject: string;
  body: string;
}

export interface AiSalesScheduledStart {
  id: string;
  persona: "female" | "male";
  run_at: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  created_by?: number | null;
  created_at?: string;
  finished_at?: string | null;
  error?: string | null;
  result_message?: string | null;
}

export interface AiSalesAutoModeSettings {
  enabled: boolean;
  study_contacts: boolean;
  call_mode: boolean;
  send_email_after_call: boolean;
  send_whatsapp_after_call: boolean;
  bulk_email_when_no_call: boolean;
  study_products: boolean;
  product_brief: string;
  bulk_email_by_persona?: {
    female: AiSalesBulkEmailPersonaSettings;
    male: AiSalesBulkEmailPersonaSettings;
  };
  scheduled_starts?: AiSalesScheduledStart[];
}

export interface WorkspaceAiAutopilotSettings {
  enabled: boolean;
  auto_remarks: boolean;
  auto_interested: boolean;
  auto_not_interested: boolean;
  auto_no_response: boolean;
  auto_follow_up: boolean;
}

export interface AiSalesProcess {
  id: string;
  name: string;
  persona: "male" | "female" | "both";
  enabled: boolean;
  schedule: {
    kind: "daily" | "weekly";
    time: string;
    weekdays: string[];
  };
  actions: {
    call: boolean;
    email: boolean;
    whatsapp: boolean;
  };
  buyer_ids: number[];
  contact_ids?: (number | null)[];
  last_run_at?: string | null;
  last_run_key?: string | null;
  last_result?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

export interface AiSalesAgentFollowup {
  whatsapp_status?: string | null;
  whatsapp_message?: string | null;
  email_status?: string | null;
  email_message?: string | null;
  email_to?: string | null;
}

export interface AiSalesAgentTask {
  id: number;
  persona: string;
  buyer_id: number;
  contact_id: number | null;
  company_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email?: string | null;
  country?: string | null;
  status: string;
  queue_lane?: "outreach" | "data_update" | "auto_mode" | "direct" | string | null;
  is_test?: boolean;
  interaction_id: number | null;
  call_sid: string | null;
  outcome: string | null;
  remarks: string | null;
  error_message: string | null;
  ready?: boolean;
  warnings?: string[];
  followup?: AiSalesAgentFollowup;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface AiSalesDataUpdateSchedule {
  enabled: boolean;
  time: string;
  end_time?: string;
  stop_mode?: "until_done" | "until_end_time" | string;
  weekdays: string[];
  cooldown_sec: number;
  last_run_key?: string | null;
  last_started_at?: string | null;
}

export interface AiSalesDataUpdateRunState {
  status: string;
  current_buyer_id?: number | null;
  current_label?: string | null;
  next_allowed_at?: string | null;
  progress?: {
    done: number;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    filled_total: number;
  };
  log?: Array<Record<string, unknown>>;
  last_report?: Record<string, unknown> | null;
  /** Past Data Update runs (newest first) for later review. */
  run_history?: Array<Record<string, unknown>>;
  updated_at?: string | null;
  run_id?: string | null;
}

export interface AiSalesDataUpdateStatus {
  schedules: Record<string, AiSalesDataUpdateSchedule>;
  run_state: Record<string, AiSalesDataUpdateRunState>;
  queues?: Record<
    string,
    {
      outreach: AiSalesAgentTask[];
      data_update: AiSalesAgentTask[];
      auto_mode: AiSalesAgentTask[];
    }
  >;
}

export interface AiSalesAgentLogContact {
  task_id?: number | null;
  buyer_id?: number | null;
  company_name?: string;
  contact_name?: string;
  contact_phone?: string;
  contact_email?: string;
}

export interface AiSalesAgentLogEvent {
  id: number;
  user_id: number | null;
  user_label: string;
  event_kind: "assign" | "run_start" | string;
  persona: string;
  persona_label: string;
  queue_lane: string | null;
  lane_label: string | null;
  contact_count: number;
  contacts: AiSalesAgentLogContact[];
  note: string | null;
  created_at: string | null;
}

export interface AiSalesAgentLogSummaryBucket {
  key: string;
  assigned: number;
  used: number;
  difference: number;
  by_persona: Record<string, number>;
  by_lane: Record<string, number>;
  used_by_persona_lane: Record<string, number>;
  runs: number;
}

export interface AiSalesAgentLogsResponse {
  events: AiSalesAgentLogEvent[];
  runs: AiSalesAgentLogEvent[];
  summary: {
    total_assigned: number;
    total_used: number;
    total_difference: number;
    total_runs: number;
    by_user: AiSalesAgentLogSummaryBucket[];
    by_date: AiSalesAgentLogSummaryBucket[];
  };
}

export interface AiSalesAgentBriefing {
  buyer_id: number;
  ready: boolean;
  warnings: string[];
  context_text: string;
}

export interface AiModeSettings {
  user_id: number;
  enabled: boolean;
  email_auto_reply_enabled: boolean;
  whatsapp_auto_reply_enabled: boolean;
  form_url: string | null;
  email_subject_template: string;
  email_body_template: string;
  whatsapp_body_template: string;
  query_keywords: string[];
  last_email_processed_at: string | null;
  updated_at: string | null;
  lifecycle_stages: Array<{ key: string; label: string }>;
  enabled_at?: string | null;
  auto_reply_admin_only?: boolean;
  llm_query_enabled?: boolean;
  llm_auto_reply_enabled?: boolean;
  serpapi_auto_reply_enabled?: boolean;
}

export interface AiModeSettingsUpdate {
  enabled?: boolean;
  email_auto_reply_enabled?: boolean;
  whatsapp_auto_reply_enabled?: boolean;
  form_url?: string | null;
  email_subject_template?: string;
  email_body_template?: string;
  whatsapp_body_template?: string;
  query_keywords?: string[] | string;
}

export interface AiModeProcessResult {
  processed: number;
  replied: number;
  skipped: number;
  enabled: boolean;
  mode?: string;
  message?: string;
  recipient?: string;
  subject?: string;
  remaining_candidates?: number;
  skip_reasons?: Record<string, number>;
  error?: string;
  errors?: string[];
}

export interface AiModeAutoReplyLogRow {
  id: number;
  channel: string;
  recipient: string | null;
  subject: string | null;
  preview: string | null;
  status: string;
  detail: string | null;
  created_at: string | null;
}

export interface AiModeQueryRow {
  id: number;
  folder: string;
  uid: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  preview: string | null;
  received_at: string | null;
  created_at: string | null;
}

export interface AiModeQueriesResponse {
  count: number;
  rows: AiModeQueryRow[];
  scan?: {
    scanned: number;
    matched: number;
    created: number;
    purged?: number;
    deepened?: number;
    deep?: boolean;
    error?: string;
    errors?: string[];
  };
}

export interface AiModeQueryMessageResponse {
  query: AiModeQueryRow;
  message: {
    uid?: string;
    subject?: string | null;
    from_email?: string | null;
    from_name?: string | null;
    preview?: string | null;
    body?: string | null;
    date?: string | null;
    folder?: string | null;
    to?: string[] | null;
    [key: string]: unknown;
  };
}

export interface AiModeQueryReplyDraftResponse {
  query_id: number;
  body: string;
  subject: string;
  source: "llm" | "template" | string;
  llm_enabled: boolean;
  model?: string | null;
  error?: string | null;
}

export interface AiModeLifecycleRow {
  id: number;
  buyer_id: number;
  company_name?: string | null;
  country?: string | null;
  stage: string;
  stage_label: string;
  stage_entered_at: string | null;
  history: Array<{
    stage: string;
    at: string;
    notes?: string | null;
    by_user_id?: number | null;
  }>;
  notes: string | null;
  updated_at: string | null;
}

export interface AiModeLifecycleListResponse {
  total: number;
  stages: Array<{ key: string; label: string }>;
  pipeline: Record<string, number>;
  rows: AiModeLifecycleRow[];
  assignments?: AiModeAssignmentsResponse;
  call_activities?: AiModeCallActivitiesResponse;
  follow_up_activities?: AiModeFollowUpActivitiesResponse;
  interested_activities?: AiModeInterestedActivitiesResponse;
  not_interested_activities?: AiModeNotInterestedActivitiesResponse;
  interested_leads?: AiModeInterestedLeadsResponse;
  potential_clients?: AiModeInterestedLeadsResponse;
  interested_clients?: AiModeInterestedClientsResponse;
  quotation_sent_clients?: AiModeQuotationSentClientsResponse;
  negotiation_clients?: AiModeNegotiationClientsResponse;
}

export interface AiModeAssignmentRow {
  id: number;
  by_user_id: number | null;
  to_user_id: number;
  to_label: string;
  lead_count: number;
  buyer_ids?: number[];
  company_names?: string[];
  message: string;
  created_at: string | null;
}

export interface AiModeAssignmentsResponse {
  total_leads: number;
  total_events: number;
  rows: AiModeAssignmentRow[];
}

export interface AiModeCallActivityRow {
  id: number;
  user_id: number;
  user_label: string;
  buyer_id: number | null;
  company_name: string;
  interaction_id: number | null;
  message: string;
  created_at: string | null;
}

export interface AiModeCallActivitiesResponse {
  total_calls: number;
  rows: AiModeCallActivityRow[];
}

export interface AiModeFollowUpActivityRow {
  id: number;
  user_id: number;
  user_label: string;
  buyer_id: number | null;
  company_name: string;
  event_type: string;
  follow_up_at: string | null;
  message: string;
  created_at: string | null;
}

export interface AiModeFollowUpActivitiesResponse {
  total_events: number;
  rows: AiModeFollowUpActivityRow[];
}

export interface AiModeInterestedActivityRow {
  id: number;
  user_id: number;
  user_label: string;
  buyer_id: number | null;
  company_name: string;
  event_type: string;
  source: string;
  message: string;
  created_at: string | null;
}

export interface AiModeInterestedUserScore {
  user_id: number;
  user_label: string;
  placed_count: number;
}

export interface AiModeInterestedActivitiesResponse {
  total_in_list: number;
  total_events: number;
  my_placed_count: number;
  latest_id: number;
  by_user: AiModeInterestedUserScore[];
  rows: AiModeInterestedActivityRow[];
}

export type AiModeNotInterestedActivityRow = AiModeInterestedActivityRow;
export type AiModeNotInterestedUserScore = AiModeInterestedUserScore;

export interface AiModeNotInterestedActivitiesResponse {
  total_in_list: number;
  total_events: number;
  my_placed_count: number;
  latest_id: number;
  by_user: AiModeNotInterestedUserScore[];
  rows: AiModeNotInterestedActivityRow[];
}

export interface AiModeInterestedClientRow {
  buyer_id: number;
  company_name: string;
  country: string | null;
  interested_at: string | null;
  lifecycle_stage: string;
  quotation_status: "not_sent" | "sent";
}

export interface AiModeInterestedClientsResponse {
  total: number;
  rows: AiModeInterestedClientRow[];
}

export interface AiModeLifecycleClientRow {
  buyer_id: number;
  company_name: string;
  country: string | null;
  stage_entered_at: string | null;
  lifecycle_stage: string;
}

export interface AiModeQuotationSentClientRow extends AiModeLifecycleClientRow {
  meeting_status: "not_scheduled" | "scheduled";
  meeting_at: string | null;
}

export interface QuotationMeetingScheduleResult {
  buyer_id: number;
  company_name: string;
  country: string | null;
  meeting_status: "not_scheduled" | "scheduled" | "done";
  meeting_at: string | null;
  lifecycle_stage?: string;
  moved_to_negotiation?: boolean;
}

export interface QuotationMeetingAlert {
  id: string;
  buyer_id: number;
  company_name: string;
  contact_name: string | null;
  meeting_at: string;
  minutes_until: number;
}

export interface QuotationMeetingAlertsResponse {
  alerts: QuotationMeetingAlert[];
  auto_moved: Array<{
    buyer_id: number;
    company_name: string;
    meeting_at: string;
  }>;
}

export interface AiModeQuotationSentClientsResponse {
  total: number;
  rows: AiModeQuotationSentClientRow[];
}

export type AiModeNegotiationClientRow = AiModeLifecycleClientRow;

export interface AiModeNegotiationClientsResponse {
  total: number;
  rows: AiModeNegotiationClientRow[];
}

export interface AiModeInterestedLeadRow {
  buyer_id: number;
  company_name: string;
  country: string | null;
  source: string | null;
  company_grading: string | null;
  company_grade: string | null;
  ai_grade: string;
  score_reasoning: string | null;
  scored_at: string | null;
  assigned_to: string | null;
  assigned_to_user_id: number | null;
}

export interface AiModeInterestedLeadsResponse {
  total: number;
  rows: AiModeInterestedLeadRow[];
}