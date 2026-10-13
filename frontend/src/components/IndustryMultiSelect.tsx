import {
  INDUSTRIES,
  MAX_DISCOVERY_INDUSTRIES,
  industryGroups,
  industriesByGroup,
} from "../data/industries";

interface IndustryMultiSelectProps {
  selected: Set<string>;
  onToggle: (name: string) => void;
  maxSelected?: number;
}

export function IndustryMultiSelect({
  selected,
  onToggle,
  maxSelected = MAX_DISCOVERY_INDUSTRIES,
}: IndustryMultiSelectProps) {
  return (
    <div className="space-y-3">
      {industryGroups().map((group) => (
        <div key={group}>
          <p className="text-[11px] font-medium text-slate-500 mb-1.5">{group}</p>
          <div className="flex flex-wrap gap-2">
            {industriesByGroup(group).map((industry) => {
              const checked = selected.has(industry.name);
              const atMax = selected.size >= maxSelected;
              return (
                <label
                  key={industry.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs cursor-pointer transition ${
                    checked
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                      : atMax
                        ? "border-slate-800 text-slate-600 cursor-not-allowed"
                        : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && atMax}
                    onChange={() => onToggle(industry.name)}
                    className="sr-only"
                  />
                  {industry.name}
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {INDUSTRIES.length === 0 && (
        <p className="text-sm text-slate-500">No industries configured</p>
      )}
    </div>
  );
}
