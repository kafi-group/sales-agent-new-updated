import { useCallback, useEffect, useRef, useState } from "react";
import { client, type ChatMessage } from "../api/client";
import { capitalizeFirstLetter } from "../utils/spelling";
import {
  type AiResearchContactSnapshot,
  type AiResearchReviewItem,
  buildAiResearchPrompt,
  buildAiResearchReviewItems,
} from "../utils/aiResearchUpdate";
import {
  appendAiResearchLog,
} from "../utils/aiResearchLog";
import { recordAiResearchHighlights } from "../utils/aiResearchHighlights";
import type { AiResearchFieldKey } from "../utils/aiResearchUpdate";

interface ChatbotPageProps {
  onError: (msg: string) => void;
  /** Contacts handed off from Modify → AI Research & Update. */
  researchContacts?: AiResearchContactSnapshot[] | null;
  researchSection?: string | null;
  onClearResearchContacts?: () => void;
  /** Return to the same contact list (with these lead IDs still selected). */
  onReturnToTable?: (leadIds?: number[]) => void;
}

function contactLogLabel(snap: AiResearchContactSnapshot): string {
  return (
    snap.company_name?.trim() ||
    snap.contact_name?.trim() ||
    snap.contact_phone?.trim() ||
    `Lead #${snap.id}`
  );
}

function snapshotToLogContact(
  snap: AiResearchContactSnapshot,
  filled?: string[],
  changes?: import("../utils/aiResearchLog").AiResearchLogFieldChange[],
): import("../utils/aiResearchLog").AiResearchLogContact {
  const afterByField = Object.fromEntries(
    (changes ?? []).map((ch) => [ch.field, ch.after]),
  ) as Partial<Record<AiResearchFieldKey, string>>;
  return {
    id: snap.id,
    label: contactLogLabel(snap),
    company_name: snap.company_name || undefined,
    contact_name: snap.contact_name || undefined,
    phone: snap.contact_phone || undefined,
    email: snap.contact_email || undefined,
    filled_fields: filled,
    changes,
    after_company_name: afterByField.company_name || snap.company_name || undefined,
    after_contact_name: afterByField.contact_name || snap.contact_name || undefined,
    after_phone: afterByField.contact_phone || snap.contact_phone || undefined,
    after_email: afterByField.contact_email || snap.contact_email || undefined,
    after_website: afterByField.website_url || snap.website_url || undefined,
    after_address: afterByField.address || snap.address || undefined,
    after_country: afterByField.country || snap.country || undefined,
    after_designation: afterByField.contact_designation || snap.contact_designation || undefined,
    after_industry: afterByField.industry || snap.industry || undefined,
  };
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  imagePreview?: string;
  provider?: string;
  loading?: boolean;
  /** Which CRM contact this research turn belongs to (batch mode). */
  leadId?: number;
}

const COMPANY_DETAILS_PROMPT =
  "Based on the brand or product we discussed above, provide full company details in a clear structured format: " +
  "company name, country, head office address, website, phone, email, contact person, designation, " +
  "social media links, and a short business overview suitable for a sales contact record.";

const WELCOME: UIMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Upload a product image — I'll identify the brand and pull everything about that company: " +
    "contact details, address, website, social media, and company background from the pack and the web.",
};

const ACCEPTED_IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/gif";
const MAX_MB = 10;

function msgId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function contactLabel(snap: AiResearchContactSnapshot): string {
  return (
    snap.company_name?.trim() ||
    snap.contact_name?.trim() ||
    snap.contact_phone?.trim() ||
    `Lead #${snap.id}`
  );
}

