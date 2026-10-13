import { useCallback, useEffect, useState } from "react";
import {
  client,
  type AiModeAssignmentRow,
  type AiModeAutoReplyLogRow,
  type AiModeCallActivityRow,
  type AiModeFollowUpActivityRow,
  type AiModeInterestedActivityRow,
  type AiModeInterestedClientRow,
  type AiModeInterestedUserScore,
  type AiModeNegotiationClientRow,
  type AiModeQuotationSentClientRow,
  type AiModeNotInterestedActivityRow,
  type AiModeNotInterestedUserScore,
  type AiModeInterestedLeadRow,
  type AiModeLifecycleRow,
  type AiModeQueryRow,
  type AiModeSettings,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  AssignedToSelect,
  type AssigneeOption,
} from "../components/AssignedToSelect";
import { IconChevronDown, IconChevronRight } from "../components/icons/AppIcons";
import {
  QuotationMeetingControl,
  type QuotationMeetingStatus,
} from "../components/QuotationMeetingControl";
import {
  EmailBodyEditor,
  emailBodyHasContent,
} from "../components/EmailBodyEditor";
import { deriveWhatsAppFromEmail } from "../utils/channelSync";
import { capitalizeFirstLetter } from "../utils/spelling";
import { PersonalizedEmailsPage } from "./PersonalizedEmailsPage";

interface AiModePageProps {
  onError: (message: string) => void;
  /** Refresh sidebar “Leads Sent To” counts + open leads tables after an assign. */
  onLeadsAssigned?: () => void;
  onPersonalizedCountChange?: (count: number) => void;
}

type Panel = "lifecycle" | "personalized" | "auto-reply";

type PotentialClientRow = AiModeInterestedLeadRow;

interface DraftFields {
  form_url: string;
  email_subject_template: string;
  email_body_template: string;
  whatsapp_body_template: string;
  keywordsText: string;
}

function draftFromSettings(data: AiModeSettings): DraftFields {
  return {
    form_url: data.form_url ?? "",
    email_subject_template: data.email_subject_template,
    email_body_template: data.email_body_template,
    whatsapp_body_template: data.whatsapp_body_template,
    keywordsText: (data.query_keywords || []).join(", "),
  };
}

