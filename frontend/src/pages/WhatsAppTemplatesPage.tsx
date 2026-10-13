import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  client,
  type WhatsAppConfig,
  type WhatsAppTemplate,
  type WhatsAppTemplateCreatePayload,
  type WhatsAppTemplateNotification,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { IconChevronDown, IconCopy, IconEdit, IconEye, IconSearch, IconTrash } from "../components/icons/AppIcons";
import { WhatsAppPersonalTemplatesPanel } from "../components/WhatsAppPersonalTemplatesPanel";
import { WhatsAppTemplatePreviewModal } from "../components/WhatsAppTemplatePreviewModal";
import { capitalizeFirstLetter } from "../utils/spelling";

interface WhatsAppTemplatesPageProps {
  onError: (message: string) => void;
  onCountChange?: (count: number) => void;
}

type LibraryTab = "meta" | "personal";

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  pending: "bg-amber-500/10 border-amber-500/30 text-amber-300",
  rejected: "bg-red-500/10 border-red-500/30 text-red-300",
  paused: "bg-slate-700/50 border-slate-600 text-slate-400",
  disabled: "bg-slate-700/50 border-slate-600 text-slate-400",
};

type WhatsAppTemplateCategory = WhatsAppTemplateCreatePayload["category"];

interface WhatsAppTemplateCreateForm {
  name: string;
  category: WhatsAppTemplateCategory;
  language: string;
  body: string;
  footer: string;
}