function ProviderBadge({ provider }: { provider?: string }) {
  if (!provider) return null;
  const styles: Record<string, string> = {
    gemini: "bg-blue-900/50 text-blue-300 border-blue-700/40",
    openai: "bg-emerald-900/50 text-emerald-300 border-emerald-700/40",
    anthropic: "bg-purple-900/50 text-purple-300 border-purple-700/40",
  };
  const labels: Record<string, string> = {
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Claude",
  };
  const cls = styles[provider] ?? "bg-slate-800 text-slate-400 border-slate-700";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${cls}`}>
      {labels[provider] ?? provider}
    </span>
  );
}

function AssistantAvatar() {
  return (
    <span className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-amber-600/20 border border-amber-600/40 text-amber-400 text-xs font-bold">
      K
    </span>
  );
}

function UserAvatar() {
  return (
    <span className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-slate-700 border border-slate-600 text-slate-300 text-xs font-bold">
      U
    </span>
  );
}

function MessageBubble({
  msg,
  onProvideCompanyDetails,
  detailsLoading,
}: {
  msg: UIMessage;
  onProvideCompanyDetails?: () => void;
  detailsLoading?: boolean;
}) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {isUser ? <UserAvatar /> : <AssistantAvatar />}
      <div className={`max-w-[75%] flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        {msg.imagePreview && (
          <img
            src={msg.imagePreview}
            alt="Uploaded product"
            className="rounded-lg border border-slate-700 max-w-[240px] max-h-[200px] object-cover"
          />
        )}
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isUser
              ? "bg-amber-600 text-white rounded-tr-sm"
              : msg.loading
                ? "bg-slate-800 border border-slate-700 text-slate-400 rounded-tl-sm animate-pulse"
                : "bg-slate-800 border border-slate-700 text-slate-100 rounded-tl-sm"
          }`}
        >
          {msg.loading ? (
            <span className="flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:0ms]" />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:150ms]" />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:300ms]" />
            </span>
          ) : (
            msg.content
          )}
        </div>
        {!isUser && msg.provider && !msg.loading && (
          <div className="flex flex-wrap items-center gap-2 pl-1">
            <ProviderBadge provider={msg.provider} />
            {onProvideCompanyDetails && msg.content.trim().length > 40 ? (
              <button
                type="button"
                disabled={detailsLoading}
                onClick={() => onProvideCompanyDetails()}
                className="text-xs px-2.5 py-1 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
              >
                {detailsLoading ? "Loading…" : "Provide company details"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewModal({
  items,
  saving,
  onCancel,
  onConfirm,
}: {
  items: AiResearchReviewItem[];
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-slate-100">Review updates before saving</h2>
          <p className="text-sm text-slate-400 mt-1">
            Only empty fields will be filled. Existing values stay unchanged.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {items.map((item) => (
            <div key={item.leadId} className="rounded-lg border border-slate-700 bg-slate-950/60 p-4">
              <h3 className="text-sm font-semibold text-emerald-300 mb-3">{item.displayName}</h3>
              <div className="space-y-2">
                {item.changes.map((ch) => (
                  <div
                    key={ch.field}
                    className="grid grid-cols-[7rem_1fr_1fr] gap-2 text-xs sm:text-sm items-start"
                  >
                    <span className="text-slate-400 font-medium pt-0.5">{ch.label}</span>
                    <span className="rounded bg-slate-800/80 px-2 py-1 text-slate-500 line-through decoration-slate-600">
                      {ch.before}
                    </span>
                    <span className="rounded bg-emerald-950/40 border border-emerald-700/40 px-2 py-1 text-emerald-100">
                      {ch.after}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-4 border-t border-slate-800 flex justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save updates"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatbotPage({
  onError,
  researchContacts = null,
  researchSection = null,
  onClearResearchContacts,
  onReturnToTable,
}: ChatbotPageProps) {
  const [messages, setMessages] = useState<UIMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [providers, setProviders] = useState<{
    gemini: boolean;
    openai: boolean;
    anthropic: boolean;
  } | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [batchContacts, setBatchContacts] = useState<AiResearchContactSnapshot[] | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [assistantByLeadId, setAssistantByLeadId] = useState<Record<number, string>>({});
  const [reviewItems, setReviewItems] = useState<AiResearchReviewItem[] | null>(null);
  const [savingReview, setSavingReview] = useState(false);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const batchStartedKey = useRef<string | null>(null);
  const sendLock = useRef(false);

  useEffect(() => {
    client.getChatbotStatus().then(setProviders).catch(() => null);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const messagesRef = useRef<UIMessage[]>([WELCOME]);
  messagesRef.current = messages;

  const clearImage = useCallback(() => {
    setImageFile(null);
    setImagePreview(null);
  }, []);

  const send = useCallback(
    async (opts?: {
      textOverride?: string;
      leadId?: number;
      skipImage?: boolean;
      /** Fresh history for batch passes (avoids stale React state). */
      historyOverride?: ChatMessage[];
    }) => {
      const text = (opts?.textOverride ?? input).trim();
      if (!text || sendLock.current) return null;
      sendLock.current = true;

      const history: ChatMessage[] =
        opts?.historyOverride ??
        messagesRef.current
          .filter((m) => !m.loading && m.id !== "welcome")
          .map((m) => ({ role: m.role, content: m.content }));

      const userMsg: UIMessage = {
        id: msgId(),
        role: "user",
        content: text,
        imagePreview: opts?.textOverride || opts?.skipImage ? undefined : imagePreview ?? undefined,
        leadId: opts?.leadId,
      };
      const thinkingMsg: UIMessage = {
        id: msgId(),
        role: "assistant",
        content: "",
        loading: true,
        leadId: opts?.leadId,
      };

      setMessages((prev) => {
        const next = [...prev, userMsg, thinkingMsg];
        messagesRef.current = next;
        return next;
      });
      if (!opts?.textOverride) {
        setInput("");
        clearImage();
      }
      setSending(true);

      try {
        const resp = await client.sendChatbotMessage({
          message: text,
          image: opts?.textOverride || opts?.skipImage ? undefined : imageFile ?? undefined,
          history,
        });

        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === thinkingMsg.id
              ? {
                  ...m,
                  content: resp.reply,
                  provider: resp.provider,
                  loading: false,
                }
              : m,
          );
          messagesRef.current = next;
          return next;
        });
        if (opts?.leadId != null) {
          setAssistantByLeadId((prev) => ({ ...prev, [opts.leadId!]: resp.reply }));
        }
        return resp.reply;
      } catch (err) {
        const errText =
          err instanceof Error ? err.message : "The product assistant could not respond right now.";
        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === thinkingMsg.id
              ? { ...m, content: `Error: ${errText}`, loading: false }
              : m,
          );
          messagesRef.current = next;
          return next;
        });
        onError(errText);
        return null;
      } finally {
        setSending(false);
        setDetailsLoading(false);
        sendLock.current = false;
      }
    },
    [input, imageFile, imagePreview, onError, clearImage],
  );

  // Kick off sequential research when contacts arrive from the table.
  useEffect(() => {
    if (!researchContacts?.length) return;
    const key = researchContacts.map((c) => c.id).join(",");
    if (batchStartedKey.current === key) return;
    batchStartedKey.current = key;

    setBatchContacts(researchContacts);
    setBatchIndex(0);
    setAssistantByLeadId({});
    setReviewItems(null);
    setBatchNotice(null);
    clearImage();

    const intro: UIMessage = {
      id: msgId(),
      role: "assistant",
      content:
        `I'll research ${researchContacts.length} selected contact${researchContacts.length === 1 ? "" : "s"} ` +
        `one at a time (sensitive — separate pass each). Missing fields only will be proposed for update afterward.\n\n` +
        researchContacts
          .map((c, i) => `${i + 1}. ${contactLabel(c)}`)
          .join("\n"),
    };
    setMessages([intro]);
    messagesRef.current = [intro];

    appendAiResearchLog({
      action: "opened",
      section: researchSection,
      contacts: researchContacts.map((c) => snapshotToLogContact(c)),
      note: `Opened AI Research for ${researchContacts.length} contact(s)`,
    });

    let cancelled = false;
    void (async () => {
      // Each contact gets its own isolated history (no cross-bleed).
      for (let i = 0; i < researchContacts.length; i++) {
        if (cancelled) return;
        setBatchIndex(i);
        const snap = researchContacts[i];
        const prompt = buildAiResearchPrompt(snap);
        await send({
          textOverride: prompt,
          leadId: snap.id,
          skipImage: true,
          historyOverride: [],
        });
      }
      if (cancelled) return;
      setBatchIndex(researchContacts.length);
      setBatchNotice(
        "Research complete. Review with Update Selected Contact List(s), or dig deeper with Provide company details.",
      );
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once per handoff key
  }, [researchContacts]);

  async function requestCompanyDetails(leadId?: number) {
    setDetailsLoading(true);
    // Prefer the lead tagged on the bubble; else last batch contact.
    const linkedLeadId =
      leadId ??
      (batchContacts?.length
        ? batchContacts[Math.min(batchIndex, batchContacts.length - 1)]?.id
        : undefined);
    const reply = await send({
      textOverride: COMPANY_DETAILS_PROMPT,
      skipImage: true,
      leadId: linkedLeadId,
    });
    if (linkedLeadId != null && reply) {
      setAssistantByLeadId((prev) => ({ ...prev, [linkedLeadId]: reply }));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function clearChat() {
    setMessages([WELCOME]);
    clearImage();
    setBatchContacts(null);
    setBatchIndex(0);
    setAssistantByLeadId({});
    setReviewItems(null);
    setBatchNotice(null);
    batchStartedKey.current = null;
    onClearResearchContacts?.();
  }

  function selectImage(file: File) {
    if (file.size > MAX_MB * 1024 * 1024) {
      onError(`Image too large. Max ${MAX_MB} MB.`);
      return;
    }
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) selectImage(f);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) selectImage(f);
  }

  function openUpdateReview() {
    if (!batchContacts?.length) return;
    const items = buildAiResearchReviewItems(batchContacts, assistantByLeadId);
    if (!items.length) {
      onError("No empty fields could be filled from the AI answers yet. Try Provide company details first.");
      return;
    }
    setReviewItems(items);
  }

  async function confirmSaveUpdates() {
    if (!reviewItems?.length) return;
    setSavingReview(true);
    try {
      for (const item of reviewItems) {
        await client.updateLeadTableRow(item.leadId, item.updatePayload, {
          fillMissingOnly: true,
        });
      }
      const savedIds = reviewItems.map((i) => i.leadId);
      const logContacts = reviewItems.map((item) => {
        const snap = batchContacts?.find((c) => c.id === item.leadId);
        const filled = item.changes.map((c) => c.label);
        const changes = item.changes.map((c) => ({
          field: c.field,
          label: c.label,
          before: c.before,
          after: c.after,
        }));
        if (snap) {
          recordAiResearchHighlights(
            item.leadId,
            item.changes.map((c) => c.field),
            {
              company_name: changes.find((c) => c.field === "company_name")?.after || snap.company_name || undefined,
              contact_name: changes.find((c) => c.field === "contact_name")?.after || snap.contact_name || undefined,
              phone: changes.find((c) => c.field === "contact_phone")?.after || snap.contact_phone || undefined,
              email: changes.find((c) => c.field === "contact_email")?.after || snap.contact_email || undefined,
            },
          );
          return snapshotToLogContact(snap, filled, changes);
        }
        recordAiResearchHighlights(
          item.leadId,
          item.changes.map((c) => c.field),
        );
        return {
          id: item.leadId,
          label: item.displayName,
          filled_fields: filled,
          changes,
        };
      });
      appendAiResearchLog({
        action: "saved",
        section: researchSection,
        contacts: logContacts,
        note: `Saved updates for ${reviewItems.length} contact(s)`,
      });
      setReviewItems(null);
      setBatchNotice(`Saved updates for ${reviewItems.length} contact(s). Returning to the list with them still selected…`);
      onClearResearchContacts?.();
      window.setTimeout(() => {
        onReturnToTable?.(savedIds);
      }, 600);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save contact updates");
    } finally {
      setSavingReview(false);
    }
  }

  const activeCount = providers
    ? [providers.gemini, providers.openai, providers.anthropic].filter(Boolean).length
    : 0;

  const batchActive = Boolean(batchContacts?.length);
  const batchDone =
    batchActive && batchIndex >= (batchContacts?.length ?? 0) && !sending;
  const researchedCount = Object.keys(assistantByLeadId).length;

  return (
    <div className="flex flex-col h-[calc(100dvh-6rem)] sm:h-[calc(100vh-5rem)] min-h-[520px] w-full min-w-0">
      <div className="flex items-center justify-between pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">AI Research & Update</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {batchActive
              ? `Updating selected contacts — one research pass each (${Math.min(batchIndex + (sending ? 1 : 0), batchContacts!.length)} / ${batchContacts!.length}).`
              : "Upload a product image for brand identification and full company details first."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {providers && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">
                {activeCount} provider{activeCount !== 1 ? "s" : ""} active
              </span>
              <div className="flex gap-1">
                {[
                  {
                    key: "gemini",
                    label: "G",
                    title: "Gemini Flash",
                    active: providers.gemini,
                    cls: "bg-blue-900/60 border-blue-700/50 text-blue-300",
                  },
                  {
                    key: "openai",
                    label: "O",
                    title: "OpenAI",
                    active: providers.openai,
                    cls: "bg-emerald-900/60 border-emerald-700/50 text-emerald-300",
                  },
                  {
                    key: "anthropic",
                    label: "A",
                    title: "Claude",
                    active: providers.anthropic,
                    cls: "bg-purple-900/60 border-purple-700/50 text-purple-300",
                  },
                ].map((p) => (
                  <span
                    key={p.key}
                    title={`${p.title}: ${p.active ? "configured" : "not configured"}`}
                    className={`w-6 h-6 flex items-center justify-center rounded border text-[10px] font-bold transition-opacity ${p.active ? p.cls : "bg-slate-800 border-slate-700 text-slate-600 opacity-40"}`}
                  >
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={clearChat}
            className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1 rounded border border-slate-700 hover:border-slate-600 transition-colors"
          >
            Clear chat
          </button>
        </div>
      </div>

      {batchActive ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-600/30 bg-amber-950/20 px-3 py-2">
          <span className="text-xs text-amber-100/90">
            {sending
              ? `Researching: ${contactLabel(batchContacts![Math.min(batchIndex, batchContacts!.length - 1)])}`
              : batchDone
                ? `${researchedCount} contact(s) researched`
                : `Queued ${batchContacts!.length} contact(s)`}
          </span>
          <button
            type="button"
            disabled={!researchedCount || sending}
            onClick={openUpdateReview}
            className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40 font-medium"
          >
            Update Selected Contact List(s)
          </button>
        </div>
      ) : null}

      {batchNotice ? (
        <p className="mt-2 text-xs text-emerald-300/90">{batchNotice}</p>
      ) : null}

      <div
        className="flex-1 overflow-y-auto py-6 flex flex-col gap-5"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            detailsLoading={detailsLoading}
            onProvideCompanyDetails={
              msg.role === "assistant" && !msg.loading && msg.id !== "welcome"
                ? () => void requestCompanyDetails(msg.leadId)
                : undefined
            }
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-slate-800 pt-4 flex flex-col gap-3">
        {imagePreview && (
          <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-800/60 border border-slate-700">
            <img
              src={imagePreview}
              alt="Product to analyse"
              className="w-16 h-16 rounded-lg object-cover border border-slate-700 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-400 font-medium truncate">{imageFile?.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {imageFile ? `${(imageFile.size / 1024).toFixed(0)} KB` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={clearImage}
              className="text-slate-500 hover:text-slate-300 text-lg leading-none shrink-0"
              aria-label="Remove image"
            >
              ×
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            title="Upload product image"
            className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            className="hidden"
            onChange={handleFileChange}
          />

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(capitalizeFirstLetter(e.target.value))}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={
              imagePreview
                ? "Ask about this product…"
                : "Upload an image or ask a product question…"
            }
            disabled={sending}
            className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 text-slate-100 placeholder-slate-500 px-4 py-2.5 text-sm focus:outline-none focus:border-amber-600/70 focus:ring-1 focus:ring-amber-600/30 transition-colors disabled:opacity-50 max-h-32 overflow-y-auto"
            style={{ lineHeight: "1.5" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
          />

          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Send"
          >
            {sending ? (
              <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>

        <p className="text-xs text-slate-600 text-center">
          Drag &amp; drop an image anywhere · Enter to send · Shift+Enter for new line
        </p>
      </div>

      {reviewItems ? (
        <ReviewModal
          items={reviewItems}
          saving={savingReview}
          onCancel={() => setReviewItems(null)}
          onConfirm={() => void confirmSaveUpdates()}
        />
      ) : null}
    </div>
  );
}
