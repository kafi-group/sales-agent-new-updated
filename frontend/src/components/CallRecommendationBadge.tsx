interface CallRecommendationBadgeProps {
  recommended: boolean | null;
  localTime: string | null;
  reason: string | null;
  /** Allow label + time to wrap in narrow table columns. */
  wrap?: boolean;
}

export function CallRecommendationBadge({
  recommended,
  localTime,
  reason,
  wrap = false,
}: CallRecommendationBadgeProps) {
  if (recommended === null) {
    return (
      <span
        className={`px-2 py-0.5 rounded border text-xs font-medium bg-slate-700/30 text-slate-400 border-slate-600/40 ${
          wrap ? "inline-block whitespace-normal break-words leading-snug" : "whitespace-nowrap"
        }`}
        title={reason ?? "Unknown local time"}
      >
        Unknown
      </span>
    );
  }

  const label = recommended ? "Call now" : "Not now";
  const colors = recommended
    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
    : "bg-rose-500/20 text-rose-300 border-rose-500/40";

  return (
    <span
      className={`px-2 py-0.5 rounded border text-xs font-medium ${colors} ${
        wrap ? "inline-block whitespace-normal break-words leading-snug" : "whitespace-nowrap"
      }`}
      title={reason ?? undefined}
    >
      {wrap ? (
        <>
          <span className="block">{label}</span>
          {localTime ? <span className="block opacity-90">{localTime}</span> : null}
        </>
      ) : (
        <>
          {label}
          {localTime ? ` · ${localTime}` : ""}
        </>
      )}
    </span>
  );
}
