interface ScoreBadgeProps {
  score: string;
}

/** Company grade badges (AAA/AA/A). Legacy HOT/WARM/COLD still styled if present. */
const colors: Record<string, string> = {
  AAAA: "bg-purple-500/25 text-purple-200 border-purple-500/50 shadow-sm shadow-purple-950/40",
  AAA: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
  AA: "bg-sky-500/20 text-sky-200 border-sky-500/40",
  A: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  HOT: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
  WARM: "bg-sky-500/20 text-sky-200 border-sky-500/40",
  COLD: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  UNSCORED: "bg-slate-700/30 text-slate-400 border-slate-600/40",
  DRAFT: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  APPROVED: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
};

const displayLabel: Record<string, string> = {
  HOT: "AAA",
  WARM: "AA",
  COLD: "A",
};

export function ScoreBadge({ score }: ScoreBadgeProps) {
  const key = score.toUpperCase();
  const label = displayLabel[key] ?? score;
  return (
    <span
      className={`px-2 py-0.5 rounded border text-xs font-medium ${colors[key] ?? colors.A}`}
      title="Company grade (AAAA top tier · AAA elite · AA solid · A weak)"
    >
      {label}
    </span>
  );
}
