import { useEffect, useId, useRef, useState } from "react";
import type { ColumnDef } from "../hooks/useColumnVisibility";
import { IconTable } from "./icons/AppIcons";

type Props = {
  columns: ColumnDef[];
  isVisible: (id: string) => boolean;
  toggle: (id: string) => void;
  showAll: () => void;
  resetDefaults: () => void;
  hiddenCount?: number;
  className?: string;
};

export function ColumnVisibilityMenu({
  columns,
  isVisible,
  toggle,
  showAll,
  resetDefaults,
  hiddenCount = 0,
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-800"
        aria-expanded={open}
        aria-controls={menuId}
        title="Show or hide table columns"
      >
        <IconTable size="sm" className="opacity-80" />
        Columns
        {hiddenCount > 0 ? (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
            {hiddenCount} hidden
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={menuId}
          className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-slate-700 bg-slate-950 p-2 shadow-xl"
          role="menu"
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Show / hide columns
            </p>
            <div className="flex gap-1">
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] text-sky-300 hover:bg-slate-800"
                onClick={showAll}
              >
                Show all
              </button>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800"
                onClick={resetDefaults}
              >
                Reset
              </button>
            </div>
          </div>
          <ul className="max-h-72 space-y-0.5 overflow-y-auto">
            {columns.map((col) => {
              const checked = isVisible(col.id);
              return (
                <li key={col.id}>
                  <label
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                      col.locked
                        ? "cursor-default text-slate-500"
                        : "text-slate-200 hover:bg-slate-900"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="rounded border-slate-600 bg-slate-950"
                      checked={checked}
                      disabled={Boolean(col.locked)}
                      onChange={() => toggle(col.id)}
                    />
                    <span className="truncate">{col.label}</span>
                    {col.locked ? (
                      <span className="ml-auto text-[10px] uppercase text-slate-600">Required</span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
