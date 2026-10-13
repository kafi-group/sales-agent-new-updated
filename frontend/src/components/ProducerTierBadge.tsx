interface ProducerTierBadgeProps {
  tier: string | null | undefined;
  conversionPct?: number | null;
  compact?: boolean;
}

const tierColors: Record<string, string> = {
  strong: "bg-red-500/20 text-red-300 border-red-500/40",
  weak: "bg-amber-500/20 text-amber-300 border-amber-500/40",
};

const tierLabels: Record<string, string> = {
  strong: "Strong exporter",
  weak: "Weak exporter",
};

export function ProducerTierBadge({ tier, conversionPct, compact }: ProducerTierBadgeProps) {
  if (!tier) return null;
  const key = tier.toLowerCase();
  const label = tierLabels[key] ?? tier;

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span
        className={`px-2 py-0.5 rounded border text-xs font-medium whitespace-nowrap ${tierColors[key] ?? "bg-slate-700/30 text-slate-400 border-slate-600/40"}`}
      >
        {compact ? (key === "weak" ? "Weak" : "Strong") : label}
      </span>
      {key === "weak" && conversionPct != null && (
        <span
          className="text-xs font-medium text-emerald-400 whitespace-nowrap"
          title="Estimated chance to convert this exporter into a Kafi sourcing/resell client"
        >
          {Math.round(conversionPct)}% convert
        </span>
      )}
      {key === "strong" && conversionPct != null && !compact && (
        <span className="text-xs text-slate-500">{Math.round(conversionPct)}% convert</span>
      )}
    </span>
  );
}

export function ConversionBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color =
    clamped >= 60 ? "bg-emerald-500" : clamped >= 40 ? "bg-amber-500" : "bg-slate-500";

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-500">
        <span>Conversion potential</span>
        <span className="text-slate-300 font-medium">{Math.round(clamped)}%</span>
      </div>
      <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