const DEFAULT_CREATE_FORM: WhatsAppTemplateCreateForm = {
  name: "kafi_product_intro",
  category: "UTILITY",
  language: "en_US",
  body:
    "Dear {{1}},\n\n" +
    "Thank you for your interest in Kafi Commodities ESSENCE products. " +
    "We would be pleased to share specifications and pricing for {{2}}.\n\n" +
    "Best regards,\nKafi Commodities Export Team",
  footer: "Kafi Commodities (Pvt) Ltd",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs border ${STATUS_STYLES[status] ?? STATUS_STYLES.pending}`}
    >
      {status}
    </span>
  );
}

function notificationStyle(eventType: string): string {
  if (eventType === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
  if (eventType === "rejected") return "border-red-500/30 bg-red-500/10 text-red-100";
  if (eventType === "submitted") return "border-amber-500/30 bg-amber-500/10 text-amber-100";
  return "border-slate-700 bg-slate-900/80 text-slate-200";
}

export function WhatsAppTemplatesPage({ onError, onCountChange }: WhatsAppTemplatesPageProps) {
  const { isAdmin } = useAuth();
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("meta");
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [notifications, setNotifications] = useState<WhatsAppTemplateNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [showCreator, setShowCreator] = useState(false);
  const [createForm, setCreateForm] =
    useState<WhatsAppTemplateCreateForm>(DEFAULT_CREATE_FORM);
  const [submitting, setSubmitting] = useState(false);

  const [testPhone, setTestPhone] = useState("");
  const [testTemplateId, setTestTemplateId] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");

  const [editingTemplateId, setEditingTemplateId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<WhatsAppTemplateCreateForm | null>(null);
  const [resubmitting, setResubmitting] = useState(false);
  const [viewingTemplate, setViewingTemplate] = useState<WhatsAppTemplate | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [notificationsExpanded, setNotificationsExpanded] = useState(false);

  const refreshNotifications = useCallback(async () => {
    try {
      const data = await client.listWhatsAppTemplateNotifications({ unreadOnly: true, limit: 20 });
      setNotifications(data.rows || []);
      setUnreadCount(data.unread_count || 0);
    } catch {
      // Non-blocking — templates list still works without notifications.
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, rows] = await Promise.all([
        client.getWhatsAppConfig(),
        client.listWhatsAppTemplates(),
      ]);
      setConfig(cfg);
      setTemplates(rows);
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const alive = new Set(rows.map((t) => t.id));
        const next = new Set<number>();
        for (const id of prev) {
          if (alive.has(id)) next.add(id);
        }
        return next.size === prev.size ? prev : next;
      });
      onCountChange?.(rows.filter((t) => t.status === "approved").length);
      const approved = rows.filter((t) => t.status === "approved");
      setTestTemplateId((current) => {
        if (current && approved.some((t) => String(t.id) === current)) return current;
        const hello = approved.find((t) => t.name === "hello_world");
        return String((hello ?? approved[0])?.id ?? "");
      });
      await refreshNotifications();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load WhatsApp templates");
    } finally {
      setLoading(false);
    }
  }, [onCountChange, onError, refreshNotifications]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshNotifications();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refreshNotifications]);

  async function handleSync() {
    setSyncing(true);
    setNotice(null);
    try {
      const result = await client.syncWhatsAppTemplates();
      setNotice(result.message);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Template sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    setSubmitError(null);
    try {
      const result = await client.createWhatsAppTemplate({
        name: createForm.name.trim(),
        category: createForm.category,
        language: createForm.language.trim() || "en_US",
        body: createForm.body.trim(),
        footer: createForm.footer.trim() || null,
      });
      setNotice(result.message);
      setShowCreator(false);
      setCreateForm(DEFAULT_CREATE_FORM);
      setEditingTemplateId(null);
      setEditForm(null);
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to submit template to Meta";
      setSubmitError(message);
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function startDuplicateFromTemplate(template: WhatsAppTemplate) {
    const suffix = template.status === "approved" ? "_v2" : "_rev";
    setCreateForm({
      name: `${template.name}${suffix}`.slice(0, 512),
      category: (template.category?.toUpperCase() as WhatsAppTemplateCategory) || "UTILITY",
      language: template.language || "en_US",
      body: template.body_text || DEFAULT_CREATE_FORM.body,
      footer: DEFAULT_CREATE_FORM.footer,
    });
    setShowCreator(true);
    setEditingTemplateId(null);
    setEditForm(null);
    setNotice(null);
    setSubmitError(null);
  }

  function startEditTemplate(template: WhatsAppTemplate) {
    if (template.status === "approved") {
      onError(
        "Approved templates cannot be edited on Meta. Use Duplicate to create a new version with a new name.",
      );
      return;
    }
    if (template.status === "pending") {
      onError("This template is still pending Meta review. Wait for approval or rejection.");
      return;
    }
    setEditingTemplateId(template.id);
    setEditForm({
      name: template.name,
      category: (template.category?.toUpperCase() as WhatsAppTemplateCategory) || "UTILITY",
      language: template.language || "en_US",
      body: template.body_text || "",
      footer: DEFAULT_CREATE_FORM.footer,
    });
    setShowCreator(false);
    setNotice(null);
    setSubmitError(null);
  }

  function cancelEditTemplate() {
    setEditingTemplateId(null);
    setEditForm(null);
    setSubmitError(null);
  }

  async function handleResubmitEdit(event: FormEvent) {
    event.preventDefault();
    if (editingTemplateId == null || !editForm) return;
    setResubmitting(true);
    setNotice(null);
    setSubmitError(null);
    try {
      const result = await client.resubmitWhatsAppTemplate(editingTemplateId, {
        body: editForm.body.trim(),
        footer: editForm.footer.trim() || null,
        category: editForm.category,
      });
      setNotice(result.message);
      cancelEditTemplate();
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to resubmit template";
      setSubmitError(message);
      onError(message);
    } finally {
      setResubmitting(false);
    }
  }

  async function handleDeleteTemplate(template: WhatsAppTemplate) {
    const confirmed = window.confirm(
      `Delete WhatsApp template "${template.name}"?\n\nThis removes it from Meta and this list. This cannot be undone.`,
    );
    if (!confirmed) return;
    setDeletingTemplateId(template.id);
    setNotice(null);
    try {
      const result = await client.deleteWhatsAppTemplate(template.id);
      if (viewingTemplate?.id === template.id) setViewingTemplate(null);
      if (editingTemplateId === template.id) cancelEditTemplate();
      setSelectedIds((prev) => {
        if (!prev.has(template.id)) return prev;
        const next = new Set(prev);
        next.delete(template.id);
        return next;
      });
      setNotice(result.message || `Deleted ${template.name}.`);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete template");
    } finally {
      setDeletingTemplateId(null);
    }
  }

  function toggleTemplateSelected(templateId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(templateId)) next.delete(templateId);
      else next.add(templateId);
      return next;
    });
  }

  function toggleSelectAllFiltered(visibleIds: number[]) {
    setSelectedIds((prev) => {
      const allVisibleSelected =
        visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  }

  async function handleBulkDeleteSelected() {
    const selected = templates.filter((t) => selectedIds.has(t.id));
    if (selected.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${selected.length} selected WhatsApp template${selected.length === 1 ? "" : "s"}?\n\nThis removes them from Meta and this list. This cannot be undone.`,
    );
    if (!confirmed) return;
    setBulkDeleting(true);
    setNotice(null);
    let deleted = 0;
    const failures: string[] = [];
    try {
      for (const template of selected) {
        try {
          await client.deleteWhatsAppTemplate(template.id);
          deleted += 1;
          if (viewingTemplate?.id === template.id) setViewingTemplate(null);
          if (editingTemplateId === template.id) cancelEditTemplate();
        } catch (e) {
          failures.push(
            `${template.name}: ${e instanceof Error ? e.message : "delete failed"}`,
          );
        }
      }
      setSelectedIds(new Set());
      if (deleted > 0) {
        setNotice(
          `Deleted ${deleted} template${deleted === 1 ? "" : "s"}.` +
            (failures.length ? ` ${failures.length} failed.` : ""),
        );
      }
      if (failures.length) {
        onError(failures.slice(0, 3).join(" · "));
      }
      await refresh();
    } finally {
      setBulkDeleting(false);
    }
  }

  async function dismissNotifications(ids?: number[]) {
    try {
      await client.markWhatsAppTemplateNotificationsRead(ids);
      await refreshNotifications();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to mark notifications read");
    }
  }

  async function handleTestSend() {
    if (!isAdmin) {
      onError("Only an admin can send a WhatsApp test message.");
      return;
    }
    const phone = testPhone.trim();
    if (!phone) {
      onError("Enter a recipient phone number (e.g. 03XXXXXXXXX or +92…).");
      return;
    }
    const template = templates.find((t) => String(t.id) === testTemplateId);
    if (!template || template.status !== "approved") {
      onError("Select an approved template first.");
      return;
    }
    setTestSending(true);
    setNotice(null);
    try {
      const result = await client.testWhatsAppSend({
        phone,
        template_name: template.name,
        template_language: template.language || "en_US",
      });
      if (result.status === "sent") {
        setNotice(
          `Test sent to ${result.to || phone}` +
            (result.provider_message_id ? ` · id ${result.provider_message_id}` : ""),
        );
      } else {
        onError(result.message || `Send failed (${result.status})`);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "WhatsApp test send failed");
    } finally {
      setTestSending(false);
    }
  }

  const approvedTemplates = templates.filter((t) => t.status === "approved");

  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      const haystack = [t.name, t.status, t.category, t.language, t.body_text, t.rejection_reason]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [templateSearch, templates]);

  const allFilteredSelected =
    filteredTemplates.length > 0 && filteredTemplates.every((t) => selectedIds.has(t.id));
  const someFilteredSelected =
    filteredTemplates.some((t) => selectedIds.has(t.id)) && !allFilteredSelected;
  const selectedCount = selectedIds.size;

  return (
    <section className="space-y-6 w-full min-w-0">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex gap-1 border-b border-slate-800">
            <button
              type="button"
              onClick={() => setLibraryTab("meta")}
              className={`px-3 pb-2 text-sm font-semibold border-b-2 transition ${
                libraryTab === "meta"
                  ? "border-emerald-500 text-emerald-300"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              WhatsApp Meta Drafts
            </button>
            <button
              type="button"
              onClick={() => setLibraryTab("personal")}
              className={`px-3 pb-2 text-sm font-semibold border-b-2 transition ${
                libraryTab === "personal"
                  ? "border-emerald-500 text-emerald-300"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              WhatsApp Personal Drafts
            </button>
          </div>
          {libraryTab === "meta" ? (
            <p className="text-sm text-slate-500 mt-3 max-w-2xl">
              Create templates here and submit them to Meta for review. Duplicate copies a template
              as a new submission. Edit resubmits rejected, paused, or disabled templates. Delete
              removes a template from Meta and this list. Approved wording cannot be changed in
              place — duplicate it with a new name instead.
            </p>
          ) : (
            <p className="text-sm text-slate-500 mt-3 max-w-2xl">
              Save reusable messages for Personal WhatsApp (QR scanned). Select them later from Bulk
              WhatsApp → Personal WhatsApp Templates.
            </p>
          )}
        </div>
        {libraryTab === "meta" ? (
          <div className="flex flex-wrap gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowCreator((open) => !open);
                setNotice(null);
              }}
              disabled={!config?.configured}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm font-medium disabled:opacity-50"
            >
              {showCreator ? "Close creator" : "Create template"}
            </button>
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={syncing || !config?.configured}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync from Meta"}
            </button>
          </div>
        ) : null}
      </div>

      {libraryTab === "personal" ? (
        <WhatsAppPersonalTemplatesPanel onError={onError} />
      ) : (
        <>
      {unreadCount > 0 && notifications.length > 0 && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => setNotificationsExpanded((open) => !open)}
              className="inline-flex items-center gap-2 text-sm font-medium text-slate-200 hover:text-white transition"
              aria-expanded={notificationsExpanded}
            >
              <IconChevronDown
                size="sm"
                className={`shrink-0 text-slate-400 transition-transform ${
                  notificationsExpanded ? "rotate-0" : "-rotate-90"
                }`}
              />
              <span>
                Template review updates ({unreadCount} unread)
              </span>
              <span className="text-xs font-normal text-slate-500">
                {notificationsExpanded ? "Hide" : "Show"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void dismissNotifications()}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Mark all read
            </button>
          </div>
          {notificationsExpanded ? (
            <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {notifications.map((item) => (
                <li
                  key={item.id}
                  className={`rounded-lg border px-3 py-2 text-sm flex items-start justify-between gap-3 ${notificationStyle(item.event_type)}`}
                >
                  <div>
                    <p>{item.message}</p>
                    <p className="text-xs opacity-70 mt-1">
                      {item.created_at ? new Date(item.created_at).toLocaleString() : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void dismissNotifications([item.id])}
                    className="text-xs opacity-80 hover:opacity-100 shrink-0"
                  >
                    Dismiss
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">
              Collapsed — click the header to expand {notifications.length} update
              {notifications.length === 1 ? "" : "s"}.
            </p>
          )}
        </div>
      )}

      {config?.configured && config.meta_api_ok === false && config.meta_api_message && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <p className="font-medium">Meta WhatsApp API connection failed</p>
          <p className="mt-1">{config.meta_api_message}</p>
        </div>
      )}

      {config?.configured && config.meta_api_ok === true && config.meta_api_message && (
        <p className="text-xs text-emerald-400/90">{config.meta_api_message}</p>
      )}

      {config?.configured && config.cloud_sending_enabled === false && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="font-medium">Meta Cloud WhatsApp SENDS are PAUSED</p>
          <p className="mt-1 text-amber-100/90">
            {config.cloud_sending_paused_message ||
              "No templates are sent to Meta until billing is fixed and sending is re-enabled."}
          </p>
        </div>
      )}

      {config && !config.configured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <p className="font-medium">WhatsApp Cloud API is not configured yet.</p>
          <p className="mt-1 text-amber-200/80">
            Set {config.missing_env.join(", ")} in <code>backend/.env</code>, then restart the
            backend.
          </p>
        </div>
      )}

      {config?.webhook_callback_url ? (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-xs text-slate-400 space-y-1">
          <p>
            Meta webhook Callback URL:{" "}
            <code className="text-slate-200 break-all">{config.webhook_callback_url}</code>
          </p>
          <p>
            Subscribe fields: <code className="text-slate-300">messages</code> and{" "}
            <code className="text-slate-300">message_template_status_update</code>. Verify token must
            match <code className="text-slate-300">WHATSAPP_WEBHOOK_VERIFY_TOKEN</code> on the server.
          </p>
        </div>
      ) : null}

      {config?.configured && (
        <p className="text-xs text-slate-500">
          Webhook must subscribe to <code className="text-slate-400">message_template_status_update</code>{" "}
          for instant approval/rejection alerts.
          {config.display_number ? ` Sending as ${config.display_number}.` : ""}
        </p>
      )}

      {notice && (
        <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          {notice}
        </p>
      )}

      {showCreator && config?.configured && (
        <form
          onSubmit={(e) => void handleCreateSubmit(e)}
          className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-4"
        >
          <div>
            <h3 className="text-sm font-medium text-slate-200">Submit template to Meta</h3>
            <p className="text-xs text-slate-500 mt-1">
              Meta reviews every template (usually minutes to 48 hours). Use{" "}
              <code className="text-slate-400">{`{{1}}`}</code>,{" "}
              <code className="text-slate-400">{`{{2}}`}</code> for variables. Name must be
              lowercase with underscores.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block sm:col-span-1">
              <span className="text-xs text-slate-400">Template name</span>
              <input
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="kafi_product_intro"
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                required
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">Category</span>
              <select
                value={createForm.category}
                onChange={(e) =>
                  setCreateForm((f) => ({
                    ...f,
                    category: e.target.value as WhatsAppTemplateCategory,
                  }))
                }
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              >
                <option value="UTILITY">Utility</option>
                <option value="MARKETING">Marketing</option>
                <option value="AUTHENTICATION">Authentication</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">Language</span>
              <input
                value={createForm.language}
                onChange={(e) => setCreateForm((f) => ({ ...f, language: e.target.value }))}
                placeholder="en_US"
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                required
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-slate-400">Body</span>
            <textarea
              rows={8}
              value={createForm.body}
              onChange={(e) =>
                setCreateForm((f) => ({
                  ...f,
                  body: capitalizeFirstLetter(e.target.value),
                }))
              }
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
              required
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Footer (optional, max 60 chars)</span>
            <input
              value={createForm.footer}
              onChange={(e) => setCreateForm((f) => ({ ...f, footer: e.target.value }))}
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              maxLength={60}
            />
          </label>
          {submitError && (
            <p className="text-sm text-red-300 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              {submitError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreator(false)}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {submitting ? "Submitting to Meta…" : "Submit for Meta review"}
            </button>
          </div>
        </form>
      )}

      {isAdmin && config?.configured && (
        <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-slate-200">Send test WhatsApp</h3>
            <p className="text-xs text-slate-500 mt-1">
              Sends from your connected business number to any phone using an approved template.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="Recipient phone e.g. 03001234567"
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
            />
            <select
              value={testTemplateId}
              onChange={(e) => setTestTemplateId(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 min-w-[12rem]"
            >
              {approvedTemplates.length === 0 ? (
                <option value="">No approved templates</option>
              ) : (
                approvedTemplates.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.name} ({t.language})
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              onClick={() => void handleTestSend()}
              disabled={testSending || approvedTemplates.length === 0 || !testPhone.trim()}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50 shrink-0"
            >
              {testSending ? "Sending…" : "Send test"}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-medium text-slate-300">Templates</h3>
            <span className="text-xs text-slate-500">
              {templateSearch.trim()
                ? `${filteredTemplates.length} / ${templates.length}`
                : `${templates.length} total`}
              {selectedCount > 0 ? ` · ${selectedCount} selected` : ""}
            </span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-emerald-500 focus:ring-emerald-500/40"
                checked={allFilteredSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someFilteredSelected;
                }}
                onChange={() =>
                  toggleSelectAllFiltered(filteredTemplates.map((t) => t.id))
                }
                disabled={loading || filteredTemplates.length === 0}
                aria-label="Select all templates"
              />
              Select all
              {templateSearch.trim() && filteredTemplates.length > 0
                ? ` (${filteredTemplates.length})`
                : ""}
            </label>
            {selectedCount > 0 ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs px-2.5 py-1 rounded-md border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  onClick={() => void handleBulkDeleteSelected()}
                  disabled={bulkDeleting}
                  className="text-xs px-2.5 py-1 rounded-md border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20 font-medium disabled:opacity-50 inline-flex items-center gap-1"
                >
                  <IconTrash size="xs" />
                  {bulkDeleting ? "Deleting…" : `Delete selected (${selectedCount})`}
                </button>
              </div>
            ) : null}
            <label className="relative block max-w-md flex-1 min-w-[12rem]">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
                <IconSearch size="sm" />
              </span>
              <input
                type="search"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder="Search templates by name, status, body…"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-8 pr-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
              />
            </label>
          </div>
        </div>
        <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <p className="text-sm text-slate-400">Loading templates…</p>
          ) : templates.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
              No templates yet. Click <strong className="text-slate-300">Create template</strong>{" "}
              to submit one to Meta, or sync existing templates from Business Manager.
            </p>
          ) : filteredTemplates.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
              No templates match “{templateSearch.trim()}”.
            </p>
          ) : (
            filteredTemplates.map((template) => {
              const isSelected = selectedIds.has(template.id);
              return (
              <div key={template.id} className="space-y-2">
                <div
                  className={`rounded-lg border p-3.5 flex items-center justify-between gap-3 max-w-full ${
                    isSelected
                      ? "border-emerald-500/40 bg-emerald-950/20"
                      : "border-slate-800 bg-slate-950"
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-950 text-emerald-500 focus:ring-emerald-500/40"
                      checked={isSelected}
                      onChange={() => toggleTemplateSelected(template.id)}
                      aria-label={`Select ${template.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <p className="font-semibold text-slate-100 text-sm break-words whitespace-normal min-w-0">{template.name}</p>
                        <StatusBadge status={template.status} />
                        {template.category && (
                          <span className="px-2 py-0.5 rounded text-xs border border-slate-700 bg-slate-800 text-slate-300">
                            {template.category}
                          </span>
                        )}
                        <span className="text-xs text-slate-400 font-mono">{template.language}</span>
                        {template.variable_count > 0 && (
                          <span className="text-xs text-slate-500">
                            · {template.variable_count} variable{template.variable_count === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      {template.rejection_reason && (
                        <p className="text-xs text-red-300/90 mt-1.5 break-words">
                          Rejection reason: {template.rejection_reason}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 shrink-0 w-[12.5rem]">
                    <button
                      type="button"
                      onClick={() => setViewingTemplate(template)}
                      className="text-xs px-2.5 py-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 font-medium flex items-center justify-center gap-1 transition"
                      title="View template details"
                    >
                      <IconEye size="xs" />
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => startDuplicateFromTemplate(template)}
                      className="text-xs px-2.5 py-1.5 rounded-md border border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 font-medium flex items-center justify-center gap-1 transition"
                      title="Duplicate as a new Meta template"
                    >
                      <IconCopy size="xs" />
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => startEditTemplate(template)}
                      disabled={template.status === "pending"}
                      className="text-xs px-2.5 py-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 font-medium flex items-center justify-center gap-1 transition disabled:opacity-40 disabled:hover:bg-sky-500/10"
                      title={
                        template.status === "pending"
                          ? "Awaiting Meta review"
                          : template.status === "approved"
                            ? "Approved templates cannot be edited on Meta — use Duplicate"
                            : "Edit and resubmit to Meta"
                      }
                    >
                      <IconEdit size="xs" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteTemplate(template)}
                      disabled={deletingTemplateId === template.id || bulkDeleting}
                      className="text-xs px-2.5 py-1.5 rounded-md border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20 font-medium flex items-center justify-center gap-1 transition disabled:opacity-50"
                      title="Delete this template from Meta and this list"
                    >
                      <IconTrash size="xs" />
                      {deletingTemplateId === template.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
                {editingTemplateId === template.id && editForm ? (
                  <form
                    onSubmit={(e) => void handleResubmitEdit(e)}
                    className="rounded-lg border border-sky-500/30 bg-sky-950/20 p-4 space-y-3"
                  >
                    <p className="text-sm text-sky-200">
                      Edit <strong>{template.name}</strong> and resubmit to Meta for review.
                    </p>
                    <label className="block">
                      <span className="text-xs text-slate-400">Category</span>
                      <select
                        value={editForm.category}
                        onChange={(e) =>
                          setEditForm((f) =>
                            f
                              ? {
                                  ...f,
                                  category: e.target.value as WhatsAppTemplateCategory,
                                }
                              : f,
                          )
                        }
                        className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                      >
                        <option value="UTILITY">Utility</option>
                        <option value="MARKETING">Marketing</option>
                        <option value="AUTHENTICATION">Authentication</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs text-slate-400">Body</span>
                      <textarea
                        rows={8}
                        value={editForm.body}
                        onChange={(e) =>
                          setEditForm((f) =>
                            f ? { ...f, body: capitalizeFirstLetter(e.target.value) } : f,
                          )
                        }
                        className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
                        required
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-slate-400">Footer (optional)</span>
                      <input
                        value={editForm.footer}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, footer: e.target.value } : f))
                        }
                        className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                        maxLength={60}
                      />
                    </label>
                    {submitError && editingTemplateId === template.id ? (
                      <p className="text-sm text-red-300">{submitError}</p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={cancelEditTemplate}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={resubmitting}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
                      >
                        {resubmitting ? "Submitting…" : "Submit for Meta review"}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
              );
            })
          )}
        </div>
      </div>
        </>
      )}

      <WhatsAppTemplatePreviewModal
        template={viewingTemplate}
        onClose={() => setViewingTemplate(null)}
        onDuplicateTemplate={(tmpl) => {
          startDuplicateFromTemplate(tmpl);
        }}
        onEditTemplate={(tmpl) => {
          startEditTemplate(tmpl);
        }}
        onDeleteTemplate={(tmpl) => {
          void handleDeleteTemplate(tmpl);
        }}
        deleting={Boolean(viewingTemplate && deletingTemplateId === viewingTemplate.id)}
      />
    </section>
  );
}
