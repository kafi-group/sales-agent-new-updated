import { useCallback, useEffect, useRef, useState } from "react";
import {
  client,
  type PersonalizedFollowupDraft,
  type PersonalizedFollowupListResponse,
  type WhatsAppTemplate,
} from "../api/client";
import { ActionButton } from "../components/ui/ActionButton";
import {
  IconMail,
  IconRefresh,
  IconSave,
  IconSend,
  IconSparkles,
  IconWhatsApp,
  IconTelegram,
  IconX,
} from "../components/icons/AppIcons";
import { EmailBodyEditor } from "../components/EmailBodyEditor";
import { ProseInput } from "../components/ProseTextField";
import { WhatsAppTemplatePicker } from "../components/WhatsAppTemplatePicker";
import { deriveWhatsAppFromEmail } from "../utils/channelSync";

interface PersonalizedEmailsPageProps {
  onError: (message: string) => void;
  onCountChange?: (count: number) => void;
  /** When true, omit the top page title (used inside AI Mode tabs). */
  embedded?: boolean;
}

type SendChannel = "email" | "whatsapp" | "whatsapp_personal" | "all";
type SendingState = SendChannel | "telegram" | null;

const STATUS_LABELS: Record<string, string> = {
  awaiting_transcript: "Waiting for captions",
  generating: "Generating…",
  ready: "Ready to send",
  failed: "Failed",
  sent: "Sent",
  dismissed: "Dismissed",
};

const OUTCOME_LABELS: Record<string, string> = {
  interested: "Interested",
  follow_up: "Follow up",
  not_interested: "Not interested",
  not_received_call: "No answer / voicemail",
};

const CALL_CONTEXT_CLASS: Record<string, string> = {
  live_conversation: "bg-sky-500/15 text-sky-200 border-sky-500/30",
  voicemail_or_no_answer: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  negative_call: "bg-rose-500/15 text-rose-200 border-rose-500/30",
  not_interested: "bg-slate-700/60 text-slate-300 border-slate-600",
  brief_or_unclear: "bg-amber-500/15 text-amber-200 border-amber-500/30",
};

function contextClass(context: string | null | undefined): string {
  if (!context) return "bg-slate-800 text-slate-400 border-slate-700";
  return CALL_CONTEXT_CLASS[context] || "bg-slate-800 text-slate-400 border-slate-700";
}

function draftAssumesLiveCall(body: string | null | undefined): boolean {
  if (!body) return false;
  return /\b(as per our (call|conversation|discussion)|following our call|thank you for speaking with us today)\b/i.test(
    body,
  );
}

function statusClass(status: string): string {
  if (status === "ready") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (status === "generating" || status === "awaiting_transcript") {
    return "bg-amber-500/15 text-amber-200 border-amber-500/30";
  }
  if (status === "failed") return "bg-rose-500/15 text-rose-200 border-rose-500/30";
  if (status === "sent") return "bg-slate-700/60 text-slate-300 border-slate-600";
  return "bg-slate-800 text-slate-400 border-slate-700";
}

function channelSent(status: string | null | undefined): boolean {
  return status === "sent" || status === "queued";
}

