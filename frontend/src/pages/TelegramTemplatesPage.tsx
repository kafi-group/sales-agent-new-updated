import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { client, type TelegramPersonalTemplate } from "../api/client";
import { IconEdit, IconSearch, IconTrash } from "../components/icons/AppIcons";

interface TelegramTemplatesPageProps {
  onError: (message: string) => void;
}

const DEFAULT_BODY =
  "Dear {{name}},\n\n" +
  "I hope this message finds you well. We at Kafi Commodities would like to connect with {{company}} regarding our ESSENCE product range.\n\n" +
  "Please let us know if you would like specifications or current pricing.\n\n" +
  "Best regards,\nKafi Commodities Export Team";

export function TelegramTemplatesPage({ onError }: TelegramTemplatesPageProps) {
  const [templates, setTemplates] = useState<TelegramPersonalTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showCreator, setShowCreator] = useState(false);
  const [name, setName] = useState("ESSENCE introduction");
  const [body, setBody] = useState(DEFAULT_BODY);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await client.listTelegramPersonalTemplates();
      setTemplates(rows);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load Telegram templates");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => `${t.name} ${t.body}`.toLowerCase().includes(q));
  }, [search, templates]);

  function resetForm() {
    setName("ESSENCE introduction");
    setBody(DEFAULT_BODY);
    setEditingId(null);
    setShowCreator(false);
  }

  function startCreate() {
    setEditingId(null);
    setName("new_telegram_template");
    setBody(DEFAULT_BODY);
    setShowCreator(true);
    setNotice(null);
  }

  function startEdit(template: TelegramPersonalTemplate) {
    setEditingId(template.id);
    setName(template.name);
    setBody(template.body);
    setShowCreator(true);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) {
      onError("Name and message body are required.");
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      if (editingId != null) {
        await client.updateTelegramPersonalTemplate(editingId, {
          name: trimmedName,
          body: trimmedBody,
        });
        setNotice("Telegram template updated.");
      } else {
        await client.createTelegramPersonalTemplate({
          name: trimmedName,
          body: trimmedBody,
        });
        setNotice("Telegram template created.");
      }
      resetForm();
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save Telegram template");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(template: TelegramPersonalTemplate) {
    const confirmed = window.confirm(`Delete Telegram template “${template.name}”?`);
    if (!confirmed) return;
    setDeletingId(template.id);
    setNotice(null);
    try {
      await client.deleteTelegramPersonalTemplate(template.id);
      if (editingId === template.id) resetForm();
      setNotice("Telegram template deleted.");
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete Telegram template");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Telegram templates</h2>
          <p className="text-sm text-slate-500 max-w-2xl mt-1">
            Free-text templates for Telegram Mobile. Use{" "}
            <code className="text-slate-300 bg-slate-800 px-1 rounded">{"{{name}}"}</code> and{" "}
            <code className="text-slate-300 bg-slate-800 px-1 rounded">{"{{company}}"}</code> for
            per-recipient personalization.
          </p>
        </div>
        <button
          type="button"
          onClick={() => (showCreator ? resetForm() : startCreate())}
          className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm font-medium shrink-0"
        >
          {showCreator ? "Close creator" : "Create Telegram template"}
        </button>
      </div>

      {notice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
          {notice}
        </div>
      )}

      {showCreator && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-3"
        >
          <h3 className="text-sm font-semibold text-slate-200">
            {editingId != null ? "Edit Telegram template" : "New Telegram template"}
          </h3>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Message body</label>
            <textarea
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 leading-relaxed"
              required
            />
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                type="button"
                onClick={() => setBody((prev) => `${prev}{{name}}`)}
                className="px-2 py-1 rounded bg-slate-800 text-xs font-mono text-slate-200 border border-slate-700"
              >
                + {"{{name}}"}
              </button>
              <button
                type="button"
                onClick={() => setBody((prev) => `${prev}{{company}}`)}
                className="px-2 py-1 rounded bg-slate-800 text-xs font-mono text-slate-200 border border-slate-700"
              >
                + {"{{company}}"}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={resetForm}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-sm text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-medium text-white disabled:opacity-50"
            >
              {submitting ? "Saving…" : editingId != null ? "Save changes" : "Create template"}
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-medium text-slate-200">
            Templates <span className="text-slate-500 font-normal">({templates.length})</span>
          </h3>
          <div className="relative min-w-[220px] flex-1 max-w-md">
            <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size="sm" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates…"
              className="w-full rounded-lg bg-slate-950 border border-slate-700 pl-9 pr-3 py-2 text-sm text-slate-200 placeholder-slate-500"
            />
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-slate-500 py-6 text-center">Loading Telegram templates…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-6 text-center">
            {templates.length === 0
              ? "No Telegram templates yet. Create one to reuse in compose and bulk send."
              : "No templates match your search."}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((template) => (
              <li
                key={template.id}
                className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 flex items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-100">{template.name}</p>
                  <p className="text-xs text-slate-400 mt-1 line-clamp-3 whitespace-pre-wrap">
                    {template.body}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(template)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 text-xs font-medium border border-sky-500/30"
                  >
                    <IconEdit size="sm" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(template)}
                    disabled={deletingId === template.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-300 text-xs font-medium border border-red-500/30 disabled:opacity-50"
                  >
                    <IconTrash size="sm" />
                    {deletingId === template.id ? "…" : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
