import { useCallback, useEffect, useState } from "react";
import {
  client,
  type DraftInteraction,
  type WhatsAppBuyerPreview,
} from "../api/client";
import { IconWhatsApp } from "./icons/AppIcons";

interface WhatsAppChatPreviewPanelProps {
  buyerId: number;
  companyName: string;
  onError: (message: string) => void;
  /** Open WhatsApp inbox focused on this contact's full thread. */
  onViewAllMessages?: (contactId: number) => void;
}

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function previewText(content: string | null | undefined): string {
  const text = (content || "").replace(/\s+/g, " ").trim();
  if (!text) return "—";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function MessageBubble({ message }: { message: DraftInteraction }) {
  const inbound = message.direction === "inbound";
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
          inbound
            ? "bg-slate-800 text-slate-100 rounded-bl-md"
            : "bg-emerald-700/40 border border-emerald-600/30 text-emerald-50 rounded-br-md"
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{previewText(message.content)}</p>
        <p
          className={`mt-1 text-[10px] ${
            inbound ? "text-slate-500" : "text-emerald-200/70"
          }`}
        >
          {inbound ? "Them" : "You"}
          {message.created_at ? ` · ${formatWhen(message.created_at)}` : ""}
        </p>
      </div>
    </div>
  );
}

export function WhatsAppChatPreviewPanel({
  buyerId,
  companyName,
  onError,
  onViewAllMessages,
}: WhatsAppChatPreviewPanelProps) {
  const [preview, setPreview] = useState<WhatsAppBuyerPreview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPreview(await client.getWhatsAppBuyerPreview(buyerId, 3));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load WhatsApp chat");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [buyerId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasChat = Boolean(preview?.contact_id && (preview.total_messages || 0) > 0);
  const messages = preview?.messages || [];

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <IconWhatsApp size="sm" className="text-emerald-400 shrink-0" />
            <h3 className="text-sm font-medium text-slate-100">WhatsApp chat</h3>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Recent messages with {companyName}
            {preview?.contact_name ? ` · ${preview.contact_name}` : ""}
            {preview?.contact_phone ? ` · ${preview.contact_phone}` : ""}.
          </p>
        </div>
        {hasChat && preview?.contact_id != null && onViewAllMessages ? (
          <button
            type="button"
            onClick={() => onViewAllMessages(preview.contact_id!)}
            className="shrink-0 rounded-lg border border-emerald-700/50 bg-emerald-600/15 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-600/25"
          >
            View all messages
            {preview.total_messages > messages.length
              ? ` (${preview.total_messages})`
              : ""}
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading chat…</p>
      ) : !hasChat ? (
        <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 px-3 py-4">
          No WhatsApp conversation yet for this client. Threads appear here after a template
          send or when they message your Business number.
        </p>
      ) : (
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {preview && preview.total_messages > messages.length ? (
            <p className="text-[11px] text-slate-500 text-center pt-1">
              Showing last {messages.length} of {preview.total_messages} messages
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