function parseKeywords(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Two-panel AI Mode layout — expands on large monitors instead of staying narrow. */
const AI_MODE_SPLIT_GRID =
  "grid w-full gap-5 lg:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]";

function AssignmentTransferRow({ row }: { row: AiModeAssignmentRow }) {
  const [open, setOpen] = useState(false);
  const names = row.company_names || [];
  const canExpand = names.length > 0;

  return (
    <li className="py-3 px-1">
      <div className="flex items-start gap-2">
        {canExpand ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="mt-0.5 rounded-md border border-slate-700 bg-slate-900/80 p-1 text-slate-400 hover:text-slate-200 hover:border-slate-600"
            aria-expanded={open}
            aria-label={open ? "Hide client names" : "Show client names"}
            title={open ? "Hide client names" : "Show client names"}
          >
            {open ? (
              <IconChevronDown size="sm" className="text-slate-300" />
            ) : (
              <IconChevronRight size="sm" className="text-slate-300" />
            )}
          </button>
        ) : (
          <span className="w-7 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-100">{row.message}</p>
          <p className="text-xs text-slate-500 mt-1">
            To {row.to_label}
            {row.created_at ? ` · ${new Date(row.created_at).toLocaleString()}` : ""}
            {` · ${row.lead_count} client${row.lead_count === 1 ? "" : "s"}`}
          </p>
          {open && canExpand ? (
            <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/70 divide-y divide-slate-800/80">
              {names.map((name, index) => (
                <li
                  key={`${row.id}-${index}`}
                  className="px-3 py-2 text-sm text-slate-300"
                >
                  {name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function CallActivityRow({ row }: { row: AiModeCallActivityRow }) {
  const company = (row.company_name || "").trim() || "Unknown client";
  return (
    <li className="py-3 px-1">
      <p className="text-sm text-slate-100">
        <span className="text-slate-300">{row.user_label}</span>
        {" called "}
        <span className="font-medium text-emerald-300">{company}</span>
      </p>
      <p className="text-xs text-slate-500 mt-1">
        {row.created_at ? new Date(row.created_at).toLocaleString() : ""}
      </p>
    </li>
  );
}

export function AiModePage({
  onError,
  onLeadsAssigned,
  onPersonalizedCountChange,
}: AiModePageProps) {
  const { isAdmin } = useAuth();
  const [panel, setPanel] = useState<Panel>("lifecycle");
  const [settings, setSettings] = useState<AiModeSettings | null>(null);
  const [draft, setDraft] = useState<DraftFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<AiModeAutoReplyLogRow[]>([]);
  const [assigneeOptions, setAssigneeOptions] = useState<AssigneeOption[]>([]);
  const [assigningBuyerId, setAssigningBuyerId] = useState<number | null>(null);

  const [queryCount, setQueryCount] = useState(0);
  const [queryRows, setQueryRows] = useState<AiModeQueryRow[]>([]);
  const [queriesLoading, setQueriesLoading] = useState(false);
  const [selectedQuery, setSelectedQuery] = useState<AiModeQueryRow | null>(null);
  const [queryMessage, setQueryMessage] = useState<{
    uid?: string;
    folder?: string | null;
    subject?: string | null;
    from_email?: string | null;
    from_name?: string | null;
    body?: string | null;
    preview?: string | null;
    date?: string | null;
  } | null>(null);
  const [queryMessageLoading, setQueryMessageLoading] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyGenerating, setReplyGenerating] = useState(false);

  const [lifecycleRows, setLifecycleRows] = useState<AiModeLifecycleRow[]>([]);
  const [pipeline, setPipeline] = useState<Record<string, number>>({});
  const [stages, setStages] = useState<Array<{ key: string; label: string }>>([]);
  const [stageFilter, setStageFilter] = useState("");
  const [lifecycleSearch, setLifecycleSearch] = useState("");
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [assignmentRows, setAssignmentRows] = useState<AiModeAssignmentRow[]>([]);
  const [assignedLeadCount, setAssignedLeadCount] = useState(0);
  const [callActivityRows, setCallActivityRows] = useState<AiModeCallActivityRow[]>(
    [],
  );
  const [callingCount, setCallingCount] = useState(0);
  const [followUpActivityRows, setFollowUpActivityRows] = useState<
    AiModeFollowUpActivityRow[]
  >([]);
  const [followUpCount, setFollowUpCount] = useState(0);
  const [interestedActivityRows, setInterestedActivityRows] = useState<
    AiModeInterestedActivityRow[]
  >([]);
  const [interestedInListCount, setInterestedInListCount] = useState(0);
  const [interestedMyCount, setInterestedMyCount] = useState(0);
  const [interestedByUser, setInterestedByUser] = useState<
    AiModeInterestedUserScore[]
  >([]);
  const [interestedClientRows, setInterestedClientRows] = useState<
    AiModeInterestedClientRow[]
  >([]);
  const [interestedClientTotal, setInterestedClientTotal] = useState(0);
  const [quotationUpdatingId, setQuotationUpdatingId] = useState<number | null>(
    null,
  );
  const [quotationSentRows, setQuotationSentRows] = useState<
    AiModeQuotationSentClientRow[]
  >([]);
  const [quotationSentTotal, setQuotationSentTotal] = useState(0);
  const [meetingUpdatingId, setMeetingUpdatingId] = useState<number | null>(null);
  const [negotiationRows, setNegotiationRows] = useState<AiModeNegotiationClientRow[]>(
    [],
  );
  const [negotiationTotal, setNegotiationTotal] = useState(0);
  const [negotiationUpdatingId, setNegotiationUpdatingId] = useState<number | null>(
    null,
  );
  const [notInterestedActivityRows, setNotInterestedActivityRows] = useState<
    AiModeNotInterestedActivityRow[]
  >([]);
  const [notInterestedInListCount, setNotInterestedInListCount] = useState(0);
  const [notInterestedMyCount, setNotInterestedMyCount] = useState(0);
  const [notInterestedByUser, setNotInterestedByUser] = useState<
    AiModeNotInterestedUserScore[]
  >([]);
  const [potentialRows, setPotentialRows] = useState<PotentialClientRow[]>([]);
  const [potentialCount, setPotentialCount] = useState(0);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await client.getAiModeSettings();
      setSettings(data);
      setDraft(draftFromSettings(data));
      setStages(data.lifecycle_stages || []);
      const [logResult, queryResult] = await Promise.all([
        client.listAiModeAutoReplies(40),
        client.listAiModeQueries({ limit: 100 }),
      ]);
      setLogs(logResult.rows || []);
      setQueryCount(queryResult.count || 0);
      setQueryRows(queryResult.rows || []);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load AI Mode");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  const loadQueries = useCallback(
    async (refresh = true) => {
      setQueriesLoading(true);
      try {
        const data = refresh
          ? await client.scanAiModeQueries()
          : await client.listAiModeQueries({ limit: 100 });
        setQueryCount(data.count || 0);
        setQueryRows(data.rows || []);
        if (refresh && data.scan) {
          const s = data.scan;
          if (s.error) {
            onError(`Mailbox scan failed: ${s.error}`);
          } else {
            setNotice(
              `Inbox scan complete — checked ${s.scanned} message${s.scanned === 1 ? "" : "s"}, ` +
                `${s.matched} quer${s.matched === 1 ? "y" : "ies"}, ` +
                `${s.created} new.`,
            );
            window.setTimeout(() => setNotice(null), 6000);
          }
        }
      } catch (e) {
        onError(e instanceof Error ? e.message : "Failed to load query emails");
      } finally {
        setQueriesLoading(false);
      }
    },
    [onError],
  );

  const loadLifecycle = useCallback(async () => {
    setLifecycleLoading(true);
    try {
      const skipCompanyRows =
        stageFilter === "new_lead" ||
        stageFilter === "potential_clients" ||
        stageFilter === "assigned" ||
        stageFilter === "calling" ||
        stageFilter === "follow_up" ||
        stageFilter === "interested" ||
        stageFilter === "not_interested" ||
        stageFilter === "quotation_sent" ||
        stageFilter === "negotiation";
      const [data] = await Promise.all([
        client.listAiModeLifecycle({
          // Activity / grade feeds — other stages list companies.
          stage:
            stageFilter && !skipCompanyRows ? stageFilter : undefined,
          search:
            skipCompanyRows &&
            stageFilter !== "potential_clients" &&
            stageFilter !== "interested" &&
            stageFilter !== "quotation_sent" &&
            stageFilter !== "negotiation"
              ? undefined
              : lifecycleSearch.trim() || undefined,
          limit: 100,
        }),
        // Always refresh this user's query count for the New Lead chip.
        client.listAiModeQueries({ limit: 100 }).then((q) => {
          setQueryCount(q.count || 0);
          setQueryRows(q.rows || []);
        }),
      ]);
      setLifecycleRows(
        (data.rows || []).filter(
          (r) =>
            r.stage !== "new_lead" &&
            r.stage !== "potential_clients" &&
            r.stage !== "assigned" &&
            r.stage !== "calling" &&
            r.stage !== "follow_up" &&
            r.stage !== "interested" &&
            r.stage !== "not_interested" &&
            r.stage !== "quotation_sent" &&
            r.stage !== "negotiation",
        ),
      );
      setPipeline(data.pipeline || {});
      setStages(data.stages || []);
      const assignments =
        data.assignments || (await client.listAiModeAssignments(100));
      setAssignmentRows(assignments.rows || []);
      setAssignedLeadCount(assignments.total_leads || 0);
      const calls =
        data.call_activities || (await client.listAiModeCallActivities(100));
      setCallActivityRows(calls.rows || []);
      setCallingCount(calls.total_calls || 0);
      const followUps =
        data.follow_up_activities ||
        (await client.listAiModeFollowUpActivities(100));
      setFollowUpActivityRows(followUps.rows || []);
      setFollowUpCount(followUps.total_events || 0);
      const interested =
        data.interested_activities ||
        (await client.listAiModeInterestedActivities({ limit: 100 }));
      setInterestedActivityRows(interested.rows || []);
      setInterestedInListCount(interested.total_in_list || 0);
      setInterestedMyCount(interested.my_placed_count || 0);
      setInterestedByUser(interested.by_user || []);
      setInterestedClientRows(data.interested_clients?.rows || []);
      setInterestedClientTotal(data.interested_clients?.total || 0);
      setQuotationSentRows(data.quotation_sent_clients?.rows || []);
      setQuotationSentTotal(data.quotation_sent_clients?.total || 0);
      setNegotiationRows(data.negotiation_clients?.rows || []);
      setNegotiationTotal(data.negotiation_clients?.total || 0);
      const notInterested =
        data.not_interested_activities ||
        (await client.listAiModeNotInterestedActivities({ limit: 100 }));
      setNotInterestedActivityRows(notInterested.rows || []);
      setNotInterestedInListCount(notInterested.total_in_list || 0);
      setNotInterestedMyCount(notInterested.my_placed_count || 0);
      setNotInterestedByUser(notInterested.by_user || []);
      const potential =
        data.potential_clients ||
        data.interested_leads ||
        (await client.listAiModePotentialClients({
          search: lifecycleSearch.trim() || undefined,
          limit: 100,
        }));
      setPotentialRows(potential.rows || []);
      setPotentialCount(potential.total || 0);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load lifecycle");
    } finally {
      setLifecycleLoading(false);
    }
  }, [lifecycleSearch, onError, stageFilter]);

  useEffect(() => {
    if (!isAdmin) {
      setAssigneeOptions([]);
      return;
    }
    client
      .listAssignees()
      .then((users) =>
        setAssigneeOptions(
          users.map((u) => ({
            value: String(u.id),
            label: u.full_name || u.username,
            username: u.username,
          })),
        ),
      )
      .catch(() => setAssigneeOptions([]));
  }, [isAdmin]);

  async function assignPotentialClient(
    buyerId: number,
    assignedToUserId: number | null,
  ) {
    if (!isAdmin) {
      onError("Only an admin can assign leads to users.");
      return;
    }
    const previous =
      potentialRows.find((r) => r.buyer_id === buyerId)?.assigned_to_user_id ??
      null;
    if (previous === assignedToUserId) return;

    const label =
      assignedToUserId == null
        ? "Unassigned"
        : assigneeOptions.find((o) => o.value === String(assignedToUserId))
            ?.label ||
          assigneeOptions.find((o) => o.value === String(assignedToUserId))
            ?.username ||
          "selected user";

    setAssigningBuyerId(buyerId);
    setNotice(null);
    try {
      const updated = await client.updateLeadTableRow(buyerId, {
        assigned_to_user_id: assignedToUserId,
      });
      setPotentialRows((prev) =>
        prev.map((row) =>
          row.buyer_id === buyerId
            ? {
                ...row,
                assigned_to: updated.assigned_to,
                assigned_to_user_id: updated.assigned_to_user_id,
              }
            : row,
        ),
      );
      // Refresh Assigned activity feed + chip so transfer notifications appear immediately.
      const assignments = await client.listAiModeAssignments(100);
      setAssignmentRows(assignments.rows || []);
      setAssignedLeadCount(assignments.total_leads || 0);
      onLeadsAssigned?.();
      setNotice(
        assignedToUserId == null
          ? `Unassigned ${updated.company_name}.`
          : `1 lead transferred to ${label}`,
      );
      window.setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update assignee");
    } finally {
      setAssigningBuyerId(null);
    }
  }

  useEffect(() => {
    if (!isAdmin && panel === "auto-reply") {
      setPanel("lifecycle");
    }
  }, [isAdmin, panel]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const pending = sessionStorage.getItem("kafi.aiModeStage");
    const pendingPanel = sessionStorage.getItem("kafi.aiModePanel");
    if (
      pendingPanel === "auto-reply" ||
      pendingPanel === "lifecycle" ||
      pendingPanel === "personalized"
    ) {
      if (pendingPanel === "auto-reply" && !isAdmin) {
        setPanel("lifecycle");
      } else {
        setPanel(pendingPanel);
      }
      sessionStorage.removeItem("kafi.aiModePanel");
    }
    if (!pending) return;
    setPanel("lifecycle");
    setStageFilter(pending);
    sessionStorage.removeItem("kafi.aiModeStage");
  }, []);

  useEffect(() => {
    if (panel !== "lifecycle") return;
    void loadLifecycle();
    // Scan mailbox so New Lead (+query) stays up to date.
    void loadQueries(true);
  }, [panel, loadLifecycle, loadQueries]);

  useEffect(() => {
    if (panel === "lifecycle" && stageFilter === "new_lead") {
      setSelectedQuery(null);
      setQueryMessage(null);
      setReplyBody("");
    }
  }, [panel, stageFilter]);

  function buildReplyDraft(row: AiModeQueryRow): string {
    const name =
      (row.from_name || "").trim() ||
      (row.from_email || "").split("@")[0] ||
      "Sir/Madam";
    const formUrl = (settings?.form_url || "").trim();
    const formClause = formUrl
      ? `: ${formUrl}`
      : " (link will be shared by our team)";
    const template =
      settings?.email_body_template ||
      "Dear {name},\n\nThank you for showing interest in Kafi Commodities.\n\nWe would like you to fill out this form{form_clause}, or please provide a suitable date/time for a virtual meeting/call and our team will get back to you.\n\nBest regards,\nKafi Commodities Export Team";
    return template
      .replaceAll("{name}", name)
      .replaceAll("{form_clause}", formClause)
      .replaceAll("{form_url}", formUrl || "(form link)")
      .replaceAll("{subject}", row.subject || "");
  }

  async function generateQueryReply(queryId?: number, fallbackRow?: AiModeQueryRow) {
    const row = fallbackRow || selectedQuery;
    const id = queryId ?? row?.id;
    if (!id || !isAdmin) return;
    setReplyGenerating(true);
    setNotice(null);
    try {
      const draft = await client.generateAiModeQueryReply(id);
      setReplyBody(draft.body || (row ? buildReplyDraft(row) : ""));
      if (draft.source === "llm") {
        setNotice("AI draft generated — review before sending.");
      } else if (draft.error) {
        onError(`AI draft unavailable (${draft.error}). Using template.`);
        if (row) setReplyBody(draft.body || buildReplyDraft(row));
      } else {
        setNotice(
          "AI query key not configured — showing template. Set AI_MODE_QUERY_GEMINI_API_KEY or GEMINI_API_KEY.",
        );
      }
      window.setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to generate AI reply");
      if (row) setReplyBody(buildReplyDraft(row));
    } finally {
      setReplyGenerating(false);
    }
  }

  async function openQuery(row: AiModeQueryRow) {
    setSelectedQuery(row);
    const fallbackMsg = {
      uid: String(row.uid || ""),
      folder: row.folder || "INBOX",
      subject: row.subject || "(no subject)",
      from_email: row.from_email || "",
      from_name: row.from_name || row.from_email || "Customer",
      body: row.preview || "(email body snippet from query log)",
      preview: row.preview || "",
      date: row.received_at || "",
    };
    setQueryMessage(fallbackMsg);
    setReplyBody(isAdmin ? buildReplyDraft(row) : "");
    setQueryMessageLoading(true);
    try {
      const data = await client.getAiModeQueryMessage(row.id);
      if (data && data.message && (data.message.body || data.message.preview)) {
        setQueryMessage(data.message);
      }
      if (isAdmin) {
        await generateQueryReply(row.id, row);
      }
    } catch (e) {
      console.warn("Could not fetch full IMAP message body, using preview snippet:", e);
    } finally {
      setQueryMessageLoading(false);
    }
  }

  async function sendQueryReply() {
    if (!selectedQuery || !isAdmin) return;
    const body = emailBodyHasContent(replyBody) ? replyBody : "";
    if (!body) {
      onError("Reply body cannot be empty");
      return;
    }
    const uid = String(queryMessage?.uid || selectedQuery.uid || "").trim();
    const folder = String(
      queryMessage?.folder || selectedQuery.folder || "INBOX",
    ).trim();
    const to = (
      queryMessage?.from_email ||
      selectedQuery.from_email ||
      ""
    ).trim();
    if (!uid || !to) {
      onError("Missing message id or recipient — cannot send reply");
      return;
    }
    setReplySending(true);
    setNotice(null);
    try {
      const subject = (queryMessage?.subject || selectedQuery.subject || "").trim();
      const replySubject = subject.toLowerCase().startsWith("re:")
        ? subject
        : subject
          ? `Re: ${subject}`
          : settings?.email_subject_template || "Thank you for your interest in Kafi Commodities";
      const result = await client.replyInboxMessage(uid, {
        body,
        to,
        subject: replySubject,
        folder,
      });
      setNotice(
        result.status === "sent"
          ? `Reply sent to ${to}`
          : result.message || "Reply finished",
      );
      setReplyBody("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send reply");
    } finally {
      setReplySending(false);
    }
  }

  const draftDirty =
    !!settings &&
    !!draft &&
    (draft.form_url !== (settings.form_url ?? "") ||
      draft.email_subject_template !== settings.email_subject_template ||
      draft.email_body_template !== settings.email_body_template ||
      draft.whatsapp_body_template !== settings.whatsapp_body_template ||
      parseKeywords(draft.keywordsText).join("|") !==
        (settings.query_keywords || []).join("|"));

  async function saveChannelFlags(patch: {
    enabled?: boolean;
    email_auto_reply_enabled?: boolean;
    whatsapp_auto_reply_enabled?: boolean;
  }) {
    if (!settings) return;
    setSaving(true);
    setNotice(null);
    try {
      const next = await client.updateAiModeSettings(patch);
      setSettings(next);
      setNotice(
        next.enabled
          ? "AI Mode is ON — auto-replies are active."
          : "AI Mode is OFF.",
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save AI Mode settings");
    } finally {
      setSaving(false);
    }
  }

  async function saveDraftTemplates(): Promise<AiModeSettings | null> {
    if (!settings || !draft) return null;
    setSaving(true);
    setNotice(null);
    try {
      const next = await client.updateAiModeSettings({
        form_url: draft.form_url.trim() || null,
        email_subject_template: draft.email_subject_template,
        email_body_template: draft.email_body_template,
        whatsapp_body_template: draft.whatsapp_body_template,
        query_keywords: parseKeywords(draft.keywordsText),
      });
      setSettings(next);
      setDraft(draftFromSettings(next));
      setNotice("Templates, form URL, and keywords saved.");
      return next;
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save templates");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function runProcessNow() {
    setProcessing(true);
    setNotice(null);
    try {
      if (draftDirty) {
        const saved = await saveDraftTemplates();
        if (!saved) return;
      }
      const result = await client.processAiModeEmails();
      const detail =
        typeof result.message === "string" && result.message.trim()
          ? result.message.trim()
          : null;
      setNotice(
        result.enabled
          ? detail ||
              `Processed · scanned ${result.processed} · replied ${result.replied} · skipped ${result.skipped}`
          : "Turn AI Mode on to process emails.",
      );
      const logResult = await client.listAiModeAutoReplies(40);
      setLogs(logResult.rows || []);
      const queryResult = await client.listAiModeQueries({ limit: 100 });
      setQueryCount(queryResult.count || 0);
      setQueryRows(queryResult.rows || []);
      await loadSettings();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to process emails");
    } finally {
      setProcessing(false);
    }
  }

  async function changeStage(row: AiModeLifecycleRow, stage: string) {
    try {
      await client.updateAiModeLifecycle(row.buyer_id, { stage });
      await loadLifecycle();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update stage");
    }
  }

  async function markQuotationSent(buyerId: number) {
    setQuotationUpdatingId(buyerId);
    try {
      await client.updateAiModeLifecycle(buyerId, {
        stage: "quotation_sent",
        notes: "Quotation sent",
      });
      setNotice("Client moved to Quotation Sent.");
      window.setTimeout(() => setNotice(null), 4000);
      await loadLifecycle();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update quotation status");
    } finally {
      setQuotationUpdatingId(null);
    }
  }

  async function updateMeetingStatus(buyerId: number, meetingStatus: QuotationMeetingStatus) {
    if (meetingStatus === "scheduled") {
      setQuotationSentRows((rows) =>
        rows.map((row) =>
          row.buyer_id === buyerId ? { ...row, meeting_status: "scheduled" } : row,
        ),
      );
      return;
    }

    setMeetingUpdatingId(buyerId);
    try {
      const result = await client.updateQuotationMeeting(buyerId, {
        meeting_status: meetingStatus,
        meeting_at: null,
      });
      if (result.moved_to_negotiation || meetingStatus === "done") {
        setNotice("Client moved to Negotiation.");
        window.setTimeout(() => setNotice(null), 4000);
        await loadLifecycle();
        return;
      }
      setQuotationSentRows((rows) =>
        rows.map((row) =>
          row.buyer_id === buyerId
            ? {
                ...row,
                meeting_status: "not_scheduled",
                meeting_at: result.meeting_at,
              }
            : row,
        ),
      );
      if (meetingStatus === "not_scheduled") {
        setNotice("Meeting schedule cleared.");
        window.setTimeout(() => setNotice(null), 4000);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update meeting status");
      await loadLifecycle();
    } finally {
      setMeetingUpdatingId(null);
    }
  }

  async function saveMeetingSchedule(buyerId: number, meetingAtIso: string) {
    setMeetingUpdatingId(buyerId);
    try {
      const result = await client.updateQuotationMeeting(buyerId, {
        meeting_status: "scheduled",
        meeting_at: meetingAtIso,
      });
      setQuotationSentRows((rows) =>
        rows.map((row) =>
          row.buyer_id === buyerId
            ? {
                ...row,
                meeting_status: "scheduled",
                meeting_at: result.meeting_at,
              }
            : row,
        ),
      );
      setNotice("Meeting scheduled.");
      window.setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to schedule meeting");
      await loadLifecycle();
    } finally {
      setMeetingUpdatingId(null);
    }
  }

  async function markNegotiationOutcome(buyerId: number, outcome: "won" | "lost") {
    setNegotiationUpdatingId(buyerId);
    try {
      await client.updateAiModeLifecycle(buyerId, {
        stage: outcome,
        notes: outcome === "won" ? "Deal won" : "Deal lost",
      });
      setNotice(outcome === "won" ? "Client marked as Won." : "Client marked as Lost.");
      window.setTimeout(() => setNotice(null), 4000);
      await loadLifecycle();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update negotiation outcome");
    } finally {
      setNegotiationUpdatingId(null);
    }
  }

  const panelTabs = (
    <div className="flex gap-2 border-b border-slate-800 pb-2 flex-wrap">
      {(isAdmin
        ? ([
            ["lifecycle", "Company lifecycle"],
            ["personalized", "Personalized Emails"],
            ["auto-reply", "Auto-reply"],
          ] as const)
        : ([
            ["lifecycle", "Company lifecycle"],
            ["personalized", "Personalized Emails"],
          ] as const)
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => setPanel(id)}
          className={`rounded-lg px-3 py-1.5 text-sm ${
            panel === id
              ? "bg-slate-800 text-slate-100"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (panel === "personalized") {
    return (
      <div className="space-y-5 w-full min-w-0">
        <div>
          <h2 className="text-lg font-medium text-slate-100">AI Mode</h2>
          <p className="text-sm text-slate-500 mt-1 max-w-3xl lg:max-w-none">
            Personalized Emails — post-call drafts from closed captions. Review once, then
            send the same message on email and WhatsApp.
          </p>
        </div>
        {notice && (
          <p className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-300">
            {notice}
          </p>
        )}
        {panelTabs}
        <PersonalizedEmailsPage
          embedded
          onError={onError}
          onCountChange={onPersonalizedCountChange}
        />
      </div>
    );
  }

  if (loading || !settings || !draft) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-sm text-slate-400">
        Loading AI Mode…
      </div>
    );
  }

  return (
    <div className="space-y-5 w-full min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-slate-100">AI Mode</h2>
          <p className="text-sm text-slate-500 mt-1 max-w-3xl lg:max-w-none">
            {isAdmin ? (
              <>
                Turn AI Mode on when you leave for the day. Auto-replies go to any{" "}
                <span className="text-slate-400">new</span> inbound email from a real person
                (not newsletters or marketing) received after you enable it — not messages
                already sitting in the inbox. Company lifecycle tracks each lead for the whole
                team.
              </>
            ) : (
              <>
                Company lifecycle tracks leads for the whole team. AI auto-reply and
                AI query replies are configured by an admin only.
              </>
            )}
          </p>
        </div>
        {isAdmin ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveChannelFlags({ enabled: !settings.enabled })}
            className={`relative inline-flex h-10 w-[7.5rem] items-center rounded-full border px-1 transition-colors ${
              settings.enabled
                ? "bg-emerald-600/30 border-emerald-500/50"
                : "bg-slate-900 border-slate-700"
            }`}
            aria-pressed={settings.enabled}
            title={settings.enabled ? "Turn AI Mode off" : "Turn AI Mode on"}
          >
            <span
              className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-semibold transition-transform ${
                settings.enabled
                  ? "translate-x-[3.85rem] bg-emerald-500 text-slate-950"
                  : "translate-x-0 bg-slate-600 text-slate-100"
              }`}
            >
              {settings.enabled ? "ON" : "OFF"}
            </span>
          </button>
        ) : null}
      </div>

      {notice && (
        <p className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-300">
          {notice}
        </p>
      )}

      {panelTabs}

      {panel === "auto-reply" && isAdmin && (
        <div className={AI_MODE_SPLIT_GRID}>
          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="text-sm font-medium text-slate-200">Channels</h3>
            <p className="text-xs text-slate-500">
              When AI Mode is on,{" "}
              <span className="text-slate-400">New Lead queries</span> get a brief{" "}
              <span className="text-slate-400">AI-generated</span> auto-reply tailored to what
              the client asked. Other person-to-person mail uses your{" "}
              <span className="text-slate-400">static template</span>. Only messages received
              after you turn AI Mode on
              {settings.enabled_at
                ? ` (${new Date(settings.enabled_at).toLocaleString()})`
                : ""}{" "}
              are eligible. Older unread messages are skipped.
            </p>
            <label className="flex items-center justify-between gap-3 text-sm text-slate-300">
              <span>Email auto-reply (Inbox + Junk)</span>
              <input
                type="checkbox"
                checked={settings.email_auto_reply_enabled}
                onChange={(e) =>
                  void saveChannelFlags({ email_auto_reply_enabled: e.target.checked })
                }
                className="rounded border-slate-600"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm text-slate-300">
              <span>WhatsApp auto-reply (when connected)</span>
              <input
                type="checkbox"
                checked={settings.whatsapp_auto_reply_enabled}
                onChange={(e) =>
                  void saveChannelFlags({ whatsapp_auto_reply_enabled: e.target.checked })
                }
                className="rounded border-slate-600"
              />
            </label>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Form URL (optional)</label>
              <input
                value={draft.form_url}
                onChange={(e) => setDraft({ ...draft, form_url: e.target.value })}
                placeholder="https://forms.example.com/kafi-interest"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">
                Query keywords (comma or newline separated)
              </label>
              <textarea
                value={draft.keywordsText}
                onChange={(e) => setDraft({ ...draft, keywordsText: e.target.value })}
                rows={3}
                placeholder="inquiry, quote, price, interested, meeting…"
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Inquiry keywords detect New Lead queries. When AI Mode is on, matching emails
                are auto-replied with a short AI answer (and still listed under Company
                lifecycle → New Lead). Other person-to-person mail uses the static template.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={saving || !draftDirty}
                onClick={() => void saveDraftTemplates()}
                className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-2 text-sm font-medium"
              >
                {saving ? "Saving…" : draftDirty ? "Save templates" : "Saved"}
              </button>
              <button
                type="button"
                disabled={processing || saving || !settings.enabled}
                onClick={() => void runProcessNow()}
                className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-2 text-sm font-medium"
              >
                {processing ? "Processing…" : "Save & process mailbox"}
              </button>
            </div>
            {draftDirty && (
              <p className="text-xs text-amber-400/90">Unsaved template changes.</p>
            )}
            {settings.last_email_processed_at && (
              <p className="text-xs text-slate-500">
                Last email scan: {new Date(settings.last_email_processed_at).toLocaleString()}
              </p>
            )}
          </section>

          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="text-sm font-medium text-slate-200">Reply drafts</h3>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Email subject</label>
              <input
                value={draft.email_subject_template}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    email_subject_template: capitalizeFirstLetter(e.target.value),
                  })
                }
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">
                Email body (source of truth) — placeholders: {"{name}"}, {"{form_clause}"},{" "}
                {"{form_url}"}
              </label>
              <EmailBodyEditor
                value={draft.email_body_template}
                onChange={(email_body_template) => {
                  setDraft({
                    ...draft,
                    email_body_template,
                    // Keep WhatsApp synchronized with the same information.
                    whatsapp_body_template: deriveWhatsAppFromEmail(email_body_template),
                  });
                }}
                rows={8}
                placeholder="Write the email auto-reply body…"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">
                WhatsApp body — synced from email (same information on both channels)
              </label>
              <textarea
                value={draft.whatsapp_body_template}
                readOnly
                rows={6}
                title="Mirrors the email body so customers get the same information"
                className="w-full rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-slate-300 font-mono"
              />
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
                Preview (email body)
              </p>
              <pre className="whitespace-pre-wrap text-xs text-slate-300 font-sans">
                {draft.email_body_template
                  .replaceAll("{name}", "Sir/Madam")
                  .replaceAll(
                    "{form_clause}",
                    draft.form_url.trim()
                      ? `: ${draft.form_url.trim()}`
                      : " (link will be shared by our team)",
                  )
                  .replaceAll(
                    "{form_url}",
                    draft.form_url.trim() || "(form link)",
                  )}
              </pre>
            </div>
          </section>

          <section className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="text-sm font-medium text-slate-200 mb-3">Recent auto-replies</h3>
            {logs.length === 0 ? (
              <p className="text-sm text-slate-500">No auto-replies yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-slate-800">
                      <th className="py-2 pr-3">When</th>
                      <th className="py-2 pr-3">Channel</th>
                      <th className="py-2 pr-3">To</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2">Subject / preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((row) => (
                      <tr key={row.id} className="border-b border-slate-800/60 text-slate-300 align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-slate-500">
                          {row.created_at
                            ? new Date(row.created_at).toLocaleString()
                            : "—"}
                        </td>
                        <td className="py-2 pr-3 capitalize">{row.channel}</td>
                        <td className="py-2 pr-3">{row.recipient || "—"}</td>
                        <td className="py-2 pr-3">
                          <span
                            className={
                              row.status === "sent"
                                ? "text-emerald-400"
                                : row.status === "error"
                                  ? "text-rose-400"
                                  : undefined
                            }
                          >
                            {row.status}
                          </span>
                          {row.status === "error" && row.detail ? (
                            <p className="mt-1 max-w-xs text-[11px] leading-snug text-rose-300/80 whitespace-normal">
                              {row.detail}
                            </p>
                          ) : null}
                        </td>
                        <td className="py-2 truncate max-w-md">
                          {row.subject || row.preview || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {panel === "lifecycle" && (
        <div className="space-y-4">
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {stages.map((s) => {
              const count =
                s.key === "new_lead"
                  ? queryCount
                  : s.key === "potential_clients"
                    ? potentialCount
                    : s.key === "assigned"
                      ? assignedLeadCount
                      : s.key === "calling"
                        ? callingCount
                        : s.key === "follow_up"
                          ? followUpCount
                          : s.key === "interested"
                            ? interestedInListCount
                          : s.key === "not_interested"
                            ? notInterestedInListCount
                            : (pipeline[s.key] ?? 0);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() =>
                    setStageFilter((prev) => (prev === s.key ? "" : s.key))
                  }
                  className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs whitespace-nowrap ${
                    stageFilter === s.key
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                      : "border-slate-700 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {s.key === "new_lead"
                    ? "New Lead (Queries)"
                    : s.key === "potential_clients"
                      ? "Potential Clients"
                      : s.label}
                  <span className="ml-1 text-slate-500">{count}</span>
                </button>
              );
            })}
          </div>

          {stageFilter === "new_lead" ? (
            <div className={AI_MODE_SPLIT_GRID}>
              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium text-slate-200">
                      Query emails{" "}
                      <span className="text-emerald-400/90">({queryCount})</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Scan mailbox checks the latest{" "}
                      <span className="text-slate-400">10 inbox emails</span> (read or
                      unread) for real buyer inquiries.
                      {isAdmin
                        ? " AI replies and auto-reply are admin-only."
                        : " Query replies are handled by an admin."}
                    </p>
                  </div>
                  {isAdmin ? (
                    <button
                      type="button"
                      disabled={queriesLoading}
                      onClick={() => void loadQueries(true)}
                      className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                    >
                      {queriesLoading ? "Scanning…" : "Scan mailbox"}
                    </button>
                  ) : null}
                </div>
                {queriesLoading && queryRows.length === 0 ? (
                  <p className="text-sm text-slate-500">Scanning mailbox…</p>
                ) : queryRows.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No query emails yet. Press Scan mailbox to check your latest 10 inbox
                    emails (read or unread).
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-800 max-h-[28rem] xl:max-h-[36rem] overflow-y-auto">
                    {queryRows.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => void openQuery(row)}
                          className={`w-full text-left py-2.5 px-1 hover:bg-slate-800/50 rounded-md ${
                            selectedQuery?.id === row.id ? "bg-slate-800/70" : ""
                          }`}
                        >
                          <p className="text-sm text-slate-200 truncate">
                            {row.subject || "(no subject)"}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5 truncate">
                            {row.from_name || row.from_email || "—"}
                            {row.received_at
                              ? ` · ${new Date(row.received_at).toLocaleString()}`
                              : ""}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 min-h-[16rem] xl:min-h-[24rem]">
                <h3 className="text-sm font-medium text-slate-200 mb-3">
                  {isAdmin ? "Email & reply" : "Email preview"}
                </h3>
                {!selectedQuery ? (
                  <p className="text-sm text-slate-500">
                    {isAdmin
                      ? "Select a query to open the email and reply."
                      : "Select a query to preview the email. Replies are admin-only."}
                  </p>
                ) : queryMessageLoading ? (
                  <p className="text-sm text-slate-500">Loading email…</p>
                ) : !queryMessage ? (
                  <p className="text-sm text-slate-500">Could not load this email.</p>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium text-slate-100">
                        {queryMessage.subject || "(no subject)"}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        From: {queryMessage.from_name || queryMessage.from_email || "—"}
                        {queryMessage.date
                          ? ` · ${new Date(queryMessage.date).toLocaleString()}`
                          : ""}
                      </p>
                    </div>
                    <pre className="whitespace-pre-wrap text-sm text-slate-300 font-sans max-h-[12rem] xl:max-h-[22rem] overflow-y-auto rounded-md border border-slate-800 bg-slate-950/50 p-3">
                      {queryMessage.body || queryMessage.preview || "(empty body)"}
                    </pre>

                    {isAdmin ? (
                      <div className="border-t border-slate-800 pt-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="block text-xs text-slate-500">
                            Your reply (from your mailbox)
                          </label>
                          <button
                            type="button"
                            disabled={replyGenerating || replySending}
                            onClick={() => void generateQueryReply()}
                            title={
                              settings?.llm_query_enabled
                                ? "Draft a short reply based on this inquiry"
                                : "Needs AI_MODE_QUERY_GEMINI_API_KEY or GEMINI_API_KEY on the server"
                            }
                            className="rounded-lg border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-50 px-2.5 py-1 text-xs text-violet-200"
                          >
                            {replyGenerating ? "Generating…" : "Generate with AI"}
                          </button>
                        </div>
                        <EmailBodyEditor
                          value={replyBody}
                          onChange={setReplyBody}
                          rows={8}
                          placeholder="Write your reply…"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={replySending || !emailBodyHasContent(replyBody)}
                            onClick={() => void sendQueryReply()}
                            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                          >
                            {replySending ? "Sending…" : "Send reply"}
                          </button>
                          <button
                            type="button"
                            disabled={replySending || !selectedQuery}
                            onClick={() =>
                              selectedQuery && setReplyBody(buildReplyDraft(selectedQuery))
                            }
                            className="rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2 text-sm text-slate-300"
                          >
                            Reset to template
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          Sends via your company mailbox (Vercel mailer when configured).
                          With AI Mode on, new queries are also auto-replied with a brief AI
                          answer; you can still review and send manually here.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 border-t border-slate-800 pt-3">
                        Only an admin can send AI or template replies from this screen.
                      </p>
                    )}
                  </div>
                )}
              </section>
            </div>
          ) : stageFilter === "assigned" ? (
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Lead transfers{" "}
                    <span className="text-emerald-400/90">
                      ({assignedLeadCount})
                    </span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    When an admin assigns clients from Potential Clients, Scrapped Leads,
                    Old clients, Master table, or any other section, each batch (max 20
                    per notification) is logged here. Click the arrow to see company names.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {lifecycleLoading && assignmentRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading transfers…</p>
              ) : assignmentRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No lead transfers yet. Assign leads from Scrapped Leads / Old clients
                  (admin) and they will appear here.
                </p>
              ) : (
                <ul className="divide-y divide-slate-800 max-h-[32rem] xl:max-h-[40rem] overflow-y-auto">
                  {assignmentRows.map((row) => (
                    <AssignmentTransferRow key={row.id} row={row} />
                  ))}
                </ul>
              )}
            </section>
          ) : stageFilter === "calling" ? (
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Call activity{" "}
                    <span className="text-emerald-400/90">({callingCount})</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    When anyone places a call, it is logged as “User called Company
                    Name”. Includes admin and every sales user.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {lifecycleLoading && callActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading call activity…</p>
              ) : callActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No calls logged yet. When a user dials a lead, it appears here for
                  admin tracking.
                </p>
              ) : (
                <ul className="divide-y divide-slate-800 max-h-[32rem] overflow-y-auto">
                  {callActivityRows.map((row) => (
                    <CallActivityRow key={row.id} row={row} />
                  ))}
                </ul>
              )}
            </section>
          ) : stageFilter === "follow_up" ? (
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Follow up clients activity{" "}
                    <span className="text-emerald-400/90">({followUpCount})</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Tracks when anyone (admin or sales) moves a lead into Follow up clients
                    or schedules a reminder — e.g. “Usman put Acme Trading in Follow up
                    clients”.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {lifecycleLoading && followUpActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading follow-up activity…</p>
              ) : followUpActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No follow-up activity yet. Mark a call as Follow up or set a follow-up
                  date and it will appear here.
                </p>
              ) : (
                <ul className="divide-y divide-slate-800 max-h-[32rem] overflow-y-auto">
                  {followUpActivityRows.map((row) => (
                    <li key={row.id} className="py-3 px-1">
                      <p className="text-sm text-slate-100">{row.message}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        {row.user_label}
                        {row.company_name ? ` · ${row.company_name}` : ""}
                        {row.created_at
                          ? ` · ${new Date(row.created_at).toLocaleString()}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : stageFilter === "interested" ? (
            <div className="space-y-4">
              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium text-slate-200">
                      Interested clients — quotation{" "}
                      <span className="text-emerald-400/90">
                        ({interestedClientTotal})
                      </span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Clients on the Interested Clients table. Default is{" "}
                      <span className="text-slate-400">Quotation not send</span>. When
                      quotation is sent, they move to the Quotation Sent tab.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={lifecycleLoading}
                    onClick={() => void loadLifecycle()}
                    className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                  >
                    {lifecycleLoading ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={lifecycleSearch}
                    onChange={(e) => setLifecycleSearch(e.target.value)}
                    placeholder="Search company or country…"
                    className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => void loadLifecycle()}
                    className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm"
                  >
                    Search
                  </button>
                </div>
                {lifecycleLoading && interestedClientRows.length === 0 ? (
                  <p className="text-sm text-slate-500">Loading interested clients…</p>
                ) : interestedClientRows.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No interested clients awaiting quotation. Add clients to Interested
                    Clients from the leads table or mark a call as Client is Interested.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-800">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-slate-500 border-b border-slate-800 bg-slate-950">
                          <th className="py-2 px-3">Company</th>
                          <th className="py-2 px-3">Added</th>
                          <th className="py-2 px-3 min-w-[12rem]">Quotation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {interestedClientRows.map((row) => (
                          <tr
                            key={row.buyer_id}
                            className="border-b border-slate-800/60"
                          >
                            <td className="py-2 px-3 text-slate-200">
                              <div>{row.company_name}</div>
                              <div className="text-xs text-slate-500">
                                {row.country || "—"}
                              </div>
                            </td>
                            <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                              {row.interested_at
                                ? new Date(row.interested_at).toLocaleString()
                                : "—"}
                            </td>
                            <td className="py-2 px-3">
                              <select
                                value={row.quotation_status}
                                disabled={quotationUpdatingId === row.buyer_id}
                                onChange={(e) => {
                                  if (e.target.value === "sent") {
                                    void markQuotationSent(row.buyer_id);
                                  }
                                }}
                                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 disabled:opacity-50"
                              >
                                <option value="not_sent">Quotation not send</option>
                                <option value="sent">Quotation send</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Interested Clients activity{" "}
                    <span className="text-emerald-400/90">
                      ({interestedInListCount})
                    </span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Linked to the Interested Clients leads table. Tracks who added each
                    client — from call outcome “Client is Interested” or manual move.
                    {isAdmin
                      ? " Admin sees every user’s score and full feed."
                      : ` You have added ${interestedMyCount} client${interestedMyCount === 1 ? "" : "s"} to Interested Clients.`}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {isAdmin && interestedByUser.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {interestedByUser.map((score) => (
                    <span
                      key={score.user_id}
                      className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200"
                    >
                      {score.user_label}: {score.placed_count} client
                      {score.placed_count === 1 ? "" : "s"}
                    </span>
                  ))}
                </div>
              )}
              {!isAdmin && interestedMyCount > 0 && (
                <p className="text-xs text-emerald-300/90 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                  You added {interestedMyCount} client
                  {interestedMyCount === 1 ? "" : "s"} to Interested Clients.
                </p>
              )}
              {lifecycleLoading && interestedActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading interested activity…</p>
              ) : interestedActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No Interested Clients activity yet. Mark a call as Client is Interested
                  or move leads to Interested Clients from the leads table.
                </p>
              ) : (
                <ul className="divide-y divide-slate-800 max-h-[32rem] overflow-y-auto">
                  {interestedActivityRows.map((row) => (
                    <li key={row.id} className="py-3 px-1">
                      <p className="text-sm text-slate-100">{row.message}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        {row.user_label}
                        {row.company_name ? ` · ${row.company_name}` : ""}
                        {row.created_at
                          ? ` · ${new Date(row.created_at).toLocaleString()}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              </section>
            </div>
          ) : stageFilter === "not_interested" ? (
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Not interested clients activity{" "}
                    <span className="text-rose-400/90">
                      ({notInterestedInListCount})
                    </span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Linked to the Not interested clients leads table. Tracks who marked
                    each client as not interested from post-call remarks.
                    {isAdmin
                      ? " Admin sees every user’s score and full feed."
                      : ` You have marked ${notInterestedMyCount} client${notInterestedMyCount === 1 ? "" : "s"} as not interested.`}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {isAdmin && notInterestedByUser.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {notInterestedByUser.map((score) => (
                    <span
                      key={score.user_id}
                      className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-200"
                    >
                      {score.user_label}: {score.placed_count} client
                      {score.placed_count === 1 ? "" : "s"}
                    </span>
                  ))}
                </div>
              )}
              {!isAdmin && notInterestedMyCount > 0 && (
                <p className="text-xs text-rose-300/90 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2">
                  You marked {notInterestedMyCount} client
                  {notInterestedMyCount === 1 ? "" : "s"} as not interested.
                </p>
              )}
              {lifecycleLoading && notInterestedActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading not interested activity…</p>
              ) : notInterestedActivityRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No Not interested clients activity yet. Mark a call as Not interested in
                  post-call remarks — the client appears in the Not interested clients table.
                </p>
              ) : (
                <ul className="divide-y divide-slate-800 max-h-[32rem] overflow-y-auto">
                  {notInterestedActivityRows.map((row) => (
                    <li key={row.id} className="py-3 px-1">
                      <p className="text-sm text-slate-100">{row.message}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        {row.user_label}
                        {row.company_name ? ` · ${row.company_name}` : ""}
                        {row.created_at
                          ? ` · ${new Date(row.created_at).toLocaleString()}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : stageFilter === "quotation_sent" ? (
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Quotation sent — meeting{" "}
                    <span className="text-emerald-400/90">({quotationSentTotal})</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Clients with quotation sent. Default is{" "}
                    <span className="text-slate-400">Meeting not scheduled</span>. Schedule a
                    date and time for a reminder 15 minutes before; when the meeting is complete,
                    select <span className="text-slate-400">Meeting done</span> to move the client
                    to Negotiation.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  value={lifecycleSearch}
                  onChange={(e) => setLifecycleSearch(e.target.value)}
                  placeholder="Search company or country…"
                  className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm"
                >
                  Search
                </button>
              </div>
              {lifecycleLoading && quotationSentRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading quotation sent clients…</p>
              ) : quotationSentRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No clients in Quotation Sent yet. Mark quotation as sent from the
                  Interested tab.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-800 bg-slate-950">
                        <th className="py-2 px-3">Company</th>
                        <th className="py-2 px-3">Since</th>
                        <th className="py-2 px-3 min-w-[12rem]">Meeting</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotationSentRows.map((row) => (
                        <tr
                          key={row.buyer_id}
                          className="border-b border-slate-800/60"
                        >
                          <td className="py-2 px-3 text-slate-200">
                            <div>{row.company_name}</div>
                            <div className="text-xs text-slate-500">
                              {row.country || "—"}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                            {row.stage_entered_at
                              ? new Date(row.stage_entered_at).toLocaleString()
                              : "—"}
                          </td>
                          <td className="py-2 px-3">
                            <QuotationMeetingControl
                              meetingStatus={row.meeting_status}
                              meetingAt={row.meeting_at}
                              disabled={meetingUpdatingId === row.buyer_id}
                              onStatusChange={(status) =>
                                void updateMeetingStatus(row.buyer_id, status)
                              }
                              onSchedule={(meetingAtIso) =>
                                void saveMeetingSchedule(row.buyer_id, meetingAtIso)
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : stageFilter === "negotiation" ? (
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Negotiation{" "}
                    <span className="text-emerald-400/90">({negotiationTotal})</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Clients in active negotiation. Use{" "}
                    <span className="text-emerald-400">✓</span> for Won or{" "}
                    <span className="text-rose-400">✕</span> for Lost to close the deal.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  value={lifecycleSearch}
                  onChange={(e) => setLifecycleSearch(e.target.value)}
                  placeholder="Search company or country…"
                  className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm"
                >
                  Search
                </button>
              </div>
              {lifecycleLoading && negotiationRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading negotiation clients…</p>
              ) : negotiationRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No clients in Negotiation yet. Mark{" "}
                  <span className="text-slate-400">Meeting done</span> from Quotation Sent after
                  the meeting is complete.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-800 bg-slate-950">
                        <th className="py-2 px-3">Company</th>
                        <th className="py-2 px-3">Since</th>
                        <th className="py-2 px-3 w-[8rem]">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {negotiationRows.map((row) => (
                        <tr
                          key={row.buyer_id}
                          className="border-b border-slate-800/60"
                        >
                          <td className="py-2 px-3 text-slate-200">
                            <div>{row.company_name}</div>
                            <div className="text-xs text-slate-500">
                              {row.country || "—"}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                            {row.stage_entered_at
                              ? new Date(row.stage_entered_at).toLocaleString()
                              : "—"}
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={negotiationUpdatingId === row.buyer_id}
                                onClick={() => void markNegotiationOutcome(row.buyer_id, "won")}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                                title="Mark as Won"
                                aria-label={`Mark ${row.company_name} as Won`}
                              >
                                ✓
                              </button>
                              <button
                                type="button"
                                disabled={negotiationUpdatingId === row.buyer_id}
                                onClick={() => void markNegotiationOutcome(row.buyer_id, "lost")}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
                                title="Mark as Lost"
                                aria-label={`Mark ${row.company_name} as Lost`}
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : stageFilter === "potential_clients" ? (
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">
                    Potential clients{" "}
                    <span className="text-emerald-400/90">({potentialCount})</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Scrapped Leads where both Excel company grading and AI grade are AA or
                    AAA.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lifecycleLoading}
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-violet-700 hover:bg-violet-600 disabled:opacity-50 px-3 py-1.5 text-sm"
                >
                  {lifecycleLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  value={lifecycleSearch}
                  onChange={(e) => setLifecycleSearch(e.target.value)}
                  placeholder="Search company or country…"
                  className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => void loadLifecycle()}
                  className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm"
                >
                  Search
                </button>
              </div>
              {lifecycleLoading && potentialRows.length === 0 ? (
                <p className="text-sm text-slate-500">Loading potential clients…</p>
              ) : potentialRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No Scrapped Leads currently match AA/AAA on both company grading and AI
                  grade.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-800 bg-slate-950">
                        <th className="py-2 px-3">Company</th>
                        <th className="py-2 px-3">Company grade</th>
                        <th className="py-2 px-3">AI grade</th>
                        <th className="py-2 px-3 min-w-[11rem]">Assigned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {potentialRows.map((row) => (
                        <tr
                          key={row.buyer_id}
                          className="border-b border-slate-800/60"
                        >
                          <td className="py-2 px-3 text-slate-200">
                            <div>{row.company_name}</div>
                            <div className="text-xs text-slate-500">
                              {row.country || "—"}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-emerald-300/90">
                            {row.company_grade || row.company_grading || "—"}
                          </td>
                          <td className="py-2 px-3 text-emerald-300/90">
                            {row.ai_grade}
                          </td>
                          <td className="py-2 px-3">
                            <AssignedToSelect
                              value={row.assigned_to_user_id}
                              options={assigneeOptions}
                              disabled={
                                !isAdmin || assigningBuyerId === row.buyer_id
                              }
                              onChange={(userId) => {
                                void assignPotentialClient(row.buyer_id, userId);
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  value={lifecycleSearch}
                  onChange={(e) => setLifecycleSearch(e.target.value)}
                  placeholder="Search company…"
                  className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => {
                    void loadLifecycle();
                    void loadQueries(true);
                  }}
                  className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm"
                >
                  Refresh
                </button>
              </div>
              {lifecycleLoading ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : lifecycleRows.length === 0 ? (
                <p className="text-sm text-slate-500">
                  {stageFilter === "interested"
                    ? "Select the Interested tab above to see who added clients to Interested Clients."
                    : stageFilter === "not_interested"
                      ? "Select the Not Interested tab above to see who marked clients as not interested."
                      : stageFilter === "quotation_sent"
                        ? "Select Quotation Sent to schedule meetings after quotation."
                        : stageFilter === "negotiation"
                          ? "Select Negotiation to close deals as Won or Lost."
                    : "No companies in this stage yet. Move clients through Interested → Quotation Sent → Negotiation → Won/Lost using the pipeline tabs above."}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-800 bg-slate-950">
                        <th className="py-2 px-3">Company</th>
                        <th className="py-2 px-3">Stage</th>
                        <th className="py-2 px-3">Since</th>
                        <th className="py-2 px-3">History</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lifecycleRows.map((row) => (
                        <tr key={row.id} className="border-b border-slate-800/60">
                          <td className="py-2 px-3 text-slate-200">
                            <div>{row.company_name}</div>
                            <div className="text-xs text-slate-500">
                              {row.country || "—"}
                            </div>
                          </td>
                          <td className="py-2 px-3">
                            <select
                              value={row.stage}
                              onChange={(e) => void changeStage(row, e.target.value)}
                              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                            >
                              {stages.map((s) => (
                                <option key={s.key} value={s.key}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                            {row.stage_entered_at
                              ? new Date(row.stage_entered_at).toLocaleString()
                              : "—"}
                          </td>
                          <td className="py-2 px-3 text-xs text-slate-500 max-w-sm">
                            {(row.history || [])
                              .slice(-4)
                              .map((h) => {
                                const label =
                                  stages.find((s) => s.key === h.stage)?.label ||
                                  h.stage;
                                return `${label} · ${new Date(h.at).toLocaleDateString()}`;
                              })
                              .join(" → ") || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
