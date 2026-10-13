import { useEffect, useId, useRef, useState } from "react";
import { client, type CompanyNameSuggestion } from "../api/client";
import {
  autocorrectText,
  capitalizeFirstLetter,
  spellingInputProps,
} from "../utils/spelling";

interface CompanyNameSuggestProps {
  value: string;
  onChange: (value: string) => void;
  onSelectExisting?: (suggestion: CompanyNameSuggestion) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

function metaLine(row: CompanyNameSuggestion): string {
  return [row.country, row.industry, row.source]
    .map((part) => (part || "").trim())
    .filter(Boolean)
    .join(" · ");
}

export function CompanyNameSuggest({
  value,
  onChange,
  onSelectExisting,
  disabled = false,
  placeholder = "e.g. Al Noor Food Trading",
  className = "",
  inputClassName = "mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600",
}: CompanyNameSuggestProps) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<CompanyNameSuggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const requestSeq = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 1) {
      setRows([]);
      setLoading(false);
      return;
    }

    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void client
        .suggestCompanyNames(q, 12)
        .then((result) => {
          if (seq !== requestSeq.current) return;
          setRows(result.rows);
          setHighlight(0);
          setOpen(true);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setRows([]);
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, 200);

    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  function pick(row: CompanyNameSuggestion) {
    onChange(row.company_name);
    onSelectExisting?.(row);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter" && rows[highlight]) {
      e.preventDefault();
      pick(rows[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showMenu = open && value.trim().length > 0 && (loading || rows.length > 0);

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <input
        type="text"
        required
        disabled={disabled}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={showMenu}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={placeholder}
        onChange={(e) => {
          onChange(capitalizeFirstLetter(e.target.value));
          setOpen(true);
        }}
        onFocus={() => {
          if (value.trim()) setOpen(true);
        }}
        onBlur={(e) =>
          onChange(autocorrectText(e.target.value, "name"))
        }
        onKeyDown={handleKeyDown}
        className={inputClassName}
        {...spellingInputProps("name")}
      />

      {showMenu ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 shadow-xl"
        >
          {loading && rows.length === 0 ? (
            <li className="px-3 py-2 text-xs text-slate-500">Searching master table…</li>
          ) : (
            rows.map((row, index) => {
              const meta = metaLine(row);
              return (
                <li key={row.id} role="option" aria-selected={index === highlight}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(row)}
                    onMouseEnter={() => setHighlight(index)}
                    className={`w-full text-left px-3 py-2.5 border-b border-slate-800/80 last:border-0 ${
                      index === highlight
                        ? "bg-emerald-600/20 text-slate-100"
                        : "hover:bg-slate-900 text-slate-200"
                    }`}
                  >
                    <span className="block text-sm font-medium truncate">
                      {row.company_name}
                    </span>
                    {meta ? (
                      <span className="block text-[11px] text-slate-500 truncate mt-0.5">
                        {meta} · already in master table
                      </span>
                    ) : (
                      <span className="block text-[11px] text-slate-500 mt-0.5">
                        Already in master table
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
