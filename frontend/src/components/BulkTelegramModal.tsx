import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { client, type TelegramPersonalTemplate } from "../api/client";
import { ActionButton } from "./ui/ActionButton";
import { IconSend, IconTelegram, IconX } from "./icons/AppIcons";

interface BulkTelegramModalProps {
  buyerIds: number[];
  onClose: () => void;
  onError: (message: string) => void;
  onCreated: (result: {
    sent_count: number;
    failed_count: number;
    skipped_count: number;
  }) => void;
}

type BulkTab = "message" | "template";

export function BulkTelegramModal({
  buyerIds,
  onClose,
  onError,
  onCreated,
}: BulkTelegramModalProps) {
  const [tab, setTab] = useState<BulkTab>("message");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(
    "Dear {{name}},\n\n" +
      "I hope this message finds you well. We at Kafi Commodities would like to connect with {{company}} regarding our ESSENCE product range.\n\n" +
      "Please let us know if you would like specifications or current pricing.\n\n" +
      "Best regards,\nKafi Commodities Export Team",
  );
  const [templates, setTemplates] = useState<TelegramPersonalTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
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

  const bodyToSend =
    tab === "template" && selectedTemplate ? selectedTemplate.body : message;

  async function handleSend() {
    const text = bodyToSend.trim();
    if (!text) {
      onError("Message body is required.");
      return;
    }
    if (buyerIds.length === 0) {
      onError("No leads selected.");
      return;
    }
    setSending(true);
    try {
      const result = await client.sendTelegramPersonalBulk({
        buyer_ids: buyerIds,
        message: text,
      });
      onCreated(result);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk Telegram send failed");
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
      <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-slate-100 flex items-center gap-2">
              <IconTelegram size="sm" />
              Bulk Telegram ({buyerIds.length})
            </h3>
            <p className="text-sm text-slate-400 mt-1">
              Sends via your connected Telegram Mobile account. Use{" "}
              <code className="text-slate-300">{"{{name}}"}</code> /{" "}
              <code className="text-slate-300">{"{{company}}"}</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800"
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
              tab === "message" ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            Free text
          </button>
          <button
            type="button"
            onClick={() => setTab("template")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              tab === "template" ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            Saved template
          </button>
        </div>

        {tab === "message" ? (
          <textarea
            rows={10}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
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
              <p className="text-sm text-slate-500">Loading…</p>
            ) : filteredTemplates.length === 0 ? (
              <p className="text-sm text-slate-500">No templates yet.</p>
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
                          : "border-slate-800 bg-slate-950"
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
          </div>
        )}

        <div className="flex justify-end gap-2">
          <ActionButton type="button" variant="secondary" icon={IconX} onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton
            type="button"
            icon={IconSend}
            disabled={sending || !bodyToSend.trim()}
            onClick={() => void handleSend()}
          >
            {sending ? "Sending…" : `Send to ${buyerIds.length}`}
          </ActionButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
