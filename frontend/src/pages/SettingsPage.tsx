import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  client,
  type AutoTrashSettings,
  type TwilioBalance,
  type VoiceEngineSettings,
} from "../api/client";
import { ActionButton } from "../components/ui/ActionButton";
import { IconRefresh } from "../components/icons/AppIcons";
import {
  loadResearchPatience,
  saveResearchPatience,
  RESEARCH_PATIENCE,
  type ResearchPatience,
} from "../lib/researchPatience";
import {
  loadNarratorPrefs,
  saveNarratorPrefs,
  type NarratorGender,
  type NarratorPause,
  type NarratorPrefs,
  type NarratorSpeed,
} from "../utils/narratorPrefs";
import {
  AI_TOOLS_PASSWORD,
  areAiToolsUnlocked,
  lockAiTools,
  unlockAiTools,
} from "../lib/aiToolsGate";
import { OrgAdminSettingsPanel } from "../components/OrgAdminSettingsPanel";
import { KpiScorecardSettingsPanel } from "../components/KpiScorecardSettingsPanel";

interface SettingsPageProps {
  onError: (message: string) => void;
  /** Open restricted AI tools after Settings password unlock (admin only). */
  onOpenRestrictedAi?: (tab: "ai-mode" | "leads") => void;
}

function formatBalance(data: TwilioBalance): string {
  if (!data.ok || data.balance == null) return "—";
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: (data.currency || "USD").toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(data.balance);
  return amount;
}

