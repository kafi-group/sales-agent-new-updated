import { useCallback, useEffect, useRef, useState } from "react";
import { client, type WorkspaceAiAutopilotSettings } from "../api/client";

const DEFAULTS: WorkspaceAiAutopilotSettings = {
  enabled: false,
  auto_remarks: true,
  auto_interested: true,
  auto_not_interested: true,
  auto_no_response: true,
  auto_follow_up: true,
};

interface WorkspaceAiAutopilotButtonProps {
  onError?: (message: string) => void;
  compact?: boolean;
}

export function WorkspaceAiAutopilotButton({
  onError,
  compact = false,
}: WorkspaceAiAutopilotButtonProps) {
  const [settings, setSettings] = useState<WorkspaceAiAutopilotSettings>(DEFAULTS);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await client.getWorkspaceAiAutopilot();
      setSettings({ ...DEFAULTS, ...data });
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Failed to load Sara/Rayan workspace autopilot");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function save(patch: Partial<WorkspaceAiAutopilotSettings>) {
    setSaving(true);
    try {
      const next = await client.updateWorkspaceAiAutopilot(patch);
      setSettings({ ...DEFAULTS, ...next });
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Failed to save workspace autopilot");
    } finally {
      setSaving(false);
    }
  }

  const toggles: Array<{
    key: keyof WorkspaceAiAutopilotSettings;
    label: string;
    hint: string;
  }> = [
    {
      key: "auto_remarks",
      label: "Add remarks",
      hint: "Write call notes on the lead automatically",
    },
    {
      key: "auto_interested",
      label: "Interested",
      hint: "Move to Interested/Potential when buyer wants quote/catalogue",
    },
    {
      key: "auto_not_interested",
      label: "Not interested",
      hint: "Mark Not Interested when buyer declines",
    },
    {
      key: "auto_no_response",
      label: "No response",
      hint: "Mark No Response on no-answer / voicemail",
    },
    {
      key: "auto_follow_up",
      label: "Needs follow-up",
      hint: "Move to Needs Follow Up for callbacks / nurture",
    },
  ];

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] sm:text-xs font-bold uppercase tracking-wide shadow-md transition ${
          settings.enabled
            ? "border-violet-400/70 bg-violet-600/90 text-white shadow-violet-950/40 hover:bg-violet-500"
            : "border-slate-600 bg-slate-800/90 text-slate-200 hover:bg-slate-700"
        } ${compact ? "px-2" : ""}`}
        title="Sara & Rayan auto-update Target & Workspace (remarks, interested, not interested, no response)"
      >
        <span aria-hidden>🤖</span>
        {compact ? "AI" : "Sara / Rayan"}
        {settings.enabled ? (
          <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-black">ON</span>
        ) : (
          <span className="rounded-full bg-slate-600/80 px-1.5 py-0.5 text-[10px] font-black text-slate-300">
            OFF
          </span>
        )}
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-2 w-[min(100vw-2rem,22rem)] rounded-xl border border-violet-500/40 bg-slate-950 shadow-2xl shadow-black/50 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-100">Sara / Rayan Workspace</p>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                When ON, after each AI call they write remarks and move the lead in the outreach
                funnel (Interested, Not Interested, No Response, Follow Up) — no human click needed.
              </p>
            </div>
            <button
              type="button"
              disabled={saving || loading}
              onClick={() => void save({ enabled: !settings.enabled })}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
                settings.enabled ? "bg-emerald-500" : "bg-slate-700"
              }`}
              aria-pressed={settings.enabled}
              title={settings.enabled ? "Turn autopilot off" : "Turn autopilot on"}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                  settings.enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <ul className="space-y-2 border-t border-slate-800 pt-3">
            {toggles.map((row) => (
              <li key={row.key} className="flex items-start gap-2">
                <input
                  id={`ws-ai-${row.key}`}
                  type="checkbox"
                  checked={Boolean(settings[row.key])}
                  disabled={saving || loading || !settings.enabled}
                  onChange={() => void save({ [row.key]: !settings[row.key] })}
                  className="mt-0.5 rounded border-slate-600 bg-slate-900 text-violet-500 focus:ring-violet-500/40"
                />
                <label htmlFor={`ws-ai-${row.key}`} className="min-w-0 cursor-pointer">
                  <span className="text-xs font-medium text-slate-200">{row.label}</span>
                  <span className="block text-[10px] text-slate-500 leading-snug">{row.hint}</span>
                </label>
              </li>
            ))}
          </ul>

          <p className="text-[10px] text-slate-500 leading-snug">
            Uses the call summary / transcript when available. Turn this on here, then run Sara or
            Rayan from Call Center → AI Sales Agent.
          </p>
        </div>
      ) : null}
    </div>
  );
}
