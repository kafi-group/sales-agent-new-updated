/** Period pills + anchor date or custom From/To range for KPI pages. */
export type KpiPeriodDateFilterProps<T extends string> = {
  period: T;
  onPeriodChange: (next: T) => void;
  options: { value: T; label: string }[];
  customPeriodValue: T;
  /** Shown when period is not custom (e.g. "Date", "Any day in week"). */
  anchorDate?: string;
  onAnchorDateChange?: (value: string) => void;
  anchorDateLabel?: string;
  customDateFrom: string;
  customDateTo: string;
  onCustomDateFromChange: (value: string) => void;
  onCustomDateToChange: (value: string) => void;
  /** Called when user picks custom — e.g. seed month-to-today. */
  onPickCustom?: () => void;
  accent?: "emerald" | "violet";
};

const ACCENT_ACTIVE: Record<"emerald" | "violet", string> = {
  emerald: "bg-emerald-600 border-emerald-500 text-white shadow-sm",
  violet: "bg-violet-600 border-violet-500 text-white shadow-sm",
};

const ACCENT_INPUT: Record<"emerald" | "violet", string> = {
  emerald: "border-slate-700",
  violet: "border-violet-700/60",
};

export function KpiPeriodDateFilter<T extends string>({
  period,
  onPeriodChange,
  options,
  customPeriodValue,
  anchorDate,
  onAnchorDateChange,
  anchorDateLabel = "Date",
  customDateFrom,
  customDateTo,
  onCustomDateFromChange,
  onCustomDateToChange,
  onPickCustom,
  accent = "emerald",
}: KpiPeriodDateFilterProps<T>) {
  const isCustom = period === customPeriodValue;
  const inactive =
    "bg-slate-900/80 border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-100";
  const active = ACCENT_ACTIVE[accent];
  const inputBorder = ACCENT_INPUT[accent];

  function selectPeriod(next: T) {
    if (next === customPeriodValue) {
      onPickCustom?.();
    }
    onPeriodChange(next);
  }

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => selectPeriod(opt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
              period === opt.value ? active : inactive
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {isCustom ? (
        <div
          className={`flex flex-col gap-2 rounded-lg border ${inputBorder} bg-slate-950/60 px-3 py-2.5`}
        >
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span className="font-medium text-slate-300">From</span>
            <input
              type="date"
              value={customDateFrom}
              max={customDateTo}
              onChange={(e) => onCustomDateFromChange(e.target.value)}
              className={`w-full rounded-lg border ${inputBorder} bg-slate-900 px-3 py-2 text-sm text-slate-100`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            <span className="font-medium text-slate-300">To</span>
            <input
              type="date"
              value={customDateTo}
              min={customDateFrom}
              onChange={(e) => onCustomDateToChange(e.target.value)}
              className={`w-full rounded-lg border ${inputBorder} bg-slate-900 px-3 py-2 text-sm text-slate-100`}
            />
          </label>
        </div>
      ) : onAnchorDateChange && anchorDate !== undefined ? (
        <label className="block text-xs text-slate-400">
          {anchorDateLabel}
          <input
            type="date"
            value={anchorDate}
            onChange={(e) => onAnchorDateChange(e.target.value)}
            className={`mt-1 block w-full sm:w-auto rounded-lg border ${inputBorder} bg-slate-900 px-3 py-2 text-sm text-slate-100`}
          />
        </label>
      ) : null}
    </div>
  );
}
