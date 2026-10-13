"use client";

import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, getStoredToken } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { TemplatePicker } from "@/components/TemplatePicker";
import {
  AiComposeAssist,
  type ComposeWriteMode,
} from "@/components/AiComposeAssist";
import {
  EmailBodyEditor,
  emailBodyHasContent,
  htmlToPlainText,
  plainTextToEditorHtml,
  type EmailBodyEditorHandle,
} from "@/components/EmailBodyEditor";
import { PictureDropdownPicker } from "@/components/PictureDropdownPicker";
import { PictureSidebar } from "@/components/PictureSidebar";
import { ensureDearSalutation } from "@/lib/personalizeEmail";
import { normalizeEditorTextColor } from "@/lib/emailTextColor";
import {
  attachmentSizeMessage,
  parseSendApiResponse,
} from "@/lib/parseSendResponse";
import {
  formatAttachmentSize,
  hostedFromTemplateAttachments,
  uploadAttachmentToSalesAgent,
  type HostedAttachment,
} from "@/lib/hostAttachments";
import {
  buildEmailSignatureHtml,
  bodyHasCurrentUserSignature,
  signatureDisplayName,
} from "@/lib/emailSignature";
import {
  hostDataUriImagesInBrowser,
  htmlHasDataUriImages,
} from "@/lib/hostInlineImagesClient";

function defaultComposeBody(contactName: string, companyName: string): string {
  const name = contactName.trim() || "[Contact Name]";
  void companyName;
  return plainTextToEditorHtml(`Dear ${name},\n\n`);
}

function ComposeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { token, user } = useAuth();
  const [to, setTo] = useState(params.get("to") || "");
  const [cc, setCc] = useState(params.get("cc") || "");
  const [bcc, setBcc] = useState(params.get("bcc") || "");
  const [showCc, setShowCc] = useState(Boolean(params.get("cc")));
  const [showBcc, setShowBcc] = useState(Boolean(params.get("bcc")));
  const [subject, setSubject] = useState(params.get("subject") || "");
  const [body, setBody] = useState(() => {
    const fromParam = params.get("body") || "";
    if (fromParam) return fromParam;
    const contact = params.get("contact_name") || "";
    const company = params.get("company_name") || "";
    if (contact || company) {
      return defaultComposeBody(contact, company);
    }
    return "";
  });
  const [templateId, setTemplateId] = useState("");
  const [writeMode, setWriteMode] = useState<ComposeWriteMode>("free");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attachments, setAttachments] = useState<HostedAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPictureSidebar, setShowPictureSidebar] = useState(false);
  const bodyEditorRef = useRef<EmailBodyEditorHandle>(null);
  const draftId = params.get("draft_id");
  const buyerIdParam = params.get("buyer_id");
  const buyerId =
    buyerIdParam && /^\d+$/.test(buyerIdParam) ? Number(buyerIdParam) : undefined;
  const mergeCompany = params.get("company_name") || "";
  const mergeContact = params.get("contact_name") || "";
  const mergeDesignation = params.get("designation") || "";

  const aiContextHint = [
    mergeContact ? `Contact name: ${mergeContact}` : "",
    mergeCompany ? `Company: ${mergeCompany}` : "",
    mergeDesignation ? `Designation: ${mergeDesignation}` : "",
    "Use [Contact Name] and [Company Name] placeholders — they are filled automatically on send.",
  ]
    .filter(Boolean)
    .join(". ");

  const attachmentBytes = attachments.reduce((sum, file) => sum + (file.size || 0), 0);
  const attachmentWarning =
    attachments.length > 0 ? attachmentSizeMessage(attachmentBytes) : null;

  async function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    const auth = token || getStoredToken();
    if (!auth) {
      setError("Not signed in — cannot upload attachments");
      return;
    }
    setUploadingAttachments(true);
    setUploadPercent(0);
    setUploadLabel("Preparing upload…");
    setError(null);
    setNotice(null);
    try {
      const next: HostedAttachment[] = [];
      for (const file of Array.from(files)) {
        next.push(
          await uploadAttachmentToSalesAgent(file, {
            authToken: auth,
            onProgress: ({ percent, label }) => {
              setUploadPercent(percent);
              setUploadLabel(label);
            },
          }),
        );
      }
      setAttachments((prev) => [...prev, ...next]);
      setNotice(
        next.length === 1
          ? `Attached ${next[0].filename} (${formatAttachmentSize(next[0].size)})`
          : `Attached ${next.length} files`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attachment upload failed");
      setNotice(null);
    } finally {
      setUploadingAttachments(false);
      setUploadPercent(0);
      setUploadLabel(null);
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function saveDraft() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch("/inbox/drafts", {
        method: "POST",
        body: JSON.stringify({
          id: draftId ? Number(draftId) : undefined,
          to_addrs: to,
          cc_addrs: cc,
          subject,
          body,
        }),
      });
      setNotice("Draft saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function send() {
    const auth = token || getStoredToken();
    if (!auth) {
      setError("Not signed in");
      return;
    }
    if (!to.includes("@") || !subject.trim() || !emailBodyHasContent(body)) {
      setError("To, subject, and body are required");
      return;
    }
    setSending(true);
    setError(null);
    try {
      // Convert pasted data:image blobs to HTTPS URLs before hitting /api/send
      // (avoids Vercel body-size limits and Gmail raw-base64 rendering).
      let sendHtml = body;
      if (htmlHasDataUriImages(body)) {
        setNotice("Uploading inline images…");
        sendHtml = await hostDataUriImagesInBrowser(body, { authToken: auth });
        setBody(sendHtml);
      }
      if (attachmentWarning) {
        setError(attachmentWarning);
        return;
      }
      const payload = {
        auth_token: auth,
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim(),
        body: sendHtml,
        html: true,
        buyer_id: buyerId,
        company_name: mergeCompany.trim() || undefined,
        contact_name: mergeContact.trim() || undefined,
        designation: mergeDesignation.trim() || undefined,
        // Hosted refs only — never base64 PDFs through Vercel (4.5 MB body limit).
        attachments: attachments.length
          ? attachments.map((file) => ({
              id: file.id,
              url: file.url,
              filename: file.filename,
              contentType: file.contentType,
              size: file.size,
            }))
          : undefined,
      };

      setNotice(attachments.length ? "Sending with attachment(s)…" : null);
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseSendApiResponse(res);
      if (!data.ok) throw new Error(data.error || "Send failed");
      if (draftId) {
        void apiFetch(`/inbox/drafts/${draftId}`, { method: "DELETE" }).catch(() => null);
      }
      setNotice("Sent via Vercel SMTP");
      window.setTimeout(() => router.push("/sent"), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: "flex", width: "100%", minHeight: "100dvh", alignItems: "stretch" }}>
      <div className="compose-page" style={{ flex: 1, minWidth: 0, paddingRight: showPictureSidebar ? "1rem" : undefined }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <h2 className="folder-title" style={{ margin: 0 }}>Compose</h2>
            <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
              From: {user?.mailbox_email || user?.username} · Sends via Vercel SMTP (not Railway)
            </p>
          </div>
          <button
            type="button"
            className={showPictureSidebar ? "btn small" : "btn ghost small"}
            onClick={() => setShowPictureSidebar((prev) => !prev)}
            title="Toggle right sidebar to browse and insert pictures"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              fontWeight: 600,
              background: showPictureSidebar ? "#0284c7" : undefined,
              color: showPictureSidebar ? "#fff" : undefined,
            }}
          >
            <span>🖼️ {showPictureSidebar ? "Close pictures" : "Browse pictures"}</span>
          </button>
        </div>
        {error && <p className="bad">{error}</p>}
        {notice && <p className="ok">{notice}</p>}

      <TemplatePicker
        value={templateId}
        onChange={(id, tpl) => {
          setTemplateId(id);
          if (tpl) {
            setSubject(tpl.subject);
            const salutationName = mergeContact.trim() || "[Contact Name]";
            setBody(
              normalizeEditorTextColor(
                ensureDearSalutation(tpl.body, salutationName),
              ),
            );
            setWriteMode("free");
            const fromTemplate = hostedFromTemplateAttachments(tpl.attachments);
            setAttachments(fromTemplate);
            setNotice(
              fromTemplate.length
                ? `Loaded template “${tpl.name}” with ${fromTemplate.length} attachment${
                    fromTemplate.length === 1 ? "" : "s"
                  } — edit before send if needed`
                : `Loaded template “${tpl.name}” — edit before send if needed`,
            );
          } else {
            setAttachments([]);
          }
        }}
      />

      <AiComposeAssist
        mode={writeMode}
        onModeChange={setWriteMode}
        toHint={to}
        contextHint={aiContextHint || undefined}
        subject={subject}
        body={body}
        onDraft={(draft) => {
          setSubject(draft.subject);
          setBody(draft.body);
        }}
        onNotice={setNotice}
        onError={setError}
      />

      {(mergeCompany || mergeContact) && (
        <p className="muted small">
          Merge fields on send:{" "}
          {mergeContact ? (
            <>
              contact <strong>{mergeContact}</strong>
            </>
          ) : null}
          {mergeCompany ? (
            <>
              {mergeContact ? " · " : ""}
              company <strong>{mergeCompany}</strong>
            </>
          ) : null}
        </p>
      )}

      <div className="compose-to-row">
        <label className="compose-to-label">To</label>
        <div className="compose-cc-toggles">
          {!showCc && (
            <button type="button" className="linkish" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
          {!showBcc && (
            <button type="button" className="linkish" onClick={() => setShowBcc(true)}>
              Bcc
            </button>
          )}
        </div>
      </div>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="name@example.com"
      />

      {showCc && (
        <>
          <label>Cc</label>
          <input
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="cc@example.com — comma-separated for multiple"
          />
        </>
      )}

      {showBcc && (
        <>
          <label>Bcc</label>
          <input
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
            placeholder="bcc@example.com — comma-separated for multiple"
          />
        </>
      )}

      <label>Subject</label>
      <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      <label>Attachments</label>
      <input
        type="file"
        multiple
        disabled={uploadingAttachments || sending}
        onChange={(e) => {
          void addAttachments(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="muted small">
        PDFs and files upload to Sales Agent first (up to ~10 MB total — encoding adds
        ~33%; larger files often bounce as spam or size-reject). Not limited by
        Vercel&apos;s 4 MB request size.
      </p>
      {uploadingAttachments && (
        <div className="upload-progress" role="status" aria-live="polite">
          <div className="upload-progress-meta">
            <span>{uploadLabel || "Uploading…"}</span>
            <strong>{uploadPercent}%</strong>
          </div>
          <div
            className="upload-progress-track"
            role="progressbar"
            aria-valuenow={uploadPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="upload-progress-fill" style={{ width: `${uploadPercent}%` }} />
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <>
          <ul className="small muted">
            {attachments.map((file, index) => (
              <li key={`${file.id}-${index}`}>
                {file.filename} ({formatAttachmentSize(file.size)}){" "}
                <button type="button" className="linkish" onClick={() => removeAttachment(index)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {attachmentWarning && <p className="bad small">{attachmentWarning}</p>}
        </>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "1rem", marginBottom: "0.4rem" }}>
        <label style={{ margin: 0 }}>Body</label>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            className={showPictureSidebar ? "btn small" : "btn ghost small"}
            disabled={sending}
            onClick={() => setShowPictureSidebar((prev) => !prev)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontWeight: 500,
              fontSize: "0.8rem",
            }}
            title="Toggle right sidebar with all pictures"
          >
            <span>🖼️ {showPictureSidebar ? "Hide sidebar" : "Picture sidebar"}</span>
          </button>
          <PictureDropdownPicker
            disabled={sending}
            onInsert={(url, filename) => bodyEditorRef.current?.insertPicture(url, filename)}
          />
        </div>
      </div>
      <EmailBodyEditor ref={bodyEditorRef} value={body} onChange={setBody} rows={14} />
      <div className="detail-actions">
        <button
          type="button"
          className="btn"
          disabled={sending || uploadingAttachments || Boolean(attachmentWarning)}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : "Send"}
        </button>
        <button type="button" className="btn ghost" disabled={saving} onClick={() => void saveDraft()}>
          {saving ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={sending || saving || bodyHasCurrentUserSignature(body, user, htmlToPlainText)}
          title={`Insert ${signatureDisplayName(user)} signature where the cursor is`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            bodyEditorRef.current?.insertBlock(buildEmailSignatureHtml(user, plainTextToEditorHtml))
          }
          style={{
            background: bodyHasCurrentUserSignature(body, user, htmlToPlainText)
              ? undefined
              : "#047857",
          }}
        >
          {bodyHasCurrentUserSignature(body, user, htmlToPlainText)
            ? "Signature added"
            : "Add signature"}
        </button>
      </div>
      </div>

      <PictureSidebar
        isOpen={showPictureSidebar}
        onClose={() => setShowPictureSidebar(false)}
        onInsert={(url, filename) => {
          bodyEditorRef.current?.insertPicture(url, filename);
        }}
        disabled={sending}
      />
    </div>
  );
}

export default function ComposePage() {
  return (
    <Suspense fallback={<div className="pad muted">Loading…</div>}>
      <ComposeInner />
    </Suspense>
  );
}
