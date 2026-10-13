import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  type DraftInteraction,
  type WhatsAppConversation,
} from "../api/client";
import { IconSearch, IconSend, IconWhatsApp } from "../components/icons/AppIcons";
import { ProseTextarea } from "../components/ProseTextField";
import { autocorrectText } from "../utils/spelling";
import {
  markWhatsAppThreadSeen,
  whatsAppThreadUnread,
} from "../utils/whatsappRead";

const POLL_MS = 8_000;

interface WhatsAppPersonalInboxProps {
  connected: boolean;
  connectedPhone?: string | null;
  userName: string;
  onError: (message: string) => void;
  onNeedConnect: () => void;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function formatChatTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isCleanName(val: string | null | undefined, phone?: string | null): boolean {
  if (!val) return false;
  const s = val.trim();
  if (!s) return false;
  const stripped = s.replace(/[\s+\-()_./]/g, "");
  if (!stripped || /^\d+$/.test(stripped)) return false;
  if (phone) {
    const pDigits = phone.replace(/\D/g, "");
    const sDigits = s.replace(/\D/g, "");
    if (pDigits && sDigits && pDigits === sDigits) return false;
  }
  return true;
}

function chatTitle(conv: WhatsAppConversation): string {
  if (conv.contact_phone?.trim()) return conv.contact_phone.trim();
  if (isCleanName(conv.contact_name)) return conv.contact_name!.trim();
  if (isCleanName(conv.company_name)) return conv.company_name!.trim();
  return "Unknown";
}

function chatSubtitle(conv: WhatsAppConversation): string | null {
  const phone = conv.contact_phone || null;
  if (isCleanName(conv.contact_name, phone)) return conv.contact_name!.trim();
  if (isCleanName(conv.company_name, phone)) return conv.company_name!.trim();
  return null;
}

function initialsFrom(label: string): string {
  const clean = label.replace(/[\s+\-()_./]/g, "");
  if (!clean || /^\d+$/.test(clean)) return "#";
  return label.trim().charAt(0).toUpperCase() || "?";
}

export function WhatsAppPersonalInbox({
  connected,
  connectedPhone,
  userName,
  onError,
  onNeedConnect,
}: WhatsAppPersonalInboxProps) {
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selected, setSelected] = useState<WhatsAppConversation | null>(null);
  const [messages, setMessages] = useState<DraftInteraction[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newMessage, setNewMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const listLock = useRef(false);

  const refreshConversations = useCallback(
    async (options?: { silent?: boolean }) => {
      if (listLock.current) return [] as WhatsAppConversation[];
      listLock.current = true;
      if (!options?.silent) setLoadingList(true);
      try {
        const result = await client.listWhatsAppPersonalConversations({ page: 1, page_size: 80 });
        setConversations(result.rows);
        setSelected((prev) => {
          if (!prev) return prev;
          return result.rows.find((r) => r.contact_id === prev.contact_id) || prev;
        });
        return result.rows;
      } catch (e) {
        if (!options?.silent) {
          onError(e instanceof Error ? e.message : "Failed to load personal WhatsApp chats");
        }
        return [] as WhatsAppConversation[];
      } finally {
        if (!options?.silent) setLoadingList(false);
        listLock.current = false;
      }
    },
    [onError],
  );

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    if (!connected) return;
    const id = window.setInterval(() => {
      void refreshConversations({ silent: true });
      if (selected) {
        void client
          .listWhatsAppPersonalMessages(selected.contact_id)
          .then(setMessages)
          .catch(() => {});
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [connected, refreshConversations, selected]);

  const loadThread = useCallback(
    async (conversation: WhatsAppConversation, options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setSelected(conversation);
        setReply("");
        setLoadingThread(true);
      }
      try {
        const rows = await client.listWhatsAppPersonalMessages(conversation.contact_id);
        setMessages(rows);
        markWhatsAppThreadSeen(conversation.contact_id, conversation.last_message_at);
        void refreshConversations({ silent: true });
      } catch (e) {
        if (!options?.silent) {
          onError(e instanceof Error ? e.message : "Failed to load conversation");
        }
      } finally {
        if (!options?.silent) setLoadingThread(false);
      }
    },
    [onError, refreshConversations],
  );

  const filteredConversations = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conv) => {
      const hay = `${conv.contact_phone || ""} ${conv.contact_name || ""} ${conv.company_name || ""} ${conv.last_message || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [chatSearch, conversations]);

  async function handleSend() {
    if (!selected || !reply.trim()) return;
    if (!connected) {
      onNeedConnect();
      onError("Scan WhatsApp first — this inbox sends from your linked phone.");
      return;
    }
    setSending(true);
    try {
      const text = autocorrectText(reply.trim());
      await client.replyWhatsAppPersonalConversation(selected.contact_id, text);
      setReply("");
      await loadThread(selected, { silent: true });
      await refreshConversations({ silent: true });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send WhatsApp reply");
    } finally {
      setSending(false);
    }
  }

  async function handleStartChat() {
    const phone = newPhone.trim();
    const text = newMessage.trim();
    if (!phone || !text) {
      onError("Enter a phone number and a first message.");
      return;
    }
    if (!connected) {
      onNeedConnect();
      onError("Scan WhatsApp first — this inbox sends from your linked phone.");
      return;
    }
    setStarting(true);
    try {
      await client.sendWhatsAppPersonal({ to_phone: phone, message: text });
      setNewPhone("");
      setNewMessage("");
      setNotice(`Sent from ${userName}'s WhatsApp.`);
      const rows = await refreshConversations();
      const digits = phone.replace(/\D/g, "");
      const match = (rows || []).find((r) => {
        const other = (r.contact_phone || "").replace(/\D/g, "");
        return Boolean(digits && other && (other.endsWith(digits) || digits.endsWith(other)));
      });
      if (match) void loadThread(match);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to start chat");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      {!connected ? (
        <p className="text-sm text-amber-200 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          Phone is not linked. Open{" "}
          <button type="button" onClick={onNeedConnect} className="underline font-semibold">
            Scan &amp; connect
          </button>{" "}
          and scan QR — then chats and replies will appear here.
        </p>
      ) : null}

