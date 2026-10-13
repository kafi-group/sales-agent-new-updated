import { industryGroups, industriesByGroup, findIndustry } from "../data/industries";

interface IndustrySelectProps {
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  label?: string;
  labelClassName?: string;
  className?: string;
  extraOptions?: string[];
}

export function IndustrySelect({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = "All industries",
  label,
  labelClassName = "text-xs text-slate-400",
  className = "mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200",
  extraOptions = [],
}: IndustrySelectProps) {
  const known = findIndustry(value);
  const hasCustomValue = Boolean(value.trim()) && !known;
  const canonicalNames = new Set(
    industryGroups().flatMap((group) => industriesByGroup(group).map((i) => i.name)),
  );
  const otherOptions = extraOptions
    .map((option) => option.trim())
    .filter((option) => option && !canonicalNames.has(option) && option !== value);

  return (
    <label className="block">
      {label && <span className={labelClassName}>{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={label ? className : className.replace(/^mt-1\s*/, "")}
      >
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {!allowEmpty && <option value="">Select industry</option>}
        {industryGroups().map((group) => (
          <optgroup key={group} label={group}>
            {industriesByGroup(group).map((industry) => (
              <option key={industry.id} value={industry.name}>
                {industry.name}
              </option>
            ))}
          </optgroup>
        ))}
        {hasCustomValue && (
          <optgroup label="Other">
            <option value={value}>{value}</option>
          </optgroup>
        )}
        {otherOptions.length > 0 && (
          <optgroup label="From your leads">
            {otherOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

export { INDUSTRIES } from "../data/industries";
