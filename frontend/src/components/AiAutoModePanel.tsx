import { useCallback, useEffect, useState } from "react";
import {
  client,
  type AiSalesAutoModeSettings,
  type AiSalesBulkEmailPersonaSettings,
  type AiSalesScheduledStart,
  type EmailTemplate,
} from "../api/client";
import { EmailBodyEditor } from "./EmailBodyEditor";
import {
  hostDataUriImagesInHtml,
  htmlHasDataUriImages,
  inlineMediaPublicUrl,
} from "../lib/hostInlineImages";
import { personaDisplayName } from "../lib/aiAgentPersona";

interface AiAutoModePanelProps {
  onError: (message: string) => void;
  /** When true, show compact panel suitable under unlock / above runners. */
  compact?: boolean;
  onStartAgent?: (persona: string) => void;
  startingPersona?: string | null;
}

const EMPTY_BULK: AiSalesBulkEmailPersonaSettings = {
  template_id: null,
  from_mailbox_email: "",
  cc: "",
  subject: "",
  body: "",
};

const DEFAULTS: AiSalesAutoModeSettings = {
  enabled: false,
  study_contacts: true,
  call_mode: true,
  send_email_after_call: true,
  send_whatsapp_after_call: true,
  bulk_email_when_no_call: true,
  study_products: true,
  product_brief: "",
  bulk_email_by_persona: {
    female: { ...EMPTY_BULK },
    male: { ...EMPTY_BULK },
  },
  scheduled_starts: [],
};

type MailboxOption = { user_id: number; email: string; label?: string };

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultScheduleLocal(): string {
  const d = new Date(Date.now() + 15 * 60 * 1000);
  d.setSeconds(0, 0);
  return toDatetimeLocalValue(d);
}

function formatRunAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export function AiAutoModePanel({
  onError,
  compact = false,
  onStartAgent,
  startingPersona = null,
}: AiAutoModePanelProps) {
  const [settings, setSettings] = useState<AiSalesAutoModeSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [bulkPersona, setBulkPersona] = useState<"female" | "male">("female");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
  const [bulkDraft, setBulkDraft] = useState<AiSalesBulkEmailPersonaSettings>({
    ...EMPTY_BULK,
  });
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedulePersona, setSchedulePersona] = useState<"female" | "male">("female");
  const [scheduleAt, setScheduleAt] = useState(defaultScheduleLocal);
  const [scheduling, setScheduling] = useState(false);
  const [bodyEditorOpen, setBodyEditorOpen] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await client.getAiSalesAutoMode();
      const merged: AiSalesAutoModeSettings = {
        ...DEFAULTS,
        ...data,
        bulk_email_by_persona: {
          female: {
            ...EMPTY_BULK,
            ...(data.bulk_email_by_persona?.female || {}),
          },
          male: {
            ...EMPTY_BULK,
            ...(data.bulk_email_by_persona?.male || {}),
          },
        },
        scheduled_starts: data.scheduled_starts || [],
      };
      setSettings(merged);
      setBulkDraft({
        ...EMPTY_BULK,
        ...(merged.bulk_email_by_persona?.[bulkPersona] || {}),
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load AI Auto Mode");
    } finally {
      setLoading(false);
    }
  }, [onError, bulkPersona]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const [tpls, mbRes] = await Promise.all([
          client.listEmailTemplates().catch(() => [] as EmailTemplate[]),
          client.listInboxSwitchableMailboxes().catch(() => ({
            can_switch: false,
            mailboxes: [] as Array<{ user_id: number; email: string }>,
          })),
        ]);
        setTemplates(Array.isArray(tpls) ? tpls : []);
        const rows = Array.isArray(mbRes?.mailboxes) ? mbRes.mailboxes : [];
        setMailboxes(
          rows
            .map((row) => ({
              user_id: Number(row.user_id),
              email: String(row.email || "").trim(),
              label: String(
                (row as { display_name?: string | null }).display_name ||
                  row.email ||
                  "",
              ),
            }))
            .filter((row) => row.email),
        );
      } catch {
        /* optional */
      }
    })();
  }, []);

  useEffect(() => {
    const saved = settings.bulk_email_by_persona?.[bulkPersona];
    setBulkDraft({ ...EMPTY_BULK, ...(saved || {}) });
  }, [bulkPersona, settings.bulk_email_by_persona]);

  async function save(patch: Partial<AiSalesAutoModeSettings>) {
    setSaving(true);
    setNotice(null);
    try {
      const next = await client.updateAiSalesAutoMode(patch);
      const merged: AiSalesAutoModeSettings = {
        ...DEFAULTS,
        ...next,
        bulk_email_by_persona: {
          female: {
            ...EMPTY_BULK,
            ...(next.bulk_email_by_persona?.female || {}),
          },
          male: {
            ...EMPTY_BULK,
            ...(next.bulk_email_by_persona?.male || {}),
          },
        },
        scheduled_starts: next.scheduled_starts || settings.scheduled_starts || [],
      };
      setSettings(merged);
      setNotice("AI Auto Mode settings saved (does not start outreach by itself).");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save AI Auto Mode");
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: keyof AiSalesAutoModeSettings) {
    if (
      key === "product_brief" ||
      key === "bulk_email_by_persona" ||
      key === "scheduled_starts"
    ) {
      return;
    }
    const next = !settings[key];
    void save({ [key]: next });
  }

  function openScheduleDialog() {
    if (!settings.enabled) {
      onError("Turn AI Auto Mode ON before scheduling.");
      return;
    }
    setSchedulePersona(bulkPersona);
    setScheduleAt(defaultScheduleLocal());
    setScheduleOpen(true);
  }

  async function confirmSchedule() {
    if (!scheduleAt.trim()) {
      onError("Pick a date and time.");
      return;
    }
    if (
      settings.enabled &&
      !settings.call_mode &&
      settings.bulk_email_when_no_call
    ) {
      const cfg = settings.bulk_email_by_persona?.[schedulePersona];
      if (!cfg?.subject?.trim() || !cfg?.body?.trim()) {
        onError(
          `Save bulk email setup for ${personaDisplayName({ id: schedulePersona })} first.`,
        );
        setBulkPersona(schedulePersona);
        setScheduleOpen(false);
        return;
      }
    }
    setScheduling(true);
    setNotice(null);
    try {
      const res = await client.scheduleAiSalesAutoModeStart({
        persona: schedulePersona,
        run_at: scheduleAt,
      });
      const next = await client.getAiSalesAutoMode();
      setSettings({
        ...DEFAULTS,
        ...next,
        bulk_email_by_persona: {
          female: { ...EMPTY_BULK, ...(next.bulk_email_by_persona?.female || {}) },
          male: { ...EMPTY_BULK, ...(next.bulk_email_by_persona?.male || {}) },
        },
        scheduled_starts: next.scheduled_starts || [],
      });
      setScheduleOpen(false);
      setNotice(res.message || "Start scheduled.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to schedule start");
    } finally {
      setScheduling(false);
    }
  }

  async function cancelSchedule(id: string) {
    try {
      await client.cancelAiSalesAutoModeStart(id);
      const next = await client.getAiSalesAutoMode();
      setSettings((prev) => ({
        ...prev,
        ...next,
        scheduled_starts: next.scheduled_starts || [],
      }));
      setNotice("Scheduled start cancelled.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to cancel schedule");
    }
  }

  function applyTemplate(templateId: number) {
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) {
      setBulkDraft((prev) => ({ ...prev, template_id: templateId }));
      return;
    }
    setBulkDraft((prev) => ({
      ...prev,
      template_id: templateId,
      subject: tpl.subject || prev.subject,
      body: tpl.body || prev.body,
    }));
  }

  async function saveBulkSetup() {
    if (!bulkDraft.subject.trim() || !bulkDraft.body.trim()) {
      onError("Subject and body are required (pick a template, then edit the signature).");
      return;
    }
    let body = bulkDraft.body;
    try {
      if (htmlHasDataUriImages(body)) {
        body = await hostDataUriImagesInHtml(body);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not host inline images");
      return;
    }
    await save({
      bulk_email_by_persona: {
        [bulkPersona]: {
          template_id: bulkDraft.template_id,
          from_mailbox_email: bulkDraft.from_mailbox_email.trim(),
          cc: bulkDraft.cc.trim(),
          subject: bulkDraft.subject,
          body,
        },
      } as AiSalesAutoModeSettings["bulk_email_by_persona"],
    });
    setBulkDraft((prev) => ({ ...prev, body }));
  }

  function handleStart(persona: "female" | "male") {
    if (!onStartAgent) return;
    if (
      settings.enabled &&
      !settings.call_mode &&
      settings.bulk_email_when_no_call
    ) {
      const cfg = settings.bulk_email_by_persona?.[persona];
      if (!cfg?.subject?.trim() || !cfg?.body?.trim()) {
        onError(
          `Save bulk email setup for ${personaDisplayName({ id: persona })} first (template, From, CC, signature).`,
        );
        setBulkPersona(persona);
        return;
      }
      const agent = personaDisplayName({ id: persona });
      const ok = window.confirm(
        `Send bulk emails as ${agent}?\n\n` +
          `From: ${cfg.from_mailbox_email || "(your mailbox)"}\n` +
          `CC: ${cfg.cc || "(none)"}\n` +
          `Subject: ${cfg.subject.slice(0, 80)}${cfg.subject.length > 80 ? "…" : ""}\n\n` +
          `Contacts on ${agent}'s AI Auto Mode list will each get a personalized copy.`,
      );
      if (!ok) return;
    }
    onStartAgent(persona);
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-4 text-sm text-slate-400">
        Loading AI Auto Mode…
      </div>
    );
  }

  const showBulkSetup = settings.enabled && settings.bulk_email_when_no_call;

  return (
    <div
      className={`rounded-xl border border-violet-500/40 bg-gradient-to-br from-violet-950/40 to-slate-900/60 ${
        compact ? "" : "shadow-lg shadow-violet-950/20"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-100">AI Auto Mode</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            The toggle only saves which actions are allowed. Use{" "}
            <strong className="text-slate-300">Start</strong> to run now on that agent&apos;s{" "}
            <strong className="text-slate-300">AI Auto Mode</strong> list (move contacts there under
            the schedule panel), or <strong className="text-slate-300">Schedule</strong> a date/time
            for Start.
          </p>
        </div>
        <span className="text-slate-400 text-sm shrink-0 pt-0.5">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="px-4 pb-4 space-y-3 border-t border-violet-500/20 pt-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save({ enabled: !settings.enabled })}
              className={`relative inline-flex h-8 w-14 items-center rounded-full transition ${
                settings.enabled ? "bg-emerald-500" : "bg-slate-700"
              }`}
              aria-pressed={settings.enabled}
              title="Toggle AI Auto Mode settings"
            >
              <span
                className={`inline-block h-6 w-6 transform rounded-full bg-white transition ${
                  settings.enabled ? "translate-x-7" : "translate-x-1"
                }`}
              />
            </button>
            {!compact && onStartAgent ? (
              <>
                <button
                  type="button"
                  disabled={!settings.enabled || startingPersona === "female"}
                  onClick={() => handleStart("female")}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                  title="Start Sara now using Auto Mode actions on her AI Auto Mode list"
                >
                  {startingPersona === "female" ? "Starting…" : "Start Sara"}
                </button>
                <button
                  type="button"
                  disabled={!settings.enabled || startingPersona === "male"}
                  onClick={() => handleStart("male")}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
                  title="Start Rayan now using Auto Mode actions on his AI Auto Mode list"
                >
                  {startingPersona === "male" ? "Starting…" : "Start Rayan"}
                </button>
                <button
                  type="button"
                  disabled={!settings.enabled || scheduling}
                  onClick={() => openScheduleDialog()}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-violet-400/50 text-violet-100 hover:bg-violet-500/20 disabled:opacity-40"
                  title="Pick date and time — Start runs automatically then"
                >
                  Schedule
                </button>
              </>
            ) : null}
          </div>

          {scheduleOpen ? (
            <div className="rounded-lg border border-violet-500/40 bg-slate-950/80 p-3 space-y-3">
              <p className="text-xs font-semibold text-violet-200">
                Schedule Start — date &amp; time
              </p>
              <p className="text-[11px] text-slate-400">
                At that time the agent runs the same actions as Start now (with call mode off,
                that means bulk email using the template / From / CC you saved).
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-xs text-slate-400">
                  Agent
                  <select
                    value={schedulePersona}
                    disabled={scheduling}
                    onChange={(e) =>
                      setSchedulePersona(e.target.value === "male" ? "male" : "female")
                    }
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                  >
                    <option value="female">Sara</option>
                    <option value="male">Rayan</option>
                  </select>
                </label>
                <label className="block text-xs text-slate-400">
                  Date &amp; time (your local time)
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    disabled={scheduling}
                    min={toDatetimeLocalValue(new Date())}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                  />
                </label>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={scheduling}
                  onClick={() => setScheduleOpen(false)}
                  className="px-3 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={scheduling || !scheduleAt}
                  onClick={() => void confirmSchedule()}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40"
                >
                  {scheduling ? "Scheduling…" : "Confirm schedule"}
                </button>
              </div>
            </div>
          ) : null}

          {(() => {
            const pending = (settings.scheduled_starts || []).filter(
              (s: AiSalesScheduledStart) =>
                s.status === "pending" || s.status === "running",
            );
            if (!pending.length) return null;
            return (
              <ul className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-950/20 p-2">
                {pending.map((s) => {
                  const name = personaDisplayName({ id: s.persona });
                  return (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-200"
                    >
                      <span>
                        {name} starts{" "}
                        <strong className="text-violet-200">{formatRunAt(s.run_at)}</strong>
                        {s.status === "running" ? " (starting…)" : ""}
                      </span>
                      {s.status === "pending" ? (
                        <button
                          type="button"
                          onClick={() => void cancelSchedule(s.id)}
                          className="text-[11px] text-red-300 hover:text-red-200 underline"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            );
          })()}

          {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}

          <fieldset
            disabled={!settings.enabled || saving}
            className={`space-y-2 ${settings.enabled ? "" : "opacity-50"}`}
          >
            <legend className="text-xs font-semibold uppercase tracking-wide text-violet-300 mb-1">
              Actions used when you Start (or when a process runs)
            </legend>

            {(
              [
                [
                  "study_contacts",
                  "Study each assigned contact (company, person, designation) before acting",
                ],
                ["call_mode", "Call mode — dial contacts in the queue (Sara / Rayan)"],
                ["send_email_after_call", "After call — send email drafted from the call"],
                ["send_whatsapp_after_call", "After call — send WhatsApp personal message"],
                [
                  "bulk_email_when_no_call",
                  "If call mode is OFF — bulk email assigned contacts instead of dialling",
                ],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 cursor-pointer hover:border-violet-500/40"
              >
                <input
                  type="checkbox"
                  checked={Boolean(settings[key])}
                  onChange={() => toggle(key)}
                  className="mt-0.5 rounded border-slate-600 text-violet-500 focus:ring-violet-500"
                />
                <span>{label}</span>
              </label>
            ))}

            {showBulkSetup ? (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-3 space-y-3 mt-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-cyan-100">
                    Bulk email setup (template · From · CC · signature)
                  </p>
                  <div className="flex gap-1">
                    {(
                      [
                        ["female", "Sara"],
                        ["male", "Rayan"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setBulkPersona(id)}
                        className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                          bulkPersona === id
                            ? "border-cyan-400/60 bg-cyan-500/25 text-cyan-50"
                            : "border-slate-700 text-slate-400"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">
                  Pick a saved Email template, edit the signature (e.g. Sara — Sales Manager), choose
                  From (essence@…) and optional CC (marketing@…). Saved per agent. Merge tags like{" "}
                  {"{{contact_name}}"} / {"{{company_name}}"} still personalize each send.
                </p>

                <label className="block text-xs text-slate-400">
                  Template
                  <select
                    value={bulkDraft.template_id ?? ""}
                    disabled={saving}
                    onChange={(e) => {
                      const id = e.target.value ? Number(e.target.value) : null;
                      if (id) applyTemplate(id);
                      else setBulkDraft((prev) => ({ ...prev, template_id: null }));
                    }}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                  >
                    <option value="">Select a template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-xs text-slate-400">
                    From
                    <select
                      value={bulkDraft.from_mailbox_email}
                      disabled={saving}
                      onChange={(e) =>
                        setBulkDraft((prev) => ({
                          ...prev,
                          from_mailbox_email: e.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                    >
                      <option value="">My mailbox (operator)</option>
                      {mailboxes.map((m) => (
                        <option key={`${m.user_id}-${m.email}`} value={m.email}>
                          {m.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-slate-400">
                    CC
                    <input
                      type="email"
                      value={bulkDraft.cc}
                      disabled={saving}
                      placeholder="marketing@kafi-group.com"
                      onChange={(e) =>
                        setBulkDraft((prev) => ({ ...prev, cc: e.target.value }))
                      }
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                    />
                  </label>
                </div>

                <label className="block text-xs text-slate-400">
                  Subject
                  <input
                    type="text"
                    value={bulkDraft.subject}
                    disabled={saving}
                    onChange={(e) =>
                      setBulkDraft((prev) => ({ ...prev, subject: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                  />
                </label>

                <div className="space-y-1.5 rounded-md border border-slate-700/80 bg-slate-950/30 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setBodyEditorOpen((v) => !v)}
                      className="flex items-start gap-2 text-left min-w-0 flex-1 hover:opacity-90"
                      title={bodyEditorOpen ? "Collapse body editor" : "Expand body editor"}
                      aria-expanded={bodyEditorOpen}
                    >
                      <span className="text-slate-400 text-xs shrink-0 pt-0.5 w-3">
                        {bodyEditorOpen ? "▾" : "▸"}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs text-slate-300 font-medium">
                          Body (edit signature / formatting — images stay in the template)
                        </span>
                        {!bodyEditorOpen ? (
                          <span className="block text-[10px] text-slate-500 mt-0.5">
                            {bulkDraft.body.trim()
                              ? `Hidden · ~${Math.max(1, Math.round(bulkDraft.body.length / 80))} lines worth — click Open to edit`
                              : "Empty — click Open to edit"}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setBodyEditorOpen((v) => !v)}
                      className="text-[11px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800 shrink-0"
                    >
                      {bodyEditorOpen ? "Close" : "Open"}
                    </button>
                  </div>
                  {bodyEditorOpen ? (
                    <EmailBodyEditor
                      rows={10}
                      value={bulkDraft.body}
                      disabled={saving}
                      adaptTextToTheme
                      onChange={(body) => setBulkDraft((prev) => ({ ...prev, body }))}
                      placeholder="Pick a template above, then edit the signature (e.g. Sara — Sales Manager)…"
                      onAttachFiles={async (files) => {
                        for (const file of files) {
                          try {
                            const uploaded = await client.uploadEmailAttachment(file);
                            if (!uploaded.id) continue;
                            const url = inlineMediaPublicUrl(String(uploaded.id));
                            const alt = (uploaded.filename || "image").replace(/"/g, "");
                            setBulkDraft((prev) => ({
                              ...prev,
                              body:
                                prev.body +
                                `<p><img src="${url}" alt="${alt}" style="max-width:100%;height:auto;" /></p>`,
                            }));
                          } catch (err) {
                            onError(
                              err instanceof Error ? err.message : "Failed to attach image",
                            );
                          }
                        }
                      }}
                    />
                  ) : null}
                </div>

                {bulkDraft.body.trim() ? (
                  (() => {
                    const tpl = templates.find((t) => t.id === bulkDraft.template_id);
                    const atts = tpl?.attachments ?? [];
                    if (!atts.length) return null;
                    return (
                      <p className="text-[11px] text-slate-500">
                        Template also sends {atts.length} attachment
                        {atts.length === 1 ? "" : "s"}:{" "}
                        {atts.map((a) => a.filename || a.id).filter(Boolean).join(", ")}
                      </p>
                    );
                  })()
                ) : null}

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveBulkSetup()}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40"
                  >
                    {saving
                      ? "Saving…"
                      : `Save ${personaDisplayName({ id: bulkPersona })} bulk email setup`}
                  </button>
                </div>
              </div>
            ) : null}

            {settings.bulk_email_when_no_call && settings.call_mode ? (
              <p className="text-[11px] text-amber-200/90 pt-1">
                Turn <strong>Call mode</strong> OFF before Start so Sara/Rayan send this bulk email
                instead of dialling.
              </p>
            ) : null}

            <p className="text-[11px] text-slate-500 pt-1">
              Product study &amp; brief live under{" "}
              <span className="text-slate-300">Call Center → AI Train</span>.
            </p>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
