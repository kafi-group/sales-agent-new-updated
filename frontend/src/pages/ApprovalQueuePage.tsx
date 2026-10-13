import { useEffect, useState } from "react";
import { client, type DraftInteraction, type WhatsAppTemplate } from "../api/client";
import { EmailBodyEditor } from "../components/EmailBodyEditor";
import { Pagination } from "../components/Pagination";
import { ProseTextarea } from "../components/ProseTextField";
import { useDrafts } from "../hooks/useDrafts";

interface ApprovalQueuePageProps {
  onError: (message: string) => void;
  onCountChange?: (count: number) => void;
}

const PAGE_SIZE = 20;

function ChannelBadge({ channel }: { channel: string }) {
  const styles: Record<string, string> = {
    email: "bg-sky-500/10 border-sky-500/30 text-sky-300",
    whatsapp: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs border capitalize ${
        styles[channel] ?? "bg-slate-700/50 border-slate-600 text-slate-400"
      }`}
    >
      {channel}
    </span>
  );
}

function DraftCard({
  draft,
  onError,
  onHandled,
}: {
  draft: DraftInteraction;
  onError: (message: string) => void;
  onHandled: () => void;
}) {
  const [content, setContent] = useState(draft.content);
  const [busy, setBusy] = useState(false);
  const [needsTemplate, setNeedsTemplate] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<string[]>([]);

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

  const selectedTemplate = templates.find((t) => String(t.id) === templateId);

  useEffect(() => {
    setVariables(Array(selectedTemplate?.variable_count ?? 0).fill(""));
  }, [selectedTemplate]);

  async function handleApprove() {
    setBusy(true);
    try {
      await client.approveDraft(draft.id, content, true);
      onHandled();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Approve failed";
      if (draft.channel === "whatsapp" && /template/i.test(message)) {
        setNeedsTemplate(true);
      } else {
        onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSendWithTemplate() {
    if (!selectedTemplate) {
      onError("Select an approved template first");
      return;
    }
    setBusy(true);
    try {
      await client.approveDraft(draft.id, content, true, {
        template_name: selectedTemplate.name,
        template_language: selectedTemplate.language,
        template_variables: variables,
      });
      onHandled();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Send with template failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    setBusy(true);
    try {
      await client.rejectDraft(draft.id);
      onHandled();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <ChannelBadge channel={draft.channel} />
            <p className="font-medium text-slate-100 truncate">
              {draft.company_name || "Unknown lead"}
            </p>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {draft.contact_name}
            {draft.channel === "email" && draft.contact_email ? ` · ${draft.contact_email}` : ""}
            {draft.channel === "whatsapp" && draft.contact_phone
              ? ` · ${draft.contact_phone}`
              : ""}
          </p>
          {draft.subject && <p className="text-sm text-slate-300 mt-1">{draft.subject}</p>}
        </div>
        <p className="text-xs text-slate-600 shrink-0">
          {new Date(draft.created_at).toLocaleString()}
        </p>
      </div>

      {draft.channel === "email" ? (
        <EmailBodyEditor
          value={content}
          onChange={setContent}
          rows={5}
          placeholder="Edit the email draft…"
        />
      ) : (
        <ProseTextarea
          value={content}
          onChange={setContent}
          rows={5}
          className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200"
        />
      )}

      {needsTemplate && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
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
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send with template"}
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => void handleReject()}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-sm disabled:opacity-50"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => void handleApprove()}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Sending…" : "Approve & send"}
        </button>
      </div>
    </div>
  );
}

export function ApprovalQueuePage({ onError, onCountChange }: ApprovalQueuePageProps) {
  const [page, setPage] = useState(1);
  const { drafts, total, totalPages, loading, refresh } = useDrafts({
    page,
    pageSize: PAGE_SIZE,
  });

  useEffect(() => {
    onCountChange?.(total);
  }, [total, onCountChange]);

  return (
    <section className="space-y-6 w-full min-w-0">
      <div>
        <h2 className="text-lg font-medium text-slate-100">Approval queue</h2>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl">
          Every outbound message — email or WhatsApp — waits here for a human review before it is
          sent. Edit the content if needed, then approve or reject.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-300">Pending drafts</h3>
          <span className="text-xs text-slate-500">{total} total</span>
        </div>
        <div className="p-4 space-y-3">
          {loading ? (
            <p className="text-sm text-slate-400">Loading drafts…</p>
          ) : drafts.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
              No pending drafts — new outreach and bulk campaigns will appear here for approval.
            </p>
          ) : (
            drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                onError={onError}
                onHandled={() => void refresh()}
              />
            ))
          )}
        </div>
        <div className="px-4 pb-4">
          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            disabled={loading}
          />
        </div>
      </div>
    </section>
  );
}