      {notice ? (
        <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          {notice}
        </p>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-[minmax(300px,380px)_1fr] gap-0 rounded-xl border border-[#2a3942] bg-[#111b21] overflow-hidden min-h-[min(78vh,640px)]">
        <div
          className={`border-r border-[#2a3942] overflow-y-auto max-h-[78vh] bg-[#111b21] ${
            selected ? "hidden md:block" : ""
          }`}
        >
          <div className="px-3 py-3 border-b border-[#2a3942] sticky top-0 bg-[#202c33] space-y-2 z-[1]">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-[#e9edef]">Chats</h3>
                {connectedPhone ? (
                  <p className="text-[11px] text-[#8696a0] font-mono truncate">{connectedPhone}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8696a0]">
                  {chatSearch.trim()
                    ? `${filteredConversations.length} / ${conversations.length}`
                    : conversations.length}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void refreshConversations();
                    if (selected) void loadThread(selected);
                  }}
                  className="text-xs text-[#8696a0] hover:text-[#e9edef]"
                >
                  Refresh
                </button>
              </div>
            </div>
            <label className="relative block">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8696a0] pointer-events-none">
                <IconSearch size="sm" />
              </span>
              <input
                type="search"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search chats"
                className="w-full rounded-lg border border-[#2a3942] bg-[#2a3942] pl-8 pr-3 py-2 text-sm text-[#e9edef] placeholder:text-[#8696a0]"
              />
            </label>
            <div className="space-y-1.5 pt-1">
              <p className="text-[11px] text-[#8696a0] font-semibold uppercase tracking-wide">New chat</p>
              <input
                type="text"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="+971501234567"
                className="w-full rounded-lg border border-[#2a3942] bg-[#2a3942] px-3 py-1.5 text-sm text-[#e9edef] placeholder:text-[#8696a0] font-mono"
              />
              <input
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="First message"
                className="w-full rounded-lg border border-[#2a3942] bg-[#2a3942] px-3 py-1.5 text-sm text-[#e9edef] placeholder:text-[#8696a0]"
              />
              <button
                type="button"
                onClick={() => void handleStartChat()}
                disabled={starting || !newPhone.trim() || !newMessage.trim()}
                className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-xs font-semibold text-white py-1.5"
              >
                {starting ? "Sending…" : "Start chat"}
              </button>
            </div>
          </div>
          {loadingList ? (
            <p className="text-sm text-[#8696a0] p-4">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-[#8696a0] p-4">
              No personal chats yet. Send a test message from Scan &amp; connect, start a chat here,
              or wait for a reply on the linked phone.
            </p>
          ) : filteredConversations.length === 0 ? (
            <p className="text-sm text-[#8696a0] p-4">No chats match “{chatSearch.trim()}”.</p>
          ) : (
            filteredConversations.map((conv) => {
              const unread = whatsAppThreadUnread(conv);
              const active = selected?.contact_id === conv.contact_id;
              const subtitle = chatSubtitle(conv);
              return (
                <button
                  key={conv.contact_id}
                  type="button"
                  onClick={() => void loadThread(conv)}
                  className={`w-full text-left px-3 py-3 border-b border-[#2a3942]/70 flex gap-3 items-start hover:bg-[#202c33] ${
                    active ? "bg-[#2a3942]" : ""
                  }`}
                >
                  <div className="w-12 h-12 rounded-full bg-[#6b7178] text-[#e9edef] flex items-center justify-center text-sm font-medium shrink-0">
                    {initialsFrom(subtitle || chatTitle(conv))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[15px] font-normal text-[#e9edef] truncate">{chatTitle(conv)}</p>
                      <span className="text-[11px] text-[#8696a0] shrink-0 pt-0.5">
                        {formatChatTime(conv.last_message_at)}
                      </span>
                    </div>
                    {subtitle ? <p className="text-xs text-[#8696a0] truncate">{subtitle}</p> : null}
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <p className="text-sm text-[#8696a0] truncate">
                        {conv.last_direction === "inbound" ? "" : "You: "}
                        {conv.last_message || "No messages yet"}
                      </p>
                      {unread > 0 ? (
                        <span className="shrink-0 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[#25d366] text-[#111b21] text-xs font-semibold flex items-center justify-center">
                          {unread > 99 ? "99+" : unread}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div
          className={`flex flex-col min-h-[min(78vh,640px)] bg-[#0b141a] ${
            selected ? "" : "hidden md:flex"
          }`}
        >
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-slate-500 px-6 text-center">
              <IconWhatsApp className="w-10 h-10 text-emerald-500/50" />
              <p>Select a conversation to read messages.</p>
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-[#2a3942] bg-[#202c33]">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="md:hidden text-sm text-[#8696a0] hover:text-[#e9edef] mb-2"
                >
                  ← Back to list
                </button>
                <p className="text-sm font-medium text-[#e9edef]">{chatTitle(selected)}</p>
                {chatSubtitle(selected) ? (
                  <p className="text-xs text-[#8696a0]">{chatSubtitle(selected)}</p>
                ) : null}
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[50vh] bg-[#0b141a]">
                {loadingThread ? (
                  <p className="text-sm text-slate-400">Loading messages…</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-slate-500">No messages yet.</p>
                ) : (
                  messages.map((msg) => {
                    const outbound = msg.direction === "outbound";
                    return (
                      <div
                        key={msg.id}
                        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                          outbound ? "wa-chat-bubble-out ml-auto" : "wa-chat-bubble-in mr-auto"
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                        <p className="text-[10px] mt-1 wa-chat-meta">{formatDate(msg.created_at)}</p>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="p-4 border-t border-slate-800 flex gap-2">
                <ProseTextarea
                  value={reply}
                  onChange={setReply}
                  onBlur={() => {
                    if (reply.trim()) setReply(autocorrectText(reply));
                  }}
                  rows={2}
                  placeholder={connected ? "Type a reply…" : "Scan WhatsApp to reply"}
                  className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={sending || !reply.trim()}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50 self-end inline-flex items-center gap-1.5"
                >
                  <IconSend size="sm" />
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
