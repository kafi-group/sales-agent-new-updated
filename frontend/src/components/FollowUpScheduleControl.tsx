import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface FollowUpScheduleControlProps {
  value: string | null | undefined;
  onChange: (isoOrNull: string | null) => Promise<void> | void;
  disabled?: boolean;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toNoonIso(date: Date): string {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  return local.toISOString();
}

function parseLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatScheduled(iso: string | null | undefined): string {
  if (!iso) return "Not scheduled";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function FollowUpScheduleControl({
  value,
  onChange,
  disabled = false,
}: FollowUpScheduleControlProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const selected = parseLocalDate(value);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selected ?? new Date()));
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);

  const busy = disabled || saving;
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  useEffect(() => {
    if (!open) return;
    setViewMonth(startOfMonth(selected ?? new Date()));
  }, [open, selected]);

  useEffect(() => {
    if (!open || !buttonRef.current) return;

    function place() {
      if (!buttonRef.current) return;
      const rect = buttonRef.current.getBoundingClientRect();
      const width = 280;
      const left = Math.min(
        Math.max(8, rect.left),
        window.innerWidth - width - 8,
      );
      const top = Math.min(rect.bottom + 6, window.innerHeight - 320);
      setPanelPos({ top, left });
    }

    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  async function apply(next: string | null) {
    setSaving(true);
    try {
      await onChange(next);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  const cells = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const startOffset = first.getDay();
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - startOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + index);
      return day;
    });
  }, [viewMonth]);

  const calendar = open && panelPos
    ? createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Choose follow-up date"
          className="fixed z-[120] w-[280px] rounded-xl border border-slate-600 bg-slate-900 shadow-2xl shadow-black/50 p-3"
          style={{ top: panelPos.top, left: panelPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 mb-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => setViewMonth((prev) => addMonths(prev, -1))}
              className="px-2 py-1 rounded-md text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              aria-label="Previous month"
            >
              ‹
            </button>
            <p className="text-sm font-medium text-slate-100">{monthLabel(viewMonth)}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => setViewMonth((prev) => addMonths(prev, 1))}
              className="px-2 py-1 rounded-md text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              aria-label="Next month"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {WEEKDAYS.map((label) => (
              <div key={label} className="text-center text-[10px] uppercase text-slate-500 py-1">
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((day) => {
              const inMonth = day.getMonth() === viewMonth.getMonth();
              const isSelected = selected ? sameDay(day, selected) : false;
              const isToday = sameDay(day, today);
              const isPast = day < today;
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  disabled={busy || isPast}
                  onClick={() => void apply(toNoonIso(day))}
                  className={`h-8 rounded-md text-xs transition ${
                    isSelected
                      ? "bg-amber-600 text-white"
                      : isToday
                        ? "border border-amber-500/60 text-amber-200 hover:bg-amber-500/10"
                        : inMonth
                          ? "text-slate-200 hover:bg-slate-800"
                          : "text-slate-600 hover:bg-slate-800/60"
                  } disabled:opacity-35 disabled:hover:bg-transparent`}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-800 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void apply(toNoonIso(today))}
              className="text-xs text-amber-300 hover:text-amber-200 disabled:opacity-50"
            >
              Today
            </button>
            {value ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void apply(null)}
                className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              >
                Clear date
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              >
                Close
              </button>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        disabled={busy}
        onClick={() => setOpen((prev) => !prev)}
        className={`w-full min-w-[150px] rounded-md border px-2.5 py-1.5 text-left text-xs transition disabled:opacity-50 ${
          value
            ? "border-amber-600/50 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
            : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
        }`}
      >
        <span className="block text-[10px] uppercase tracking-wide opacity-70">
          {value ? "Scheduled" : "Follow-up"}
        </span>
        <span className="block truncate mt-0.5">
          {value ? formatScheduled(value) : "Open calendar…"}
        </span>
      </button>
      {calendar}
    </div>
  );
}
