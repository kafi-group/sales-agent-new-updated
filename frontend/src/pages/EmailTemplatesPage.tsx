import { useCallback, useEffect, useState, type FormEvent } from "react";
import { client, type EmailTemplate } from "../api/client";
import { EmailAttachmentsField } from "../components/EmailAttachmentsField";
import {
  appendEmailPlaceholder,
  EmailBodyEditor,
  emailBodyHasContent,
} from "../components/EmailBodyEditor";
import { HtmlEmailPreview } from "../components/HtmlEmailPreview";
import {
  estimateJsonBytes,
  hostDataUriImagesInHtml,
  htmlHasDataUriImages,
} from "../lib/hostInlineImages";
import {
  emptyTemplateForm,
  PLACEHOLDER_HINTS,
} from "../utils/emailTemplateDefaults";
import { capitalizeFirstLetter } from "../utils/spelling";
import { PictureLibraryManager } from "../components/PictureLibraryManager";
import { CallFollowupsPanel } from "../components/CallFollowupsPanel";
import { CataloguePage } from "./CataloguePage";

interface EmailTemplatesPageProps {
  onError: (message: string) => void;
  onCountChange?: (count: number) => void;
}

export function EmailTemplatesPage({ onError, onCountChange }: EmailTemplatesPageProps) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [templateForm, setTemplateForm] = useState(emptyTemplateForm());
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<"templates" | "pictures" | "followups" | "catalogue">(
    "templates",
  );
  const [pictureCount, setPictureCount] = useState(0);

  const refreshTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await client.listEmailTemplates();
      setTemplates(rows);
      onCountChange?.(rows.length);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [onCountChange, onError]);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  const query = search.trim().toLowerCase();
  const filteredTemplates = query
    ? templates.filter((template) => {
        const haystack = [
          template.name,
          template.subject,
          template.body,
          ...(template.attachments ?? []).map((a) => a.filename || ""),
        ]
          .join("\n")
          .toLowerCase();
        return haystack.includes(query);
      })
    : templates;

  function startCreate() {
    setEditingId(null);
    setTemplateForm(emptyTemplateForm());
    setShowEditor(true);
    setNotice(null);
  }

  function startAiCreate() {
    setEditingId(null);
    setTemplateForm({
      name: "",
      subject: "",
      body: "",
      attachments: [],
    });
    setShowEditor(true);
    setNotice("Enter a template title, then click Generate with AI.");
  }

  async function handleGenerateWithAi() {
    const title = templateForm.name.trim();
    if (title.length < 2) {
      onError("Enter a template title / name first (at least 2 characters).");
      return;
    }
    setGenerating(true);
    setNotice(null);
    try {
      const draft = await client.generateEmailTemplateFromTitle(title);
      setTemplateForm((prev) => ({
        ...prev,
        name: draft.name || title,
        subject: draft.subject,
        body: draft.body,
      }));
      setNotice("AI draft ready — review and edit before saving.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "AI template generation failed");
    } finally {
      setGenerating(false);
    }
  }

  function startEdit(template: EmailTemplate) {
    setEditingId(template.id);
    setTemplateForm({
      name: template.name,
      subject: template.subject,
      body: template.body,
      attachments: template.attachments ?? [],
    });
    setShowEditor(true);
    setNotice(null);
  }

  function cancelEditor() {
    setShowEditor(false);
    setEditingId(null);
    setTemplateForm(emptyTemplateForm());
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!emailBodyHasContent(templateForm.body)) {
      onError("Template body cannot be empty");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      let body = templateForm.body;
      if (htmlHasDataUriImages(body)) {
        setNotice("Uploading pasted images…");
        body = await hostDataUriImagesInHtml(body);
        setTemplateForm((prev) => ({ ...prev, body }));
        if (htmlHasDataUriImages(body)) {
          throw new Error(
            "Some pasted images are still too large to save. Remove them and paste again, or use Attach.",
          );
        }
      }
      const payload = {
        name: templateForm.name,
        subject: templateForm.subject,
        body,
        attachments: templateForm.attachments,
      };
      const bytes = estimateJsonBytes(payload);
      if (bytes > 3_500_000) {
        throw new Error(
          "Template is still too large to save (pasted images). Remove heavy images and try again.",
        );
      }
      if (editingId) {
        await client.updateEmailTemplate(editingId, payload);
        setNotice("Template updated.");
      } else {
        await client.createEmailTemplate(payload);
        setNotice("Template created.");
      }
      setShowEditor(false);
      setEditingId(null);
      setTemplateForm(emptyTemplateForm());
      await refreshTemplates();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(template: EmailTemplate) {
    if (!window.confirm(`Delete template "${template.name}"?`)) return;
    try {
      await client.deleteEmailTemplate(template.id);
      if (editingId === template.id) cancelEditor();
      setNotice("Template deleted.");
      await refreshTemplates();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete template");
    }
  }

  return (
    <section className="space-y-6 w-full min-w-0">
      <div className="flex items-start justify-between gap-4 flex-wrap pb-4 border-b border-slate-800/80">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-xl font-bold tracking-tight text-white">
              {mode === "templates"
                ? "Email templates"
                : mode === "pictures"
                  ? "Picture library"
                  : mode === "followups"
                    ? "Call follow-ups for AI Agents"
                    : "Catalogue"}
            </h2>

            {/* Switchable Mode Toggle */}
            <div className="inline-flex items-center rounded-xl bg-slate-900/90 p-1 border border-slate-700/80 shadow-inner backdrop-blur-sm">
              <button
                type="button"
                onClick={() => setMode("templates")}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
                  mode === "templates"
                    ? "bg-emerald-600 text-white shadow-md shadow-emerald-950/40"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                }`}
              >
                <span>✉️ Email templates</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  mode === "templates" ? "bg-emerald-700/80 text-emerald-100" : "bg-slate-800 text-slate-400"
                }`}>
                  {templates.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMode("pictures")}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
                  mode === "pictures"
                    ? "bg-sky-600 text-white shadow-md shadow-sky-950/40"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                }`}
              >
                <span>🖼️ Picture library</span>
                {pictureCount > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    mode === "pictures" ? "bg-sky-700/80 text-sky-100" : "bg-slate-800 text-slate-400"
                  }`}>
                    {pictureCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setMode("followups")}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
                  mode === "followups"
                    ? "bg-violet-600 text-white shadow-md shadow-violet-950/40"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                }`}
              >
                <span>🤖 Call follow-ups for AI Agents</span>
              </button>

              <button
                type="button"
                onClick={() => setMode("catalogue")}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
                  mode === "catalogue"
                    ? "bg-amber-600 text-white shadow-md shadow-amber-950/40"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                }`}
              >
                <span>📚 Catalogue</span>
              </button>
            </div>
          </div>

          <p className="text-xs text-slate-500 mt-1.5 max-w-2xl">
            {mode === "templates" ? (
              <>
                Create and manage reusable outreach templates here. Use placeholders like{" "}
                <code className="text-slate-400">[company_name]</code> and{" "}
                <code className="text-slate-400">[contact_name]</code> — they are filled in per lead
                when you send from the Leads table.
              </>
            ) : mode === "followups" ? (
              <>
                Situations Sara and Rayan choose from after a call — each situation has a "when to use
                this" description and one or more email drafts.
              </>
            ) : mode === "catalogue" ? (
              <>Product catalogues and brand folios, ready to attach or send.</>
            ) : (
              <>
                Organize product photos, brochures, and company assets into groups. Pictures here can be
                directly inserted into bulk emails and outreach from the Mailer.
              </>
            )}
          </p>
        </div>

        {mode === "templates" && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startAiCreate}
              className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-medium"
            >
              AI create
            </button>
            <button
              type="button"
              onClick={startCreate}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
            >
              + New template
            </button>
          </div>
        )}
      </div>

      {mode === "followups" ? (
        <CallFollowupsPanel onError={onError} />
      ) : mode === "catalogue" ? (
        <CataloguePage initialCatalogueId={null} onError={onError} />
      ) : mode === "pictures" ? (
        <PictureLibraryManager
          onError={onError}
          onTotalPicturesChange={setPictureCount}
        />
      ) : (
        <>
          {notice && (
            <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              {notice}
            </p>
          )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-slate-300">Saved templates</h3>
              <span className="text-xs text-slate-500">
                {query
                  ? `${filteredTemplates.length} of ${templates.length}`
                  : `${templates.length} total`}
              </span>
            </div>
            <label className="block">
              <span className="sr-only">Search templates</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, subject, or body…"
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-slate-500"
              />
            </label>
          </div>
          <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto">
            {loading ? (
              <p className="text-sm text-slate-400">Loading templates…</p>
            ) : templates.length === 0 ? (
              <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
                No templates yet. Click <strong className="text-slate-300">New template</strong> to
                create your first one.
              </p>
            ) : filteredTemplates.length === 0 ? (
              <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
                No templates match “{search.trim()}”. Try a different name, subject, or phrase.
              </p>
            ) : (
              filteredTemplates.map((template) => {
                const isActive = editingId === template.id && showEditor;
                return (
                  <div
                    key={template.id}
                    className={`rounded-lg border p-3 flex items-start justify-between gap-3 ${
                      isActive
                        ? "border-emerald-500/50 bg-emerald-500/10"
                        : "border-slate-800 bg-slate-950"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => startEdit(template)}
                      className="min-w-0 text-left flex-1"
                    >
                      <p className="font-medium text-slate-100">{template.name}</p>
                      <p className="text-sm text-slate-400 truncate mt-0.5">{template.subject}</p>
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2 whitespace-pre-wrap">
                        {template.body}
                      </p>
                      {template.attachments?.length ? (
                        <p className="text-xs text-slate-500 mt-1">
                          {template.attachments.length} attachment
                          {template.attachments.length === 1 ? "" : "s"}
                        </p>
                      ) : null}
                    </button>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(template)}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(template)}
                        className="px-2 py-1 rounded bg-red-900/50 hover:bg-red-800 text-xs text-red-200"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          {showEditor ? (
            <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
              <h3 className="text-sm font-medium text-slate-300">
                {editingId ? "Edit template" : "New template"}
              </h3>
              <label className="block">
                <span className="text-sm text-slate-400">Name / title</span>
                <div className="mt-1 flex flex-col sm:flex-row gap-2">
                  <input
                    required
                    value={templateForm.name}
                    onChange={(e) => setTemplateForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. Follow-up after Gulfood meeting"
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void handleGenerateWithAi()}
                    disabled={generating || templateForm.name.trim().length < 2}
                    className="shrink-0 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-medium disabled:opacity-50"
                    title="Draft subject and body from this title with Gemini"
                  >
                    {generating ? "Generating…" : "Generate with AI"}
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-1.5">
                  Write a short title describing the email, then Generate with AI fills subject and
                  body (with placeholders). Edit before saving.
                </p>
              </label>
              <label className="block">
                <span className="text-sm text-slate-400">Subject</span>
                <input
                  required
                  value={templateForm.subject}
                  onChange={(e) =>
                    setTemplateForm((p) => ({
                      ...p,
                      subject: capitalizeFirstLetter(e.target.value),
                    }))
                  }
                  className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                />
              </label>
              <div>
                <span className="text-sm text-slate-400">Body</span>
                <div className="flex flex-wrap gap-1.5 mt-2 mb-2">
                  {PLACEHOLDER_HINTS.map((token) => (
                    <button
                      key={token}
                      type="button"
                      onClick={() =>
                        setTemplateForm((p) => ({
                          ...p,
                          body: appendEmailPlaceholder(p.body, token),
                        }))
                      }
                      className="px-2 py-0.5 rounded border border-slate-700 bg-slate-800 text-xs text-slate-300 hover:bg-slate-700"
                    >
                      {token}
                    </button>
                  ))}
                </div>
                <EmailBodyEditor
                  rows={12}
                  value={templateForm.body}
                  onChange={(body) => setTemplateForm((p) => ({ ...p, body }))}
                  placeholder="Write the template body…"
                  adaptTextToTheme
                  onAttachFiles={async (files) => {
                    for (const file of files) {
                      try {
                        const uploaded = await client.uploadEmailAttachment(file);
                        setTemplateForm((p) => ({
                          ...p,
                          attachments: [...(p.attachments ?? []), uploaded],
                        }));
                      } catch (err) {
                        onError(err instanceof Error ? err.message : "Failed to attach image");
                      }
                    }
                  }}
                />
                {templateForm.body.trim() ? (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-300">
                        Template preview
                      </span>
                      <span className="text-[10px] text-slate-500">
                        Formatting &amp; images as recipients see them
                      </span>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-2 space-y-2">
                      <p className="text-[11px] text-slate-400 px-1">
                        Subject:{" "}
                        <span className="text-slate-200">
                          {templateForm.subject || "(no subject)"}
                        </span>
                      </p>
                      <HtmlEmailPreview html={templateForm.body} maxHeight={480} />
                    </div>
                  </div>
                ) : null}
              </div>
              <EmailAttachmentsField
                attachments={templateForm.attachments}
                onChange={(attachments) => setTemplateForm((p) => ({ ...p, attachments }))}
                label="Default attachments"
                hint="Included whenever this template is used for outreach."
              />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={cancelEditor}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
                >
                  {saving ? "Saving…" : editingId ? "Update template" : "Save template"}
                </button>
              </div>
            </form>
          ) : (
            <div className="h-full min-h-[280px] flex flex-col items-center justify-center text-center px-4">
              <p className="text-sm text-slate-400">
                Select a template to edit, or create a new one.
              </p>
              <p className="text-xs text-slate-500 mt-2 max-w-sm">
                Templates created here appear in the compose window when sending email from the
                Leads table — preview there, then send.
              </p>
              <div className="mt-4 flex flex-wrap gap-2 justify-center">
                <button
                  type="button"
                  onClick={startAiCreate}
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-medium"
                >
                  AI create
                </button>
                <button
                  type="button"
                  onClick={startCreate}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
                >
                  + New template
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
        </>
      )}
    </section>
  );
}

