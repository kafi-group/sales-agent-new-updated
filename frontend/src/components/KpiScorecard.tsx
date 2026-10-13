import type { KpiScorecard as KpiScorecardData, KpiScorecardCell } from "../api/client";

interface KpiScorecardProps {
  scorecard: KpiScorecardData | null;
  loading: boolean;
}

const GRADE_STYLE: Record<string, string> = {
  "A+": "bg-emerald-500 text-emerald-950",
  A: "bg-emerald-400 text-emerald-950",
  "B+": "bg-lime-400 text-lime-950",
  B: "bg-yellow-400 text-yellow-950",
  C: "bg-orange-400 text-orange-950",
  D: "bg-rose-500 text-rose-50",
};

const BAR_STYLE: Record<string, string> = {
  "A+": "bg-emerald-500",
  A: "bg-emerald-400",
  "B+": "bg-lime-400",
  B: "bg-yellow-400",
  C: "bg-orange-400",
  D: "bg-rose-500",
};

function GradeChip({ grade, large = false }: { grade: string | null; large?: boolean }) {
  if (!grade) return <span className="text-slate-600">—</span>;
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md font-black ${
        large ? "min-w-[2.75rem] px-2.5 py-1 text-lg" : "min-w-[2rem] px-1.5 py-0.5 text-xs"
      } ${GRADE_STYLE[grade] || "bg-slate-600 text-white"}`}
    >
      {grade}
    </span>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function Cell({ cell }: { cell: KpiScorecardCell | undefined }) {
  if (!cell || cell.target == null || cell.percent == null) {
    return <span className="text-slate-600">—</span>;
  }
  return (
    <div className="min-w-[7.5rem]">
      <div className="flex items-center justify-between gap-2">
        <span className="tabular-nums text-slate-200">
          <span className="font-semibold">{formatNumber(cell.actual)}</span>
          <span className="text-slate-500"> / {formatNumber(cell.target)}</span>
        </span>
        <GradeChip grade={cell.grade} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full rounded-full ${BAR_STYLE[cell.grade || "D"] || "bg-slate-500"}`}
            style={{ width: `${Math.max(2, Math.min(100, cell.percent))}%` }}
          />
        </div>
        <span className="w-10 text-right text-[11px] tabular-nums text-slate-400">{cell.percent}%</span>
      </div>
    </div>
  );
}

/** Quantitative score card: one row per pointer, one column per person (and the team). */
export function KpiScorecard({ scorecard, loading }: KpiScorecardProps) {
  if (loading && !scorecard) {
    return <p className="text-sm text-slate-400">Loading scorecard…</p>;
  }
  if (!scorecard) return null;

  const multiple = scorecard.users.length > 1;
  const range =
    scorecard.date_start === scorecard.date_end
      ? scorecard.date_start
      : `${scorecard.date_start} → ${scorecard.date_end}`;
  const shown = scorecard.users.length > 0 ? scorecard.users : [];

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-emerald-300">Score card</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {range} · {scorecard.working_days} working day{scorecard.working_days === 1 ? "" : "s"} · each pointer
            is actual ÷ target, capped at 100%
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
          {scorecard.bands.map((band) => (
            <span key={band.grade} className="inline-flex items-center gap-1">
              <GradeChip grade={band.grade} />
              <span>{band.grade === "D" ? "below" : `${band.min}%+`}</span>
            </span>
          ))}
        </div>
      </div>

      {scorecard.pointers.length === 0 ? (
        <p className="rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-6 text-center text-sm text-slate-400">
          {scorecard.working_days === 0
            ? "No working day to grade in this period yet (off day, or a day that has not happened)."
            : "No targets are set yet. An admin can set daily targets in Settings → KPI Scorecard targets."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/80 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 min-w-[12rem]">Pointer</th>
                {shown.map((entry) => (
                  <th key={entry.user.id} className="px-4 py-3">
                    {entry.user.full_name}
                  </th>
                ))}
                {multiple ? <th className="px-4 py-3 text-emerald-300">Team</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {scorecard.pointers.map((pointer) => (
                <tr key={pointer.key} className="align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-100">{pointer.label}</div>
                    <div className="text-[11px] text-slate-500">
                      Target {formatNumber(pointer.target_per_day)}/day · {pointer.source === "manual" ? "manual KPI" : "auto"}
                    </div>
                    {pointer.note ? <div className="text-[11px] text-slate-600">{pointer.note}</div> : null}
                  </td>
                  {shown.map((entry) => (
                    <td key={entry.user.id} className="px-4 py-3">
                      <Cell cell={entry.pointers.find((c) => c.key === pointer.key)} />
                    </td>
                  ))}
                  {multiple ? (
                    <td className="px-4 py-3 bg-emerald-950/10">
                      <Cell cell={scorecard.team.pointers.find((c) => c.key === pointer.key)} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-700 bg-slate-900/80">
              <tr>
                <td className="px-4 py-3 font-semibold text-slate-100">Overall</td>
                {shown.map((entry) => (
                  <td key={entry.user.id} className="px-4 py-3">
                    {entry.overall_percent == null ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <GradeChip grade={entry.overall_grade} large />
                        <span className="text-sm font-semibold tabular-nums text-slate-200">
                          {entry.overall_percent}%
                        </span>
                      </div>
                    )}
                  </td>
                ))}
                {multiple ? (
                  <td className="px-4 py-3 bg-emerald-950/10">
                    {scorecard.team.overall_percent == null ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <GradeChip grade={scorecard.team.overall_grade} large />
                        <span className="text-sm font-semibold tabular-nums text-slate-200">
                          {scorecard.team.overall_percent}%
                        </span>
                      </div>
                    )}
                  </td>
                ) : null}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** Plain-text version of the score card (used for the PDF export). */
export function scorecardToText(scorecard: KpiScorecardData | null): string | null {
  if (!scorecard || scorecard.pointers.length === 0) return null;
  const lines: string[] = [];
  for (const entry of scorecard.users) {
    lines.push(
      `${entry.user.full_name}: overall ${
        entry.overall_percent == null ? "—" : `${entry.overall_percent}% (${entry.overall_grade})`
      }`,
    );
    for (const pointer of scorecard.pointers) {
      const cell = entry.pointers.find((c) => c.key === pointer.key);
      if (!cell || cell.target == null || cell.percent == null) continue;
      lines.push(
        `   ${pointer.label}: ${formatNumber(cell.actual)} / ${formatNumber(cell.target)} = ${cell.percent}% (${cell.grade})`,
      );
    }
    lines.push("");
  }
  if (scorecard.users.length > 1 && scorecard.team.overall_percent != null) {
    lines.push(`Team overall: ${scorecard.team.overall_percent}% (${scorecard.team.overall_grade})`);
  }
  return lines.join("\n").trim();
}
