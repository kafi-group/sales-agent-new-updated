import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type QuotationMeetingStatus = "not_scheduled" | "scheduled" | "done";

interface QuotationMeetingControlProps {
  meetingStatus: QuotationMeetingStatus;
  meetingAt: string | null | undefined;
  disabled?: boolean;
  onStatusChange: (status: QuotationMeetingStatus) => Promise<void> | void;
  onSchedule: (meetingAtIso: string) => Promise<void> | void;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DEFAULT_TIME_TEXT = "10:00";
const DEFAULT_MERIDIEM = "AM" as const;

type Meridiem = "AM" | "PM";

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

function parseLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseTimeParts(iso: string | null | undefined): { timeText: string; meridiem: Meridiem } {
  if (!iso) {
    return { timeText: DEFAULT_TIME_TEXT, meridiem: DEFAULT_MERIDIEM };
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { timeText: DEFAULT_TIME_TEXT, meridiem: DEFAULT_MERIDIEM };
  }
  const hours24 = date.getHours();
  const meridiem: Meridiem = hours24 >= 12 ? "PM" : "AM";
  let hour12 = hours24 % 12;
  if (hour12 === 0) hour12 = 12;
  return {
    timeText: `${hour12}:${String(date.getMinutes()).padStart(2, "0")}`,
    meridiem,
  };
}

/** Parse user-typed time: 10:30, 10.30, 10, 10:5, 10:30 am, etc. */
function normalizeTimeInput(raw: string): { timeText: string; meridiem?: Meridiem } {
  const trimmed = raw.trim();
  const ampmMatch = trimmed.match(/\s*(am|pm)\s*$/i);
  if (ampmMatch) {
    const nextMeridiem = ampmMatch[1].toUpperCase() as Meridiem;
    const timeText = trimmed.replace(/\s*(am|pm)\s*$/i, "").trim();
    return { timeText, meridiem: nextMeridiem };
  }
  return { timeText: trimmed };
}

function parseTimeText(text: string): { hour: number; minute: number } | null {
  const { timeText } = normalizeTimeInput(text);
  const cleaned = timeText.trim();
  if (!cleaned) return null;

  const withMinutes = cleaned.match(/^(\d{1,2})[:.](\d{1,2})$/);
  if (withMinutes) {
    return { hour: Number(withMinutes[1]), minute: Number(withMinutes[2]) };
  }

  const hourOnly = cleaned.match(/^(\d{1,2})$/);
  if (hourOnly) {
    return { hour: Number(hourOnly[1]), minute: 0 };
  }

  return null;
}

function to24HourString(timeText: string, meridiem: Meridiem): string | null {
  const parsed = parseTimeText(timeText);
  if (!parsed) return null;

  const { minute } = parsed;
  let hour = parsed.hour;
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;

  if (meridiem === "AM") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatTimePreview(timeText: string, meridiem: Meridiem): string {
  const hhmm = to24HourString(timeText, meridiem);
  if (!hhmm) return "Enter a valid time";
  const [h, m] = hhmm.split(":").map(Number);
  const preview = new Date(2000, 0, 1, h, m);
  return preview.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function combineDateAndTime(date: Date, timeHHMM: string): string {
  const [hours, minutes] = timeHHMM.split(":").map((part) => Number(part));
  const local = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Number.isFinite(hours) ? hours : 10,
    Number.isFinite(minutes) ? minutes : 0,
    0,
  );
  return local.toISOString();
}

function formatScheduled(iso: string | null | undefined): string {
  if (!iso) return "Pick date & time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Pick date & time";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function QuotationMeetingControl({
  meetingStatus,
  meetingAt,
  disabled = false,
  onStatusChange,
  onSchedule,
}: QuotationMeetingControlProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedDate = parseLocalDate(meetingAt);
  const initialTime = parseTimeParts(meetingAt);
  const [pendingDate, setPendingDate] = useState<Date | null>(selectedDate);
  const [timeText, setTimeText] = useState(initialTime.timeText);
  const [meridiem, setMeridiem] = useState<Meridiem>(initialTime.meridiem);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selectedDate ?? new Date()));
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);

  const busy = disabled || saving;
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  useEffect(() => {
    setPendingDate(selectedDate);
    const next = parseTimeParts(meetingAt);
    setTimeText(next.timeText);
    setMeridiem(next.meridiem);
    setTimeError(null);
  }, [meetingAt, selectedDate]);

  useEffect(() => {
    if (!open) return;
    setViewMonth(startOfMonth(pendingDate ?? selectedDate ?? new Date()));
    if (!pendingDate && !selectedDate) {
      setPendingDate(today);
      setTimeText(DEFAULT_TIME_TEXT);
      setMeridiem(DEFAULT_MERIDIEM);
      setTimeError(null);
    }
  }, [open, pendingDate, selectedDate, today]);

