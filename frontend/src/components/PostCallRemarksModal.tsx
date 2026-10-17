import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type EmailAttachment,
  type PersonalizedFollowupDraft,
  type WhatsAppTemplate,
} from "../api/client";
import { useCallQueueOptional } from "../hooks/useCallQueue";
import { useTwilioVoice } from "../hooks/useTwilioVoice";
import { type CallOutcome, callOutcomeSectionHint } from "../utils/callOutcomes";
import { deriveWhatsAppFromEmail } from "../utils/channelSync";
import { FOLLOWUP_LANGUAGES } from "../utils/followupLanguages";
import { autocorrectText } from "../utils/spelling";
import { CallRemarksForm } from "./CallRemarksForm";
import { EmailAttachmentsField } from "./EmailAttachmentsField";
import { TryAnotherNumberButtons } from "./TryAnotherNumberButtons";
import { WhatsAppTemplatePicker } from "./WhatsAppTemplatePicker";
import { ActionButton } from "./ui/ActionButton";
import { IconWhatsApp, IconX } from "./icons/AppIcons";

interface PostCallRemarksModalProps {
  onError: (message: string) => void;
  onSaved?: (outcome: string | null | undefined) => void;
}

export function PostCallRemarksModal({ onError, onSaved }: PostCallRemarksModalProps) {
  const { pendingFollowUp, clearPendingFollowUp, clearLeadDialSession, bulkModeActive } =
    useTwilioVoice();
  const callQueue = useCallQueueOptional();
  const bulkOwnsFollowUp =
    bulkModeActive &&
    callQueue != null &&
    (callQueue.status === "running" || callQueue.status === "between");
  const [remarks, setRemarks] = useState("");
  const [outcome, setOutcome] = useState<CallOutcome | "">("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<PersonalizedFollowupDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [sendingChannel, setSendingChannel] = useState<string | null>(null);
  const [step, setStep] = useState<"remarks" | "confirm">("remarks");
  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [waTemplates, setWaTemplates] = useState<WhatsAppTemplate[]>([]);
  const [waTemplatesLoading, setWaTemplatesLoading] = useState(false);
  const [waTemplateId, setWaTemplateId] = useState("");
  const [waTemplateSearch, setWaTemplateSearch] = useState("");
  const [waTemplateVariables, setWaTemplateVariables] = useState<string[]>([]);
  const [needsWaTemplate, setNeedsWaTemplate] = useState(false);
  const [selectedPhone, setSelectedPhone] = useState("");
  const [customPhone, setCustomPhone] = useState("");
  const [selectedEmail, setSelectedEmail] = useState("");
  const [customEmail, setCustomEmail] = useState("");
  const [invalidEmails, setInvalidEmails] = useState<string[]>([]);
  const [addingEmail, setAddingEmail] = useState(false);
  const [whatsappBody, setWhatsappBody] = useState("");
  const [waBodyCustomized, setWaBodyCustomized] = useState(false);
  const [draftLanguage, setDraftLanguage] = useState("en");
  const [englishSnapshot, setEnglishSnapshot] = useState<{
    subject: string;
    email: string;
    whatsapp: string;
  } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcriptText, setTranscriptText] = useState("");
  const [transcriptStatus, setTranscriptStatus] = useState<string | null>(null);
  const [recordingAvailable, setRecordingAvailable] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [trainSaraRayan, setTrainSaraRayan] = useState(false);
  const [trainSaving, setTrainSaving] = useState(false);

  useEffect(() => {
    if (!pendingFollowUp) return;
    setRemarks("");
    setOutcome("");
    setDraft(null);
    setSubject("");
    setEmailBody("");
    setWhatsappBody("");
    setWaBodyCustomized(false);
    setAttachments([]);
    setSelectedPhone("");
    setCustomPhone("");
    setSelectedEmail("");
    setCustomEmail("");
    setInvalidEmails([]);
    setDraftNotice(null);
    setStep("remarks");
    setWaTemplateId("");
    setWaTemplateSearch("");
    setWaTemplateVariables([]);
    setNeedsWaTemplate(false);
    setDraftLanguage("en");
    setEnglishSnapshot(null);
    setShowTranscript(true);
    setTranscriptText("");
    setTranscriptStatus(null);
    setRecordingAvailable(false);
    setTrainSaraRayan(false);
  }, [pendingFollowUp]);

  useEffect(() => {
    if (!pendingFollowUp || step !== "remarks") return;
    let cancelled = false;
    void (async () => {
      try {
        const call = await client.getCallHistoryItem(pendingFollowUp.interactionId);
        if (cancelled) return;
        setTranscriptText(call.transcript || "");
        setTranscriptStatus(call.transcript_status || null);
        setRecordingAvailable(Boolean(call.recording_available));
        setTrainSaraRayan(Boolean(call.ai_training_selected));
      } catch {
        /* recording may not be ready yet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingFollowUp?.interactionId, step]);
  useEffect(() => {
    if (step !== "confirm") return;
    let cancelled = false;
    setWaTemplatesLoading(true);
    client
      .listWhatsAppTemplates(true)
      .then((rows) => {
        if (cancelled) return;
        setWaTemplates(rows);
        setWaTemplateId((current) => {
          if (current && rows.some((t) => String(t.id) === current)) return current;
          return rows.length > 0 ? String(rows[0].id) : "";
        });
      })
      .catch(() => {
        if (!cancelled) setWaTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setWaTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const selectedWaTemplate = waTemplates.find((t) => String(t.id) === waTemplateId);

  useEffect(() => {
    const count = selectedWaTemplate?.variable_count ?? 0;
    setWaTemplateVariables((prev) => {
      if (prev.length === count) return prev;
      const next = Array(count).fill("");
      for (let i = 0; i < Math.min(prev.length, count); i += 1) {
        next[i] = prev[i];
      }
      return next;
    });
  }, [selectedWaTemplate?.id, selectedWaTemplate?.variable_count]);

  useEffect(() => {
    if (!draft) return;
    setSubject(draft.subject || "");
    const email = draft.email_body || "";
    setEmailBody(email);
    const wa = draft.whatsapp_body || deriveWhatsAppFromEmail(email);
    setWhatsappBody(wa);
    setWaBodyCustomized(
      Boolean(draft.whatsapp_body && draft.whatsapp_body !== deriveWhatsAppFromEmail(email)),
    );
    setAttachments([]);
    setEnglishSnapshot({
      subject: draft.subject || "",
      email,
      whatsapp: wa,
    });
    setDraftLanguage("en");
    setTrainSaraRayan(Boolean(draft.ai_training_selected));
    if (draft.selected_phone) {
      setSelectedPhone(draft.selected_phone);
    } else if (draft.available_phones && draft.available_phones.length > 0) {
      setSelectedPhone(draft.available_phones[0].phone);
    } else if (draft.contact_phone) {
      setSelectedPhone(draft.contact_phone);
    }
    if (draft.selected_email) {
      setSelectedEmail(draft.selected_email);
    } else if (draft.available_emails && draft.available_emails.length > 0) {
      setSelectedEmail(draft.available_emails[0].email);
    } else if (draft.contact_email) {
      setSelectedEmail(draft.contact_email);
    }
  }, [draft?.id]);

  if (!pendingFollowUp || bulkOwnsFollowUp) return null;

  async function loadDraft(interactionId: number, attempt = 0) {
    setDraftLoading(true);
    try {
      const row = await client.getPersonalizedFollowupByInteraction(interactionId);
      setDraft(row);
      setStep("confirm");
      return;
    } catch {
      if (attempt < 4) {
        window.setTimeout(() => void loadDraft(interactionId, attempt + 1), 800);
        return;
      }
      setStep("confirm");
    } finally {
      setDraftLoading(false);
    }
  }

  async function saveRemarks() {
    if (!pendingFollowUp) return;
    setSaving(true);
    setDraftNotice(null);
    try {
      await client.updateCallFollowUp(pendingFollowUp.interactionId, {
        notes: autocorrectText(remarks, "prose"),
        call_outcome: outcome || null,
      });
      onSaved?.(outcome || null);
      clearLeadDialSession();
      void loadDraft(pendingFollowUp.interactionId);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save call remarks");
    } finally {
      setSaving(false);
    }
  }

  async function saveDraftEdits(showNotice = true) {
    if (!draft) return false;
    setSavingDraft(true);
    setDraftNotice(null);
    try {
      const updated = await client.updatePersonalizedFollowup(draft.id, {
        subject,
        email_body: emailBody,
        whatsapp_body: whatsappBody,
      });
      setDraft(updated);
      setSubject(updated.subject || subject);
      setEmailBody(updated.email_body || emailBody);
      setWhatsappBody(updated.whatsapp_body || whatsappBody);
      if (showNotice) {
        setDraftNotice("Draft saved successfully.");
      }
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save draft");
      return false;
    } finally {
      setSavingDraft(false);
    }
  }

  async function applyDraftLanguage(nextLang: string) {
    if (!draft) return;
    const prev = draftLanguage;
    setDraftLanguage(nextLang);
    if (nextLang === "en") {
      if (englishSnapshot) {
        setSubject(englishSnapshot.subject);
        setEmailBody(englishSnapshot.email);
        setWhatsappBody(englishSnapshot.whatsapp);
        setWaBodyCustomized(false);
      }
      setDraftNotice("Restored English draft.");
      return;
    }
    setTranslating(true);
    setDraftNotice(null);
    try {
      const source = englishSnapshot || {
        subject,
        email: emailBody,
        whatsapp: whatsappBody,
      };
      if (!englishSnapshot) {
        setEnglishSnapshot(source);
      }
      const translated = await client.translatePersonalizedFollowup(draft.id, {
        language: nextLang,
        subject: source.subject,
        email_body: source.email,
        whatsapp_body: source.whatsapp,
      });
      setSubject(translated.subject);
      setEmailBody(translated.email_body);
      setWhatsappBody(translated.whatsapp_body);
      setWaBodyCustomized(false);
      setDraftNotice(`Translated to ${translated.language_label}. Review before sending.`);
    } catch (e) {
      setDraftLanguage(prev);
      onError(e instanceof Error ? e.message : "Translation failed");
    } finally {
      setTranslating(false);
    }
  }

  async function refreshTranscript() {
    const interactionId = pendingFollowUp?.interactionId ?? draft?.interaction_id;
    if (!interactionId) return;
    try {
      const call = await client.getCallHistoryItem(interactionId);
      setTranscriptText(call.transcript || "");
      setTranscriptStatus(call.transcript_status || null);
      setRecordingAvailable(Boolean(call.recording_available));
      setTrainSaraRayan(Boolean(call.ai_training_selected));
      if (call.transcript) setShowTranscript(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load transcription");
    }
  }

  async function generateTranscript() {
    const interactionId = pendingFollowUp?.interactionId ?? draft?.interaction_id;
    if (!interactionId) return;
    setTranscribing(true);
    try {
      const call = await client.transcribeCall(interactionId, true);
      setTranscriptText(call.transcript || "");
      setTranscriptStatus(call.transcript_status || null);
      setRecordingAvailable(Boolean(call.recording_available));
      if (call.transcript) setShowTranscript(true);
      else
        setDraftNotice(
          call.transcript_error || "Captions are still generating — try again shortly.",
        );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to generate closed captions");
    } finally {
      setTranscribing(false);
    }
  }

  async function toggleTrainSaraRayan(next: boolean) {
    if (!draft?.interaction_id) return;
    setTrainSaving(true);
    try {
      const call = await client.setCallTrainingFlag(draft.interaction_id, next);
      setTrainSaraRayan(Boolean(call.ai_training_selected));
      setDraft((prev) =>
        prev ? { ...prev, ai_training_selected: Boolean(call.ai_training_selected) } : prev,
      );
      setDraftNotice(
        next
          ? "Marked for Sara & Rayan training (recording + captions will be used)."
          : "Removed from Sara & Rayan training set.",
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update training flag");
    } finally {
      setTrainSaving(false);
    }
  }

  async function sendDraft(channels: "email" | "whatsapp" | "whatsapp_personal" | "all") {
    if (!draft) return;
    const wantsWaMeta = channels === "whatsapp" || channels === "all";
    const wantsEmail = channels === "email" || channels === "all";
    if (wantsWaMeta && needsWaTemplate && !selectedWaTemplate) {
      onError("Select an approved Meta template for WhatsApp Business send.");
      return;
    }
    const emailTarget = (selectedEmail || customEmail || "").trim();
    if (wantsEmail && !emailTarget) {
      onError("Select or add an email address before sending.");
      return;
    }
    if (wantsEmail && isEmailMarkedInvalid(emailTarget)) {
      onError("That email was marked invalid. Choose another address or add a new one.");
      return;
    }
    const useWaTemplate = wantsWaMeta && Boolean(selectedWaTemplate);
    setSendingChannel(channels);
    setDraftNotice(null);
    try {
      const saved = await saveDraftEdits(false);
      if (!saved) return;
      const result = await client.sendPersonalizedFollowup(draft.id, {
        channels,
        target_phone: selectedPhone.trim() || undefined,
        target_email: wantsEmail ? emailTarget : undefined,
        subject,
        email_body: emailBody,
        whatsapp_body: whatsappBody,
        attachments: channels === "email" || channels === "all" ? attachments : undefined,
        ...(useWaTemplate
          ? {
              template_name: selectedWaTemplate!.name,
              template_language: selectedWaTemplate!.language,
              template_variables: waTemplateVariables,
            }
          : {}),
      });
      setDraft(result.draft);
      if (result.draft.available_emails?.length) {
        // Keep picker in sync with server list (e.g. after add).
      }

      const waFailedNeedsTemplate =
        result.needs_whatsapp_template ||
        (!result.whatsapp_sent &&
          channels !== "email" &&
          /template/i.test(result.message || result.draft.whatsapp_send_message || ""));

      if (result.email_invalid && result.failed_email) {
        const failed = result.failed_email.trim().toLowerCase();
        setInvalidEmails((prev) => (prev.includes(failed) ? prev : [...prev, failed]));
        const nextEmails = (result.available_emails || result.draft.available_emails || []).filter(
          (e) => e.email.trim().toLowerCase() !== failed && !isEmailMarkedInvalid(e.email, [...invalidEmails, failed]),
        );
        if (nextEmails.length > 0) {
          setSelectedEmail(nextEmails[0].email);
          setCustomEmail("");
          setDraftNotice(
            `Email not sent — ${result.failed_email} is no longer valid or does not exist. Try another email below.`,
          );
        } else {
          setSelectedEmail("");
          setDraftNotice(
            "All listed emails are invalid or do not exist. Add a new email address below to continue.",
          );
        }
        return;
      }

      if (waFailedNeedsTemplate) {
        setNeedsWaTemplate(true);
        setDraftNotice(
          result.email_sent
            ? "Email sent. Outside the 24h WhatsApp window — confirm the approved template below and send again."
            : "Outside the 24h WhatsApp window — select an approved template and send WhatsApp Meta again.",
        );
      } else {
        setNeedsWaTemplate(false);
        setDraftNotice(result.message);
        if (wantsEmail) {
          if (result.email_sent) {
            clearLeadDialSession();
            window.setTimeout(() => clearPendingFollowUp(), 900);
          }
        } else if (result.whatsapp_sent) {
          clearLeadDialSession();
          window.setTimeout(() => clearPendingFollowUp(), 1200);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to send confirmation";
      if ((channels === "whatsapp" || channels === "all") && /template/i.test(message)) {
        setNeedsWaTemplate(true);
        setDraftNotice("Outside the 24h WhatsApp window — select an approved template and retry.");
      } else {
        onError(message);
      }
    } finally {
      setSendingChannel(null);
    }
  }

  function normalizeEmailKey(value: string) {
    return value.trim().toLowerCase();
  }

  function isEmailMarkedInvalid(value: string, list: string[] = invalidEmails) {
    const key = normalizeEmailKey(value);
    return Boolean(key) && list.includes(key);
  }

  async function addNewEmailToContact() {
    if (!draft?.contact_id) {
      onError("No contact on this draft — cannot save a new email.");
      return;
    }
    const next = customEmail.trim();
    if (!next || !next.includes("@")) {
      onError("Enter a valid email address.");
      return;
    }
    if (isEmailMarkedInvalid(next)) {
      onError("That address was already marked invalid.");
      return;
    }
    setAddingEmail(true);
    setDraftNotice(null);
    try {
      const listed = draft.available_emails || [];
      const hasPrimary = listed.some((e) => e.is_primary) || Boolean(draft.contact_email);
      const hasSecondary = listed.some((e) => !e.is_primary && e.label.toLowerCase().includes("secondary"));
      if (!hasPrimary) {
        await client.updateContact(draft.contact_id, { email: next });
      } else if (!hasSecondary) {
        await client.updateContact(draft.contact_id, { secondary_email: next });
      }
      // Always allow sending to the new address even if both slots were already filled.
      setSelectedEmail(next);
      setCustomEmail("");
      setDraft((prev) => {
        if (!prev) return prev;
        const exists = (prev.available_emails || []).some(
          (e) => normalizeEmailKey(e.email) === normalizeEmailKey(next),
        );
        if (exists) return prev;
        return {
          ...prev,
          available_emails: [
            ...(prev.available_emails || []),
            {
              email: next,
              label: hasPrimary ? (hasSecondary ? "New Email" : "Secondary Email") : "Primary Email",
              contact_id: prev.contact_id,
              is_primary: !hasPrimary,
            },
          ],
          selected_email: next,
          contact_email: hasPrimary ? prev.contact_email : next,
        };
      });
      setDraftNotice("New email added. Click Send email to try again.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add email");
    } finally {
      setAddingEmail(false);
    }
  }

  function dismiss() {
    clearLeadDialSession();
    clearPendingFollowUp();
  }

  const availablePhones = draft?.available_phones || [];
  const selectedPhoneObj = availablePhones.find((p) => p.phone === selectedPhone);
  const availableEmails = draft?.available_emails || [];
  const allEmailsExhausted =
    availableEmails.length > 0 &&
    availableEmails.every((e) => isEmailMarkedInvalid(e.email)) &&
    (!selectedEmail || isEmailMarkedInvalid(selectedEmail));
  const busy = Boolean(sendingChannel) || savingDraft || translating || trainSaving || addingEmail;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="post-call-title"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4">
        <h3 id="post-call-title" className="text-lg font-medium text-slate-100">
          {step === "remarks"
            ? "Call remarks & outcome"
            : `Follow-up draft — ${draft?.company_name || "Lead"}`}
        </h3>

        {step === "remarks" ? (
          <>
            {pendingFollowUp.buyerId ? (
              <TryAnotherNumberButtons
                buyerId={pendingFollowUp.buyerId}
                triedPhones={pendingFollowUp.triedPhones ?? []}
                onError={onError}
                disabled={saving}
              />
            ) : null}

            <div className="rounded-xl border border-slate-700/80 bg-slate-950/50 p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={saving || transcribing}
                  onClick={() => {
                    setShowTranscript((v) => !v);
                    if (!showTranscript && !transcriptText) void refreshTranscript();
                  }}
                  className="rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-slate-100"
                >
                  {showTranscript ? "Hide transcription" : "View transcription / closed captions"}
                </button>
                {(recordingAvailable ||
                  transcriptStatus === "pending" ||
                  transcriptStatus === "processing" ||
                  transcriptStatus === "ready" ||
                  Boolean(transcriptText)) && (
                  <button
                    type="button"
                    disabled={saving || transcribing}
                    onClick={() => void generateTranscript()}
                    className="rounded-lg border border-sky-700/60 bg-sky-950/40 hover:bg-sky-900/50 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-sky-200"
                  >
                    {transcribing ? "Generating captions…" : "Generate / refresh captions"}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                Status: {transcriptStatus || (recordingAvailable ? "pending" : "no recording yet")}
              </p>
              {showTranscript ? (
                <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 max-h-48 overflow-y-auto">
                  {transcriptText ? (
                    <pre className="whitespace-pre-wrap text-xs text-slate-200 font-sans leading-relaxed">
                      {transcriptText}
                    </pre>
                  ) : (
                    <p className="text-xs text-amber-200/90">
                      No closed captions yet. Generate captions (needs a call recording), then write
                      remarks from what was discussed.
                    </p>
                  )}
                </div>
              ) : null}
              {draftNotice && step === "remarks" ? (
                <p className="text-xs text-amber-200/90">{draftNotice}</p>
              ) : null}
            </div>

            <CallRemarksForm
              remarks={remarks}
              outcome={outcome}
              onRemarksChange={setRemarks}
              onOutcomeChange={setOutcome}
              onSave={() => void saveRemarks()}
              saving={saving}
              saveLabel="Save & generate draft"
              compact
            />
            {outcome ? (
              <p className="text-xs text-slate-400">
                Next list:{" "}
                <span className="text-slate-200">{callOutcomeSectionHint(outcome)}</span>
              </p>
            ) : null}
            <ActionButton
              icon={IconX}
              variant="ghost"
              size="sm"
              onClick={dismiss}
              title="Skip for now"
              className="text-slate-400"
            >
              Skip for now
            </ActionButton>
          </>
        ) : (
          <>
            {draftLoading ? (
              <p className="text-sm text-slate-400 animate-pulse">Preparing email & WhatsApp drafts…</p>
            ) : draft?.status === "ready" || draft?.status === "sent" ? (
              <div className="space-y-4">
                {draft.call_context_label ? (
                  <p className="text-xs text-slate-400">
                    Draft tone:{" "}
                    <span className="text-slate-200">{draft.call_context_label}</span>
                  </p>
                ) : null}

                <div className="rounded-xl border border-slate-700/80 bg-slate-950/50 p-3 space-y-3">
                  <label className="block">
                    <span className="text-xs text-slate-400">Recipient language (email & WhatsApp)</span>
                    <select
                      value={draftLanguage}
                      disabled={busy}
                      onChange={(e) => void applyDraftLanguage(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
                    >
                      {FOLLOWUP_LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.code}>
                          {lang.label}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[11px] text-slate-500">
                      {translating
                        ? "Translating…"
                        : "Translate the AI draft into the buyer’s local language before sending."}
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={trainSaraRayan}
                      disabled={busy}
                      onChange={(e) => void toggleTrainSaraRayan(e.target.checked)}
                      className="mt-0.5 rounded border-slate-600 bg-slate-900 text-violet-500 focus:ring-violet-500"
                    />
                    <span className="text-xs text-slate-300 leading-snug">
                      <span className="font-semibold text-violet-200">Train Sara &amp; Rayan</span>
                      <span className="block text-slate-500 mt-0.5">
                        Tick only good calls. Their recording + captions feed curated training (not
                        every no-answer / bad call).
                      </span>
                    </span>
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs text-slate-400">Email subject</span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-400">Email message</span>
                  <textarea
                    rows={8}
                    value={emailBody}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEmailBody(val);
                      if (!waBodyCustomized) {
                        setWhatsappBody(deriveWhatsAppFromEmail(val));
                      }
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                  />
                </label>

                <div className="rounded-xl border border-slate-700/80 bg-slate-950/60 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">Target email</span>
                    {invalidEmails.length > 0 ? (
                      <span className="text-[11px] text-rose-300">
                        {invalidEmails.length} invalid — try another
                      </span>
                    ) : null}
                  </div>

                  {availableEmails.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {availableEmails.map((e) => {
                        const invalid = isEmailMarkedInvalid(e.email);
                        const isSelected =
                          !invalid && normalizeEmailKey(selectedEmail) === normalizeEmailKey(e.email);
                        return (
                          <label
                            key={`${e.email}-${e.label}`}
                            onClick={() => {
                              if (invalid) return;
                              setSelectedEmail(e.email);
                              setCustomEmail("");
                            }}
                            className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs transition ${
                              invalid
                                ? "border-rose-700/70 bg-rose-950/40 text-rose-200 cursor-not-allowed opacity-90"
                                : isSelected
                                  ? "border-sky-500 bg-sky-950/30 text-slate-100 shadow-sm cursor-pointer"
                                  : "border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700 cursor-pointer"
                            }`}
                          >
                            <input
                              type="radio"
                              name="target_email"
                              disabled={invalid}
                              checked={isSelected}
                              onChange={() => {
                                if (invalid) return;
                                setSelectedEmail(e.email);
                                setCustomEmail("");
                              }}
                              className="mt-0.5 text-sky-500 focus:ring-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 font-medium">
                                <span className="truncate">{e.label}</span>
                                {invalid ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-900/70 text-rose-200 border border-rose-700/60">
                                    No longer valid
                                  </span>
                                ) : e.is_primary ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-300 border border-sky-700/50">
                                    Primary
                                  </span>
                                ) : null}
                              </div>
                              <p
                                className={`font-mono text-[11px] mt-0.5 truncate ${
                                  invalid ? "text-rose-300 line-through" : "text-slate-400"
                                }`}
                              >
                                {e.email}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-amber-300/90">
                      No email on file for this contact. Add one below.
                    </p>
                  )}

                  {(allEmailsExhausted || availableEmails.length === 0 || invalidEmails.length > 0) && (
                    <p className="text-xs text-amber-200/90 rounded-lg bg-amber-950/40 border border-amber-800/50 px-2.5 py-1.5">
                      {allEmailsExhausted ||
                      (availableEmails.length > 0 &&
                        availableEmails.every((e) => isEmailMarkedInvalid(e.email)))
                        ? "All current emails are invalid or do not exist. Add a new email to continue."
                        : invalidEmails.length > 0
                          ? "Select another email above, or add a new one if needed."
                          : "Enter an email address to send this follow-up."}
                    </p>
                  )}

                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1 border-t border-slate-800/80">
                    <input
                      type="email"
                      value={customEmail}
                      onChange={(e) => setCustomEmail(e.target.value)}
                      placeholder="Add another email…"
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                    />
                    <button
                      type="button"
                      disabled={busy || !customEmail.trim()}
                      onClick={() => {
                        const next = customEmail.trim();
                        if (!next) return;
                        if (draft?.contact_id) {
                          void addNewEmailToContact();
                        } else {
                          setSelectedEmail(next);
                          setDraftNotice("Using this email for send. Save it on the contact later if needed.");
                        }
                      }}
                      className="rounded-lg border border-sky-700/60 bg-sky-950/50 hover:bg-sky-900/50 disabled:opacity-50 px-3 py-2 text-sm font-medium text-sky-100 whitespace-nowrap"
                    >
                      {addingEmail ? "Adding…" : "Add & use"}
                    </button>
                  </div>
                </div>

                <EmailAttachmentsField
                  attachments={attachments}
                  onChange={setAttachments}
                  disabled={busy}
                  label="Email attachments"
                  hint="Optional — PDF, images, Excel, etc. Included when you send email."
                />

                <div className="rounded-xl border border-slate-700/80 bg-slate-950/60 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <IconWhatsApp size="sm" className="text-emerald-400" />
                      Target WhatsApp Recipient
                    </span>
                    {selectedPhoneObj && (
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                          selectedPhoneObj.is_landline
                            ? "bg-amber-950/70 text-amber-300 border border-amber-800/60"
                            : "bg-emerald-950/70 text-emerald-300 border border-emerald-800/60"
                        }`}
                      >
                        {selectedPhoneObj.is_landline ? "⚠️ Landline (No WhatsApp)" : "🟢 WhatsApp Mobile"}
                      </span>
                    )}
                  </div>

                  {availablePhones.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {availablePhones.map((p) => {
                        const isSelected = selectedPhone === p.phone;
                        return (
                          <label
                            key={p.phone}
                            onClick={() => {
                              setSelectedPhone(p.phone);
                              setCustomPhone("");
                            }}
                            className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                              isSelected
                                ? "border-emerald-500 bg-emerald-950/30 text-slate-100 shadow-sm"
                                : "border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700"
                            }`}
                          >
                            <input
                              type="radio"
                              name="target_phone"
                              checked={isSelected}
                              onChange={() => {
                                setSelectedPhone(p.phone);
                                setCustomPhone("");
                              }}
                              className="mt-0.5 text-emerald-500 focus:ring-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 font-medium">
                                <span className="truncate">{p.label}</span>
                                {p.is_dialed && (
                                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-sky-900/60 text-sky-300 border border-sky-700/50">
                                    Dialed
                                  </span>
                                )}
                              </div>
                              <p className="text-slate-400 font-mono text-[11px] mt-0.5 truncate">
                                {p.phone}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}

                  {selectedPhoneObj?.is_landline && (
                    <p className="text-xs text-amber-300/90 rounded-lg bg-amber-950/40 border border-amber-800/50 px-2.5 py-1.5">
                      ⚠️ <strong>Landline selected:</strong> WhatsApp cannot deliver messages to
                      landlines. Please select a mobile number above or enter one below.
                    </p>
                  )}

                  <div className="flex items-center gap-2 pt-1 border-t border-slate-800/80">
                    <span className="text-[11px] text-slate-400 shrink-0">Other number:</span>
                    <input
                      type="text"
                      placeholder="e.g. +971501234567"
                      value={customPhone}
                      onChange={(e) => {
                        setCustomPhone(e.target.value);
                        if (e.target.value.trim()) {
                          setSelectedPhone(e.target.value.trim());
                        }
                      }}
                      className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                </div>

                <label className="block">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      WhatsApp message {waBodyCustomized ? "(customized)" : "(auto-synced from email)"}
                    </span>
                    {waBodyCustomized && (
                      <button
                        type="button"
                        onClick={() => {
                          setWhatsappBody(deriveWhatsAppFromEmail(emailBody));
                          setWaBodyCustomized(false);
                        }}
                        className="text-[11px] text-sky-400 hover:text-sky-300 font-medium transition"
                      >
                        ↺ Reset to email sync
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={5}
                    value={whatsappBody}
                    onChange={(e) => {
                      setWhatsappBody(e.target.value);
                      setWaBodyCustomized(true);
                    }}
                    placeholder="Type or customize your WhatsApp message…"
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500"
                  />
                </label>
                <div
                  className={`rounded-lg border p-3 space-y-2 ${
                    needsWaTemplate
                      ? "border-amber-500/40 bg-amber-500/10"
                      : "border-emerald-500/25 bg-emerald-500/5"
                  }`}
                >
                  <p className="text-xs text-slate-300">
                    <strong className="text-emerald-300">WhatsApp Meta</strong> — searchable approved
                    templates. Use a template for cold outreach; inside the 24h reply window free text
                    may work without one.
                  </p>
                  <WhatsAppTemplatePicker
                    templates={waTemplates}
                    loading={waTemplatesLoading}
                    templateId={waTemplateId}
                    onTemplateIdChange={setWaTemplateId}
                    search={waTemplateSearch}
                    onSearchChange={setWaTemplateSearch}
                    variables={waTemplateVariables}
                    onVariablesChange={setWaTemplateVariables}
                    leadContext={
                      draft
                        ? {
                            company_name: draft.company_name,
                            contact_name: draft.contact_name,
                            country: draft.country,
                          }
                        : null
                    }
                    compact
                  />
                </div>
                {draftNotice ? (
                  <p
                    className={`text-sm ${
                      invalidEmails.length > 0 && !/sent\./i.test(draftNotice)
                        ? "text-amber-200"
                        : "text-emerald-300/90"
                    }`}
                  >
                    {draftNotice}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveDraftEdits()}
                    className="rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-3 py-2 text-sm font-medium text-slate-100"
                  >
                    {savingDraft ? "Saving…" : "Save draft"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void sendDraft("email")}
                    className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    {sendingChannel === "email" ? "Sending…" : "Send email"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void sendDraft("whatsapp")}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    <IconWhatsApp size="md" className="text-white !h-7 !w-7" />
                    {sendingChannel === "whatsapp" ? "Sending…" : "WhatsApp Meta"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void sendDraft("whatsapp_personal")}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                    title="Send post-call follow-up via your mobile WhatsApp number"
                  >
                    <IconWhatsApp size="md" className="text-white !h-7 !w-7" />
                    {sendingChannel === "whatsapp_personal" ? "Sending…" : "WhatsApp Mobile"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void sendDraft("all")}
                    className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    {sendingChannel === "all" ? "Sending…" : "Send all 3"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-amber-200/90">
                {draft?.generation_error ||
                  "Draft is still generating — open Emails → Personalized emails in a moment."}
              </p>
            )}
            <ActionButton
              icon={IconX}
              variant="ghost"
              onClick={dismiss}
              title="Close"
              className="text-slate-400"
            >
              Close
            </ActionButton>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