export function PersonalizedEmailsPage({
  onError,
  onCountChange,
  embedded = false,
}: PersonalizedEmailsPageProps) {
  const [rows, setRows] = useState<PersonalizedFollowupDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState<SendingState>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "ready" | "sent">("active");

  const [needsTemplate, setNeedsTemplate] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [pendingWaChannel, setPendingWaChannel] = useState<SendChannel | null>(null);

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const onCountChangeRef = useRef(onCountChange);
  useEffect(() => {
    onCountChangeRef.current = onCountChange;
  }, [onCountChange]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const status = filter === "active" ? undefined : filter;
      const data: PersonalizedFollowupListResponse = await client.listPersonalizedFollowups(
        status ? { status } : {},
      );
      setRows(data.rows || []);
      onCountChangeRef.current?.(data.pending_count || 0);
      setSelectedId((prev) => {
        if (prev && (data.rows || []).some((r) => r.id === prev)) return prev;
        return (data.rows || [])[0]?.id ?? null;
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load personalized emails");
    } finally {
      setLoading(false);
    }
  }, [filter, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setSubject("");
      setEmailBody("");
      setNeedsTemplate(false);
      setPendingWaChannel(null);
      return;
    }
    setSubject(selected.subject || "");
    setEmailBody(selected.email_body || "");
    setNeedsTemplate(false);
    setPendingWaChannel(null);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- reset editor only on draft switch

  useEffect(() => {
    if (!needsTemplate) return;
    client
      .listWhatsAppTemplates(true)
      .then((rows) => {
        setTemplates(rows);
        if (rows.length > 0) setTemplateId(String(rows[0].id));
      })
      .catch(() => setTemplates([]));
  }, [needsTemplate]);

  const selectedTemplate = templates.find((t) => String(t.id) === templateId);

  useEffect(() => {
    setVariables(Array(selectedTemplate?.variable_count ?? 0).fill(""));
  }, [selectedTemplate?.id, selectedTemplate?.variable_count]);

  // WhatsApp always mirrors email — same information on both channels.
  const whatsappBody = deriveWhatsAppFromEmail(emailBody);

  // Poll while any draft is generating / waiting for captions
  useEffect(() => {
    const pending = rows.some((r) =>
      ["awaiting_transcript", "generating"].includes(r.status),
    );
    if (!pending) return;
    const id = window.setInterval(() => {
      void refresh();
    }, 8000);
    return () => window.clearInterval(id);
  }, [rows, refresh]);

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    setNotice(null);
    try {
      const updated = await client.updatePersonalizedFollowup(selected.id, {
        subject,
        email_body: emailBody,
      });
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setEmailBody(updated.email_body || emailBody);
      setNotice("Draft saved. Email and WhatsApp stay synchronized.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save draft");
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate(id: number) {
    setBusyId(id);
    setNotice(null);
    try {
      const updated = await client.regeneratePersonalizedFollowup(id);
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setNotice("Regenerating from closed captions…");
      window.setTimeout(() => void refresh(), 2500);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to regenerate");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSendTelegram() {
    if (!selected?.contact_phone) {
      onError("No phone number on this draft.");
      return;
    }
    const text = (selected.whatsapp_body || emailBody || "").trim();
    if (!text) {
      onError("Message body is empty.");
      return;
    }
    if (!window.confirm("Send via your Telegram Mobile account?")) return;
    setSending("telegram");
    setNotice(null);
    try {
      await client.sendTelegramPersonal(selected.contact_phone, text);
      setNotice(`Telegram sent to ${selected.contact_phone}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send Telegram");
    } finally {
      setSending(null);
    }
  }

  async function handleSend(
    channels: SendChannel,
    templateOpts?: {
      template_name: string;
      template_language: string;
      template_variables: string[];
    },
  ) {
    if (!selected) return;

    const labels: Record<SendChannel, string> = {
      email: "Send this message via email?",
      whatsapp: "Send via Meta Business WhatsApp?",
      whatsapp_personal: "Send via your personal WhatsApp (QR session)?",
      all: "Send via email, Meta WhatsApp, and personal WhatsApp?",
    };
    if (!templateOpts && !window.confirm(labels[channels])) return;

    setSending(channels);
    setNotice(null);
    try {
      // Don't PATCH a fully/partially sent draft — backend rejects edits after send.
      if (selected.status !== "sent") {
        await client.updatePersonalizedFollowup(selected.id, {
          subject,
          email_body: emailBody,
        });
      }
      const result = await client.sendPersonalizedFollowup(selected.id, {
        channels,
        target_email: selected.selected_email || selected.contact_email || undefined,
        ...templateOpts,
      });
      setNotice(result.message);
      setRows((prev) =>
        prev.map((r) => (r.id === result.draft.id ? result.draft : r)),
      );

      if (result.email_invalid) {
        setNotice(
          result.message ||
            "Email not sent — that address is no longer valid. Open the lead and try another email.",
        );
      }

      const waFailedNeedsTemplate =
        result.needs_whatsapp_template ||
        (!result.whatsapp_sent &&
          channels !== "email" &&
          /template/i.test(result.message || result.draft.whatsapp_send_message || ""));

      if (waFailedNeedsTemplate) {
        setNeedsTemplate(true);
        setPendingWaChannel(channels === "email" ? "whatsapp" : channels);
        setNotice(
          result.email_sent
            ? "Email sent. Outside the 24h WhatsApp window — pick an approved template below."
            : "Outside the 24h WhatsApp window — select an approved template to send.",
        );
      } else {
        setNeedsTemplate(false);
        setPendingWaChannel(null);
        await refresh();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to send";
      if (channels !== "email" && /template/i.test(message)) {
        setNeedsTemplate(true);
        setPendingWaChannel(channels === "all" ? "all" : "whatsapp");
        setNotice(
          "Outside the 24h WhatsApp window — select an approved template to send.",
        );
      } else {
        onError(message);
      }
    } finally {
      setSending(null);
    }
  }

  async function handleSendWithTemplate() {
    if (!selectedTemplate) {
      onError("Select an approved template first");
      return;
    }
    const channels = pendingWaChannel || "whatsapp";
    await handleSend(channels, {
      template_name: selectedTemplate.name,
      template_language: selectedTemplate.language,
      template_variables: variables,
    });
  }

  async function handleDismiss(id: number) {
    if (!window.confirm("Dismiss this personalized draft?")) return;
    setBusyId(id);
    try {
      await client.dismissPersonalizedFollowup(id);
      setNotice("Draft dismissed.");
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to dismiss");
    } finally {
      setBusyId(null);
    }
  }

  const emailAlreadySent = channelSent(selected?.email_send_status);
  const waAlreadySent = selected?.whatsapp_send_status === "sent";
  const waPersonalAlreadySent = selected?.whatsapp_personal_send_status === "sent";
  const canEdit = selected?.status !== "sent" || needsTemplate;
  const showSendActions =
    selected &&
    (selected.status !== "sent" ||
      needsTemplate ||
      !emailAlreadySent ||
      !waAlreadySent);

  return (
    <section className={`w-full min-w-0 ${embedded ? "space-y-4" : "space-y-6"}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          {!embedded ? (
            <h2 className="text-lg font-medium text-slate-100">Personalized Emails</h2>
          ) : null}
          <p className={`text-sm text-slate-400 max-w-2xl ${embedded ? "" : "mt-1"}`}>
            After a call is marked Interested or Follow up, a draft is built from closed
            captions. Review, then send by email, WhatsApp, or both.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as "active" | "ready" | "sent");
              setSelectedId(null);
            }}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
          >
            <option value="active">Active drafts</option>
            <option value="ready">Ready only</option>
            <option value="sent">Sent</option>
          </select>
          <ActionButton
            icon={IconRefresh}
            size="md"
            onClick={() => void refresh()}
            title="Refresh"
          >
            Refresh
          </ActionButton>
        </div>
      </div>

      {notice && (
        <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          {notice}
        </p>
      )}

      {loading && !rows.length ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !rows.length ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-10 text-center">
          <p className="text-slate-300">No personalized drafts yet</p>
          <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
            Mark a completed call as Interested or Follow up. When captions (or remarks)
            are available, a draft appears here for your review.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <ul className="space-y-1 rounded-xl border border-slate-800 bg-slate-900/40 p-2 max-h-[70vh] overflow-y-auto">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={`w-full text-left rounded-lg px-3 py-2.5 transition ${
                    selectedId === row.id
                      ? "bg-emerald-600/20 border border-emerald-500/40"
                      : "hover:bg-slate-800/80 border border-transparent"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-slate-100 truncate">
                      {row.company_name || `Buyer #${row.buyer_id}`}
                    </span>
                    <span
                      className={`shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${statusClass(row.status)}`}
                    >
                      {STATUS_LABELS[row.status] || row.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500 truncate">
                    {OUTCOME_LABELS[row.call_outcome] || row.call_outcome}
                    {row.call_context_label ? ` · ${row.call_context_label}` : ""}
                    {row.contact_name ? ` · ${row.contact_name}` : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5 space-y-4 min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-medium text-slate-100">
                    {selected.company_name || `Buyer #${selected.buyer_id}`}
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {selected.contact_name || "Contact"}
                    {selected.contact_email ? ` · ${selected.contact_email}` : " · no email"}
                    {selected.contact_phone ? ` · ${selected.contact_phone}` : " · no WhatsApp phone"}
                    {selected.country ? ` · ${selected.country}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-xs px-2 py-1 rounded border ${statusClass(selected.status)}`}
                  >
                    {STATUS_LABELS[selected.status] || selected.status}
                  </span>
                  {selected.call_context_label ? (
                    <span
                      className={`text-xs px-2 py-1 rounded border ${contextClass(selected.call_context)}`}
                    >
                      {selected.call_context_label}
                    </span>
                  ) : null}
                </div>
              </div>

              {selected.call_context &&
                ["voicemail_or_no_answer", "brief_or_unclear"].includes(selected.call_context) &&
                draftAssumesLiveCall(emailBody) && (
                  <p className="text-xs text-amber-200/95 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                    This draft reads like a live conversation, but the call was voicemail or could
                    not connect. Click <strong>Regenerate</strong> or edit before sending.
                  </p>
                )}

              {selected.call_context === "negative_call" && (
                <p className="text-xs text-slate-400 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2">
                  Captions suggest a difficult call — the draft stays professional and does not
                  repeat any hostile language.
                </p>
              )}

              {selected.generation_error && selected.status !== "ready" && (
                <p className="text-xs text-amber-200/90">{selected.generation_error}</p>
              )}

              {selected.transcript_excerpt && (
                <details className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <summary className="cursor-pointer text-xs text-slate-400">
                    Conversation excerpt (captions / remarks)
                  </summary>
                  <p className="mt-2 text-xs text-slate-400 whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {selected.transcript_excerpt}
                  </p>
                </details>
              )}

              <label className="block space-y-1.5">
                <span className="text-xs text-slate-400">Email subject</span>
                <ProseInput
                  value={subject}
                  onChange={setSubject}
                  disabled={!canEdit || selected.status === "sent"}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                />
              </label>

              <div className="block space-y-1.5">
                <span className="text-xs text-slate-400">
                  Message (email + WhatsApp free-text — same information)
                </span>
                <EmailBodyEditor
                  value={emailBody}
                  onChange={setEmailBody}
                  disabled={!canEdit || selected.status === "sent"}
                  rows={10}
                  placeholder="Write the message…"
                />
              </div>

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 space-y-1.5">
                <p className="text-xs text-emerald-300/90">
                  WhatsApp preview (locked to the message above — free-text inside the 24h
                  window; outside that window use an approved template below)
                </p>
                <pre className="whitespace-pre-wrap break-words text-sm text-slate-300 font-sans m-0 max-h-36 overflow-y-auto">
                  {whatsappBody || "—"}
                </pre>
              </div>

              {(selected.email_send_status || selected.whatsapp_send_status) && (
                <div className="text-xs text-slate-400 space-y-1">
                  {selected.email_send_status && (
                    <p>
                      Email: {selected.email_send_status}
                      {selected.email_send_message ? ` — ${selected.email_send_message}` : ""}
                    </p>
                  )}
                  {selected.whatsapp_send_status && (
                    <p>
                      WhatsApp: {selected.whatsapp_send_status}
                      {selected.whatsapp_send_message
                        ? ` — ${selected.whatsapp_send_message}`
                        : ""}
                    </p>
                  )}
                </div>
              )}

              {needsTemplate && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-sm text-amber-200">
                    Outside the 24h WhatsApp reply window — select an approved template to
                    send instead of free text.
                  </p>
                  <WhatsAppTemplatePicker
                    templates={templates}
                    loading={false}
                    templateId={templateId}
                    onTemplateIdChange={(id) => setTemplateId(id)}
                    search={templateSearch}
                    onSearchChange={setTemplateSearch}
                    variables={variables}
                    onVariablesChange={setVariables}
                    leadContext={
                      selected
                        ? {
                            company_name: selected.company_name,
                            contact_name: selected.contact_name,
                            country: selected.country,
                          }
                        : null
                    }
                  />
                  <ActionButton
                    icon={IconWhatsApp}
                    variant="primary"
                    size="md"
                    onClick={() => void handleSendWithTemplate()}
                    disabled={!!sending || !selectedTemplate}
                    title="Send WhatsApp with template"
                  >
                    {sending ? "Sending…" : "Send with template"}
                  </ActionButton>
                </div>
              )}

              {showSendActions && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <ActionButton
                    icon={IconSave}
                    size="md"
                    onClick={() => void handleSave()}
                    disabled={saving || selected.status === "sent"}
                    title="Save edits"
                  >
                    {saving ? "Saving…" : "Save"}
                  </ActionButton>
                  <ActionButton
                    icon={IconSparkles}
                    size="md"
                    onClick={() => void handleRegenerate(selected.id)}
                    disabled={busyId === selected.id || selected.status === "sent"}
                    title="Regenerate from captions"
                  >
                    Regenerate
                  </ActionButton>
                  {!emailAlreadySent && (
                    <ActionButton
                      icon={IconMail}
                      size="md"
                      onClick={() => void handleSend("email")}
                      disabled={
                        !!sending ||
                        !subject.trim() ||
                        !emailBody.trim() ||
                        selected.status === "generating"
                      }
                      title="Send email only"
                    >
                      {sending === "email" ? "Sending…" : "Send email"}
                    </ActionButton>
                  )}
                  {!waAlreadySent && (
                    <ActionButton
                      icon={IconWhatsApp}
                      size="md"
                      onClick={() => void handleSend("whatsapp")}
                      disabled={
                        !!sending ||
                        !emailBody.trim() ||
                        selected.status === "generating" ||
                        !selected.contact_phone
                      }
                      title="Send via Meta Business WhatsApp (templates / 24h window)"
                    >
                      {sending === "whatsapp" ? "Sending…" : "WhatsApp Meta"}
                    </ActionButton>
                  )}
                  {!waPersonalAlreadySent && (
                    <ActionButton
                      icon={IconWhatsApp}
                      size="md"
                      onClick={() => void handleSend("whatsapp_personal")}
                      disabled={
                        !!sending ||
                        !emailBody.trim() ||
                        selected.status === "generating" ||
                        !selected.contact_phone
                      }
                      title="Send from your mobile WhatsApp account (scan QR code in WhatsApp Mobile module)"
                    >
                      {sending === "whatsapp_personal" ? "Sending…" : "WhatsApp Mobile"}
                    </ActionButton>
                  )}
                  <ActionButton
                    icon={IconTelegram}
                    size="md"
                    onClick={() => void handleSendTelegram()}
                    disabled={
                      !!sending ||
                      !emailBody.trim() ||
                      selected.status === "generating" ||
                      !selected.contact_phone
                    }
                    title="Send via your Telegram Mobile account"
                  >
                    {sending === "telegram" ? "Sending…" : "Telegram"}
                  </ActionButton>
                  {!emailAlreadySent && !waAlreadySent && !waPersonalAlreadySent && (
                    <ActionButton
                      icon={IconSend}
                      variant="primary"
                      size="md"
                      onClick={() => void handleSend("all")}
                      disabled={
                        !!sending ||
                        !subject.trim() ||
                        !emailBody.trim() ||
                        selected.status === "generating"
                      }
                      title="Send email + Meta WhatsApp + Personal WhatsApp"
                    >
                      {sending === "all" ? "Sending…" : "Send all 3"}
                    </ActionButton>
                  )}
                  {selected.status !== "sent" && (
                    <ActionButton
                      icon={IconX}
                      variant="rose"
                      size="md"
                      onClick={() => void handleDismiss(selected.id)}
                      disabled={busyId === selected.id}
                      title="Dismiss"
                    >
                      Dismiss
                    </ActionButton>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500 p-4">Select a draft to review.</p>
          )}
        </div>
      )}
    </section>
  );
}
