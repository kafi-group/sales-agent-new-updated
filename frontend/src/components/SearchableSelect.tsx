import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  allowEmpty?: boolean;
  emptyLabel?: string;
  label?: string;
  labelClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  multiSelect?: boolean;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  allowEmpty = false,
  emptyLabel = "All",
  label,
  labelClassName = "text-xs text-slate-400",
  placeholder = "Search…",
  disabled = false,
  multiSelect = true,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedValues = useMemo(() => {
    if (!value) return new Set<string>();
    return new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  }, [value]);

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) ||
        option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toggleOption(optValue: string) {
    if (!multiSelect) {
      onChange(optValue);
      setOpen(false);
      setQuery("");
      return;
    }
    const next = new Set(selectedValues);
    if (next.has(optValue)) {
      next.delete(optValue);
    } else {
      next.add(optValue);
    }
    onChange(Array.from(next).join(", "));
  }

  function clearAll() {
    onChange("");
  }

  const count = selectedValues.size;
  const buttonLabel = !multiSelect
    ? selectedOption?.label ?? (allowEmpty ? emptyLabel : "Select…")
    : count === 0
      ? allowEmpty
        ? emptyLabel
        : "Select…"
      : count === 1
        ? (() => {
            const first = Array.from(selectedValues)[0];
            const found = options.find((o) => o.value === first);
            return found ? found.label : first;
          })()
        : `${count} selected`;

  return (
    <label className="block">
      {label && <span className={labelClassName}>{label}</span>}
      <div ref={containerRef} className={`relative ${label ? "mt-1" : ""}`}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((prev) => !prev)}
          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 text-left flex items-center justify-between gap-2 disabled:opacity-50"
        >
          <span className="truncate flex items-center gap-1.5">
            {multiSelect && count > 1 && (
              <span className="inline-flex items-center justify-center bg-emerald-500/20 text-emerald-400 text-[10px] font-bold px-1.5 py-0.5 rounded">
                {count}
              </span>
            )}
            <span className="truncate">{buttonLabel}</span>
          </span>
          <span className="text-slate-500">{open ? "▴" : "▾"}</span>
        </button>

        {open && !disabled && (
          <div className="absolute z-30 mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 shadow-xl min-w-[200px]">
            <div className="p-2 border-b border-slate-800 space-y-1.5">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                autoFocus
                className="w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
              />
              {multiSelect && (
                <div className="flex items-center justify-between text-xs px-1 text-slate-400">
                  <span>{count > 0 ? `${count} selected` : "Tick boxes to filter"}</span>
                  {count > 0 && (
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-emerald-400 hover:underline font-medium"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              )}
            </div>
            <ul className="max-h-56 overflow-y-auto py-1">
              {allowEmpty && (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      clearAll();
                      if (!multiSelect) setOpen(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 hover:bg-slate-900 ${
                      count === 0 && (!value || multiSelect)
                        ? "bg-emerald-500/10 text-emerald-300 font-medium"
                        : "text-slate-400"
                    }`}
                  >
                    {multiSelect && (
                      <input
                        type="checkbox"
                        checked={count === 0}
                        readOnly
                        className="rounded border-slate-600 bg-slate-950 text-emerald-500 pointer-events-none"
                      />
                    )}
                    <span>{emptyLabel}</span>
                  </button>
                </li>
              )}
              {filtered.map((option) => {
                const checked = multiSelect
                  ? selectedValues.has(option.value)
                  : value === option.value;
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      onClick={() => toggleOption(option.value)}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 hover:bg-slate-900 ${
                        checked ? "bg-emerald-500/10 text-emerald-300 font-medium" : "text-slate-200"
                      }`}
                    >
                      {multiSelect && (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOption(option.value)}
                          className="rounded border-slate-600 bg-slate-950 text-emerald-500 focus:ring-emerald-500 cursor-pointer shrink-0"
                        />
                      )}
                      <span className="truncate">{option.label}</span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-500">No matches</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </label>
  );
}

export function stringOptions(values: string[]): SearchableSelectOption[] {
  return values.map((value) => ({ value, label: value }));
}
