import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type BulkEmailDraftResponse,
  type EmailAttachment,
  type EmailTemplate,
  type EmailTemplatePreview,
} from "../api/client";
import { EmailAttachmentsField } from "./EmailAttachmentsField";
import {
  appendEmailPlaceholder,
  EmailBodyEditor,
  emailBodyHasContent,
  htmlToPlainText,
  plainTextToEditorHtml,
} from "./EmailBodyEditor";
import { HtmlEmailPreview } from "./HtmlEmailPreview";
import {
  DEFAULT_TEMPLATE_BODY,
  DEFAULT_TEMPLATE_SUBJECT,
  PLACEHOLDER_HINTS,
} from "../utils/emailTemplateDefaults";
import { useAuth } from "../auth/AuthContext";
import {
  applyEmailSignatureHtml,
  bodyHasCurrentUserSignature,
  signatureDisplayName,
} from "../lib/emailSignature";

type ComposeTab = "manual" | "template";

interface BulkEmailModalProps {
  buyerIds: number[];
  sampleBuyerId: number | null;
  sampleCompanyName?: string | null;
  onClose: () => void;
  onError: (message: string) => void;
  onCreated: (result: BulkEmailDraftResponse) => void;
}

const DEFAULT_MANUAL_SUBJECT = DEFAULT_TEMPLATE_SUBJECT;
const DEFAULT_MANUAL_BODY = DEFAULT_TEMPLATE_BODY;

function MailIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-5 w-5 shrink-0 ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="m5.5 7.5 6.1 4.2a1 1 0 0 0 1.1 0L18.8 7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BulkEmailModal({
  buyerIds,
  sampleBuyerId,
  sampleCompanyName,
  onClose,
  onError,
  onCreated,
}: BulkEmailModalProps) {
  const { user } = useAuth();
  const [tab, setTab] = useState<ComposeTab>("manual");
  const [sending, setSending] = useState(false);

  const [manualSubject, setManualSubject] = useState(DEFAULT_MANUAL_SUBJECT);
  const [manualBody, setManualBody] = useState(DEFAULT_MANUAL_BODY);
  const [manualAttachments, setManualAttachments] = useState<EmailAttachment[]>([]);
  const [manualPreview, setManualPreview] = useState<EmailTemplatePreview | null>(null);
  const [loadingManualPreview, setLoadingManualPreview] = useState(false);

  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [templatePreview, setTemplatePreview] = useState<EmailTemplatePreview | null>(null);
  const [loadingTemplatePreview, setLoadingTemplatePreview] = useState(false);
  const [extraAttachments, setExtraAttachments] = useState<EmailAttachment[]>([]);

  const previewLabel = sampleCompanyName || "first selected lead";

  const refreshTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const rows = await client.listEmailTemplates();
      setTemplates(rows);
      setTemplateId((current) => {
        if (current && rows.some((t) => String(t.id) === current)) return current;
        return rows.length > 0 ? String(rows[0].id) : "";
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoadingTemplates(false);
    }
  }, [onError]);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  useEffect(() => {
    if (!sampleBuyerId || !manualSubject.trim() || !emailBodyHasContent(manualBody)) {
      setManualPreview(null);
      return;
    }
    setLoadingManualPreview(true);
    client
      .previewEmailText(sampleBuyerId, manualSubject, manualBody)
      .then(setManualPreview)
      .catch(() => setManualPreview(null))
      .finally(() => setLoadingManualPreview(false));
  }, [sampleBuyerId, manualSubject, manualBody]);

  useEffect(() => {
    if (!templateId || !sampleBuyerId) {
      setTemplatePreview(null);
      return;
    }
    setLoadingTemplatePreview(true);
    client
      .previewEmailTemplate(Number(templateId), sampleBuyerId)
      .then(setTemplatePreview)
      .catch(() => setTemplatePreview(null))
      .finally(() => setLoadingTemplatePreview(false));
  }, [templateId, sampleBuyerId]);

  async function handleSendManual() {
    if (!manualSubject.trim() || !emailBodyHasContent(manualBody)) {
      onError("Subject and message are required");
      return;
    }
    let confirmOverlap = false;
    try {
      const overlap = await client.checkBulkEmailOverlap(buyerIds);
      if (overlap.has_overlap) {
        const ok = window.confirm(
          `${overlap.message || "A bulk email for some of these same clients already started recently."}\n\nClick OK to send anyway, or Cancel to stop.`,
        );
        if (!ok) return;
        confirmOverlap = true;
      }
    } catch {
      /* check unavailable — backend still guards */
    }
    setSending(true);
    try {
      const result = await client.createBulkManualEmailDrafts(
        buyerIds,
        manualSubject,
        manualBody,
        manualAttachments,
        true,
        confirmOverlap,
      );
      onCreated(result);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk send failed");
    } finally {
      setSending(false);
    }
  }

  async function handleSendTemplate() {
    if (!templateId) {
      onError("Select a template first");
      return;
    }
    let confirmOverlap = false;
    try {
      const overlap = await client.checkBulkEmailOverlap(buyerIds);
      if (overlap.has_overlap) {
        const ok = window.confirm(
          `${overlap.message || "A bulk email for some of these same clients already started recently."}\n\nClick OK to send anyway, or Cancel to stop.`,
        );
        if (!ok) return;
        confirmOverlap = true;
      }
    } catch {
      /* check unavailable — backend still guards */
    }
    setSending(true);
    try {
      const result = await client.createBulkEmailDrafts(
        Number(templateId),
        buyerIds,
        extraAttachments,
        true,
        confirmOverlap,
      );
      onCreated(result);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk send failed");
    } finally {
      setSending(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        className="w-full sm:max-w-3xl max-h-[92vh] overflow-hidden flex flex-col rounded-t-2xl sm:rounded-xl border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-compose-email-title"
      >
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3
              id="bulk-compose-email-title"
              className="text-lg font-medium text-slate-100 flex items-center gap-2"
            >
              <MailIcon className="h-5 w-5 shrink-0 text-emerald-400" />
              Compose bulk email
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              {buyerIds.length} lead{buyerIds.length === 1 ? "" : "s"} selected — each recipient
              gets a personalized email. Name and company placeholders are filled per lead.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 pt-4 shrink-0">
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-1">
            <button
              type="button"
              onClick={() => setTab("manual")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                tab === "manual"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Manual email
            </button>
            <button
              type="button"
              onClick={() => setTab("template")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                tab === "template"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Email template
            </button>
          </div>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {tab === "manual" ? (
            <>
              <label className="block">
                <span className="text-sm text-slate-400">Subject</span>
                <input
                  value={manualSubject}
                  onChange={(e) => setManualSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                />
              </label>
              <div>
                <span className="text-sm text-slate-400">Message</span>
                <div className="flex flex-wrap gap-1.5 mt-2 mb-2">
                  {PLACEHOLDER_HINTS.map((token) => (
                    <button
                      key={token}
                      type="button"
                      onClick={() =>
                        setManualBody((body) => appendEmailPlaceholder(body, token))
                      }
                      className="px-2 py-0.5 rounded border border-slate-700 bg-slate-800 text-xs text-slate-300 hover:bg-slate-700"
                    >
                      {token}
                    </button>
                  ))}
                </div>
                <EmailBodyEditor
                  rows={12}
                  value={manualBody}
                  onChange={setManualBody}
                  placeholder="Write your message…"
                />
              </div>
              <EmailAttachmentsField
                attachments={manualAttachments}
                onChange={setManualAttachments}
                label="Attachments"
                hint="Same files attached to every email in this batch."
              />

              {sampleBuyerId && (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Preview for {previewLabel}
                  </p>
                  {loadingManualPreview ? (
                    <p className="text-sm text-slate-400">Loading preview…</p>
                  ) : manualPreview ? (
                    <>
                      <p className="text-sm font-medium text-slate-200">
                        Subject: {manualPreview.subject}
                      </p>
                      <p className="text-sm text-slate-400">
                        To: {manualPreview.contact_email || "—"}
                      </p>
                      <HtmlEmailPreview html={manualPreview.body || ""} maxHeight={360} />
                    </>
                  ) : (
                    <p className="text-sm text-slate-500">
                      No preview — first selected lead may not have an email contact.
                    </p>
                  )}
                </div>
              )}

              <p className="text-xs text-slate-500">
                Use placeholders like [company_name] and [contact_name] — each lead receives their
                own personalized version. Sends via Outlook; track progress in{" "}
                <strong className="text-slate-400">Email Activity</strong>.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Choose a saved template, preview it for the first selected lead, then send. Each
                recipient gets their own personalized names. Manage templates in{" "}
                <strong className="text-slate-400">Email templates</strong>.
              </p>

              {loadingTemplates ? (
                <p className="text-sm text-slate-400">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
                  No templates yet. Open <strong className="text-slate-300">Email templates</strong>{" "}
                  in the sidebar to create one.
                </p>
              ) : (
                <ul className="space-y-2">
                  {templates.map((template) => {
                    const selected = String(template.id) === templateId;
                    return (
                      <li key={template.id}>
                        <button
                          type="button"
                          onClick={() => setTemplateId(String(template.id))}
                          className={`w-full rounded-lg border p-3 text-left transition ${
                            selected
                              ? "border-emerald-500/50 bg-emerald-500/10"
                              : "border-slate-800 bg-slate-950 hover:border-slate-700"
                          }`}
                        >
                          <p className="font-medium text-slate-100">{template.name}</p>
                          <p className="text-sm text-slate-400 truncate">{template.subject}</p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {templateId && sampleBuyerId && (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Preview for {previewLabel} (each lead gets their own names)
                  </p>
                  {loadingTemplatePreview ? (
                    <p className="text-sm text-slate-400">Loading preview…</p>
                  ) : templatePreview ? (
                    <>
                      <p className="text-sm font-medium text-slate-200">
                        Subject: {templatePreview.subject}
                      </p>
                      <p className="text-sm text-slate-400">
                        To: {templatePreview.contact_email || "—"}
                      </p>
                      <HtmlEmailPreview html={templatePreview.body || ""} maxHeight={420} />
                    </>
                  ) : (
                    <p className="text-sm text-slate-500">Preview unavailable.</p>
                  )}
                </div>
              )}

              <EmailAttachmentsField
                attachments={extraAttachments}
                onChange={setExtraAttachments}
                label="Extra attachments for this batch"
                hint="Added on top of any files saved on the template. All selected leads get the same attachments."
              />
            </>
          )}
        </div>

        <div className="p-5 border-t border-slate-800 flex flex-wrap justify-end gap-2 shrink-0">
          {tab === "manual" ? (
            <button
              type="button"
              onClick={() =>
                setManualBody((prev) => applyEmailSignatureHtml(prev, user, plainTextToEditorHtml))
              }
              disabled={
                sending || bodyHasCurrentUserSignature(manualBody, user, htmlToPlainText)
              }
              title={`Paste ${signatureDisplayName(user)} signature at the bottom of the body`}
              className="px-4 py-2 rounded-lg border border-slate-700 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50 mr-auto"
            >
              {bodyHasCurrentUserSignature(manualBody, user, htmlToPlainText)
                ? "Signature added"
                : "Add signature"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm"
          >
            Cancel
          </button>
          {tab === "manual" ? (
            <button
              type="button"
              onClick={() => void handleSendManual()}
              disabled={
                sending || !manualSubject.trim() || !emailBodyHasContent(manualBody)
              }
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {sending ? "Sending…" : `Send ${buyerIds.length} email(s)`}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSendTemplate()}
              disabled={sending || !templateId || templates.length === 0}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {sending ? "Sending…" : `Send ${buyerIds.length} email(s)`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
