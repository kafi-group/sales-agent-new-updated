import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { client, type EmailAttachment, type EmailTemplate, type MailComposeDraft } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  applyEmailSignatureHtml,
  bodyHasCurrentUserSignature,
  signatureDisplayName,
} from "../lib/emailSignature";
import { EmailBodyEditor, emailBodyHasContent, htmlToPlainText, plainTextToEditorHtml } from "./EmailBodyEditor";
import { AttachedFilesList } from "./AttachedFilesList";
import { AttachCatalogueModal } from "./AttachCatalogueModal";
import { AttachCnfCardModal } from "./AttachCnfCardModal";
import { ProseInput } from "./ProseTextField";
import { IconBookOpen, IconPaperclip } from "./icons/AppIcons";

interface ComposeMailModalProps {
  fromEmail: string;
  mailboxUserId?: number | null;
  onClose: () => void;
  onSent: (message: string) => void;
  onError: (message: string) => void;
  initialDraft?: (Partial<MailComposeDraft> & { attachments?: EmailAttachment[] }) | null;
  onDraftSaved?: () => void;
  onDraftDiscarded?: () => void;
}

function hasDraftContent(to: string, cc: string, subject: string, body: string): boolean {
  return Boolean(to.trim() || cc.trim() || subject.trim() || emailBodyHasContent(body));
}

