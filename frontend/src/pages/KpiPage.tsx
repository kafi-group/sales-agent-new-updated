import { useCallback, useEffect, useState } from "react";
import {
  client,
  type DailyKpiReport,
  type KpiCounts,
  type KpiPeriod,
  type KpiScorecard as KpiScorecardData,
  type AppUser,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ManualKpiSection } from "../components/ManualKpiSection";
import { ColumnVisibilityMenu } from "../components/ColumnVisibilityMenu";
import { KpiDrillDownModal } from "../components/KpiDrillDownModal";
import { KpiScorecard, scorecardToText } from "../components/KpiScorecard";
import {
  useColumnVisibility,
  type ColumnDef,
} from "../hooks/useColumnVisibility";
import { exportKpiReportPdf } from "../utils/exportKpiPdf";

interface KpiPageProps {
  onError: (message: string) => void;
}

function todayInKarachi(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    timeZone: "Asia/Karachi",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRangeLabel(report: DailyKpiReport): string {
  const start = report.date_start || report.date;
  const end = report.date_end || report.date;
  if (report.period === "day" || start === end) return start;
  return `${start} → ${end}`;
}

const PERIOD_OPTIONS: { value: KpiPeriod; label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

const COUNT_CARDS: { key: keyof KpiCounts; label: string }[] = [
  { key: "calls_logged", label: "Calls attempted" },
  { key: "companies_called", label: "Companies called" },
  { key: "outcomes_follow_up", label: "Calls picked up" },
  { key: "outcomes_interested", label: "Client interested" },
  { key: "outcomes_not_interested", label: "Not interested" },
  { key: "outcomes_not_received_call", label: "No answer" },
  { key: "call_remarks", label: "Call remarks" },
  { key: "leads_imported", label: "Leads imported" },
  { key: "table_edits", label: "Table edits" },
  { key: "email_templates_created", label: "Templates created" },
  { key: "personal_emails_sent", label: "Personal emails sent" },
  { key: "bulk_emails_sent", label: "Bulk emails sent" },
  { key: "personal_whatsapp_sent", label: "Personal WhatsApp sent" },
  { key: "bulk_whatsapp_sent", label: "Bulk WhatsApp sent" },
  { key: "inbox_replies", label: "Inbox replies" },
  { key: "brand_assistant_sessions", label: "AI Research & Update" },
];

const KPI_PER_USER_COLUMNS: ColumnDef[] = [
  { id: "user", label: "User", locked: true },
  { id: "calls", label: "Calls Attempted" },
  { id: "outcomes", label: "Outcomes" },
  { id: "edits", label: "Edits" },
  { id: "email", label: "Email" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "events", label: "Events" },
];

export function KpiPage({ onError }: KpiPageProps) {
  const { isAdmin, user } = useAuth();
  const columnsUi = useColumnVisibility(
    "kpi.per_user",
    KPI_PER_USER_COLUMNS,
    user?.id,
  );
  const [period, setPeriod] = useState<KpiPeriod>("day");
  const [date, setDate] = useState(todayInKarachi);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [assignees, setAssignees] = useState<AppUser[]>([]);
  const [report, setReport] = useState<DailyKpiReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [scorecard, setScorecard] = useState<KpiScorecardData | null>(null);
  const [scorecardLoading, setScorecardLoading] = useState(true);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [drillDownKey, setDrillDownKey] = useState<keyof KpiCounts | null>(null);
  const [drillDownLabel, setDrillDownLabel] = useState<string>("");

  useEffect(() => {
    if (!isAdmin) return;
    client
      .listAssignees()
      .then(setAssignees)
      .catch(() => setAssignees([]));
  }, [isAdmin]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const userId =
        isAdmin && selectedUserId ? Number(selectedUserId) : undefined;
      const result = await client.getDailyKpi({
        date,
        period,
        user_id: userId ?? null,
      });
      setReport(result);
    } catch (e) {
      setReport(null);
      onError(e instanceof Error ? e.message : "Failed to load KPI report");
    } finally {
      setLoading(false);
    }
  }, [date, isAdmin, onError, period, selectedUserId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadScorecard = useCallback(async () => {
    setScorecardLoading(true);
    try {
      const userId = isAdmin && selectedUserId ? Number(selectedUserId) : undefined;
      setScorecard(await client.getKpiScorecard({ date, period, user_id: userId ?? null }));
    } catch (e) {
      setScorecard(null);
      onError(e instanceof Error ? e.message : "Failed to load the score card");
    } finally {
      setScorecardLoading(false);
    }
  }, [date, isAdmin, onError, period, selectedUserId]);

  useEffect(() => {
    void loadScorecard();
  }, [loadScorecard]);

  function exportPdf() {
    if (!report) return;
    setPdfExporting(true);
    try {
      exportKpiReportPdf({
        report,
        summary: scorecardToText(scorecard),
        summarySubject: "KPI score card",
        scopeLabel,
        periodLabel,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to export KPI PDF");
    } finally {
      setPdfExporting(false);
    }
  }

  const scopeLabel =
    report?.scope === "team"
      ? "Team"
      : report?.user?.full_name || user?.full_name || "Your activity";

  const periodLabel =
    period === "week" ? "Weekly" : period === "month" ? "Monthly" : "Daily";

  const dateInputLabel =
    period === "week"
      ? "Any day in week"
      : period === "month"
        ? "Any day in month"
        : "Date";

  return (
    <div className="space-y-6 w-full min-w-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">KPI</h2>
          <p className="mt-1 text-sm text-slate-400">
            {periodLabel} activity report ({report?.timezone || "Asia/Karachi"}).
            Weeks are Mon–Sun. Tracking starts from go-live.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-xs text-slate-400">
            Period
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as KpiPeriod)}
              className="mt-1 block rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              {PERIOD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-slate-400">
            {dateInputLabel}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 block rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            />
          </label>
          {isAdmin && (
            <label className="block text-xs text-slate-400">
              User
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="mt-1 block min-w-[12rem] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                <option value="">All users (team)</option>
                {assignees.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.username})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => {
              void refresh();
              void loadScorecard();
            }}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={!report || loading || pdfExporting}
            onClick={exportPdf}
            className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
          >
            {pdfExporting ? "Exporting…" : "Export PDF"}
          </button>
        </div>
      </div>

      {loading && !report ? (
        <p className="text-sm text-slate-400">Loading report…</p>
      ) : report ? (
        <>
          <p className="text-sm text-slate-300">
            Showing <span className="text-slate-100 font-medium">{scopeLabel}</span>{" "}
            · {report.activity_count} activit
            {report.activity_count === 1 ? "y" : "ies"} · {formatRangeLabel(report)}
          </p>

          <KpiScorecard scorecard={scorecard} loading={scorecardLoading} />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {COUNT_CARDS.map((card) => {
              const val = report.counts[card.key] ?? 0;
              return (
                <button
                  type="button"
                  key={card.key}
                  onClick={() => {
                    setDrillDownKey(card.key);
                    setDrillDownLabel(card.label);
                  }}
                  className="group relative rounded-xl border border-slate-800 bg-slate-900/70 hover:bg-slate-800/90 hover:border-sky-500/70 p-3.5 text-left transition-all duration-150 hover:shadow-xl hover:shadow-sky-950/40 hover:-translate-y-0.5 active:translate-y-0 cursor-pointer"
                  title={`Click to view details for ${card.label}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-400 group-hover:text-sky-300 font-medium transition">
                      {card.label}
                    </p>
                    <span className="text-[11px] text-slate-500 group-hover:text-sky-300 opacity-0 group-hover:opacity-100 transition font-mono">
                      ↗ Details
                    </span>
                  </div>
                  <p className="mt-1.5 text-2xl font-black tabular-nums text-slate-100 group-hover:text-sky-100">
                    {val}
                  </p>
                  {card.key === "personal_emails_sent" &&
                  ((report.counts.emails_after_calls ?? 0) > 0 ||
                    (report.counts.emails_other_personal ?? 0) > 0) ? (
                    <p className="mt-1 text-[11px] text-slate-500 leading-snug">
                      {report.counts.emails_after_calls ?? 0} after calls ·{" "}
                      {report.counts.emails_other_personal ?? 0} other personal
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>

          {report.email_attribution_note ? (
            <section className="rounded-lg border border-sky-800/40 bg-sky-950/20 px-4 py-3">
              <h3 className="text-xs font-medium uppercase tracking-wider text-sky-400/90">
                Calls vs emails
              </h3>
              <p className="mt-2 text-sm text-slate-200 leading-relaxed">
                {report.email_attribution_note}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Personal emails linked to a call log count as post-call follow-up. Other personal
                sends are table outreach, mailer, or manual compose. Bulk is batch sends.
              </p>
            </section>
          ) : null}

          {isAdmin && report.scope === "team" && report.per_user.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium uppercase tracking-wider text-slate-500">
                  Per user
                </h3>
                <ColumnVisibilityMenu
                  columns={columnsUi.columns}
                  isVisible={columnsUi.isVisible}
                  toggle={columnsUi.toggle}
                  showAll={columnsUi.showAll}
                  resetDefaults={columnsUi.resetDefaults}
                  hiddenCount={columnsUi.hiddenCount}
                />
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                {columnsUi.css ? <style>{columnsUi.css}</style> : null}
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-900/80 text-xs uppercase text-slate-500">
                    <tr>
                      <th data-col="user" className="px-3 py-2 font-medium">User</th>
                      <th data-col="calls" className="px-3 py-2 font-medium">Calls</th>
                      <th data-col="outcomes" className="px-3 py-2 font-medium">Outcomes</th>
                      <th data-col="edits" className="px-3 py-2 font-medium">Edits</th>
                      <th data-col="email" className="px-3 py-2 font-medium">Email</th>
                      <th data-col="whatsapp" className="px-3 py-2 font-medium">WhatsApp</th>
                      <th data-col="events" className="px-3 py-2 font-medium">Events</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {report.per_user.map((row) => {
                      const outcomes =
                        row.counts.outcomes_interested +
                        (row.counts.outcomes_follow_up ?? 0) +
                        row.counts.outcomes_not_interested +
                        row.counts.outcomes_not_received_call;
                      const emails =
                        (row.counts.personal_emails_sent ?? 0) + (row.counts.bulk_emails_sent ?? 0);
                      const emailDetail =
                        (row.counts.emails_after_calls ?? 0) > 0 ||
                        (row.counts.emails_other_personal ?? 0) > 0
                          ? `${row.counts.emails_after_calls ?? 0} call · ${row.counts.emails_other_personal ?? 0} other · ${row.counts.bulk_emails_sent ?? 0} bulk`
                          : null;
                      const whatsapp =
                        (row.counts.personal_whatsapp_sent ?? 0) +
                        (row.counts.bulk_whatsapp_sent ?? 0);
                      return (
                        <tr key={row.user?.id ?? row.activity_count} className="text-slate-300">
                          <td data-col="user" className="px-3 py-2 text-slate-100">
                            {row.user?.full_name || "Unknown"}
                          </td>
                          <td data-col="calls" className="px-3 py-2 tabular-nums">
                            <div>{row.counts.calls_logged}</div>
                            {row.counts.companies_called ? (
                              <div className="text-[10px] text-slate-500 font-normal">
                                {row.counts.companies_called} {row.counts.companies_called === 1 ? "company" : "companies"}
                              </div>
                            ) : null}
                          </td>
                          <td data-col="outcomes" className="px-3 py-2 tabular-nums">
                            <div>{outcomes}</div>
                            {(row.counts.outcomes_follow_up ?? 0) > 0 ? (
                              <div className="text-[10px] text-emerald-400 font-normal">
                                {row.counts.outcomes_follow_up} picked up
                              </div>
                            ) : null}
                          </td>
                          <td data-col="edits" className="px-3 py-2 tabular-nums">{row.counts.table_edits}</td>
                          <td data-col="email" className="px-3 py-2 tabular-nums">
                            <div>{emails}</div>
                            {emailDetail ? (
                              <div className="text-[10px] text-slate-500 font-normal">{emailDetail}</div>
                            ) : null}
                          </td>
                          <td data-col="whatsapp" className="px-3 py-2 tabular-nums">{whatsapp}</td>
                          <td data-col="events" className="px-3 py-2 tabular-nums">{row.activity_count}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-medium uppercase tracking-wider text-slate-500">
              Full activity
            </h3>
            {report.activities.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-500">
                No tracked activity for this {period === "day" ? "day" : period} yet.
                New work will appear here once you call, edit leads, send bulk email,
                and so on.
              </p>
            ) : (
              <ul className="space-y-2">
                {report.activities.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-slate-100">{item.title}</p>
                      <p className="text-xs text-slate-500">{formatWhen(item.created_at)}</p>
                    </div>
                    <p className="mt-1 text-sm text-slate-400">{item.summary}</p>
                    <p className="mt-1 text-xs text-slate-600">
                      {item.full_name || item.username || `User #${item.user_id}`}
                      {item.quantity > 1 ? ` · qty ${item.quantity}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      <ManualKpiSection
        anchorDate={date}
        isAdmin={isAdmin}
        assignees={assignees}
        onError={onError}
      />

      {drillDownKey && report && (
        <KpiDrillDownModal
          cardKey={drillDownKey}
          cardLabel={drillDownLabel}
          activities={report.activities}
          counts={report.counts}
          scopeLabel={scopeLabel}
          dateLabel={formatRangeLabel(report)}
          reportParams={{
            date,
            period,
            user_id: isAdmin && selectedUserId ? Number(selectedUserId) : null,
          }}
          onClose={() => {
            setDrillDownKey(null);
            setDrillDownLabel("");
          }}
        />
      )}
    </div>
  );
}
