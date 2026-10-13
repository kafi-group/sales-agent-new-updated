import { formatMarketRoleLabel } from "../utils/marketRoleLabels";

interface MarketRoleBadgeProps {
  role: string;
}

const colors: Record<string, string> = {
  consumer: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  producer: "bg-orange-500/20 text-orange-300 border-orange-500/40",
  hybrid: "bg-violet-500/20 text-violet-300 border-violet-500/40",
  unknown: "bg-slate-700/30 text-slate-400 border-slate-600/40",
};

export function MarketRoleBadge({ role }: MarketRoleBadgeProps) {
  const key = role.toLowerCase();
  const label = formatMarketRoleLabel(role);
  return (
    <span
      className={`px-2 py-0.5 rounded border text-xs font-medium whitespace-nowrap ${colors[key] ?? colors.unknown}`}
      title={label}
    >
      {label}
    </span>
  );
}