export function ComposeMailModal({
  fromEmail,
  mailboxUserId = null,
  onClose,
  onSent,
  onError,
  initialDraft = null,
  onDraftSaved,
  onDraftDiscarded,
}: ComposeMailModalProps) {
  const { user } = useAuth();
  const titleId = useId();
  const [to, setTo] = useState(initialDraft?.to_addrs || "");
  const [cc, setCc] = useState(initialDraft?.cc_addrs || "");
  const [subject, setSubject] = useState(initialDraft?.subject || "");
  const [body, setBody] = useState(initialDraft?.body || "");
  const [attachments, setAttachments] = useState<EmailAttachment[]>(initialDraft?.attachments || []);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [showAttachCatalogue, setShowAttachCatalogue] = useState(false);
  const [showAttachCnf, setShowAttachCnf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sending, setSending] = useState(false);
  const [showCc, setShowCc] = useState(Boolean(initialDraft?.cc_addrs?.trim()));
  const [draftId, setDraftId] = useState<number | null>(initialDraft?.id ?? null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const sentRef = useRef(false);
  const discardedRef = useRef(false);
  const closingRef = useRef(false);
  const stateRef = useRef({ to, cc, subject, body, draftId });
  stateRef.current = { to, cc, subject, body, draftId };

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadingAttachment(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploaded = await client.uploadEmailAttachment(file);
        setAttachments((prev) => [...prev, uploaded]);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to upload attachment");
    } finally {
      setUploadingAttachment(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleRemoveAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function saveDraftNow(force = false): Promise<number | null> {
    const snap = stateRef.current;
    if (sentRef.current || discardedRef.current || sending || discarding) return snap.draftId;
    if (!force && !hasDraftContent(snap.to, snap.cc, snap.subject, snap.body)) {
      return snap.draftId;
    }
    setSavingDraft(true);
    try {
      const saved = await client.upsertMailDraft({
        id: snap.draftId,
        to_addrs: snap.to,
        cc_addrs: snap.cc,
        subject: snap.subject,
        body: snap.body,
      });
      setDraftId(saved.id);
      stateRef.current.draftId = saved.id;
      onDraftSaved?.();
      return saved.id;
    } catch (e) {
      if (force) {
        onError(e instanceof Error ? e.message : "Failed to save draft");
      }
      return snap.draftId;
    } finally {
      setSavingDraft(false);
    }
  }

  async function closeWithDraftSave() {
    if (closingRef.current || sending || discarding) return;
    closingRef.current = true;
    await saveDraftNow();
    onClose();
  }

  async function discardDraft() {
    if (sending || discarding || closingRef.current) return;
    const id = stateRef.current.draftId;
    setDiscarding(true);
    discardedRef.current = true;
    closingRef.current = true;
    try {
      if (id != null) {
        await client.deleteMailDraft(id);
      }
      onDraftDiscarded?.();
      onClose();
    } catch (e) {
      discardedRef.current = false;
      closingRef.current = false;
      onError(e instanceof Error ? e.message : "Failed to discard draft");
    } finally {
      setDiscarding(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sending) {
        void closeWithDraftSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending]);

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        void saveDraftNow();
      }
    }
    function onPageHide() {
      void saveDraftNow();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openTemplates() {
    setShowTemplates(true);
    setLoadingTemplates(true);
    try {
      setTemplates(await client.listEmailTemplates());
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load templates");
      setShowTemplates(false);
    } finally {
      setLoadingTemplates(false);
    }
  }

  function applyTemplate(template: EmailTemplate) {
    setSubject(template.subject || "");
    setBody(template.body || "");
    setShowTemplates(false);
  }

  async function handleSend() {
    const recipient = to.trim();
    if (!recipient || !recipient.includes("@")) {
      onError("Enter a valid To: email address");
      return;
    }
    if (!emailBodyHasContent(body)) {
      onError("Email body cannot be empty");
      return;
    }
    setSending(true);
    try {
      const result = await client.composeInboxMail(
        {
          to: recipient,
          subject: subject.trim(),
          body: body.trimEnd(),
          cc: cc.trim() || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        mailboxUserId,
      );
      sentRef.current = true;
      if (draftId != null) {
        try {
          await client.deleteMailDraft(draftId);
          onDraftSaved?.();
        } catch {
          /* draft cleanup is best-effort */
        }
      }
      onSent(
        `Sent to ${result.to || recipient}` +
          (result.subject ? ` — ${result.subject}` : ""),
      );
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !sending) {
          void closeWithDraftSave();
        }
      }}
    >
      <div className="w-full sm:max-w-5xl max-h-[94vh] overflow-y-auto rounded-t-2xl sm:rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-medium text-slate-100">
              Compose mail
            </h3>
            {(savingDraft || draftId) && (
              <p className="text-[11px] text-slate-500 mt-0.5">
                {savingDraft ? "Saving draft…" : "Draft saved"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void closeWithDraftSave()}
            disabled={sending}
            className="text-slate-400 hover:text-slate-200 text-sm disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void openTemplates()}
              disabled={sending}
              className="px-3 py-1.5 rounded-lg border border-emerald-700/50 bg-emerald-900/30 text-emerald-200 text-xs font-medium hover:bg-emerald-900/50 disabled:opacity-50"
            >
              Import From Email Templates
            </button>
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-slate-500">From</span>
            <input
              type="text"
              value={fromEmail}
              readOnly
              className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-300"
            />
          </label>

          <label className="block space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">To</span>
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                >
                  Add Cc
                </button>
              )}
            </div>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-600"
            />
          </label>

          {showCc && (
            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Cc</span>
              <input
                type="email"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="optional@example.com"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-600"
              />
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Subject</span>
            <ProseInput
              value={subject}
              onChange={setSubject}
              placeholder="Subject"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-600"
            />
          </label>

          <div className="block space-y-1">
            <span className="text-xs text-slate-500">Message</span>
            <EmailBodyEditor
              value={body}
              onChange={setBody}
              rows={12}
              disabled={sending}
              placeholder="Write your email…"
              onAttachClick={() => fileInputRef.current?.click()}
              attachmentCount={attachments.length}
              isUploadingAttachment={uploadingAttachment}
            />
          </div>

          <AttachedFilesList
            attachments={attachments}
            onRemove={handleRemoveAttachment}
            onClearAll={() => setAttachments([])}
            uploading={uploadingAttachment}
          />
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              multiple
              className="hidden"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp,.gif"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending || uploadingAttachment}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-xs font-medium text-slate-200 transition cursor-pointer disabled:opacity-50"
            >
              <IconPaperclip size="sm" className="text-emerald-400" />
              <span>{uploadingAttachment ? "Attaching…" : "Attach Document"}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowAttachCatalogue(true)}
              disabled={sending || uploadingAttachment}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-xs font-medium text-slate-200 transition cursor-pointer disabled:opacity-50"
            >
              <IconBookOpen size="sm" className="text-emerald-400" />
              <span>Attach Catalogue</span>
            </button>
            <button
              type="button"
              onClick={() => setShowAttachCnf(true)}
              disabled={sending || uploadingAttachment}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-cyan-800/60 bg-cyan-950/40 hover:bg-cyan-900/50 text-xs font-medium text-cyan-300 transition cursor-pointer disabled:opacity-50"
            >
              <span>🏷️</span>
              <span>Attach Live Price Card / CNF</span>
            </button>
            {attachments.length > 0 && (
              <span className="text-xs text-emerald-400 font-medium">
                {attachments.length} attached
              </span>
            )}
            {(draftId != null ||
              hasDraftContent(to, cc, subject, body) ||
              Boolean(initialDraft)) && (
              <button
                type="button"
                onClick={() => void discardDraft()}
                disabled={sending || discarding}
                className="px-3 py-2 rounded-lg border border-red-800/50 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-50 ml-2"
              >
                {discarding ? "Discarding…" : "Discard"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setBody((prev) => applyEmailSignatureHtml(prev, user, plainTextToEditorHtml))
              }
              disabled={
                sending || discarding || bodyHasCurrentUserSignature(body, user, htmlToPlainText)
              }
              title={`Paste ${signatureDisplayName(user)} signature at the bottom of the body`}
              className="px-3 py-2 rounded-lg border border-slate-700 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {bodyHasCurrentUserSignature(body, user, htmlToPlainText)
                ? "Signature added"
                : "Add signature"}
            </button>
            <button
              type="button"
              onClick={() => void closeWithDraftSave()}
              disabled={sending || discarding}
              className="px-3 py-2 rounded-lg border border-slate-700 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || discarding || !to.trim() || !emailBodyHasContent(body) || uploadingAttachment}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white disabled:opacity-50 font-semibold"
            >
              {sending ? "Sending…" : "Send Email"}
            </button>
          </div>
        </div>
      </div>

      {showTemplates && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Select template"
          onClick={() => setShowTemplates(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h4 className="text-sm font-medium text-slate-100">Insert Email Template</h4>
              <button
                type="button"
                onClick={() => setShowTemplates(false)}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Close
              </button>
            </div>
            <div className="overflow-y-auto divide-y divide-slate-800/80">
              {loadingTemplates ? (
                <p className="py-10 text-center text-slate-500 text-sm">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="py-10 text-center text-slate-500 text-sm">No templates yet.</p>
              ) : (
                templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => applyTemplate(template)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-800/60 transition"
                  >
                    <div className="text-sm font-medium text-slate-100">{template.name}</div>
                    <div className="text-xs text-slate-400 truncate mt-0.5">
                      {template.subject || "(no subject)"}
                    </div>
                    <div className="text-xs text-slate-500 truncate mt-1">
                      {(template.body || "").replace(/\s+/g, " ").slice(0, 120)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {showAttachCatalogue && (
        <AttachCatalogueModal
          onClose={() => setShowAttachCatalogue(false)}
          onAttach={(newAtts) => setAttachments((prev) => [...prev, ...newAtts])}
          onError={onError}
        />
      )}
      {showAttachCnf && (
        <AttachCnfCardModal
          onClose={() => setShowAttachCnf(false)}
          onAttach={(newAtts) => setAttachments((prev) => [...prev, ...newAtts])}
          onError={onError}
        />
      )}
    </div>,
    document.body,
  );
}
