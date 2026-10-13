import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type LeadTableRow,
  type WhatsAppCampaignDraftResponse,
  type WhatsAppTemplate,
} from "../api/client";
import { ActionButton } from "./ui/ActionButton";
import {
  IconEye,
  IconSend,
  IconWhatsApp,
  IconX,
} from "./icons/AppIcons";
import { ProseTextarea } from "./ProseTextField";
import { WhatsAppTemplatePreviewModal } from "./WhatsAppTemplatePreviewModal";

type ComposeTab = "personal" | "template";

export interface WhatsAppComposeTarget {
  row: LeadTableRow;
  phone: string;
  /** Open Personal or Template tab first (toolbar quick actions). */
  initialTab?: ComposeTab;
}

interface LeadWhatsAppComposeModalProps {
  target: WhatsAppComposeTarget;
  onClose: () => void;
  onError: (message: string) => void;
  onSent: (message: string) => void;
}

function WhatsAppIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.75 1.53 5.28L2 22l4.94-1.62a9.83 9.83 0 0 0 5.1 1.4h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2Zm5.79 14.06c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.1.11-1.77-.11a15.4 15.4 0 0 1-1.6-.6c-2.82-1.22-4.66-4.07-4.8-4.26-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.35.26-.28.57-.35.76-.35.19 0 .38 0 .55.01.18.01.42-.07.65.5.24.58.81 2 .88 2.14.07.14.12.31.02.5-.1.19-.15.31-.29.48-.14.17-.3.37-.43.5-.14.14-.29.29-.13.57.17.28.75 1.24 1.62 2.01 1.11 1 2.05 1.31 2.34 1.46.29.14.46.12.63-.07.17-.19.72-.83.91-1.12.19-.28.38-.24.65-.14.26.1 1.68.79 1.97.93.29.14.48.21.55.33.07.12.07.71-.17 1.39Z" />
    </svg>
  );
}

