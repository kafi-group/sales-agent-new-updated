import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  setAiSalesAgentAccessCode,
  getAiSalesAgentAccessCode,
  sanitizeUserFacingError,
  isTransientApiError,
  type AiSalesAgentRunner,
  type AiSalesAgentTask,
  type DialableContactSuggestion,
  type OrgAdminAiSalesAgent,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { AiSalesAgentQueuePicker } from "../components/AiSalesAgentQueuePicker";
import {
  LeadWhatsAppComposeModal,
  type WhatsAppComposeTarget,
} from "../components/WhatsAppComposeLink";
import {
  LeadTelegramComposeModal,
  type TelegramComposeTarget,
} from "../components/TelegramComposeLink";
import { ComposeMailModal } from "../components/ComposeMailModal";
import { AiAutoModePanel } from "../components/AiAutoModePanel";
import { AiAutoDataUpdatePanel } from "../components/AiAutoDataUpdatePanel";
import { AiSalesProcessesPanel } from "../components/AiSalesProcessesPanel";
import { loadOrgAdminLocal, resolveAgentsForMasterList } from "../lib/orgAdminLocalStore";
import { personaDisplayName, personaVoiceGender } from "../lib/aiAgentPersona";

const SPEAKING_LANGUAGE_OPTIONS: { code: string; label: string; defaultOn: boolean }[] = [
  { code: "en", label: "🇺🇸 English", defaultOn: true },
  { code: "ur", label: "🇵🇰 Urdu (اردو)", defaultOn: true },
  { code: "fr", label: "🇫🇷 French", defaultOn: true },
  { code: "ar", label: "🇸🇦 Arabic", defaultOn: true },
  { code: "de", label: "🇩🇪 German", defaultOn: true },
  { code: "ru", label: "🇷🇺 Russian", defaultOn: true },
  // Off by default — multi STT often mislabels Urdu as Chinese/Japanese.
  { code: "zh", label: "🇨🇳 Chinese", defaultOn: false },
  { code: "ja", label: "🇯🇵 Japanese", defaultOn: false },
  { code: "fil", label: "🇵🇭 Filipino / Tagalog", defaultOn: true },
];

function ensureStartLanguageAllowed(start: string, allowed: string[]): string[] {
  const next = [...allowed];
  if (start && !next.includes(start)) next.unshift(start);
  return next.length ? next : [start || "en"];
}

interface AiSalesAgentPageProps {
  onError: (message: string) => void;
  /** Active Master List — only agents ticked for this list are shown. */
  masterType?: string;
}

const PERSONA_LABELS: Record<string, string> = {
  male: "Rayan",
  female: "Sara",
  pipeline: "AI Sales Agent list",
};

