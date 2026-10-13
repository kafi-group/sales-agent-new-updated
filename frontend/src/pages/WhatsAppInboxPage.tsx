import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  type DraftInteraction,
  type WhatsAppConfig,
  type WhatsAppConversation,
  type WhatsAppTemplate,
} from "../api/client";
import { IconSearch } from "../components/icons/AppIcons";
import { ProseTextarea } from "../components/ProseTextField";
import { autocorrectText } from "../utils/spelling";
import {
  markWhatsAppThreadSeen,
  whatsAppThreadUnread,
} from "../utils/whatsappRead";

interface WhatsAppInboxPageProps {
  onError: (message: string) => void;
  /** When set (e.g. from buyer profile), open this contact's thread once loaded. */
  initialContactId?: number | null;
  onInitialContactConsumed?: () => void;
}

const POLL_MS = 12_000;

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
  // 1. Display contact person name if available in our master contact list
  if (isCleanName(conv.contact_name, phone)) {
    return conv.contact_name!.trim();
  }
  // 2. If contact name not available then company name
  if (isCleanName(conv.company_name, phone)) {
    return conv.company_name!.trim();
  }
  // 3. If neither, do not display name, just phone number
  return null;
}

function initialsFrom(label: string): string {
  const clean = label.replace(/[\s+\-()_./]/g, "");
  if (!clean || /^\d+$/.test(clean)) return "#";
  return label.trim().charAt(0).toUpperCase() || "?";
}

