import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type EmailAttachment,
  type EmailTemplate,
  type EmailTemplatePreview,
  type LeadTableRow,
} from "../api/client";
import { EmailAttachmentsField } from "./EmailAttachmentsField";
import { EmailBodyEditor, emailBodyHasContent } from "./EmailBodyEditor";
import { HtmlEmailPreview } from "./HtmlEmailPreview";
import { capitalizeFirstLetter } from "../utils/spelling";

type ComposeTab = "manual" | "template";

interface LeadEmailComposeModalProps {
  row: LeadTableRow;
  onClose: () => void;
  onError: (message: string) => void;
  onDraftCreated: (message: string) => void;
}

function MailIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

export function LeadEmailComposeModal({
  row,
  onClose,
  onError,
  onDraftCreated,
}: LeadEmailComposeModalProps) {
  const [tab, setTab] = useState<ComposeTab>("manual");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [preview, setPreview] = useState<EmailTemplatePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);

  const [manualSubject, setManualSubject] = useState(
    `Kafi Commodities — for ${row.company_name}`,
  );
  const [manualBody, setManualBody] = useState(
    `Dear ${row.contact_name || "Sir/Madam"},\n\n` +
      `I hope this message finds you well. We at Kafi Commodities would like to connect with ${row.company_name} regarding our ESSENCE product range.\n\n` +
      `Please let us know if you would like specifications or pricing.\n\n` +
      `Best regards,\nKafi Commodities Export Team`,
  );
  const [manualAttachments, setManualAttachments] = useState<EmailAttachment[]>([]);
  const [extraAttachments, setExtraAttachments] = useState<EmailAttachment[]>([]);

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
    if (!templateId) {
      setPreview(null);
      return;
    }
    setLoadingPreview(true);
    client
      .previewEmailTemplate(Number(templateId), row.id)
      .then(setPreview)
      .catch(() => setPreview(null))
      .finally(() => setLoadingPreview(false));
  }, [templateId, row.id]);

  async function handleCreateManualDraft() {
    setSending(true);
    try {
      const result = await client.createManualEmailDraft({
        buyer_id: row.id,
        subject: manualSubject,
        body: manualBody,
        contact_id: row.contact_id,
        attachments: manualAttachments,
        send: true,
      });
      if (result.sent) {
        onDraftCreated(
          `Email sent to ${row.company_name}. Check Email Activity for the delivery notification.`,
        );
      } else {
        onDraftCreated(
          result.send_message ||
            `Send did not complete for ${row.company_name}. See Email Activity for details.`,
        );
      }
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  }

  async function handleCreateTemplateDraft() {
    if (!templateId) {
      onError("Select a template first");
      return;
    }
    setSending(true);
    try {
      const result = await client.createBulkEmailDrafts(
        Number(templateId),
        [row.id],
        extraAttachments,
        true,
      );
      if ((result.sent_count ?? 0) > 0) {
        onDraftCreated(
          `Email sent to ${row.company_name}. Check Email Activity for the notification.`,
        );
        onClose();
      } else if (result.created_count > 0 && (result.failed_count ?? 0) > 0) {
        onError(
          result.created[0]?.send_message ||
            "Send failed — see Email Activity for details.",
        );
      } else {
        const reason = result.skipped[0]?.reason ?? "Could not send email";
        onError(reason);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  }

  const toEmail = row.contact_email || "—";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        className="w-full max-w-3xl rounded-xl border border-slate-700 bg-slate-900 shadow-xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-email-title"
      >
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 id="compose-email-title" className="text-lg font-medium text-slate-100 flex items-center gap-2">
              <MailIcon className="h-5 w-5 text-emerald-400" />
              Compose email
            </h3>
            <p className="text-sm text-slate-500 mt-1 truncate">
              To: <span className="text-slate-300">{toEmail}</span>
              {" · "}
              {row.company_name}
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
              onClick={(e) => {
                e.stopPropagation();
                setTab("manual");
              }}
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
              onClick={(e) => {
                e.stopPropagation();
                setTab("template");
              }}
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
                  onChange={(e) =>
                    setManualSubject(capitalizeFirstLetter(e.target.value))
                  }
                  className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                />
              </label>
              <div>
                <span className="text-sm text-slate-400">Message</span>
                <div className="mt-1">
                  <EmailBodyEditor
                    rows={12}
                    value={manualBody}
                    onChange={setManualBody}
                    placeholder="Write your message…"
                  />
                </div>
              </div>
              <EmailAttachmentsField
                attachments={manualAttachments}
                onChange={setManualAttachments}
                label="Attachments"
                hint="Optional files for this draft."
              />
              <p className="text-xs text-slate-500">
                Sends immediately via your configured Outlook mailbox. Results appear in{" "}
                <strong className="text-slate-400">Email Activity</strong>.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Choose a saved template, preview it for this lead, then send. Manage templates in
                the <strong className="text-slate-400">Email templates</strong> sidebar section.
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

              {templateId && (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Preview for {row.company_name}
                  </p>
                  {loadingPreview ? (
                    <p className="text-sm text-slate-400">Loading preview…</p>
                  ) : preview ? (
                    <>
                      <p className="text-sm font-medium text-slate-200">
                        Subject: {preview.subject}
                      </p>
                      <p className="text-sm text-slate-400">
                        To: {preview.contact_email || toEmail}
                      </p>
                      <HtmlEmailPreview html={preview.body || ""} maxHeight={420} />
                    </>
                  ) : (
                    <p className="text-sm text-slate-500">Preview unavailable.</p>
                  )}
                </div>
              )}

              <EmailAttachmentsField
                attachments={extraAttachments}
                onChange={setExtraAttachments}
                label="Extra attachments for this draft"
                hint="Added on top of any files saved on the selected template."
              />
            </>
          )}
        </div>

        <div className="p-5 border-t border-slate-800 flex justify-end gap-2 shrink-0">
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
              onClick={() => void handleCreateManualDraft()}
              disabled={
                sending || !manualSubject.trim() || !emailBodyHasContent(manualBody)
              }
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send email"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleCreateTemplateDraft()}
              disabled={sending || !templateId}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send from template"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface EmailComposeButtonProps {
  row: LeadTableRow;
  email?: string | null;
  onError: (message: string) => void;
  onDraftCreated: (message: string) => void;
}

/** Shows the email address plus a mail icon that opens the compose window. */
export function EmailComposeButton({
  row,
  email,
  onError,
  onDraftCreated,
}: EmailComposeButtonProps) {
  const [open, setOpen] = useState(false);
  const display = (email ?? row.contact_email ?? "").trim();
  if (!display) return <>—</>;

  return (
    <>
      <span
        className="flex items-center gap-1.5 min-w-0"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="truncate text-slate-300">{display}</span>
        <button
          type="button"
          title={`Compose email to ${display}`}
          aria-label={`Compose email to ${display}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-colors"
        >
          <MailIcon />
        </button>
      </span>
      {open && (
        <LeadEmailComposeModal
          row={row}
          onClose={() => setOpen(false)}
          onError={onError}
          onDraftCreated={(message) => {
            onDraftCreated(message);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
