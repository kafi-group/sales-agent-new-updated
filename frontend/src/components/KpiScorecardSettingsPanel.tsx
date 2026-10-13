import { useState, type FormEvent } from "react";
import {
  client,
  type KpiScorecardConfig,
  type KpiScorecardConfigPayload,
} from "../api/client";

interface KpiScorecardSettingsPanelProps {
  onError: (message: string) => void;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const inputClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100";

/** Admin-only, password protected: the daily target for every score card pointer. */
export function KpiScorecardSettingsPanel({ onError }: KpiScorecardSettingsPanelProps) {
  const [pin, setPin] = useState("");
  const [unlockedPin, setUnlockedPin] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<Omit<KpiScorecardConfigPayload, "config"> | null>(null);
  const [draft, setDraft] = useState<KpiScorecardConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load(payload: KpiScorecardConfigPayload) {
    const { config, ...rest } = payload;
    setMeta(rest);
    setDraft(config);
  }

  async function unlock(e: FormEvent) {
    e.preventDefault();
    if (!pin.trim() || busy) return;
    setBusy(true);
    setPinError(null);
    try {
      load(await client.unlockKpiScorecardConfig(pin.trim()));
      setUnlockedPin(pin.trim());
      setPin("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not unlock";
      setPinError(/incorrect|password|403/i.test(message) ? "Incorrect password." : message);
    } finally {
      setBusy(false);
    }
  }

  function lockAgain() {
    setUnlockedPin(null);
    setDraft(null);
    setMeta(null);
    setNotice(null);
  }

  async function save() {
    if (!draft || !unlockedPin || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      load(await client.saveKpiScorecardConfig(unlockedPin, draft));
      setNotice("Saved. The score card on the KPI page now uses these targets.");
      window.setTimeout(() => setNotice(null), 6000);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the targets");
    } finally {
      setBusy(false);
    }
  }

  function patchPointer(index: number, patch: Partial<KpiScorecardConfig["pointers"][number]>) {
    setDraft((d) => d && { ...d, pointers: d.pointers.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  }

  function setPersonTarget(userId: number, key: string, raw: string) {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d.user_targets };
      const row = { ...(next[String(userId)] || {}) };
      if (raw.trim() === "") delete row[key];
      else row[key] = Math.max(0, Number(raw) || 0);
      if (Object.keys(row).length === 0) delete next[String(userId)];
      else next[String(userId)] = row;
      return { ...d, user_targets: next };
    });
  }

  const savedPointers = draft?.pointers.filter((p) => p.key) ?? [];

  return (
    <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-emerald-200">KPI Scorecard targets</h3>
        <p className="mt-1 text-xs text-slate-400 leading-relaxed">
          Set the daily target for each score card pointer. Each person is graded on actual ÷ target
          (A+ / A / B+ / B / C / D). Password protected.
        </p>
      </div>

      {!unlockedPin || !draft || !meta ? (
        <form onSubmit={unlock} className="flex flex-wrap items-end gap-3">
          <label className="block min-w-[12rem] flex-1">
            <span className="text-xs font-medium text-slate-300">Password</span>
            <input
              type="password"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setPinError(null);
              }}
              placeholder="Enter password"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              autoComplete="off"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !pin.trim()}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
          {pinError ? <p className="w-full text-xs text-rose-300">{pinError}</p> : null}
        </form>
      ) : (
        <div className="space-y-6">
          {/* Pointers */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Pointers and daily targets</h4>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/80 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">On</th>
                    <th className="px-3 py-2 min-w-[11rem]">Pointer</th>
                    <th className="px-3 py-2 min-w-[14rem]">Measured by</th>
                    <th className="px-3 py-2 w-28">Target / day</th>
                    <th className="px-3 py-2 w-20">Weight</th>
                    <th className="px-3 py-2 min-w-[12rem]">Note</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {draft.pointers.map((p, index) => (
                    <tr key={`${p.key || "new"}-${index}`} className="align-middle">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={(e) => patchPointer(index, { enabled: e.target.checked })}
                          title="Graded only when switched on and a target is set"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={p.label}
                          maxLength={60}
                          onChange={(e) => patchPointer(index, { label: e.target.value })}
                          className={inputClass}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={p.metric}
                          onChange={(e) => patchPointer(index, { metric: e.target.value })}
                          className={inputClass}
                        >
                          <optgroup label="Auto — from the system">
                            {meta.metrics
                              .filter((m) => m.source === "auto")
                              .map((m) => (
                                <option key={m.key} value={m.key}>
                                  {m.label}
                                </option>
                              ))}
                          </optgroup>
                          <optgroup label="Manual KPI sheet">
                            {meta.metrics
                              .filter((m) => m.source === "manual")
                              .map((m) => (
                                <option key={m.key} value={m.key}>
                                  {m.label}
                                </option>
                              ))}
                          </optgroup>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={p.target}
                          onChange={(e) => patchPointer(index, { target: Math.max(0, Number(e.target.value) || 0) })}
                          className={inputClass}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={p.weight}
                          onChange={(e) => patchPointer(index, { weight: Math.max(0, Number(e.target.value) || 0) })}
                          className={inputClass}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={p.note}
                          maxLength={200}
                          onChange={(e) => patchPointer(index, { note: e.target.value })}
                          placeholder="Optional"
                          className={inputClass}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            setDraft((d) => d && { ...d, pointers: d.pointers.filter((_, i) => i !== index) })
                          }
                          className="text-xs text-slate-500 hover:text-rose-300"
                          title="Remove this pointer"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              onClick={() =>
                setDraft(
                  (d) =>
                    d && {
                      ...d,
                      pointers: [
                        ...d.pointers,
                        { key: "", label: "", metric: meta.metrics[0]?.key || "calls_logged", target: 0, weight: 1, enabled: true, note: "" },
                      ],
                    },
                )
              }
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-200 hover:bg-slate-800"
            >
              + Add pointer
            </button>
            <p className="text-[11px] text-slate-500">
              A pointer with no target (0) is not graded. “Weight” makes a pointer count more or less in the overall
              grade (1 = normal). Week and month targets are the daily target × working days so far.
            </p>
          </div>

          {/* Per person */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Different target for one person (optional)
            </h4>
            {savedPointers.length === 0 || meta.users.length === 0 ? (
              <p className="text-xs text-slate-500">Save the pointers first, then you can set a person-specific target.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-900/80 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 min-w-[11rem]">Pointer (default / day)</th>
                      {meta.users.map((u) => (
                        <th key={u.id} className="px-3 py-2 min-w-[7rem]">
                          {u.full_name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {savedPointers.map((p) => (
                      <tr key={p.key}>
                        <td className="px-3 py-2 text-slate-200">
                          {p.label} <span className="text-slate-500">({p.target})</span>
                        </td>
                        {meta.users.map((u) => (
                          <td key={u.id} className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              value={draft.user_targets[String(u.id)]?.[p.key] ?? ""}
                              placeholder="default"
                              onChange={(e) => setPersonTarget(u.id, p.key, e.target.value)}
                              className={inputClass}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Grades + working days */}
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Grade — minimum % needed</h4>
              <div className="flex flex-wrap items-end gap-3">
                {meta.grade_order.map((grade) => (
                  <label key={grade} className="block text-xs text-slate-400">
                    {grade}
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      value={draft.grade_bands[grade] ?? 0}
                      onChange={(e) =>
                        setDraft((d) => d && { ...d, grade_bands: { ...d.grade_bands, [grade]: Number(e.target.value) || 0 } })
                      }
                      className="mt-1 block w-20 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100"
                    />
                  </label>
                ))}
                <span className="pb-2 text-xs text-slate-500">D = below C</span>
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Working days</h4>
              <div className="flex flex-wrap gap-3">
                {DAYS.map((label, day) => (
                  <label key={label} className="inline-flex items-center gap-1.5 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={draft.working_days.includes(day)}
                      onChange={(e) =>
                        setDraft(
                          (d) =>
                            d && {
                              ...d,
                              working_days: e.target.checked
                                ? [...d.working_days, day].sort()
                                : d.working_days.filter((x) => x !== day),
                            },
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save targets"}
            </button>
            <button
              type="button"
              onClick={lockAgain}
              className="px-4 py-2 rounded-lg border border-slate-700 text-sm text-slate-400 hover:text-slate-200"
            >
              Lock again
            </button>
            {notice ? <span className="text-xs text-emerald-300">{notice}</span> : null}
          </div>
        </div>
      )}
    </section>
  );
}