export function AiSalesAgentPage({ onError, masterType = "fmcg" }: AiSalesAgentPageProps) {
  const { isAdmin, user } = useAuth();
  const [unlocked, setUnlocked] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [runners, setRunners] = useState<AiSalesAgentRunner[]>([]);
  const [tasks, setTasks] = useState<AiSalesAgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [registryAgents, setRegistryAgents] = useState<OrgAdminAiSalesAgent[]>([]);
  const [assignPersona, setAssignPersona] = useState<string>("pipeline");
  const [buyerIdsRaw, setBuyerIdsRaw] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [filterPersona, setFilterPersona] = useState<string>("");
  const [selfTestPhone, setSelfTestPhone] = useState("");
  const [selfTestName, setSelfTestName] = useState("");
  const [selfTestPersona, setSelfTestPersona] = useState<string>("female");
  const [selfTestLanguage, setSelfTestLanguage] = useState<string>("en");
  const [allowedLanguages, setAllowedLanguages] = useState<string[]>(() =>
    SPEAKING_LANGUAGE_OPTIONS.filter((o) => o.defaultOn).map((o) => o.code),
  );
  const [lastCallSid, setLastCallSid] = useState<string | null>(null);
  const [lastCallTaskId, setLastCallTaskId] = useState<number | null>(null);
  const [selfTesting, setSelfTesting] = useState(false);
  const [endingCall, setEndingCall] = useState(false);
  const [callingTaskId, setCallingTaskId] = useState<number | null>(null);
  const [startingAutoPersona, setStartingAutoPersona] = useState<string | null>(null);
  const [whatsAppModalTarget, setWhatsAppModalTarget] = useState<WhatsAppComposeTarget | null>(null);
  const [telegramModalTarget, setTelegramModalTarget] = useState<TelegramComposeTarget | null>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailModalInitial, setEmailModalInitial] = useState<{ to: string; subject: string } | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());
  // Long staging lists start collapsed (same pattern as Outreach / Data Update / Auto Mode lanes).
  const [pipelineListOpen, setPipelineListOpen] = useState(true);
  const pipelineLenRef = useRef(0);
  const [bulkRemoving, setBulkRemoving] = useState(false);

  useEffect(() => {
    setUnlocked(Boolean(getAiSalesAgentAccessCode()));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void client
      .listOrgAiSalesAgents(true, masterType)
      .then((res) => {
        if (cancelled) return;
        // Settings ticks (local) must still show when API filter is empty/out of sync.
        setRegistryAgents(
          resolveAgentsForMasterList(res.agents || [], masterType, true) as OrgAdminAiSalesAgent[],
        );
      })
      .catch(() => {
        if (cancelled) return;
        setRegistryAgents(
          resolveAgentsForMasterList([], masterType, true) as OrgAdminAiSalesAgent[],
        );
      });
    return () => {
      cancelled = true;
    };
  }, [masterType]);

  const agentOptions = useMemo(
    () =>
      registryAgents.map((a) => ({
        id: a.id,
        name: a.name,
        product_focus: a.product_focus || "",
        voice: a.voice || "",
        gender_label: a.gender_label || "",
      })),
    [registryAgents],
  );

  function voiceGenderForAgent(agentId: string): "female" | "male" {
    const a = agentOptions.find((x) => x.id === agentId);
    return personaVoiceGender({
      id: a?.id || agentId,
      name: a?.name,
      gender_label: a?.gender_label,
      voice: a?.voice,
    });
  }

  function personaName(persona: string): string {
    if (persona === "pipeline") return "AI Sales Agent list";
    const fromReg = agentOptions.find((a) => a.id === persona);
    if (fromReg) return personaDisplayName({ id: fromReg.id, name: fromReg.name });
    return personaDisplayName({ id: persona, name: PERSONA_LABELS[persona] ?? persona });
  }

  const masterListLabel = useMemo(() => {
    const fromLocal = loadOrgAdminLocal().master_lists.find((m) => m.key === masterType)?.label;
    return fromLocal || masterType;
  }, [masterType]);

  useEffect(() => {
    if (agentOptions.length === 0) return;
    const ids = new Set(agentOptions.map((a) => a.id));
    if (assignPersona !== "pipeline" && !ids.has(assignPersona)) {
      setAssignPersona("pipeline");
    }
    if (!ids.has(selfTestPersona)) {
      setSelfTestPersona(agentOptions[0].id);
    }
    if (filterPersona && !ids.has(filterPersona)) {
      setFilterPersona("");
    }
  }, [agentOptions, assignPersona, selfTestPersona, filterPersona]);

  useEffect(() => {
    if (user?.full_name && !selfTestName) {
      setSelfTestName(user.full_name);
    }
  }, [user?.full_name, selfTestName]);

  const load = useCallback(async () => {
    if (!getAiSalesAgentAccessCode()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [runnerRes, taskRes] = await Promise.all([
        client.listAiSalesAgentRunners(),
        client.listAiSalesAgentTasks({
          limit: 500,
        }),
      ]);
      setRunners(runnerRes.runners);
      setTasks(taskRes.tasks);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load AI Sales Agent");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    if (!unlocked) return;
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load, unlocked]);

  async function tryUnlock() {
    const code = codeInput.trim();
    if (!code) return;
    setUnlocking(true);
    setUnlockError(null);
    const retryDelaysMs = [0, 900, 2_200];
    let lastMessage = "Invalid access code";
    try {
      for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        if (retryDelaysMs[attempt] > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelaysMs[attempt]));
        }
        try {
          await client.unlockAiSalesAgent(code);
          setAiSalesAgentAccessCode(code);
          setUnlocked(true);
          setCodeInput("");
          setUnlockError(null);
          return;
        } catch (e) {
          const raw = e instanceof Error ? e.message : "Invalid access code";
          lastMessage = sanitizeUserFacingError(raw);
          const wrongCode = /invalid access code|403/i.test(raw);
          if (wrongCode || !isTransientApiError(raw)) break;
        }
      }
      setUnlockError(lastMessage);
      onError(lastMessage);
    } finally {
      setUnlocking(false);
    }
  }

  function followupNotice(prefix: string, followup?: AiSalesAgentTask["followup"] | null) {
    if (!followup) return prefix;
    const waBit =
      followup.whatsapp_status === "sent"
        ? " WhatsApp sent."
        : followup.whatsapp_message
          ? ` WhatsApp: ${followup.whatsapp_message}`
          : "";
    const emailBit =
      followup.email_status === "sent"
        ? ` Email sent${followup.email_to ? ` to ${followup.email_to}` : ""}.`
        : followup.email_message
          ? ` Email: ${followup.email_message}`
          : "";
    return `${prefix}${waBit}${emailBit}`;
  }

  async function handleSelfTest() {
    const phone = selfTestPhone.trim();
    if (!phone) {
      onError("Enter your mobile number in international format, e.g. +923001234567");
      return;
    }
    const allowed = ensureStartLanguageAllowed(selfTestLanguage, allowedLanguages);
    setSelfTesting(true);
    try {
      const result = await client.queueAiSalesAgentSelfTest({
        persona: selfTestPersona,
        phone,
        contact_name: selfTestName.trim() || undefined,
        language: selfTestLanguage,
        allowed_languages: allowed,
        dial_now: false,
        voice_gender: voiceGenderForAgent(selfTestPersona),
      });
      setFilterPersona(selfTestPersona);
      setQueueNotice(
        `Queued test call to ${phone} as ${personaName(selfTestPersona)}. ` +
          "Use Call this number in the queue, or Start calling (all in sequence).",
      );
      setTimeout(() => setQueueNotice(null), 10000);
      await load();
      if (result.task?.contact_phone) {
        setSelfTestPhone(result.task.contact_phone);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Self-test queue failed");
    } finally {
      setSelfTesting(false);
    }
  }

  async function handleDirectCall() {
    const phone = selfTestPhone.trim();
    if (!phone) {
      onError("Enter phone number in international format, e.g. +923001234567");
      return;
    }
    const allowed = ensureStartLanguageAllowed(selfTestLanguage, allowedLanguages);
    setSelfTesting(true);
    try {
      const result = await client.queueAiSalesAgentSelfTest({
        persona: selfTestPersona,
        phone,
        contact_name: selfTestName.trim() || undefined,
        language: selfTestLanguage,
        allowed_languages: allowed,
        dial_now: true,
        voice_gender: voiceGenderForAgent(selfTestPersona),
      });
      const agentName = personaName(selfTestPersona);
      setQueueNotice(
        `📞 ${agentName} is calling ${phone} now. When the call ends, WhatsApp and email are sent automatically — including a missed-call email if no one picks up.`,
      );
      setTimeout(() => setQueueNotice(null), 14000);
      await load();
      if (result.task?.call_sid) {
        setLastCallSid(result.task.call_sid);
      }
      if (result.task?.id) {
        setLastCallTaskId(result.task.id);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Direct call failed");
    } finally {
      setSelfTesting(false);
    }
  }

  async function handleAssign() {
    const ids = buyerIdsRaw
      .split(/[\s,;]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) {
      onError("Enter one or more buyer IDs from the Master table.");
      return;
    }
    setAssigning(true);
    try {
      const result = await client.assignAiSalesAgentTasks({
        persona: assignPersona,
        buyer_ids: ids,
      });
      setBuyerIdsRaw("");
      setQueueNotice(
        result.notice
          ? `Added ${result.tasks.length}. ${result.notice}`
          : `Added ${result.tasks.length} contact(s) to the queue.`,
      );
      setTimeout(() => setQueueNotice(null), result.notice ? 14000 : 8000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setAssigning(false);
    }
  }

  async function handleAssignContacts(contacts: DialableContactSuggestion[]) {
    if (!contacts.length) {
      onError("Tick at least one contact from the Master Table list.");
      return;
    }
    setAssigning(true);
    try {
      const result = await client.assignAiSalesAgentTasks({
        persona: assignPersona,
        buyer_ids: contacts.map((row) => row.buyer_id),
        contact_ids: contacts.map((row) => row.contact_id),
      });
      setFilterPersona(assignPersona);
      const dest = personaName(assignPersona);
      const base =
        assignPersona === "pipeline"
          ? `Added ${result.tasks.length} contact(s) to AI Sales Agent list. Assign them to an AI Sales Agent below, then split Outreach / Data Update / AI Auto Mode.`
          : `Added ${result.tasks.length} Master Table contact(s) to ${dest}'s queue. Use Start calling or set lanes under Data Update / Auto Mode.`;
      setQueueNotice(result.notice ? `${base} ${result.notice}` : base);
      setTimeout(() => setQueueNotice(null), result.notice ? 16000 : 8000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not add contacts to the queue");
    } finally {
      setAssigning(false);
    }
  }

  async function handleAutoModeStart(persona: string) {
    setStartingAutoPersona(persona);
    try {
      await client.startAiSalesAgentRunner(persona, {
        sequence: true,
        queue_lane: "auto_mode",
      });
      const name = personaName(persona);
      setQueueNotice(
        `${name} started AI Auto Mode on the AI Auto Mode list only. Outreach and Data Update lists are untouched.`,
      );
      setTimeout(() => setQueueNotice(null), 10000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not start agent");
    } finally {
      setStartingAutoPersona(null);
    }
  }

  async function handleCallOne(task: AiSalesAgentTask) {
    if (task.persona === "pipeline") {
      onError("Assign this contact to an AI Sales Agent first.");
      return;
    }
    setCallingTaskId(task.id);
    try {
      await client.startAiSalesAgentRunner(task.persona, {
        task_id: task.id,
        sequence: false,
      });
      const agentName = personaName(task.persona);
      setQueueNotice(
        `${agentName} is calling ${task.contact_name || task.company_name || "this number"} now. Follow-up WhatsApp and email send automatically when the call ends.`,
      );
      setTimeout(() => setQueueNotice(null), 12000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not start this call");
    } finally {
      setCallingTaskId(null);
    }
  }

  async function handleRunnerAction(
    persona: string,
    action: "start" | "pause",
  ) {
    try {
      if (action === "start") {
        await client.startAiSalesAgentRunner(persona, { sequence: true });
        const agentName = personaName(persona);
        setQueueNotice(
          `${agentName} is calling the queue in sequence. After each call, WhatsApp and email are sent automatically (missed-call email if no pickup), then the next number is dialed.`,
        );
        setTimeout(() => setQueueNotice(null), 14000);
      } else {
        await client.pauseAiSalesAgentRunner(persona);
      }
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Runner action failed");
    }
  }

  async function handleEndCall(opts?: {
    persona?: string;
    call_sid?: string | null;
    task_id?: number | null;
  }) {
    setEndingCall(true);
    try {
      const persona = opts?.persona || selfTestPersona;
      const call_sid = opts?.call_sid || lastCallSid || undefined;
      const task_id = opts?.task_id || lastCallTaskId || undefined;
      // Prefer live in-progress task for this persona when SID not passed.
      const live =
        !call_sid && !task_id
          ? tasks.find(
              (t) =>
                t.persona === persona &&
                (t.status === "in_progress" || t.status === "running") &&
                t.call_sid,
            )
          : null;
      const res = await client.endAiSalesAgentCall({
        persona,
        call_sid: call_sid || live?.call_sid || undefined,
        task_id: task_id || live?.id || undefined,
      });
      setLastCallSid(null);
      setLastCallTaskId(null);
      setQueueNotice(followupNotice("Call ended.", res.followup || res.task?.followup));
      setTimeout(() => setQueueNotice(null), 12000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to end call");
    } finally {
      setEndingCall(false);
    }
  }

  function toggleAllowedLanguage(code: string) {
    setAllowedLanguages((prev) => {
      if (prev.includes(code)) {
        // Keep at least the speaking language ticked.
        if (code === selfTestLanguage) return prev;
        const next = prev.filter((c) => c !== code);
        return next.length ? next : [selfTestLanguage || "en"];
      }
      return [...prev, code];
    });
  }

  function onSpeakingLanguageChange(code: string) {
    setSelfTestLanguage(code);
    setAllowedLanguages((prev) => ensureStartLanguageAllowed(code, prev));
  }

  function openWhatsAppForTask(task: AiSalesAgentTask) {
    if (!task.contact_phone) {
      onError("No phone number available for this contact.");
      return;
    }
    setWhatsAppModalTarget({
      phone: task.contact_phone,
      row: {
        id: task.buyer_id || 0,
        company_name: task.company_name || "Lead",
        country: task.country || null,
      } as unknown as any,
    });
  }

  function openTelegramForTask(task: AiSalesAgentTask) {
    if (!task.contact_phone) {
      onError("No phone number available for this contact.");
      return;
    }
    setTelegramModalTarget({
      phone: task.contact_phone,
      row: {
        id: task.buyer_id || 0,
        company_name: task.company_name || "Lead",
        country: task.country || null,
      } as unknown as any,
    });
  }

  function openEmailForTask(task: AiSalesAgentTask) {
    setEmailModalInitial({
      to: (task as any).contact_email || "",
      subject: `Follow-up from Kafi Commodities · ${task.company_name || ""}`,
    });
    setEmailModalOpen(true);
  }

  async function handleSkip(taskId: number) {
    try {
      await client.skipAiSalesAgentTask(taskId);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Skip failed");
    }
  }

  async function handleRemove(taskId: number) {
    try {
      await client.deleteAiSalesAgentTask(taskId);
      setSelectedTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Remove failed");
    }
  }

  async function handleBulkRemove() {
    const ids = [...selectedTaskIds];
    if (!ids.length) return;
    if (!window.confirm(`Remove ${ids.length} contact(s) from the AI Sales Agent Pipeline?`)) return;
    setBulkRemoving(true);
    try {
      await client.bulkDeleteAiSalesAgentTasks(ids);
      setSelectedTaskIds(new Set());
      await load();
      setQueueNotice(`Removed ${ids.length} contact(s) from the pipeline.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk remove failed");
    } finally {
      setBulkRemoving(false);
    }
  }

  async function handleAssignToAgent(persona: string, taskIds?: number[]) {
    const ids =
      taskIds ??
      [...selectedTaskIds].filter((id) =>
        tasks.some((t) => t.id === id && t.persona === "pipeline"),
      );
    if (!ids.length) {
      onError("Select contacts from the AI Sales Agent list first.");
      return;
    }
    const name = personaName(persona);
    setAssigning(true);
    try {
      const res = await client.setAiSalesTaskPersona({ task_ids: ids, persona });
      setSelectedTaskIds(new Set());
      setFilterPersona(persona);
      setQueueNotice(
        `Assigned ${res.updated} contact(s) to ${name}. Split them into Outreach / Data Update / AI Auto Mode under the schedule panel.`,
      );
      setTimeout(() => setQueueNotice(null), 12000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to assign to agent");
    } finally {
      setAssigning(false);
    }
  }

  function toggleTaskSelected(taskId: number) {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function toggleSelectAllVisible(on: boolean) {
    const visible = filterPersona
      ? tasks.filter((t) => t.persona === filterPersona)
      : tasks;
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      for (const t of visible) {
        if (on) next.add(t.id);
        else next.delete(t.id);
      }
      return next;
    });
  }

  const pipelineTasks = tasks.filter((t) => t.persona === "pipeline");
  const visibleTasks = filterPersona
    ? tasks.filter((t) => t.persona === filterPersona)
    : tasks;
  const selectedPipelineIds = [...selectedTaskIds].filter((id) =>
    tasks.some((t) => t.id === id && t.persona === "pipeline"),
  );

  useEffect(() => {
    const prev = pipelineLenRef.current;
    pipelineLenRef.current = visibleTasks.length;
    if (prev <= 12 && visibleTasks.length > 12) setPipelineListOpen(false);
  }, [visibleTasks.length]);

  if (!unlocked) {
    return (
      <section className="max-w-3xl space-y-5">
        <div>
          <h2 className="text-lg font-medium text-slate-100">AI Sales Agent</h2>
          <p className="text-sm text-slate-400 mt-1">
            Enter the access code to open Rayan and Sara&apos;s outbound calling queue.
          </p>
        </div>
        {unlockError ? (
          <p className="text-sm text-red-400">{unlockError}</p>
        ) : null}
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void tryUnlock();
          }}
          placeholder="Access code"
          className="w-full max-w-md rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100"
        />
        <button
          type="button"
          disabled={unlocking || !codeInput.trim()}
          onClick={() => void tryUnlock()}
          className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40"
        >
          {unlocking ? "Checking… (may retry if API is restarting)" : "Unlock"}
        </button>

        {isAdmin ? (
          <div className="pt-2 space-y-2">
            <p className="text-xs text-slate-500">
              Configure Auto Mode below (saved even before unlock). Training lives under{" "}
              <strong className="text-slate-300">Call Center → AI Train</strong>.
            </p>
            <AiAutoModePanel onError={onError} compact />
          </div>
        ) : null}
      </section>
    );
  }

  if (loading && !runners.length) {
    return <p className="text-sm text-slate-400 p-6">Loading AI Sales Agent…</p>;
  }

  return (
    <section className="space-y-6 w-full min-w-0">
      <div>
        <h2 className="text-lg font-medium text-slate-100">AI Sales Agent</h2>
        <p className="text-sm text-slate-400 mt-1">
          Agents dial leads for the Active Master List{" "}
          <strong className="text-slate-200">{masterListLabel}</strong>. Only agents ticked for
          this list in Settings appear below — product-specialized agents stay scoped to their
          lists. Use <strong className="text-slate-300">AI Auto Mode</strong> for call / email /
          WhatsApp behaviour. Training is under{" "}
          <strong className="text-slate-300">Call Center → AI Train</strong>.
        </p>
      </div>

      {agentOptions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-violet-500/40 bg-violet-950/20 px-4 py-8 text-center space-y-2">
          <p className="text-sm text-slate-100">
            No AI Sales Agents for <strong>{masterListLabel}</strong>
          </p>
          <p className="text-xs text-slate-400 max-w-lg mx-auto">
            In Settings → Access to master lists, tick which agents may work{" "}
            <strong>{masterListLabel}</strong>. Product-specialized agents only appear when that
            list is selected and they are assigned.
          </p>
        </div>
      ) : null}

      <AiAutoDataUpdatePanel
        onError={onError}
        tasks={tasks}
        onTasksChanged={() => void load()}
        masterType={masterType}
        allowedAgents={agentOptions.map((a) => ({ id: a.id, label: a.name }))}
      />

      {agentOptions.length > 0 ? (
        <>
      <AiAutoModePanel
        onError={onError}
        onStartAgent={(persona) => void handleAutoModeStart(persona)}
        startingPersona={startingAutoPersona}
      />

      <AiSalesProcessesPanel onError={onError} />
      {queueNotice ? (
        <p className="text-sm text-emerald-300 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          {queueNotice}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {runners
          .filter((runner) => agentOptions.some((a) => a.id === runner.persona))
          .map((runner) => (
          <div
            key={runner.persona}
            className="rounded-xl border border-slate-700/80 bg-slate-900/40 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-medium text-slate-100">
                  {runner.display_name}{" "}
                  <span className="text-slate-500 text-sm">({runner.gender_label})</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Mailbox / KPI: {runner.app_username} · Voice: {runner.voice}
                </p>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  runner.status === "running"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : runner.status === "paused"
                      ? "bg-amber-500/20 text-amber-300"
                      : "bg-slate-700 text-slate-300"
                }`}
              >
                {runner.status}
              </span>
            </div>
            <p className="text-sm text-slate-400">
              {runner.pending_count} pending
              {runner.sequence_mode && runner.status === "running" ? " · sequence" : ""}
              {runner.current_task?.company_name
                ? ` · Calling ${runner.current_task.company_name}`
                : ""}
            </p>
            {!runner.twilio_ready && (
              <p className="text-xs text-amber-400">
                Twilio webhooks not ready — check Railway TWILIO_* env vars.
              </p>
            )}
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={
                    !runner.twilio_ready ||
                    runner.status === "running" ||
                    runner.pending_count === 0
                  }
                  onClick={() => void handleRunnerAction(runner.persona, "start")}
                  className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium"
                >
                  Start calling (all in sequence)
                </button>
                <button
                  type="button"
                  disabled={runner.status !== "running"}
                  onClick={() => void handleRunnerAction(runner.persona, "pause")}
                  className="px-3 py-1.5 text-sm rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Pause
                </button>
                <button
                  type="button"
                  disabled={endingCall || (runner.status !== "running" && !runner.current_task)}
                  onClick={() =>
                    void handleEndCall({
                      persona: runner.persona,
                      call_sid: runner.current_task?.call_sid,
                      task_id: runner.current_task?.id ?? runner.current_task_id,
                    })
                  }
                  className="px-3 py-1.5 text-sm rounded-lg bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-40 font-medium flex items-center gap-1"
                  title="End current call immediately"
                >
                  <span>🔴 End call</span>
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {isAdmin && (
        <div className="rounded-xl border border-violet-500/40 bg-violet-500/5 p-4 space-y-3">
          <h3 className="font-medium text-slate-100">Test call to your phone</h3>
          <p className="text-xs text-slate-500">
            Fastest way to hear Sara or Rayan: enter your mobile here. When the call ends they
            send WhatsApp and email automatically (a missed-call note if you do not pick up).
          </p>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm text-slate-400">
              Agent
              <select
                value={selfTestPersona}
                onChange={(e) => setSelfTestPersona(e.target.value)}
                className="mt-1 block w-full min-w-[140px] rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              >
                {agentOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-400">
              Speaking Language
              <select
                value={selfTestLanguage}
                onChange={(e) => onSpeakingLanguageChange(e.target.value)}
                className="mt-1 block w-full min-w-[160px] rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100 font-medium"
              >
                {SPEAKING_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                    {opt.code === "en" ? " (Default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-400 flex-1 min-w-[160px]">
              Your name on the call
              <input
                value={selfTestName}
                onChange={(e) => setSelfTestName(e.target.value)}
                placeholder={user?.full_name || "Your name"}
                className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              />
            </label>
            <label className="text-sm text-slate-400 flex-1 min-w-[180px]">
              Your mobile (E.164)
              <input
                value={selfTestPhone}
                onChange={(e) => setSelfTestPhone(e.target.value)}
                placeholder="+923001234567"
                className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={selfTesting || !selfTestPhone.trim()}
                onClick={() => void handleDirectCall()}
                className="px-4 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 font-bold text-white shadow-md disabled:opacity-40 flex items-center gap-1.5"
                title="Initiate direct call to this phone number immediately"
              >
                <span>📞 Call Now</span>
              </button>
              <button
                type="button"
                disabled={endingCall}
                onClick={() =>
                  void handleEndCall({
                    persona: selfTestPersona,
                    call_sid: lastCallSid,
                    task_id: lastCallTaskId,
                  })
                }
                className="px-3.5 py-2 text-sm rounded-lg bg-rose-600 hover:bg-rose-500 font-semibold text-white disabled:opacity-40 flex items-center gap-1.5"
                title="End active call immediately"
              >
                <span>🔴 End Call</span>
              </button>
              <button
                type="button"
                disabled={selfTesting || !selfTestPhone.trim()}
                onClick={() => void handleSelfTest()}
                className="px-3.5 py-2 text-sm rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                {selfTesting ? "Queueing…" : "Queue test call"}
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-slate-700/80 bg-slate-950/50 px-3 py-2.5">
            <p className="text-xs font-medium text-slate-300 mb-1.5">
              Allowed languages on this call
            </p>
            <p className="text-[11px] text-slate-500 mb-2">
              Untick languages you do not want (Chinese/Japanese are off by default — they were
              causing random switches when you spoke Urdu). Speaking language stays ticked.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {SPEAKING_LANGUAGE_OPTIONS.map((opt) => {
                const checked = allowedLanguages.includes(opt.code);
                const locked = opt.code === selfTestLanguage;
                return (
                  <label
                    key={opt.code}
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      locked ? "text-emerald-300" : "text-slate-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={() => toggleAllowedLanguage(opt.code)}
                      className="rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500/40"
                    />
                    <span>
                      {opt.label}
                      {locked ? " (start)" : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-cyan-500/30 bg-slate-900/40 p-4 space-y-3">
          <h3 className="font-medium text-slate-100">Add contacts to AI Sales Agent Pipeline</h3>
          <p className="text-xs text-slate-500">
            Prefer <strong className="text-slate-300">AI Sales Agent list</strong> first, then assign
            Sara or Rayan and split Outreach / Data Update / AI Auto Mode. You can still add directly
            to Sara or Rayan. Contacts come from the Master Table — filter, tick, and add.
          </p>
          <AiSalesAgentQueuePicker
            persona={assignPersona}
            onPersonaChange={setAssignPersona}
            assigning={assigning}
            onAssign={(contacts) => void handleAssignContacts(contacts)}
            agentOptions={agentOptions}
          />
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
              Or paste Master Table lead IDs
            </summary>
            <div className="flex flex-wrap gap-3 items-end mt-3">
              <label className="text-sm text-slate-400 flex-1 min-w-[200px]">
                Lead IDs from table # column
                <input
                  value={buyerIdsRaw}
                  onChange={(e) => setBuyerIdsRaw(e.target.value)}
                  placeholder="e.g. 1204 1205 1206"
                  className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
                />
              </label>
              <button
                type="button"
                disabled={assigning}
                onClick={() => void handleAssign()}
                className="px-4 py-2 text-sm rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                {assigning ? "Assigning…" : "Assign IDs to queue"}
              </button>
            </div>
          </details>
        </div>
      )}

      <div className="rounded-xl border border-slate-700/80 bg-slate-900/40 p-4 text-sm text-slate-400">
        Sara &amp; Rayan training (playbook, ticked calls, Gemini) moved to{" "}
        <strong className="text-slate-200">Call Center → AI Train</strong>.
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setPipelineListOpen((v) => !v)}
            className="flex items-center gap-2 text-left min-w-0 hover:opacity-90"
            title={pipelineListOpen ? "Collapse list" : "Expand list"}
            aria-expanded={pipelineListOpen}
          >
            <span className="text-slate-400 text-xs shrink-0 w-3">
              {pipelineListOpen ? "▾" : "▸"}
            </span>
            <h3 className="font-medium text-slate-100">AI Sales Agent Pipeline</h3>
          </button>
          <button
            type="button"
            onClick={() => setPipelineListOpen((v) => !v)}
            className="text-[11px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800"
            title={pipelineListOpen ? "Collapse list" : "Expand list"}
          >
            {pipelineListOpen ? "Close" : "Open"}
          </button>
          <p className="w-full text-xs text-slate-500">
            Flow: <strong className="text-slate-300">list</strong> →{" "}
            <strong className="text-slate-300">Sara / Rayan</strong> →{" "}
            <strong className="text-slate-300">Outreach / Data Update / AI Auto Mode</strong>. Contacts
            stay until you Remove them. A contact cannot be on both Sara and Rayan.
          </p>
          {!pipelineListOpen && visibleTasks.length > 0 ? (
            <p className="w-full text-xs text-slate-400 -mt-1">
              {visibleTasks.length.toLocaleString()} contact
              {visibleTasks.length === 1 ? "" : "s"} hidden — click Open to view
              {selectedTaskIds.size > 0
                ? ` · ${[...selectedTaskIds].filter((id) => visibleTasks.some((t) => t.id === id)).length} selected`
                : ""}
            </p>
          ) : null}
          <select
            value={filterPersona}
            onChange={(e) => setFilterPersona(e.target.value)}
            className="text-sm rounded-lg border border-slate-600 bg-slate-950 px-2 py-1 text-slate-200"
          >
            <option value="">All</option>
            <option value="pipeline">AI Sales Agent list</option>
            {agentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs text-sky-400 hover:underline"
          >
            Refresh
          </button>
          {isAdmin && tasks.length > 0 ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-violet-500"
                  checked={
                    visibleTasks.length > 0 &&
                    visibleTasks.every((t) => selectedTaskIds.has(t.id))
                  }
                  onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                />
                Select all
              </label>
              {agentOptions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={assigning || selectedPipelineIds.length === 0}
                  onClick={() => void handleAssignToAgent(a.id)}
                  className="px-3 py-1 text-xs font-semibold rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                >
                  → {a.name} ({selectedPipelineIds.length})
                </button>
              ))}
              <button
                type="button"
                disabled={bulkRemoving || selectedTaskIds.size === 0}
                onClick={() => void handleBulkRemove()}
                className="px-3 py-1 text-xs font-semibold rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 disabled:opacity-40"
              >
                {bulkRemoving
                  ? "Removing…"
                  : `Remove selected (${[...selectedTaskIds].filter((id) => visibleTasks.some((t) => t.id === id)).length})`}
              </button>
            </div>
          ) : null}
        </div>

        {pipelineListOpen ? (
          <>
            {pipelineTasks.length > 0 && (filterPersona === "" || filterPersona === "pipeline") ? (
              <div className="rounded-lg border border-violet-500/40 bg-violet-950/20 px-3 py-2 text-xs text-violet-100">
                <strong className="font-semibold">{pipelineTasks.length}</strong> on AI Sales Agent list
                (not yet Sara/Rayan). Select rows → <strong>→ Sara</strong> / <strong>→ Rayan</strong>, then
                split lanes under the schedule panel.
              </div>
            ) : null}

            {!visibleTasks.length ? (
              <p className="text-sm text-slate-500">
                No contacts in the pipeline yet. Add to{" "}
                <strong className="text-slate-300">AI Sales Agent list</strong> above (or from any Master
                list → AI Sales Agent Pipeline).
              </p>
            ) : (
              <div className="rounded-xl border border-slate-700/80 overflow-hidden">
                <table className="w-full table-fixed text-sm text-left">
                  <colgroup>
                    <col className="w-[4%]" />
                    <col className="w-[9%]" />
                    <col className="w-[15%]" />
                    <col className="w-[13%]" />
                    <col className="w-[7%]" />
                    <col className="w-[7%]" />
                    <col className="w-[8%]" />
                    <col className="w-[9%]" />
                    <col className="w-[7%]" />
                    <col className="w-[7%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                  <thead className="bg-slate-900/60 text-slate-400">
                    <tr>
                      <th className="px-2 py-2.5 font-medium">
                        <span className="sr-only">Select</span>
                      </th>
                      <th className="px-3 py-2.5 font-medium">Agent</th>
                      <th className="px-3 py-2.5 font-medium">Company</th>
                      <th className="px-3 py-2.5 font-medium">Contact / phone</th>
                      <th className="px-3 py-2.5 font-medium">Status</th>
                      <th className="px-3 py-2.5 font-medium">Call</th>
                      <th className="px-3 py-2.5 font-medium">Email sent</th>
                      <th className="px-3 py-2.5 font-medium">WhatsApp sent</th>
                      <th className="px-3 py-2.5 font-medium">Email reply</th>
                      <th className="px-3 py-2.5 font-medium">Outcome</th>
                      <th className="px-3 py-2.5 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {visibleTasks.map((task) => (
                      <tr key={task.id} className="text-slate-200 align-top">
                        <td className="px-2 py-2.5">
                          <input
                            type="checkbox"
                            className="accent-violet-500"
                            checked={selectedTaskIds.has(task.id)}
                            onChange={() => toggleTaskSelected(task.id)}
                            aria-label={`Select ${task.company_name || task.id}`}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          {PERSONA_LABELS[task.persona] ?? personaName(task.persona)}
                        </td>
                        <td className="px-3 py-2.5 break-words">
                          {task.company_name ?? `#${task.buyer_id}`}
                          {task.country ? (
                            <span className="text-slate-500 text-xs ml-1">
                              ({task.country})
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 break-words">
                          {task.contact_name ?? "—"}
                          {task.contact_phone ? (
                            <div className="text-xs text-sky-300/90 font-mono break-all">
                              {task.contact_phone}
                            </div>
                          ) : (
                            <div className="text-xs text-amber-400">No phone on lead</div>
                          )}
                        </td>
                    <td className="px-3 py-2.5 capitalize">{task.status}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {task.status === "completed" || task.status === "in_progress" || task.call_sid ? (
                        <span className="text-emerald-400">
                          {task.status === "in_progress" ? "In progress" : "Made"}
                        </span>
                      ) : task.ready === false ? (
                        <span className="text-amber-400" title={(task.warnings ?? []).join("; ")}>
                          Needs data
                        </span>
                      ) : (
                        <span className="text-slate-500">Queued</span>
                      )}
                      {task.status === "in_progress" && task.remarks ? (
                        <div className="text-[10px] text-slate-500 mt-0.5 break-words" title={task.remarks}>
                          {task.remarks}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {task.followup?.email_status === "sent" ||
                      task.followup?.email_status === "ok" ||
                      task.followup?.email_status === "success" ? (
                        <span className="text-emerald-400" title={task.followup?.email_to || ""}>
                          Sent
                        </span>
                      ) : task.followup?.email_status === "skipped" ? (
                        <span className="text-slate-500">Skipped</span>
                      ) : task.followup?.email_status ? (
                        <span className="text-amber-400">{task.followup.email_status}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {task.followup?.whatsapp_status === "sent" ? (
                        <span className="text-emerald-400">Sent</span>
                      ) : task.followup?.whatsapp_status === "skipped" ? (
                        <span className="text-slate-500">Skipped</span>
                      ) : task.followup?.whatsapp_status === "not_connected" ? (
                        <span className="text-amber-400">WA offline</span>
                      ) : task.followup?.whatsapp_status ? (
                        <span className="text-amber-400">{task.followup.whatsapp_status}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500" title="Tracked when inbound email matching is wired">
                      —
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-400 break-words">
                      {task.outcome ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {task.contact_phone && (
                          <button
                            type="button"
                            onClick={() => openWhatsAppForTask(task)}
                            className="px-2 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1 transition"
                            title={`Send WhatsApp message to ${task.contact_phone}`}
                          >
                            <span>💬</span>
                            <span>WhatsApp</span>
                          </button>
                        )}
                        {task.contact_phone && (
                          <button
                            type="button"
                            onClick={() => openTelegramForTask(task)}
                            className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-semibold flex items-center gap-1 transition"
                            title={`Send Telegram message to ${task.contact_phone}`}
                          >
                            <span>✈️</span>
                            <span>Telegram</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEmailForTask(task)}
                          className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-semibold flex items-center gap-1 transition"
                          title={`Send Email to ${task.company_name || "Lead"}`}
                        >
                          <span>✉️</span>
                          <span>Email</span>
                        </button>
                        {isAdmin && task.status === "in_progress" ? (
                          <button
                            type="button"
                            disabled={endingCall}
                            onClick={() =>
                              void handleEndCall({
                                persona: task.persona,
                                call_sid: task.call_sid,
                                task_id: task.id,
                              })
                            }
                            className="px-2 py-1 rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-200 border border-rose-500/30 text-xs font-semibold disabled:opacity-40"
                            title="Hang up / clear stuck in-progress call"
                          >
                            {endingCall ? "Ending…" : "End / clear"}
                          </button>
                        ) : null}
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => void handleRemove(task.id)}
                            className="text-xs text-red-400 hover:underline px-1"
                            title="Remove from assigned pipeline permanently"
                          >
                            Remove
                          </button>
                        )}
                        {isAdmin && task.persona === "pipeline" && task.status === "queued" ? (
                          <>
                            {agentOptions.map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                disabled={assigning}
                                onClick={() => void handleAssignToAgent(a.id, [task.id])}
                                className="px-2 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-200 border border-emerald-500/30 text-xs font-semibold disabled:opacity-40"
                              >
                                → {a.name}
                              </button>
                            ))}
                          </>
                        ) : null}
                        {isAdmin &&
                          task.persona !== "pipeline" &&
                          (task.status === "queued" || task.status === "pending") && (
                          <>
                            <button
                              type="button"
                              disabled={callingTaskId === task.id || !task.contact_phone}
                              onClick={() => void handleCallOne(task)}
                              className="px-2 py-1 rounded bg-violet-600/20 hover:bg-violet-600/30 text-violet-200 border border-violet-500/30 text-xs font-semibold disabled:opacity-40"
                              title="Call only this number (does not continue to the rest of the queue)"
                            >
                              {callingTaskId === task.id ? "Calling…" : "Call this only"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleSkip(task.id)}
                              className="text-xs text-amber-400 hover:underline px-1"
                            >
                              Skip
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isAdmin ? (
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-t border-slate-800 bg-slate-950/50">
                <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-violet-500"
                    checked={
                      visibleTasks.length > 0 &&
                      visibleTasks.every((t) => selectedTaskIds.has(t.id))
                    }
                    onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                  />
                  Select all ({visibleTasks.length})
                </label>
                <button
                  type="button"
                  disabled={bulkRemoving || selectedTaskIds.size === 0}
                  onClick={() => void handleBulkRemove()}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 disabled:opacity-40"
                >
                  {bulkRemoving
                    ? "Removing…"
                    : `Remove selected (${[...selectedTaskIds].filter((id) => visibleTasks.some((t) => t.id === id)).length})`}
                </button>
              </div>
            ) : null}
              </div>
            )}
          </>
        ) : null}
      </div>

      {whatsAppModalTarget && (
        <LeadWhatsAppComposeModal
          target={whatsAppModalTarget}
          onClose={() => setWhatsAppModalTarget(null)}
          onError={onError}
          onSent={(msg) => {
            setQueueNotice(msg);
            setTimeout(() => setQueueNotice(null), 8000);
          }}
        />
      )}

      {telegramModalTarget && (
        <LeadTelegramComposeModal
          target={telegramModalTarget}
          onClose={() => setTelegramModalTarget(null)}
          onError={onError}
          onSent={(msg) => {
            setQueueNotice(msg);
            setTimeout(() => setQueueNotice(null), 8000);
          }}
        />
      )}

      {emailModalOpen && (
        <ComposeMailModal
          fromEmail={(user as any)?.mailbox_email || "export@kafi-group.com"}
          initialDraft={
            emailModalInitial
              ? {
                  to_addrs: emailModalInitial.to,
                  subject: emailModalInitial.subject,
                }
              : null
          }
          onClose={() => {
            setEmailModalOpen(false);
            setEmailModalInitial(null);
          }}
          onError={onError}
          onSent={(msg) => {
            setQueueNotice(msg);
            setTimeout(() => setQueueNotice(null), 8000);
          }}
        />
      )}
        </>
      ) : null}
    </section>
  );
}
