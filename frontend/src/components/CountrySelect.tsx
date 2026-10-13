import { useEffect, useMemo, useRef, useState } from "react";
import { COUNTRIES } from "../data/countries";

interface CountrySelectProps {
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  label?: string;
  labelClassName?: string;
  placeholder?: string;
  multiSelect?: boolean;
}

export function CountrySelect({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = "All countries",
  label,
  labelClassName = "text-xs text-slate-400",
  placeholder = "Search countries…",
  multiSelect = true,
}: CountrySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedNames = useMemo(() => {
    if (!value) return new Set<string>();
    return new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  }, [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (country) =>
        country.name.toLowerCase().includes(q) ||
        country.code.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toggleCountry(countryName: string) {
    if (!multiSelect) {
      onChange(countryName);
      setOpen(false);
      setQuery("");
      return;
    }
    const next = new Set(selectedNames);
    if (next.has(countryName)) {
      next.delete(countryName);
    } else {
      next.add(countryName);
    }
    onChange(Array.from(next).join(", "));
  }

  function clearAll() {
    onChange("");
  }

  const count = selectedNames.size;
  const buttonLabel = !multiSelect
    ? (() => {
        const found = COUNTRIES.find((c) => c.name === value);
        return found ? `${found.flag} ${found.name}` : value || (allowEmpty ? emptyLabel : "Select country");
      })()
    : count === 0
      ? allowEmpty
        ? emptyLabel
        : "Select country"
      : count === 1
        ? (() => {
            const firstName = Array.from(selectedNames)[0];
            const found = COUNTRIES.find((c) => c.name === firstName);
            return found ? `${found.flag} ${found.name}` : firstName;
          })()
        : `${count} countries selected`;

  return (
    <label className="block">
      {label && <span className={labelClassName}>{label}</span>}
      <div ref={containerRef} className={`relative ${label ? "mt-1" : ""}`}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 text-left flex items-center justify-between gap-2"
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

        {open && (
          <div className="absolute z-30 mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 shadow-xl min-w-[220px]">
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
              {filtered.map((country) => {
                const checked = multiSelect
                  ? selectedNames.has(country.name)
                  : value === country.name;
                return (
                  <li key={country.code}>
                    <button
                      type="button"
                      onClick={() => toggleCountry(country.name)}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2.5 hover:bg-slate-900 ${
                        checked ? "bg-emerald-500/10 text-emerald-300 font-medium" : "text-slate-200"
                      }`}
                    >
                      {multiSelect && (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCountry(country.name)}
                          className="rounded border-slate-600 bg-slate-950 text-emerald-500 focus:ring-emerald-500 cursor-pointer shrink-0"
                        />
                      )}
                      <span className="mr-1">{country.flag}</span>
                      <span className="truncate">{country.name}</span>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-500">No countries found</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </label>
  );
}