export function WhatsAppInboxPage({
  onError,
  initialContactId = null,
  onInitialContactConsumed,
}: WhatsAppInboxPageProps) {
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selected, setSelected] = useState<WhatsAppConversation | null>(null);
  const [messages, setMessages] = useState<DraftInteraction[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [needsTemplate, setNeedsTemplate] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const consumedInitialContactRef = useRef<number | null>(null);

  const refreshConversations = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoadingList(true);
      try {
        const result = await client.listWhatsAppConversations({ page: 1, page_size: 50 });
        setConversations(result.rows);
        setSelected((prev) => {
          if (!prev) return prev;
          return result.rows.find((r) => r.contact_id === prev.contact_id) || prev;
        });
      } catch (e) {
        if (!options?.silent) {
          onError(e instanceof Error ? e.message : "Failed to load WhatsApp conversations");
        }
      } finally {
        if (!options?.silent) setLoadingList(false);
      }
    },
    [onError],
  );

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await client.getWhatsAppConfig());
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
    void loadConfig();
  }, [refreshConversations, loadConfig]);

  // Live refresh so inbound webhook messages appear without a manual reload.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshConversations({ silent: true });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshConversations]);

  const loadThread = useCallback(
    async (conversation: WhatsAppConversation, options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setSelected(conversation);
        setNeedsTemplate(false);
        setReply("");
        setLoadingThread(true);
      }
      try {
        const rows = await client.listWhatsAppConversationMessages(conversation.contact_id);
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

  // Deep-link from buyer profile: open a specific contact thread once.
  useEffect(() => {
    if (initialContactId == null) {
      consumedInitialContactRef.current = null;
      return;
    }
    if (loadingList) return;
    if (consumedInitialContactRef.current === initialContactId) return;
    consumedInitialContactRef.current = initialContactId;

    let cancelled = false;

    const openContact = async () => {
      const existing = conversations.find((c) => c.contact_id === initialContactId);
      if (existing) {
        if (!cancelled) {
          await loadThread(existing);
          onInitialContactConsumed?.();
        }
        return;
      }
      try {
        const rows = await client.listWhatsAppConversationMessages(initialContactId);
        if (cancelled) return;
        const last = rows[rows.length - 1];
        const synthetic: WhatsAppConversation = {
          contact_id: initialContactId,
          buyer_id: 0,
          company_name: last?.company_name ?? null,
          contact_name: last?.contact_name ?? "WhatsApp chat",
          contact_phone: last?.contact_phone ?? null,
          whatsapp_opt_in: true,
          within_session_window: true,
          window_expires_at: null,
          last_message: last?.content ?? null,
          last_message_at: last?.created_at ?? null,
          last_direction: last?.direction ?? null,
        };
        setSelected(synthetic);
        setMessages(rows);
        setLoadingThread(false);
        setConversations((prev) =>
          prev.some((c) => c.contact_id === initialContactId)
            ? prev
            : [synthetic, ...prev],
        );
        onInitialContactConsumed?.();
      } catch (e) {
        if (!cancelled) {
          onError(e instanceof Error ? e.message : "Failed to open WhatsApp chat");
          onInitialContactConsumed?.();
        }
      }
    };

    void openContact();
    return () => {
      cancelled = true;
    };
    // Only re-run when the deep-link id or list load state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- conversations snapshot at load time is enough
  }, [initialContactId, loadingList]);

  useEffect(() => {
    if (!selected) return;
    const id = window.setInterval(() => {
      void loadThread(selected, { silent: true });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [selected, loadThread]);

  const selectedTemplate = templates.find((t) => String(t.id) === templateId);

  useEffect(() => {
    setVariables(Array(selectedTemplate?.variable_count ?? 0).fill(""));
  }, [selectedTemplate]);

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

  async function handleSend() {
    if (!selected) return;
    const cleaned = autocorrectText(reply.trim());
    if (!cleaned) return;
    setSending(true);
    setNotice(null);
    try {
      const result = await client.replyToWhatsAppConversation(selected.contact_id, {
        content: cleaned,
        send: true,
        to_phone: selected.contact_phone || undefined,
      });
      if (!result.sent) {
        const message =
          result.send_message || "Send did not complete — Meta may require a template.";
        if (
          result.needs_template ||
          /template|24|window|re-engagement|131047/i.test(message)
        ) {
          setNeedsTemplate(true);
        }
        onError(message);
        await loadThread(selected);
        await refreshConversations({ silent: true });
        return;
      }
      setReply("");
      setNeedsTemplate(false);
      setNotice("Message sent.");
      await loadThread(selected);
      await refreshConversations({ silent: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to send reply";
      if (/template|24|window|re-engagement|131047/i.test(message)) {
        setNeedsTemplate(true);
      } else {
        onError(message);
      }
    } finally {
      setSending(false);
    }
  }

  async function handleSendWithTemplate() {
    if (!selected || !selectedTemplate) {
      onError("Select an approved template first");
      return;
    }
    setSending(true);
    setNotice(null);
    try {
      const result = await client.replyToWhatsAppConversation(selected.contact_id, {
        content: reply || selectedTemplate.body_text || selectedTemplate.name,
        send: true,
        template_name: selectedTemplate.name,
        template_language: selectedTemplate.language,
        template_variables: variables,
        to_phone: selected.contact_phone || undefined,
      });
      await loadThread(selected);
      await refreshConversations({ silent: true });
      if (!result.sent) {
        onError(
          result.send_message ||
            "Template send failed — Meta did not accept the message. Check token, Phone Number ID, and template approval.",
        );
        return;
      }
      setReply("");
      setNeedsTemplate(false);
      setNotice("Template accepted by Meta — wait for delivered/read on the bubble.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send with template");
      if (selected) {
        try {
          await loadThread(selected);
        } catch {
          /* ignore */
        }
      }
    } finally {
      setSending(false);
    }
  }

  const filteredConversations = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conv) => {
      const haystack = [
        conv.company_name,
        conv.contact_name,
        conv.contact_phone,
        conv.last_message,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [chatSearch, conversations]);

  const setupIncomplete =
    config &&
    (!config.configured ||
      !config.webhook_configured ||
      !config.app_secret_set ||
      config.meta_api_ok === false);

  return (
    <section className="space-y-6 w-full min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-slate-100">WhatsApp inbox</h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Two-way WhatsApp on your Business number
            {config?.display_number ? ` (${config.display_number})` : ""}. Replies within 24h of the
            customer&apos;s last message send as free text; outside that window Meta requires an
            approved template.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void refreshConversations();
            if (selected) void loadThread(selected);
            void loadConfig();
          }}
          className="rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2 text-sm text-slate-300"
        >
          Refresh
        </button>
      </div>

      {setupIncomplete ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 space-y-2">
          <p className="font-medium">WhatsApp setup incomplete</p>
          {config?.missing_env?.length ? (
            <p className="text-amber-200/90">
              Missing on the server: {config.missing_env.join(", ")}. Add them to Railway Variables
              (and local <code className="text-amber-100">backend/.env</code>), then restart.
            </p>
          ) : null}
          {config?.meta_api_ok === false ? (
            <p className="text-amber-200/90">
              Meta API check failed: {config.meta_api_message || "invalid token / WABA"}.
            </p>
          ) : null}
          {config?.webhook_callback_url ? (
            <p className="text-amber-200/80 text-xs">
              In Meta App → WhatsApp → Configuration → Webhook, set Callback URL to{" "}
              <code className="text-amber-100 break-all">{config.webhook_callback_url}</code>{" "}
              with your verify token, and subscribe to <strong>messages</strong> +{" "}
              <strong>message_template_status_update</strong>.
            </p>
          ) : (
            <p className="text-amber-200/80 text-xs">
              Set a public API base URL (same as TWILIO_WEBHOOK_BASE_URL) so the webhook callback
              URL can be shown here, then subscribe that URL in Meta.
            </p>
          )}
        </div>
      ) : config?.ready_for_two_way ? (
        <p className="text-xs text-emerald-300/90 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2">
          WhatsApp Cloud API connected
          {config.meta_api_message ? ` — ${config.meta_api_message}` : ""}. Inbound messages appear
          here automatically when Meta delivers webhooks.
        </p>
      ) : null}

      {config?.cloud_sending_enabled === false ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">
          <p className="font-medium">Outbound Meta sends are paused</p>
          <p className="text-xs text-rose-200/90 mt-1">
            {config.cloud_sending_paused_message ||
              "Set WHATSAPP_CLOUD_SENDING_ENABLED=true on Railway to allow replies."}
          </p>
        </div>
      ) : null}

      {config?.phone_number_id_mismatch ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          <p className="font-medium">Business number ID mismatch</p>
          <p className="text-xs text-amber-200/90 mt-1 whitespace-pre-wrap">
            {config.phone_number_id_mismatch}
          </p>
        </div>
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
              <h3 className="text-sm font-medium text-[#e9edef]">Chats</h3>
              <span className="text-xs text-[#8696a0]">
                {chatSearch.trim()
                  ? `${filteredConversations.length} / ${conversations.length}`
                  : conversations.length}
              </span>
            </div>
            <label className="relative block">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8696a0] pointer-events-none">
                <IconSearch size="sm" />
              </span>
              <input
                type="search"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search or start new chat"
                className="w-full rounded-lg border border-[#2a3942] bg-[#2a3942] pl-8 pr-3 py-2 text-sm text-[#e9edef] placeholder:text-[#8696a0]"
              />
            </label>
          </div>
          {loadingList ? (
            <p className="text-sm text-[#8696a0] p-4">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-[#8696a0] p-4">
              No WhatsApp conversations yet. Ask a contact to message{" "}
              {config?.display_number || "your Business number"}, or send an approved template from
              a lead — threads appear here for two-way chat.
            </p>
          ) : filteredConversations.length === 0 ? (
            <p className="text-sm text-[#8696a0] p-4">
              No chats match “{chatSearch.trim()}”.
            </p>
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
                    <p className="text-[15px] font-normal text-[#e9edef] truncate">
                      {chatTitle(conv)}
                    </p>
                    <span className="text-[11px] text-[#8696a0] shrink-0 pt-0.5">
                      {formatChatTime(conv.last_message_at)}
                    </span>
                  </div>
                  {subtitle ? (
                    <p className="text-xs text-[#8696a0] truncate">{subtitle}</p>
                  ) : null}
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
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
              Select a conversation to view messages.
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
                <p className="text-sm font-medium text-[#e9edef]">
                  {chatTitle(selected)}
                </p>
                {chatSubtitle(selected) && (
                  <p className="text-xs text-[#8696a0]">
                    {chatSubtitle(selected)}
                  </p>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[50vh] bg-[#0b141a]">
                {loadingThread ? (
                  <p className="text-sm text-slate-400">Loading messages…</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-slate-500">No messages yet.</p>
                ) : (
                  messages.map((msg) => {
                    const outbound = msg.direction === "outbound";
                    const status = (msg.wa_status || "").toLowerCase();
                    const failed = status === "failed";
                    return (
                    <div
                      key={msg.id}
                      className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                        outbound
                          ? "wa-chat-bubble-out ml-auto"
                          : "wa-chat-bubble-in mr-auto"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                      {failed && msg.wa_send_error ? (
                        <p className="text-[11px] mt-1 text-red-300/90 whitespace-pre-wrap break-words">
                          {msg.wa_send_error}
                        </p>
                      ) : null}
                      <p
                        className={`text-[10px] mt-1 wa-chat-meta ${
                          failed ? "wa-chat-meta-failed" : ""
                        }`}
                      >
                        {formatDate(msg.created_at)}
                        {outbound && msg.wa_status ? ` · ${msg.wa_status}` : ""}
                      </p>
                    </div>
                    );
                  })
                )}
              </div>

              {needsTemplate && (
                <div className="mx-4 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-sm text-amber-200">
                    Outside the 24h reply window — select an approved template to send instead.
                  </p>
                  {templates.length === 0 ? (
                    <p className="text-xs text-amber-200/80">
                      No approved templates synced yet. Open{" "}
                      <strong>WhatsApp templates</strong> and sync from Meta.
                    </p>
                  ) : (
                    <>
                      <select
                        value={templateId}
                        onChange={(e) => setTemplateId(e.target.value)}
                        className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm"
                      >
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.language})
                          </option>
                        ))}
                      </select>
                      {variables.map((value, index) => (
                        <input
                          key={index}
                          value={value}
                          onChange={(e) =>
                            setVariables((prev) =>
                              prev.map((v, i) => (i === index ? e.target.value : v)),
                            )
                          }
                          placeholder={`Variable {{${index + 1}}}`}
                          className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm"
                        />
                      ))}
                      <button
                        type="button"
                        onClick={() => void handleSendWithTemplate()}
                        disabled={sending}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
                      >
                        {sending ? "Sending…" : "Send with template"}
                      </button>
                    </>
                  )}
                </div>
              )}

              <div className="p-4 border-t border-slate-800 flex gap-2">
                <ProseTextarea
                  value={reply}
                  onChange={setReply}
                  onBlur={() => {
                    if (reply.trim()) setReply(autocorrectText(reply));
                  }}
                  rows={2}
                  placeholder={
                    selected.within_session_window
                      ? "Type a personal reply…"
                      : "24h window closed — use a template, or wait for them to message again"
                  }
                  className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={sending || !reply.trim()}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50 self-end"
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