  useEffect(() => {
    if (!open || !buttonRef.current) return;

    function place() {
      if (!buttonRef.current) return;
      const rect = buttonRef.current.getBoundingClientRect();
      const panel = panelRef.current;
      const width = 320;
      const height = panel?.offsetHeight ?? 420;
      const margin = 12;
      const gap = 8;

      const left = Math.min(
        Math.max(margin, rect.left),
        window.innerWidth - width - margin,
      );

      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      let top = rect.bottom + gap;

      if (top + height > window.innerHeight - margin) {
        if (spaceAbove >= height + gap) {
          top = rect.top - height - gap;
        } else if (spaceBelow >= spaceAbove) {
          top = Math.max(margin, window.innerHeight - height - margin);
        } else {
          top = margin;
        }
      }

      setPanelPos({ top, left });
    }

    place();
    const raf = window.requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, pendingDate, timeText, meridiem, viewMonth]);

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
    document.addEventListener("click", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onPointer);
    };
  }, [open]);

  async function handleStatusChange(next: QuotationMeetingStatus) {
    setSaving(true);
    try {
      await onStatusChange(next);
      if (next === "scheduled") {
        setOpen(true);
      } else {
        setOpen(false);
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveSchedule() {
    if (!pendingDate) return;
    const hhmm = to24HourString(timeText, meridiem);
    if (!hhmm) {
      setTimeError("Enter a valid time (e.g. 10:30) and choose AM or PM.");
      return;
    }
    setTimeError(null);
    setSaving(true);
    try {
      await onSchedule(combineDateAndTime(pendingDate, hhmm));
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

  const calendar =
    open && panelPos && meetingStatus === "scheduled"
      ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Choose meeting date and time"
            className="fixed z-[120] w-[320px] max-h-[min(440px,calc(100dvh-1.5rem))] overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 shadow-2xl shadow-black/50 p-3 pb-4"
            style={{ top: panelPos.top, left: panelPos.left }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
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
                const isSelected = pendingDate ? sameDay(day, pendingDate) : false;
                const isToday = sameDay(day, today);
                const isPast = day < today;
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    disabled={busy || isPast}
                    onClick={() => setPendingDate(day)}
                    className={`h-8 rounded-md text-xs transition ${
                      isSelected
                        ? "bg-violet-600 text-white"
                        : isToday
                          ? "border border-violet-500/60 text-violet-200 hover:bg-violet-500/10"
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
            <div className="mt-3 border-t border-slate-800 pt-3 space-y-2">
              <div
                className="block text-xs text-slate-400"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                Meeting time
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="10:30"
                    value={timeText}
                    disabled={busy}
                    onChange={(e) => {
                      const next = normalizeTimeInput(e.target.value);
                      setTimeText(next.timeText);
                      if (next.meridiem) setMeridiem(next.meridiem);
                      setTimeError(null);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100 placeholder:text-slate-600 disabled:opacity-50"
                    aria-label="Meeting time"
                  />
                  <div className="inline-flex shrink-0 rounded-md border border-slate-700 overflow-hidden">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setMeridiem("AM");
                        setTimeError(null);
                      }}
                      className={`px-3 py-2 text-xs font-semibold transition ${
                        meridiem === "AM"
                          ? "bg-violet-600 text-white"
                          : "bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                      } disabled:opacity-50`}
                    >
                      AM
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setMeridiem("PM");
                        setTimeError(null);
                      }}
                      className={`px-3 py-2 text-xs font-semibold transition ${
                        meridiem === "PM"
                          ? "bg-violet-600 text-white"
                          : "bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                      } disabled:opacity-50`}
                    >
                      PM
                    </button>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Type time yourself (e.g. <span className="text-slate-400">2:15</span> or{" "}
                  <span className="text-slate-400">10</span>) then pick AM/PM —{" "}
                  <span className="text-slate-400">{formatTimePreview(timeText, meridiem)}</span>
                </p>
                {timeError && <p className="mt-1 text-[11px] text-red-400">{timeError}</p>}
              </div>
              {!pendingDate && (
                <p className="text-[11px] text-amber-300/90">Select a date above to schedule.</p>
              )}
              <div className="flex items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPendingDate(today);
                    setTimeText(DEFAULT_TIME_TEXT);
                    setMeridiem(DEFAULT_MERIDIEM);
                    setTimeError(null);
                  }}
                  className="text-xs text-violet-300 hover:text-violet-200 disabled:opacity-50"
                >
                  Today
                </button>
                <button
                  type="button"
                  disabled={busy || !pendingDate}
                  onClick={() => void saveSchedule()}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save schedule"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="min-w-[14rem] space-y-2" onClick={(e) => e.stopPropagation()}>
      <select
        value={meetingStatus}
        disabled={busy}
        onChange={(e) => void handleStatusChange(e.target.value as QuotationMeetingStatus)}
        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 disabled:opacity-50"
      >
        <option value="not_scheduled">Meeting not scheduled</option>
        <option value="scheduled">Meeting scheduled</option>
        <option value="done">Meeting done</option>
      </select>
      {meetingStatus === "scheduled" && (
        <button
          ref={buttonRef}
          type="button"
          disabled={busy}
          onClick={() => setOpen((prev) => !prev)}
          className={`w-full rounded-md border px-2.5 py-1.5 text-left text-xs transition disabled:opacity-50 ${
            meetingAt
              ? "border-violet-600/50 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15"
              : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
          }`}
        >
          <span className="block text-[10px] uppercase tracking-wide opacity-70">Date & time</span>
          <span className="block truncate mt-0.5">
            {meetingAt ? formatScheduled(meetingAt) : "Open calendar…"}
          </span>
        </button>
      )}
      {calendar}
    </div>
  );
}
