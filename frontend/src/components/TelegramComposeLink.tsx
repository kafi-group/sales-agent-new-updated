import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type LeadTableRow,
  type TelegramPersonalTemplate,
} from "../api/client";
import { ActionButton } from "./ui/ActionButton";
import { IconSend, IconTelegram, IconX } from "./icons/AppIcons";
import { ProseTextarea } from "./ProseTextField";

type ComposeTab = "message" | "template";

export interface TelegramComposeTarget {
  row: LeadTableRow;
  phone: string;
  initialTab?: ComposeTab;
  initialMessage?: string;
}

interface LeadTelegramComposeModalProps {
  target: TelegramComposeTarget;
  onClose: () => void;
  onError: (message: string) => void;
  onSent: (message: string) => void;
}

export function LeadTelegramComposeModal({
  target,
  onClose,
  onError,
  onSent,
}: LeadTelegramComposeModalProps) {
  const { row, phone } = target;
  const [tab, setTab] = useState<ComposeTab>(target.initialTab ?? "message");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(
    target.initialMessage ||
      `Dear ${row.contact_name || "Sir/Madam"},\n\n` +
        `I hope this message finds you well. We at Kafi Commodities would like to connect with ${row.company_name} regarding our ESSENCE product range.\n\n` +
        `Please let us know if you would like specifications or pricing.\n\n` +
        `Best regards,\nKafi Commodities Export Team`,
  );
  const [templates, setTemplates] = useState<TelegramPersonalTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");

  const refreshTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const rows = await client.listTelegramPersonalTemplates();
      setTemplates(rows);
      setTemplateId((current) => {
        if (current && rows.some((t) => String(t.id) === current)) return current;
        return rows.length > 0 ? String(rows[0].id) : "";
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load Telegram templates");
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
    return templates.filter((t) => `${t.name} ${t.body}`.toLowerCase().includes(q));
  }, [templateSearch, templates]);

  const bodyToSend = useMemo(() => {
    if (tab === "template" && selectedTemplate) {
      return selectedTemplate.body
        .replace(/\{\{name\}\}/gi, row.contact_name || "Sir/Madam")
        .replace(/\{\{contact_name\}\}/gi, row.contact_name || "Sir/Madam")
        .replace(/\{\{company\}\}/gi, row.company_name || "")
        .replace(/\{\{company_name\}\}/gi, row.company_name || "");
    }
    return message;
  }, [tab, selectedTemplate, message, row.contact_name, row.company_name]);

  async function handleSend() {
    const text = bodyToSend.trim();
    if (!text) {
      onError("Message body is required.");
      return;
    }
    setSending(true);
    try {
      await client.sendTelegramPersonal(phone.trim(), text);
      onSent(`Telegram sent to ${phone.trim()} for ${row.company_name || "lead"}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send Telegram");
    } finally {
      setSending(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-labelledby="tg-compose-title"
        className="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="tg-compose-title" className="text-base font-medium text-slate-100 flex items-center gap-2">
              <IconTelegram size="sm" />
              Send Telegram
            </h3>
            <p className="text-sm text-slate-400 mt-1">
              {row.company_name || "Lead"} · {phone}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            <IconX size="sm" />
          </button>
        </div>

        <div className="flex gap-2 border-b border-slate-800 pb-2">
          <button
            type="button"
            onClick={() => setTab("message")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              tab === "message"
                ? "bg-sky-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            Free text
          </button>
          <button
            type="button"
            onClick={() => setTab("template")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              tab === "template"
                ? "bg-sky-600 text-white"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            Saved template
          </button>
        </div>

        {tab === "message" ? (
          <ProseTextarea
            value={message}
            onChange={setMessage}
            rows={10}
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100"
          />
        ) : (
          <div className="space-y-3">
            <input
              type="search"
              value={templateSearch}
              onChange={(e) => setTemplateSearch(e.target.value)}
              placeholder="Search templates…"
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
            />
            {loadingTemplates ? (
              <p className="text-sm text-slate-500">Loading templates…</p>
            ) : filteredTemplates.length === 0 ? (
              <p className="text-sm text-slate-500">
                No Telegram templates yet. Create one under Telegram templates.
              </p>
            ) : (
              <ul className="space-y-2 max-h-56 overflow-y-auto">
                {filteredTemplates.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setTemplateId(String(t.id))}
                      className={`w-full text-left rounded-lg border px-3 py-2 ${
                        templateId === String(t.id)
                          ? "border-sky-500 bg-sky-500/10"
                          : "border-slate-800 bg-slate-950 hover:border-slate-600"
                      }`}
                    >
                      <p className="text-sm font-medium text-slate-100">{t.name}</p>
                      <p className="text-xs text-slate-400 line-clamp-2 mt-0.5 whitespace-pre-wrap">
                        {t.body}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedTemplate ? (
              <pre className="text-xs text-slate-300 whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-3 max-h-40 overflow-y-auto">
                {bodyToSend}
              </pre>
            ) : null}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <ActionButton type="button" variant="secondary" icon={IconX} onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton
            type="button"
            icon={IconSend}
            disabled={sending || !bodyToSend.trim()}
            onClick={() => void handleSend()}
          >
            {sending ? "Sending…" : "Send Telegram"}
          </ActionButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
