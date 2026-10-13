"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  buildReplyRecipients,
  hasReplyAllTargets,
} from "@/lib/replyRecipients";
import { useAuth } from "./AuthProvider";
import { EmailBodyEditor, emailBodyHasContent } from "./EmailBodyEditor";

export type MessageSummary = {
  uid: string;
  folder: string;
  subject: string;
  from_email?: string | null;
  from_name?: string | null;
  date?: string | null;
  preview?: string;
  unread?: boolean;
};

export type MessageDetail = MessageSummary & {
  body_text?: string | null;
  body_html?: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  direction?: string | null;
};

type MessageListResponse = {
  items: MessageSummary[];
  total?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
};

type Props = {
  folder: "inbox" | "sent" | "trash" | "archive";
};

type ReplyMode = "reply" | "reply_all";

function formatAddrList(addrs?: string[] | null): string {
  return (addrs || []).filter(Boolean).join(", ");
}

export function FolderView({ folder }: Props) {
  const { token, user } = useAuth();
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selected, setSelected] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyMode, setReplyMode] = useState<ReplyMode>("reply");
  const [replyTo, setReplyTo] = useState("");
  const [replyCc, setReplyCc] = useState("");
  const [replyBcc, setReplyBcc] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const mailboxEmail = user?.mailbox_email || null;
  const canReplyAll = selected
    ? hasReplyAllTargets(selected, mailboxEmail)
    : false;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<MessageListResponse | MessageSummary[]>(
        `/inbox/messages?folder=${encodeURIComponent(folder)}&limit=50`,
      );
      const rows = Array.isArray(data)
        ? data
        : Array.isArray((data as MessageListResponse)?.items)
          ? (data as MessageListResponse).items
          : [];
      setMessages(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mail");
    } finally {
      setLoading(false);
    }
  }, [folder]);

  useEffect(() => {
    setSelected(null);
    setReplyOpen(false);
    void load();
  }, [load]);

  function openReply(mode: ReplyMode) {
    if (!selected) return;
    const recipients = buildReplyRecipients(selected, mailboxEmail, mode);
    if (!recipients.to) {
      setError("No reply address on this message");
      return;
    }
    setReplyMode(mode);
    setReplyTo(recipients.to);
    setReplyCc(recipients.cc);
    setReplyBcc(recipients.bcc);
    setReplyOpen(true);
    setNotice(null);
  }

  async function openMessage(row: MessageSummary) {
    setNotice(null);
    setReplyOpen(false);
    const folderKey = row.folder || folder;
    try {
      const detail = await apiFetch<MessageDetail>(
        `/inbox/messages/${encodeURIComponent(row.uid)}?folder=${encodeURIComponent(folderKey)}`,
      );
      setSelected(detail);
      if (detail.unread) {
        void apiFetch(
          `/inbox/messages/${encodeURIComponent(row.uid)}/read?folder=${encodeURIComponent(folderKey)}`,
          { method: "POST" },
        ).then(() => {
          setMessages((prev) =>
            prev.map((m) => (m.uid === row.uid ? { ...m, unread: false } : m)),
          );
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open message");
    }
  }

  async function moveTo(dest: "trash" | "archive" | "inbox") {
    if (!selected) return;
    try {
      await apiFetch(`/inbox/messages/${encodeURIComponent(selected.uid)}/move`, {
        method: "POST",
        body: JSON.stringify({ from_folder: selected.folder || folder, to_folder: dest }),
      });
      setSelected(null);
      setNotice(`Moved to ${dest}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Move failed");
    }
  }

  async function sendReply() {
    if (!selected || !token || !emailBodyHasContent(replyBody) || !replyTo.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auth_token: token,
          to: replyTo.trim(),
          cc: replyCc.trim() || undefined,
          bcc: replyBcc.trim() || undefined,
          subject: selected.subject?.startsWith("Re:")
            ? selected.subject
            : `Re: ${selected.subject || ""}`,
          body: replyBody,
          html: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      setReplyOpen(false);
      setReplyBody("");
      setReplyCc("");
      setReplyBcc("");
      setNotice(
        replyMode === "reply_all"
          ? "Reply all sent via Vercel SMTP"
          : "Reply sent via Vercel SMTP",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reply failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="folder-layout">
      <div className="folder-list">
        <div className="folder-list-head">
          <h2 className="folder-title">{folder}</h2>
          <button type="button" className="btn ghost small" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        {loading && <p className="muted pad">Loading…</p>}
        {error && <p className="bad pad">{error}</p>}
        {notice && <p className="ok pad">{notice}</p>}
        <ul className="msg-list">
          {(Array.isArray(messages) ? messages : []).map((m) => (
            <li key={m.uid}>
              <button
                type="button"
                className={`msg-row ${selected?.uid === m.uid ? "selected" : ""} ${m.unread ? "unread" : ""}`}
                onClick={() => void openMessage(m)}
              >
                <span className="msg-from">
                  {m.from_name || m.from_email || "(no sender)"}
                </span>
                <span className="msg-subject">{m.subject || "(no subject)"}</span>
                <span className="msg-preview muted">{m.preview}</span>
              </button>
            </li>
          ))}
          {!loading && messages.length === 0 && (
            <li className="muted pad">No messages</li>
          )}
        </ul>
      </div>
      <div className="folder-detail">
        {!selected ? (
          <p className="muted pad">Select a message</p>
        ) : (
          <div className="detail-card">
            <h3>{selected.subject || "(no subject)"}</h3>
            <p className="muted">
              From: {selected.from_name || selected.from_email}
              {selected.date ? ` · ${new Date(selected.date).toLocaleString()}` : ""}
            </p>
            {formatAddrList(selected.to) && (
              <p className="muted small">To: {formatAddrList(selected.to)}</p>
            )}
            {formatAddrList(selected.cc) && (
              <p className="muted small">Cc: {formatAddrList(selected.cc)}</p>
            )}
            {formatAddrList(selected.bcc) && (
              <p className="muted small">Bcc: {formatAddrList(selected.bcc)}</p>
            )}
            <div className="detail-actions">
              {folder !== "sent" && (
                <>
                  <button type="button" className="btn" onClick={() => openReply("reply")}>
                    Reply
                  </button>
                  {canReplyAll && (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => openReply("reply_all")}
                    >
                      Reply all
                    </button>
                  )}
                </>
              )}
              {folder !== "trash" && (
                <button type="button" className="btn ghost" onClick={() => void moveTo("trash")}>
                  Trash
                </button>
              )}
              {folder !== "archive" && (
                <button type="button" className="btn ghost" onClick={() => void moveTo("archive")}>
                  Archive
                </button>
              )}
              {folder !== "inbox" && (
                <button type="button" className="btn ghost" onClick={() => void moveTo("inbox")}>
                  Move to inbox
                </button>
              )}
            </div>
            {selected.body_html ? (
              <div
                className="detail-body"
                dangerouslySetInnerHTML={{ __html: selected.body_html }}
              />
            ) : (
              <div className="detail-body pre">
                {selected.body_text || selected.preview || ""}
              </div>
            )}
            {replyOpen && (
              <div className="reply-box">
                <label>{replyMode === "reply_all" ? "Reply all" : "Reply"}</label>
                <label className="small">To</label>
                <input
                  value={replyTo}
                  onChange={(e) => setReplyTo(e.target.value)}
                  placeholder="recipient@example.com"
                />
                <label className="small">Cc</label>
                <input
                  value={replyCc}
                  onChange={(e) => setReplyCc(e.target.value)}
                  placeholder="optional — comma-separated"
                />
                <label className="small">Bcc</label>
                <input
                  value={replyBcc}
                  onChange={(e) => setReplyBcc(e.target.value)}
                  placeholder="optional — comma-separated"
                />
                <label className="small">Message</label>
                <EmailBodyEditor
                  value={replyBody}
                  onChange={setReplyBody}
                  placeholder="Write your reply…"
                  rows={8}
                />
                <div className="detail-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      sending || !emailBodyHasContent(replyBody) || !replyTo.trim()
                    }
                    onClick={() => void sendReply()}
                  >
                    {sending
                      ? "Sending…"
                      : replyMode === "reply_all"
                        ? "Send reply all"
                        : "Send reply"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={sending}
                    onClick={() => setReplyOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