export function LeadWhatsAppComposeModal({
  target,
  onClose,
  onError,
  onSent,
}: LeadWhatsAppComposeModalProps) {
  const { row, phone } = target;
  const [tab, setTab] = useState<ComposeTab>(target.initialTab ?? "personal");
  const [sending, setSending] = useState(false);
  const [draftingAi, setDraftingAi] = useState(false);

  const [message, setMessage] = useState(
    `Dear ${row.contact_name || "Sir/Madam"},\n\n` +
      `I hope this message finds you well. We at Kafi Commodities would like to connect with ${row.company_name} regarding our ESSENCE product range.\n\n` +
      `Please let us know if you would like specifications or pricing.\n\n` +
      `Best regards,\nKafi Commodities Export Team`,
  );

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [requireOptIn, setRequireOptIn] = useState(false);
  const [viewingTemplate, setViewingTemplate] = useState<WhatsAppTemplate | null>(null);

  const refreshTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const rows = await client.listWhatsAppTemplates(true);
      setTemplates(rows);
      setTemplateId((current) => {
        if (current && rows.some((t) => String(t.id) === current)) return current;
        return rows.length > 0 ? String(rows[0].id) : "";
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load WhatsApp templates");
    } finally {
      setLoadingTemplates(false);
    }
  }, [onError]);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  const selectedTemplate = templates.find((t) => String(t.id) === templateId);
  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      const haystack = [t.name, t.category, t.language, t.body_text]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [templateSearch, templates]);
  const isMarketing = (selectedTemplate?.category || "").toUpperCase() === "MARKETING";

  useEffect(() => {
    setVariables(Array(selectedTemplate?.variable_count ?? 0).fill(""));
  }, [selectedTemplate]);

  async function handleDraftWithAi() {
    const source = message.trim();
    if (!source) {
      onError("Write or edit the message first, then click Draft with AI.");
      return;
    }
    setDraftingAi(true);
    try {
      const result = await client.rephraseWhatsAppMessage(source);
      if (result.message?.trim()) {
        setMessage(result.message.trim());
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Draft with AI failed");
    } finally {
      setDraftingAi(false);
    }
  }

  async function handleSendPersonal() {
    if (!message.trim()) {
      onError("Message is required");
      return;
    }
    const targetPhone = (phone || "").trim();
    if (!targetPhone) {
      onError("Contact has no phone number.");
      return;
    }
    setSending(true);
    try {
      await client.sendWhatsAppPersonal({
        to_phone: targetPhone,
        message: message.trim(),
      });
      onSent(`WhatsApp message sent to ${row.company_name} via your connected WhatsApp!`);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send WhatsApp message via connected device");
    } finally {
      setSending(false);
    }
  }

  async function handleSendTemplate() {
    if (!templateId) {
      onError("Select an approved template first");
      return;
    }
    const targetPhone = (phone || "").trim();
    if (!targetPhone) {
      onError("Contact has no phone number.");
      return;
    }
    if ((selectedTemplate?.variable_count ?? 0) > 0) {
      const missing = variables.findIndex((v) => !(v || "").trim());
      if (missing >= 0) {
        onError(
          `Fill template variable {{${missing + 1}}} before sending (Meta rejects empty variables).`,
        );
        return;
      }
    }
    setSending(true);
    try {
      const result: WhatsAppCampaignDraftResponse = await client.createWhatsAppCampaignDrafts({
        template_id: Number(templateId),
        buyer_ids: [row.id],
        template_variables: variables,
        require_opt_in: requireOptIn,
        to_phone: targetPhone,
      });
      if ((result.sent_count ?? 0) > 0) {
        onSent(
          `WhatsApp template sent to ${row.company_name} (${targetPhone}). Open WhatsApp inbox to confirm delivered/read.`,
        );
        onClose();
        return;
      }
      const reason =
        result.delivery_error ||
        result.skipped[0]?.reason ||
        result.created[0]?.send_message ||
        "Could not send WhatsApp template — Meta did not deliver the message.";
      const paymentHint = /payment|eligibility|131042/i.test(reason)
        ? " Fix: Meta Business Suite → WhatsApp Account (Essence) → add/assign a payment method, then retry."
        : "";
      onError(`${reason}${paymentHint}`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Failed to send WhatsApp template";
      if (/502|failed to respond|application error/i.test(raw)) {
        onError(
          "Server timed out while talking to Meta (502). Wait a few seconds and try Send again — if it keeps failing, check Railway logs / WhatsApp token.",
        );
      } else {
        onError(raw);
      }
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
        className="w-full sm:max-w-5xl lg:max-w-6xl max-h-[94vh] overflow-hidden flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-whatsapp-title"
      >
        <div className="p-5 sm:p-6 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3
              id="compose-whatsapp-title"
              className="text-xl font-medium text-slate-100 flex items-center gap-2"
            >
              <WhatsAppIcon className="text-emerald-400 h-6 w-6" />
              WhatsApp message
            </h3>
            <p className="text-base text-slate-500 mt-1 truncate">
              To: <span className="text-slate-300">{phone}</span>
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
              onClick={() => setTab("personal")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                tab === "personal"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Personal message
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
              WhatsApp template
            </button>
          </div>
        </div>

        <div className="p-5 sm:p-6 overflow-y-auto overflow-x-hidden flex-1 space-y-4 max-w-full text-base">
          {tab === "personal" ? (
            <>
              <div className="flex items-center gap-2.5 text-sm text-emerald-300 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                <IconWhatsApp size="sm" className="text-emerald-400 shrink-0" />
                <span>
                  Sending directly from your <strong>QR-scanned WhatsApp</strong> to{" "}
                  <strong className="text-white">{phone}</strong>.
                </span>
              </div>
              <label className="block">
                <span className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                  Message
                </span>
                <ProseTextarea
                  rows={14}
                  value={message}
                  onChange={setMessage}
                  className="mt-2 w-full min-h-[280px] rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 text-base text-slate-100 leading-relaxed whitespace-pre-wrap"
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => void handleDraftWithAi()}
                  disabled={draftingAi || sending || !message.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-violet-500/50 bg-violet-600/20 hover:bg-violet-600/30 text-violet-100 text-sm font-semibold disabled:opacity-50 transition"
                >
                  {draftingAi ? "Drafting…" : "✨ Draft with AI"}
                </button>
                <p className="text-xs text-slate-500 max-w-sm text-right leading-snug">
                  Rephrases while keeping paragraph spacing (greeting, body, sign-off).
                </p>
              </div>
              <p className="text-sm text-slate-500">
                Personal messages are sent directly from your connected WhatsApp device to this
                contact.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Select an approved Meta template to send to this lead. Click{" "}
                <strong className="text-cyan-300">View</strong> on any template to read the full message content.
              </p>

              {loadingTemplates ? (
                <p className="text-sm text-slate-400">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
                  No approved templates yet. Open{" "}
                  <strong className="text-slate-300">WhatsApp templates</strong> and sync from Meta.
                </p>
              ) : (
                <>
                  <input
                    type="search"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    placeholder="Search templates by name…"
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                  />
                  <ul className="space-y-2 max-w-full">
                    {filteredTemplates.map((template) => {
                      const selected = String(template.id) === templateId;
                      return (
                        <li key={template.id} className="flex items-center gap-2 max-w-full">
                          <button
                            type="button"
                            onClick={() => setTemplateId(String(template.id))}
                            className={`flex-1 min-w-0 rounded-lg border px-3.5 py-2.5 text-left transition ${
                              selected
                                ? "border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30"
                                : "border-slate-800 bg-slate-950 hover:border-slate-700"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 flex-wrap min-w-0">
                              <span className="font-semibold text-slate-100 text-sm break-words whitespace-normal min-w-0 flex-1">
                                {template.name}
                              </span>
                              <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 font-medium shrink-0">
                                {template.category || "TEMPLATE"}
                              </span>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => setViewingTemplate(template)}
                            className="px-3.5 py-2.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 text-xs font-semibold shrink-0 flex items-center gap-1 transition self-stretch"
                            title="Open full template content in a new window"
                          >
                            <IconEye size="xs" />
                            View
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {filteredTemplates.length === 0 && (
                    <p className="text-sm text-slate-500">No templates match your search.</p>
                  )}
                </>
              )}

              {selectedTemplate && variables.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-slate-400">Template variables</p>
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
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                    />
                  ))}
                </div>
              )}

              {isMarketing && (
                <label className="flex items-start gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={requireOptIn}
                    onChange={(e) => setRequireOptIn(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-950 mt-0.5"
                  />
                  <span>Only send if contact opted in to WhatsApp marketing</span>
                </label>
              )}
            </>
          )}
        </div>

        <div className="p-5 border-t border-slate-800 flex flex-wrap justify-end gap-2 shrink-0">
          <ActionButton icon={IconX} size="md" onClick={onClose} title="Cancel">
            Cancel
          </ActionButton>
          {tab === "personal" ? (
            <ActionButton
              icon={IconSend}
              variant="primary"
              size="md"
              onClick={() => void handleSendPersonal()}
              disabled={sending || draftingAi || !message.trim()}
              title="Send message"
            >
              {sending ? "Sending…" : "Send"}
            </ActionButton>
          ) : (
            <ActionButton
              icon={IconSend}
              variant="primary"
              size="md"
              onClick={() => void handleSendTemplate()}
              disabled={sending || !templateId || templates.length === 0}
              title="Send from template"
            >
              {sending ? "Sending…" : "Send template"}
            </ActionButton>
          )}
        </div>
      </div>

      <WhatsAppTemplatePreviewModal
        template={viewingTemplate}
        onClose={() => setViewingTemplate(null)}
        leadContext={{
          company_name: row.company_name,
          contact_name: row.contact_name,
          country: row.country,
        }}
        onSelectTemplate={(tmpl) => setTemplateId(String(tmpl.id))}
      />
    </div>,
    document.body,
  );
}