function formatFetchedAt(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function SettingsPage({ onError, onOpenRestrictedAi }: SettingsPageProps) {
  const [twilio, setTwilio] = useState<TwilioBalance | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceEngineSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverNotice, setRecoverNotice] = useState<string | null>(null);
  const [restartingRailway, setRestartingRailway] = useState(false);
  const [railwayPin, setRailwayPin] = useState("");

  // Lock / Unlock State
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [activePin, setActivePin] = useState("");

  // Restricted AI tools (AI Mode / Searched by AI)
  const [aiToolsUnlocked, setAiToolsUnlocked] = useState(() => areAiToolsUnlocked());
  const [aiToolsPin, setAiToolsPin] = useState("");
  const [aiToolsPinError, setAiToolsPinError] = useState<string | null>(null);

  // PIN Secret Verification Modal State
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinAction, setPinAction] = useState<"unlock" | "toggle_vapi" | "toggle_elevenlabs" | "save_elevenlabs" | null>(null);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState(false);

  // Pending Drafts
  const [pendingVapiState, setPendingVapiState] = useState<boolean>(true);
  const [pendingElevenLabsState, setPendingElevenLabsState] = useState<boolean>(true);
  const [elevenLabsDraft, setElevenLabsDraft] = useState("");
  const [savingHangup, setSavingHangup] = useState(false);
  const [researchPatience, setResearchPatience] = useState<ResearchPatience>(() => loadResearchPatience());
  const [narrator, setNarrator] = useState<NarratorPrefs>(() => loadNarratorPrefs());
  const [autoTrash, setAutoTrash] = useState<AutoTrashSettings | null>(null);
  const [autoTrashLearning, setAutoTrashLearning] = useState(false);
  const [autoTrashNotice, setAutoTrashNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const twData = await client.getTwilioBalance();
      setTwilio(twData);
      if (isUnlocked && activePin) {
        const voiceData = await client.unlockVoiceSettings(activePin);
        setVoiceSettings(voiceData);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load settings");
    }
  }, [onError, isUnlocked, activePin]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const twData = await client.getTwilioBalance();
        if (!cancelled) setTwilio(twData);
      } catch (err) {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : "Failed to load Twilio balance");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    void client
      .getAutoTrashSettings()
      .then((row) => {
        if (!cancelled) setAutoTrash(row);
      })
      .catch(() => {
        if (!cancelled) setAutoTrash(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function studyTrashNow() {
    setAutoTrashLearning(true);
    setAutoTrashNotice(null);
    try {
      const res = await client.runAutoTrashLearn();
      const row = await client.getAutoTrashSettings();
      setAutoTrash(row);
      const mb = (res.mailboxes || [])
        .map((m) => `${m.email || "mailbox"}: ${m.trash_sampled}`)
        .slice(0, 8)
        .join(" · ");
      setAutoTrashNotice(
        res.ready
          ? `Ready — studied ${res.samples_seen} trash emails${mb ? ` (${mb})` : ""}. Users can turn Auto Trash ON in Inbox.`
          : `Studied ${res.samples_seen} trash emails so far${mb ? ` (${mb})` : ""}. Run again after more mail is in Trash.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not study Trash");
    } finally {
      setAutoTrashLearning(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleReconnectDb() {
    setRecovering(true);
    setRecoverNotice(null);
    try {
      const result = await client.reconnectDatabase();
      setRecoverNotice(
        result.note ||
          `Database connected again at ${new Date(result.checked_at).toLocaleString()}. Refresh the page.`,
      );
      await loadData();
    } catch (err) {
      onError(
        err instanceof Error
          ? err.message
          : "Could not reconnect. If you see 502, use Restart Railway backend below.",
      );
    } finally {
      setRecovering(false);
    }
  }

  async function handleRestartRailway(mode: "restart" | "redeploy") {
    if (!railwayPin.trim()) {
      onError("Enter the emergency OPS_REDEPLOY_PIN first (set on Vercel).");
      return;
    }
    const label = mode === "redeploy" ? "redeploy" : "restart";
    const confirmed = window.confirm(
      mode === "redeploy"
        ? "Redeploy Kafi-Sales-Agent on Railway (rebuild)? Takes 1–2 minutes."
        : "Restart Kafi-Sales-Agent on Railway (no rebuild)? Clears stuck 502s in ~30–60s.",
    );
    if (!confirmed) return;
    setRestartingRailway(true);
    setRecoverNotice(null);
    try {
      const result = await client.restartRailwayBackend(railwayPin.trim(), mode);
      setRecoverNotice(result.message || `Railway ${label} started.`);
      setRailwayPin("");
    } catch (err) {
      onError(err instanceof Error ? err.message : `Railway ${label} failed`);
    } finally {
      setRestartingRailway(false);
    }
  }

  function promptUnlock() {
    setPinAction("unlock");
    setPinInput("");
    setPinError(null);
    setPinModalOpen(true);
  }

  function promptVapiToggle(newState: boolean) {
    setPendingVapiState(newState);
    setPinAction("toggle_vapi");
    setPinInput(activePin);
    setPinError(null);
    setPinModalOpen(true);
  }

  function promptElevenLabsToggle(newState: boolean) {
    setPendingElevenLabsState(newState);
    setPinAction("toggle_elevenlabs");
    setPinInput(activePin);
    setPinError(null);
    setPinModalOpen(true);
  }

  function promptElevenLabsSave() {
    setPinAction("save_elevenlabs");
    setPinInput(activePin);
    setPinError(null);
    setPinModalOpen(true);
  }

  async function handlePinSubmit(e: FormEvent) {
    e.preventDefault();
    if (!pinInput.trim()) {
      setPinError("Please enter secret code.");
      return;
    }

    setSavingAction(true);
    setPinError(null);

    try {
      if (pinAction === "unlock") {
        const data = await client.unlockVoiceSettings(pinInput.trim());
        setVoiceSettings(data);
        setActivePin(pinInput.trim());
        setIsUnlocked(true);
        setPinModalOpen(false);
      } else if (pinAction === "toggle_vapi") {
        const res = await client.toggleVapiEngine(pinInput.trim(), pendingVapiState);
        setVoiceSettings((prev) => (prev ? { ...prev, vapi_enabled: res.vapi_enabled } : prev));
        setActivePin(pinInput.trim());
        setPinModalOpen(false);
      } else if (pinAction === "toggle_elevenlabs") {
        const res = await client.toggleElevenLabsEngine(pinInput.trim(), pendingElevenLabsState);
        setVoiceSettings((prev) => (prev ? { ...prev, elevenlabs_enabled: res.elevenlabs_enabled } : prev));
        setActivePin(pinInput.trim());
        setPinModalOpen(false);
      } else if (pinAction === "save_elevenlabs") {
        const res = await client.updateElevenLabsKey(pinInput.trim(), elevenLabsDraft.trim());
        setVoiceSettings((prev) =>
          prev
            ? {
                ...prev,
                has_elevenlabs_key: res.has_key,
                elevenlabs_key_masked: elevenLabsDraft.trim()
                  ? `••••${elevenLabsDraft.trim().slice(-4)}`
                  : null,
              }
            : prev
        );
        setActivePin(pinInput.trim());
        setElevenLabsDraft("");
        setPinModalOpen(false);
      }
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Invalid secret code. Authorization failed.");
    } finally {
      setSavingAction(false);
    }
  }

  const hangupAfterFourthRing = twilio?.hangup_after_fourth_ring !== false;
  const ringSeconds = twilio?.ring_timeout_seconds ?? 16;
  const maxRingAttempts = twilio?.max_ring_attempts ?? 10;
  const lowBalance = twilio?.ok && twilio.balance != null && twilio.balance < 5;

  async function handleHangupToggle(next: boolean) {
    setSavingHangup(true);
    try {
      const res = await client.toggleHangupAfterFourthRing(next, maxRingAttempts);
      setTwilio((prev) =>
        prev
          ? {
              ...prev,
              hangup_after_fourth_ring: res.hangup_after_fourth_ring,
              ring_timeout_seconds: res.ring_timeout_seconds,
              max_ring_attempts: res.max_ring_attempts ?? maxRingAttempts,
            }
          : prev,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update hang-up after 4th ring");
    } finally {
      setSavingHangup(false);
    }
  }

  async function handleMaxRingAttempts(next: number) {
    setSavingHangup(true);
    try {
      const capped = Math.max(1, Math.min(20, Math.round(next) || 10));
      const res = await client.toggleHangupAfterFourthRing(hangupAfterFourthRing, capped);
      setTwilio((prev) =>
        prev
          ? {
              ...prev,
              hangup_after_fourth_ring: res.hangup_after_fourth_ring,
              ring_timeout_seconds: res.ring_timeout_seconds,
              max_ring_attempts: res.max_ring_attempts ?? capped,
            }
          : prev,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update max redial attempts");
    } finally {
      setSavingHangup(false);
    }
  }

  function handleUnlockAiTools(e: FormEvent) {
    e.preventDefault();
    setAiToolsPinError(null);
    if (aiToolsPin.trim() !== AI_TOOLS_PASSWORD) {
      setAiToolsPinError("Incorrect password.");
      return;
    }
    unlockAiTools();
    setAiToolsUnlocked(true);
    setAiToolsPin("");
  }

  function handleLockAiTools() {
    lockAiTools();
    setAiToolsUnlocked(false);
    setAiToolsPin("");
    setAiToolsPinError(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">Settings</h2>
          <p className="mt-1 text-sm text-slate-400">
            Admin-only integration status, voice engines, and prepaid balances.
          </p>
        </div>
        <ActionButton
          type="button"
          variant="secondary"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          icon={IconRefresh}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </ActionButton>
      </div>

      <OrgAdminSettingsPanel onError={onError} />

      <KpiScorecardSettingsPanel onError={onError} />

      <section className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-violet-200">Restricted AI tools</h3>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            AI Mode and Searched by AI are hidden from the sidebar. Unlock with the admin password
            to open them for this browser session.
          </p>
        </div>
        {aiToolsUnlocked ? (
          <div className="space-y-3">
            <p className="text-xs text-emerald-300 font-medium">Unlocked for this session</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onOpenRestrictedAi?.("ai-mode")}
                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white"
              >
                Open AI Mode
              </button>
              <button
                type="button"
                onClick={() => onOpenRestrictedAi?.("leads")}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm font-semibold text-slate-100"
              >
                Open Searched by AI
              </button>
              <button
                type="button"
                onClick={handleLockAiTools}
                className="px-4 py-2 rounded-lg border border-slate-700 text-sm text-slate-400 hover:text-slate-200"
              >
                Lock again
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleUnlockAiTools} className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[12rem] flex-1">
              <span className="text-xs font-medium text-slate-300">Password</span>
              <input
                type="password"
                value={aiToolsPin}
                onChange={(e) => {
                  setAiToolsPin(e.target.value);
                  setAiToolsPinError(null);
                }}
                placeholder="Enter password"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                autoComplete="off"
              />
            </label>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white"
            >
              Unlock
            </button>
            {aiToolsPinError ? (
              <p className="w-full text-xs text-rose-300">{aiToolsPinError}</p>
            ) : null}
          </form>
        )}
      </section>

      <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-medium text-slate-100">Database connection</h3>
            <p className="mt-1 text-sm text-slate-400">
              If contacts, WhatsApp, or email suddenly show empty (overnight / weekend), click
              Reconnect to reset the database pool. Works when the API still responds.
            </p>
            {recoverNotice ? (
              <p className="mt-2 text-xs text-emerald-300/90">{recoverNotice}</p>
            ) : null}
          </div>
          <ActionButton
            type="button"
            variant="secondary"
            onClick={() => void handleReconnectDb()}
            disabled={recovering || restartingRailway}
            icon={IconRefresh}
          >
            {recovering ? "Reconnecting…" : "Reconnect database"}
          </ActionButton>
        </div>
      </section>

      <section className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-5 sm:p-6 space-y-4">
        <div>
          <h3 className="text-base font-medium text-slate-100">Restart Railway backend (502 fix)</h3>
          <p className="mt-1 text-sm text-slate-400">
            Use this when the whole API is dead (<span className="text-slate-300">502 Bad Gateway</span>).
            Runs on Vercel → Railway API, so it still works when Sales Agent is down. Requires env vars on
            Vercel: <span className="font-mono text-[11px] text-slate-300">RAILWAY_API_TOKEN</span>,{" "}
            <span className="font-mono text-[11px] text-slate-300">RAILWAY_SERVICE_ID</span>,{" "}
            <span className="font-mono text-[11px] text-slate-300">RAILWAY_ENVIRONMENT_ID</span>,{" "}
            <span className="font-mono text-[11px] text-slate-300">OPS_REDEPLOY_PIN</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-[12rem] flex-1">
            <span className="text-xs font-medium text-slate-300">Emergency PIN</span>
            <input
              type="password"
              value={railwayPin}
              onChange={(e) => setRailwayPin(e.target.value)}
              placeholder="OPS_REDEPLOY_PIN"
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 font-mono tracking-widest"
              autoComplete="off"
            />
          </label>
          <ActionButton
            type="button"
            variant="secondary"
            onClick={() => void handleRestartRailway("restart")}
            disabled={restartingRailway || recovering}
            icon={IconRefresh}
          >
            {restartingRailway ? "Working…" : "Restart backend"}
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            onClick={() => void handleRestartRailway("redeploy")}
            disabled={restartingRailway || recovering}
            icon={IconRefresh}
          >
            Full redeploy
          </ActionButton>
        </div>
      </section>

      <section className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5 sm:p-6 space-y-5">
        <div>
          <h3 className="text-base font-medium text-slate-100">Narrator (email &amp; WhatsApp)</h3>
          <p className="mt-1 text-sm text-slate-400">
            Controls the browser voice that reads emails (hands-free reader) and WhatsApp / alert
            voiceovers. Saved on this device only.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-300">Speed</span>
            <select
              value={narrator.speed}
              onChange={(e) =>
                setNarrator(
                  saveNarratorPrefs({
                    speed: e.target.value as NarratorSpeed,
                  }),
                )
              }
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="slow">Slow</option>
              <option value="normal">Normal</option>
              <option value="fast">Fast (current default)</option>
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-300">Voice</span>
            <select
              value={narrator.gender}
              onChange={(e) =>
                setNarrator(
                  saveNarratorPrefs({
                    gender: e.target.value as NarratorGender,
                  }),
                )
              }
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="male">Male (current default)</option>
              <option value="female">Female</option>
            </select>
          </label>

          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-slate-300">
              Pause before listening for your reply
            </span>
            <select
              value={narrator.pause}
              onChange={(e) =>
                setNarrator(
                  saveNarratorPrefs({
                    pause: e.target.value as NarratorPause,
                  }),
                )
              }
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="short">Very short (easy to miss — previous default)</option>
              <option value="normal">Normal pause</option>
              <option value="long">Longer pause</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              Gives you time after the question before the mic stops waiting for yes / no.
            </span>
          </label>
        </div>

        <label className="flex items-start gap-3 cursor-pointer select-none rounded-lg border border-slate-700/80 bg-slate-950/40 px-3 py-3">
          <input
            type="checkbox"
            checked={narrator.responseBeep}
            onChange={(e) =>
              setNarrator(saveNarratorPrefs({ responseBeep: e.target.checked }))
            }
            className="mt-0.5 rounded border-slate-600 bg-slate-900 text-violet-500 focus:ring-violet-500"
          />
          <span className="min-w-0">
            <span className="block text-sm text-slate-100">Beep before I should speak</span>
            <span className="block text-xs text-slate-500 mt-0.5">
              Plays a short beep after the narrator asks a question so you know when to answer.
              Off by default.
            </span>
          </span>
        </label>
      </section>

      {/* Twilio Voice Credits Section */}
      <section className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-slate-100">Twilio voice credits</h3>
            <p className="mt-1 text-sm text-slate-400">
              Used for browser calling from the dashboard. WhatsApp billing is separate (Meta).
            </p>
          </div>
          <a
            href="https://console.twilio.com/us1/billing/manage-billing/billing-overview"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline"
          >
            Open Twilio billing
          </a>
        </div>

        {loading && !twilio ? (
          <p className="mt-4 text-sm text-slate-400">Loading Twilio balance…</p>
        ) : (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Prepaid balance</p>
              <p
                className={`mt-2 text-2xl font-semibold tabular-nums ${
                  lowBalance ? "text-amber-300" : "text-emerald-300"
                }`}
              >
                {formatBalance(twilio ?? { configured: false, ok: false })}
              </p>
              {lowBalance && (
                <p className="mt-2 text-xs text-amber-200/90">
                  Balance is low — top up in Twilio before call volume increases.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Caller ID</p>
              <p className="mt-2 text-sm text-slate-200">
                {twilio?.caller_id_masked || "Not configured"}
              </p>
              <p className="mt-3 text-xs uppercase tracking-wide text-slate-500">Account SID</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">
                {twilio?.twilio_account_sid || "—"}
              </p>
            </div>

            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
              <p className="mt-2 text-sm text-slate-200">
                {twilio?.configured
                  ? twilio.ok
                    ? "Connected — balance fetched live from Twilio"
                    : "Configured — balance unavailable"
                  : "Twilio env vars missing on server"}
              </p>
              {twilio?.message && !twilio.ok && (
                <p className="mt-2 text-xs text-red-300">{twilio.message}</p>
              )}
              {twilio?.fetched_at && (
                <p className="mt-3 text-xs text-slate-500">
                  Last checked: {formatFetchedAt(twilio.fetched_at)}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-950/20 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-[220px] flex-1">
              <p className="text-sm font-medium text-slate-100">
                Hang up after ~{ringSeconds}s + keep redialing
              </p>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Unanswered dials hang up after about {ringSeconds} seconds, then dial again — up to{" "}
                {maxRingAttempts} attempts per contact — until someone answers or the cap is reached.
                Stops early if they decline. Avoids sitting in voicemail.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                  hangupAfterFourthRing
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-slate-800 text-slate-400 border-slate-700"
                }`}
              >
                {hangupAfterFourthRing
                  ? `ON (${ringSeconds}s × ${maxRingAttempts})`
                  : "OFF (may hit voicemail)"}
              </span>
              <button
                type="button"
                disabled={savingHangup || loading}
                onClick={() => void handleHangupToggle(!hangupAfterFourthRing)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-40 ${
                  hangupAfterFourthRing ? "bg-emerald-600" : "bg-slate-700"
                }`}
                role="switch"
                aria-checked={hangupAfterFourthRing}
                title="Hang up after ring timeout, then keep redialing until answered"
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    hangupAfterFourthRing ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>
          {hangupAfterFourthRing ? (
            <label className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              Max dial attempts per contact
              <input
                type="number"
                min={1}
                max={20}
                disabled={savingHangup || loading}
                value={maxRingAttempts}
                onChange={(e) => void handleMaxRingAttempts(Number(e.target.value))}
                className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
              />
              <span className="text-slate-500">(1–20 · each ~{ringSeconds}s)</span>
            </label>
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-slate-100">Auto Trash training</h3>
            <p className="mt-1 text-sm text-slate-400">
              Scan Trash on every configured mailbox and refresh the shared Auto Trash profile.
              Users turn Auto Trash on/off in their Inbox; training stays here.
            </p>
          </div>
          {autoTrash ? (
            <span
              className={`text-xs px-2.5 py-1 rounded-full border ${
                autoTrash.profile_ready
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-200"
              }`}
            >
              {autoTrash.profile_ready
                ? `Ready · ${autoTrash.samples_seen} samples`
                : `Learning · ${autoTrash.samples_seen} samples`}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={autoTrashLearning}
            onClick={() => void studyTrashNow()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-100 text-sm font-semibold hover:bg-amber-500/25 disabled:opacity-40"
          >
            {autoTrashLearning ? "Studying Trash…" : "Study Trash now"}
          </button>
          {autoTrash?.last_learned_at ? (
            <span className="text-xs text-slate-500">
              Last studied {new Date(autoTrash.last_learned_at).toLocaleString()}
            </span>
          ) : null}
        </div>
        {autoTrashNotice ? (
          <p className="text-sm text-emerald-300/90">{autoTrashNotice}</p>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-slate-100">Research patience</h3>
            <p className="mt-1 text-sm text-slate-400">
              Max wait per lead when you run Research from the leads table. Longer patience
              helps slow websites; Fast is enough for most batches.
            </p>
          </div>
          <span className="text-xs px-2.5 py-1 rounded-full border border-slate-700 bg-slate-950/60 text-slate-300">
            {RESEARCH_PATIENCE[researchPatience].timeoutMs / 1000}s per lead
          </span>
        </div>
        <label className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">Patience</span>
          <select
            value={researchPatience}
            onChange={(e) => {
              const next = e.target.value as ResearchPatience;
              setResearchPatience(next);
              saveResearchPatience(next);
            }}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="fast">Fast 60s</option>
            <option value="normal">Normal 90s</option>
            <option value="patient">Patient 2m</option>
          </select>
        </label>
      </section>

      {/* AI Voice Engine Controls (Secret PIN Protected Container) */}
      <section className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-5 sm:p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-slate-100 flex items-center gap-2">
              <span>AI Voice Engine Configuration</span>
              {isUnlocked ? (
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                  Unlocked
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">
                  Protected
                </span>
              )}
            </h3>
            <p className="mt-1 text-sm text-slate-400">
              Control sub-second Vapi voice agent routing and high-realism ElevenLabs API keys.
            </p>
          </div>

          {isUnlocked && (
            <button
              type="button"
              onClick={() => {
                setIsUnlocked(false);
                setActivePin("");
              }}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              🔒 Lock Configuration
            </button>
          )}
        </div>

        {!isUnlocked ? (
          /* Locked Security Banner */
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-6 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 text-xl font-bold shadow-inner">
              🔒
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-slate-200">Voice Engine Configuration Hidden</h4>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Enter your secret security code to reveal Vapi routing controls, ElevenLabs voice toggles, and API keys.
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={promptUnlock}
                className="px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-lg shadow-sky-900/30 transition-all hover:scale-105 active:scale-95"
              >
                🔓 Unlock Configuration
              </button>
            </div>
          </div>
        ) : (
          /* Unlocked Controls */
          <div className="grid gap-6 md:grid-cols-2">
            {/* Vapi Toggle Card */}
            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-5 flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-200">Vapi AI Voice Engine</span>
                  <span
                    className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                      voiceSettings?.vapi_enabled
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                        : "bg-slate-800 text-slate-400 border-slate-700"
                    }`}
                  >
                    {voiceSettings?.vapi_enabled ? "ON (Vapi Active)" : "OFF (Standard TwiML)"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                  When <strong>ON</strong>, AI sales agent calls use Vapi's sub-second engine. When <strong>OFF</strong>, calls fall back to standard Twilio TwiML gathering without Vapi.
                </p>
              </div>

              <div className="pt-2 flex items-center justify-between border-t border-slate-800/80">
                <span className="text-xs text-slate-500">Require code to change</span>
                <button
                  type="button"
                  onClick={() => promptVapiToggle(!voiceSettings?.vapi_enabled)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    voiceSettings?.vapi_enabled ? "bg-emerald-600" : "bg-slate-700"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      voiceSettings?.vapi_enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* ElevenLabs Toggle & Key Card */}
            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-5 flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-200">ElevenLabs Voice API</span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                        voiceSettings?.elevenlabs_enabled
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                          : "bg-slate-800 text-slate-400 border-slate-700"
                      }`}
                    >
                      {voiceSettings?.elevenlabs_enabled ? "ON (11Labs Active)" : "OFF (Standard Voice)"}
                    </span>
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                  When <strong>ON</strong>, Sara & Rayan speak using ElevenLabs ultra-realistic human voices. When <strong>OFF</strong>, standard natural synthetic voices are used.
                </p>

                <div className="mt-3 space-y-2">
                  <input
                    type="password"
                    placeholder={voiceSettings?.elevenlabs_key_masked ? `Current Key: ${voiceSettings.elevenlabs_key_masked}` : "Enter ElevenLabs API Key..."}
                    value={elevenLabsDraft}
                    onChange={(e) => setElevenLabsDraft(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-between border-t border-slate-800/80 gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Toggle Engine:</span>
                  <button
                    type="button"
                    onClick={() => promptElevenLabsToggle(!voiceSettings?.elevenlabs_enabled)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      voiceSettings?.elevenlabs_enabled ? "bg-emerald-600" : "bg-slate-700"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        voiceSettings?.elevenlabs_enabled ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={promptElevenLabsSave}
                  disabled={!elevenLabsDraft.trim()}
                  className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Save Key
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Secret PIN Modal Dialog */}
      {pinModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-5">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <span>🔒 Enter Security Code</span>
              </h3>
              <p className="text-xs text-slate-400">
                {pinAction === "unlock"
                  ? "Enter the 6-digit secret code to reveal Voice Engine Configuration."
                  : pinAction === "toggle_vapi"
                  ? `Enter secret code to turn Vapi AI Engine ${pendingVapiState ? "ON" : "OFF"}.`
                  : pinAction === "toggle_elevenlabs"
                  ? `Enter secret code to turn ElevenLabs Voice API ${pendingElevenLabsState ? "ON" : "OFF"}.`
                  : "Enter secret code to update ElevenLabs API Key."}
              </p>
            </div>

            <form onSubmit={(e) => void handlePinSubmit(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Secret Code PIN
                </label>
                <input
                  type="password"
                  autoFocus
                  placeholder="Enter 6-digit code..."
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 font-mono tracking-widest focus:border-sky-500 focus:outline-none"
                />
                {pinError && (
                  <p className="mt-2 text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded-md px-3 py-1.5">
                    {pinError}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setPinModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAction}
                  className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                >
                  {savingAction ? "Verifying…" : "Confirm Code"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
