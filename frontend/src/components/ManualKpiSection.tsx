import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  type AppUser,
  type ManualKpiEntry,
  type ManualKpiPeriod,
} from "../api/client";

interface ManualKpiSectionProps {
  anchorDate: string;
  isAdmin: boolean;
  assignees: AppUser[];
  onError: (message: string) => void;
}

const MANUAL_PERIOD_OPTIONS: { value: ManualKpiPeriod; label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "year", label: "Yearly" },
];

const CONTACT_TYPES = ["Phone", "Call", "WhatsApp", "Email", "No"];
const FOLLOW_UP_TYPES = ["Email", "WhatsApp", "Call", "No"];
const WECHAT_OPTIONS = ["No", "Yes"];

type DraftRow = ManualKpiEntry & { _dirty?: boolean };

function formatRange(start: string, end: string, period: string): string {
  if (period === "day" || start === end) return start;
  return `${start} → ${end}`;
}

export function ManualKpiSection({
  anchorDate,
  isAdmin,
  assignees,
  onError,
}: ManualKpiSectionProps) {
  const [period, setPeriod] = useState<ManualKpiPeriod>("month");
  const [userFilter, setUserFilter] = useState("");
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [rangeLabel, setRangeLabel] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.listManualKpi({
        date: anchorDate,
        period,
        user_id: isAdmin && userFilter ? Number(userFilter) : undefined,
      });
      setRows(result.items);
      setTotal(result.total);
      setRangeLabel(formatRange(result.date_start, result.date_end, result.period));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load manual KPI");
    } finally {
      setLoading(false);
    }
  }, [anchorDate, isAdmin, onError, period, userFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateLocal(id: number, field: keyof ManualKpiEntry, value: string) {
    setRows((prev) =>
      prev.map((row) =>
        row.id === id ? { ...row, [field]: value, _dirty: true } : row,
      ),
    );
  }

  async function saveRow(row: DraftRow) {
    setSavingId(row.id);
    try {
      const updated = await client.updateManualKpi(row.id, {
        activity_date: row.activity_date,
        person_name: row.person_name || null,
        company: row.company || null,
        country: row.country || null,
        contact_type: row.contact_type || null,
        follow_up_type: row.follow_up_type || null,
        wechat_contacts: row.wechat_contacts || null,
        remarks: row.remarks || null,
      });
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...updated, _dirty: false } : r)),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save row");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteRow(id: number) {
    if (!window.confirm("Delete this manual KPI row?")) return;
    setDeletingId(id);
    try {
      await client.deleteManualKpi(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete row");
    } finally {
      setDeletingId(null);
    }
  }

  async function addRow() {
    setAdding(true);
    try {
      const created = await client.createManualKpi({
        activity_date: anchorDate,
        wechat_contacts: "No",
      });
      setRows((prev) => [created, ...prev]);
      setTotal((t) => t + 1);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add row");
    } finally {
      setAdding(false);
    }
  }

  const summaryMetrics = useMemo(() => {
    let waChat = 0;
    let waCalls = 0;
    let phoneCalls = 0;
    let callsAttended = 0;
    let callsConvertWa = 0;
    let inquiries = 0;
    let buyersFollowups = 0;
    const countriesSet = new Set<string>();

    for (const r of rows) {
      const cType = (r.contact_type || "").toLowerCase();
      const fType = (r.follow_up_type || "").toLowerCase();
      const rem = (r.remarks || "").toLowerCase();
      const ctry = (r.country || "").trim();

      if (ctry) countriesSet.add(ctry);

      if (cType.includes("whatsapp") || fType.includes("whatsapp") || cType.includes("wa")) {
        waChat++;
      }
      if (cType.includes("wa call") || cType.includes("whatsapp call")) {
        waCalls++;
      }
      if (cType.includes("call") || cType.includes("phone")) {
        phoneCalls++;
      }
      if (
        (cType.includes("call") || cType.includes("phone")) &&
        !rem.includes("hangup") &&
        !rem.includes("no answer")
      ) {
        callsAttended++;
      }
      if (fType.includes("whatsapp") || rem.includes("whatsapp") || rem.includes("wa")) {
        callsConvertWa++;
      }
      if (
        rem.includes("price") ||
        rem.includes("catalogue") ||
        rem.includes("quote") ||
        rem.includes("inquiry") ||
        rem.includes("interested")
      ) {
        inquiries++;
      }
      if (fType && fType !== "no") {
        buyersFollowups++;
      }
    }

    const countriesList = Array.from(countriesSet).join(", ") || "None";
    const waStatus = waChat > 0 || waCalls > 0 ? "Done" : "Pending";
    const bulkEmail = rows.some((r) => (r.follow_up_type || "").toLowerCase().includes("email"))
      ? "Done"
      : "Pending";

    return {
      waChat,
      waCalls,
      phoneCalls: phoneCalls || rows.length,
      callsAttended,
      callsConvertWa,
      inquiries,
      buyersFollowups,
      countriesList,
      waStatus,
      bulkEmail,
    };
  }, [rows]);

  const inputClass =
    "w-full min-w-0 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";

  return (
    <section className="space-y-4 rounded-xl border border-violet-800/40 bg-violet-950/10 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-base font-medium text-slate-100">Manual KPI (Usman & Asim Log)</h3>
          <p className="mt-1 text-sm text-slate-400">
            Off-system activity log matching the Daily KPI Report spreadsheet. Starts empty; each user logs their own rows.
            {isAdmin ? " You see entries for Usman, Asim, and all team reps." : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-xs text-slate-400">
            View
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as ManualKpiPeriod)}
              className="mt-1 block rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-sm text-slate-100"
            >
              {MANUAL_PERIOD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {isAdmin && (
            <label className="block text-xs text-slate-400">
              User
              <select
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                className="mt-1 block min-w-[10rem] rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-sm text-slate-100"
              >
                <option value="">All users (Usman & Asim)</option>
                {assignees.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name || u.username}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={adding}
            onClick={() => void addRow()}
            className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
          >
            {adding ? "Adding…" : "Add row"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-3">
        <div className="flex items-center justify-between gap-3 mb-2">
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-300 flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            Daily KPI Summary Bar (Excel Spreadsheet Metrics)
          </span>
          <span className="text-xs text-emerald-400/80 font-mono">{rangeLabel}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-11 gap-2 text-center text-xs">
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">Date</p>
            <p className="font-mono text-emerald-100 mt-1 truncate">{anchorDate}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">WA Chat</p>
            <p className="text-lg font-bold text-emerald-100 mt-0.5 tabular-nums">{summaryMetrics.waChat}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">WA Calls</p>
            <p className="text-lg font-bold text-emerald-100 mt-0.5 tabular-nums">{summaryMetrics.waCalls}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">Phone Calls</p>
            <p className="text-lg font-bold text-emerald-100 mt-0.5 tabular-nums">{summaryMetrics.phoneCalls}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">Calls Attended</p>
            <p className="text-lg font-bold text-emerald-100 mt-0.5 tabular-nums">{summaryMetrics.callsAttended}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">Calls Convert WA</p>
            <p className="text-lg font-bold text-emerald-100 mt-0.5 tabular-nums">{summaryMetrics.callsConvertWa}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">Inquiries</p>
            <p className="text-lg font-bold text-emerald-100 mt-0.5 tabular-nums">{summaryMetrics.inquiries}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">Buyers Follow Ups</p>
            <p className="text-lg font-bold text-emerald-100 mt-0.5 tabular-nums">{summaryMetrics.buyersFollowups}</p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2 lg:col-span-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">Mails & Countries</p>
            <p className="text-xs font-medium text-emerald-200 mt-1 truncate" title={summaryMetrics.countriesList}>
              {summaryMetrics.countriesList}
            </p>
          </div>
          <div className="rounded border border-emerald-800/60 bg-emerald-900/40 p-2">
            <p className="text-[10px] text-emerald-300 uppercase font-semibold">WA / Bulk Email</p>
            <p className="text-xs font-semibold text-emerald-300 mt-1">
              {summaryMetrics.waStatus} / {summaryMetrics.bulkEmail}
            </p>
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        {rangeLabel ? `${total} row${total === 1 ? "" : "s"} · ${rangeLabel}` : ""}
      </p>

      {loading ? (
        <p className="text-sm text-slate-400">Loading manual KPI…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-500">
          No manual KPI rows for this period yet. Click <strong className="text-slate-300">Add row</strong>{" "}
          to log phone calls, WhatsApp chats, or emails done outside the app.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="min-w-[1100px] w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950 text-xs uppercase text-slate-500">
                {isAdmin && <th className="px-2 py-2 text-left font-medium">User</th>}
                <th className="px-2 py-2 text-left font-medium w-28">Date</th>
                <th className="px-2 py-2 text-left font-medium min-w-[120px]">Person Name</th>
                <th className="px-2 py-2 text-left font-medium min-w-[160px]">Company</th>
                <th className="px-2 py-2 text-left font-medium w-28">Country</th>
                <th className="px-2 py-2 text-left font-medium w-28">Contact Type</th>
                <th className="px-2 py-2 text-left font-medium w-28">Follow Up Type</th>
                <th className="px-2 py-2 text-left font-medium w-24">WeChat</th>
                <th className="px-2 py-2 text-left font-medium min-w-[240px]">Remarks</th>
                <th className="px-2 py-2 text-left font-medium w-28">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {rows.map((row) => (
                <tr key={row.id} className={row._dirty ? "bg-amber-500/5" : ""}>
                  {isAdmin && (
                    <td className="px-2 py-2 text-slate-400 text-xs whitespace-nowrap">
                      {row.full_name || row.username || `#${row.user_id}`}
                    </td>
                  )}
                  <td className="px-2 py-1">
                    <input
                      type="date"
                      value={row.activity_date}
                      onChange={(e) => updateLocal(row.id, "activity_date", e.target.value)}
                      className={inputClass}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={row.person_name || ""}
                      onChange={(e) => updateLocal(row.id, "person_name", e.target.value)}
                      className={inputClass}
                      placeholder="Contact person"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={row.company || ""}
                      onChange={(e) => updateLocal(row.id, "company", e.target.value)}
                      className={inputClass}
                      placeholder="Company"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={row.country || ""}
                      onChange={(e) => updateLocal(row.id, "country", e.target.value)}
                      className={inputClass}
                      placeholder="Country"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      list={`contact-type-${row.id}`}
                      value={row.contact_type || ""}
                      onChange={(e) => updateLocal(row.id, "contact_type", e.target.value)}
                      className={inputClass}
                    />
                    <datalist id={`contact-type-${row.id}`}>
                      {CONTACT_TYPES.map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      list={`follow-up-${row.id}`}
                      value={row.follow_up_type || ""}
                      onChange={(e) => updateLocal(row.id, "follow_up_type", e.target.value)}
                      className={inputClass}
                    />
                    <datalist id={`follow-up-${row.id}`}>
                      {FOLLOW_UP_TYPES.map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      value={row.wechat_contacts || "No"}
                      onChange={(e) => updateLocal(row.id, "wechat_contacts", e.target.value)}
                      className={inputClass}
                    >
                      {WECHAT_OPTIONS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <textarea
                      value={row.remarks || ""}
                      onChange={(e) => updateLocal(row.id, "remarks", e.target.value)}
                      rows={2}
                      className={`${inputClass} resize-y min-h-[2.5rem]`}
                      placeholder="What happened?"
                    />
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap space-x-1">
                    <button
                      type="button"
                      disabled={!row._dirty || savingId === row.id}
                      onClick={() => void saveRow(row)}
                      className="px-2 py-1 rounded bg-emerald-800/80 hover:bg-emerald-700 text-xs text-white disabled:opacity-40"
                    >
                      {savingId === row.id ? "…" : "Save"}
                    </button>
                    <button
                      type="button"
                      disabled={deletingId === row.id}
                      onClick={() => void deleteRow(row.id)}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-red-900/50 text-xs text-slate-300 disabled:opacity-40"
                    >
                      Del
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
