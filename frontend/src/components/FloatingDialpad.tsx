import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COUNTRIES, findCountry } from "../data/countries";
import { buildE164, formatDialCode, getDialCode, parsePhoneForDialpad } from "../data/countryDialCodes";
import { useTwilioVoiceOptional } from "../hooks/useTwilioVoice";
import { subscribeFloatingDialpadNumber } from "../utils/dialpadEvents";
import { DialerContactInput } from "./DialerContactInput";
import { PhoneFixModal } from "./PhoneFixModal";
import { detectLeadingZeroAfterCountryCode, type PhoneZeroCheckResult } from "../utils/phoneUtils";

const DIAL_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

/** How the customer's end of the call is shown (the browser connecting is not the customer answering). */
const LEG_UI: Record<
  string,
  { label: string; box: string; text: string; dot: string; pulse: boolean }
> = {
  dialing: {
    label: "Dialing…",
    box: "border-amber-500/40 bg-amber-950/30",
    text: "text-amber-300",
    dot: "bg-amber-400",
    pulse: true,
  },
  ringing: {
    label: "Ringing…",
    box: "border-sky-500/40 bg-sky-950/30",
    text: "text-sky-300",
    dot: "bg-sky-400",
    pulse: true,
  },
  answered: {
    label: "Call Connected",
    box: "border-emerald-500/40 bg-emerald-950/40",
    text: "text-emerald-300",
    dot: "bg-emerald-400",
    pulse: true,
  },
  busy: {
    label: "Busy — the phone or its network rejected the call",
    box: "border-rose-500/40 bg-rose-950/30",
    text: "text-rose-300",
    dot: "bg-rose-400",
    pulse: false,
  },
  "no-answer": {
    label: "No answer",
    box: "border-amber-500/40 bg-amber-950/30",
    text: "text-amber-300",
    dot: "bg-amber-400",
    pulse: false,
  },
  failed: {
    label: "Call failed",
    box: "border-rose-500/40 bg-rose-950/30",
    text: "text-rose-300",
    dot: "bg-rose-400",
    pulse: false,
  },
  ended: {
    label: "Call ended",
    box: "border-slate-600 bg-slate-900",
    text: "text-slate-300",
    dot: "bg-slate-400",
    pulse: false,
  },
  unknown: {
    label: "Call in progress",
    box: "border-slate-600 bg-slate-900",
    text: "text-slate-300",
    dot: "bg-slate-400",
    pulse: false,
  },
};

const FAB_SIZE = 56;
const PANEL_WIDTH = 300;
const STORAGE_KEY = "kafi_floating_dialpad_pos";

type Pos = { x: number; y: number };

function clampPos(pos: Pos, width: number, height: number): Pos {
  const maxX = Math.max(8, window.innerWidth - width - 8);
  const maxY = Math.max(8, window.innerHeight - height - 8);
  return {
    x: Math.min(Math.max(8, pos.x), maxX),
    y: Math.min(Math.max(8, pos.y), maxY),
  };
}

function defaultFabPos(): Pos {
  return {
    x: Math.max(8, window.innerWidth - FAB_SIZE - 20),
    y: Math.max(8, window.innerHeight - FAB_SIZE - 28),
  };
}

function loadPos(): Pos | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Pos;
    if (typeof parsed?.x === "number" && typeof parsed?.y === "number") return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function savePos(pos: Pos) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

interface FloatingDialpadProps {
  onError: (message: string) => void;
}

export function FloatingDialpad({ onError }: FloatingDialpadProps) {
  const voice = useTwilioVoiceOptional();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos>(() => loadPos() ?? defaultFabPos());
  const [digits, setDigits] = useState("");
  const [countryCode, setCountryCode] = useState("PK");
  const [contactName, setContactName] = useState("");
  const [calling, setCalling] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [lastSentDtmf, setLastSentDtmf] = useState<string | null>(null);
  const [sentDtmfHistory, setSentDtmfHistory] = useState("");
  const openRef = useRef(open);
  const posRef = useRef(pos);
  openRef.current = open;
  posRef.current = pos;

  useEffect(() => {
    if (voice?.active) {
      setOpen(true);
      setSentDtmfHistory("");
      setLastSentDtmf(null);
      setPos((prev) => clampPos(prev, PANEL_WIDTH, 460));
    }
  }, [voice?.active]);

  const selectedCountry = useMemo(() => findCountry(countryCode), [countryCode]);
  const dialPrefix = formatDialCode(countryCode);
  const formattedNumber = useMemo(
    () => buildE164(countryCode, digits) ?? "",
    [countryCode, digits],
  );
  const canCall = Boolean(
    voice?.ready && formattedNumber && !voice.active && !voice.dialing && !calling,
  );

  const filteredCountries = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    if (!q) return COUNTRIES;
    const digits = q.replace(/^\+/, "");
    return COUNTRIES.filter((country) => {
      const dial = getDialCode(country.code);
      return (
        country.name.toLowerCase().includes(q) ||
        country.code.toLowerCase().includes(q) ||
        (dial && dial.includes(digits))
      );
    });
  }, [countryQuery]);

  useEffect(() => {
    function onResize() {
      setPos((prev) =>
        clampPos(prev, open ? PANEL_WIDTH : FAB_SIZE, open ? 420 : FAB_SIZE),
      );
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  useEffect(() => {
    return subscribeFloatingDialpadNumber((payload) => {
      const hintIso =
        findCountry(payload.countryHint)?.code ?? payload.countryHint ?? undefined;
      const parsed = parsePhoneForDialpad(payload.phone, hintIso);
      if (!parsed) return;
      setCountryCode(parsed.countryCode);
      setDigits(parsed.digits);
      if (payload.contactName) setContactName(payload.contactName);
      setCountryOpen(false);
      setOpen(true);
      setPos((prev) => clampPos(prev, PANEL_WIDTH, 420));
    });
  }, []);

  const appendDigit = useCallback((key: string) => {
    setDigits((prev) => `${prev}${key}`.slice(0, 20));
  }, []);

  const handleKeyClick = useCallback(
    (key: string) => {
      if (voice?.active) {
        voice.sendDigits(key);
        setLastSentDtmf(key);
        setSentDtmfHistory((prev) => `${prev}${key}`);
        window.setTimeout(
          () => setLastSentDtmf((curr) => (curr === key ? null : curr)),
          800,
        );
      } else {
        appendDigit(key);
      }
    },
    [voice, appendDigit],
  );

  function backspace() {
    setDigits((prev) => prev.slice(0, -1));
  }

  function clearDigits() {
    setDigits("");
  }

  function closePanel() {
    setOpen(false);
    setCountryOpen(false);
  }

  const [phoneFixCheck, setPhoneFixCheck] = useState<{
    check: PhoneZeroCheckResult;
    pendingTarget?: string;
  } | null>(null);

  async function startCallWithNumber(num: string) {
    if (!voice) return;
    if (!voice.ready) {
      try {
        await voice.retryInit();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Calling is not ready yet");
        return;
      }
    }
    setCalling(true);
    try {
      await voice.placeManualCall(num, {
        contactName: contactName.trim() || undefined,
        country: selectedCountry?.name,
      });
    } catch (e) {
      if (e instanceof Error && e.name === "DialCancelled") return; // user pressed End
      onError(e instanceof Error ? e.message : "Call failed");
    } finally {
      setCalling(false);
    }
  }

  async function handleCall() {
    if (!voice || !formattedNumber) return;
    const zeroErr = detectLeadingZeroAfterCountryCode(formattedNumber);
    if (zeroErr) {
      setPhoneFixCheck({ check: zeroErr, pendingTarget: formattedNumber });
      return;
    }
    await startCallWithNumber(formattedNumber);
  }

  function onDragStart(e: React.PointerEvent) {
    // FAB button and panel header both use data-dialpad-drag — allow both.
    // Do not require skipping "button" globally (that blocked the FAB itself).
    if (!(e.target as HTMLElement).closest("[data-dialpad-drag]")) return;
    e.preventDefault();
    const pointerId = e.pointerId;
    dragRef.current = {
      pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: posRef.current.x,
      origY: posRef.current.y,
      moved: false,
    };
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      const isOpen = openRef.current;
      const next = clampPos(
        { x: drag.origX + dx, y: drag.origY + dy },
        isOpen ? PANEL_WIDTH : FAB_SIZE,
        isOpen ? panelRef.current?.offsetHeight || 420 : FAB_SIZE,
      );
      setPos(next);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const drag = dragRef.current;
      if (drag?.moved) suppressClickRef.current = true;
      dragRef.current = null;
      setDragging(false);
      setPos((prev) => {
        const isOpen = openRef.current;
        const next = clampPos(
          prev,
          isOpen ? PANEL_WIDTH : FAB_SIZE,
          isOpen ? panelRef.current?.offsetHeight || 420 : FAB_SIZE,
        );
        savePos(next);
        return next;
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`fixed z-[70] touch-none ${dragging ? "cursor-grabbing" : ""}`}
      style={{ left: pos.x, top: pos.y }}
    >
      {!open ? (
        <button
          type="button"
          data-dialpad-drag
          aria-label="Open dialpad"
          title="Drag to move · Click to open"
          onPointerDown={onDragStart}
          onClick={(e) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              e.preventDefault();
              return;
            }
            setOpen(true);
            setPos((prev) => clampPos(prev, PANEL_WIDTH, 420));
          }}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg shadow-sky-950/50 border border-sky-400/30 hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-300 cursor-grab active:cursor-grabbing"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 2h2v4H7V2zm4 0h2v4h-2V2zm4 0h2v4h-2V2zM7 8h2v4H7V8zm4 0h2v4h-2V8zm4 0h2v4h-2V8zM7 14h2v4H7v-4zm4 0h2v4h-2v-4zm4 0h2v4h-2v-4zM5 22h14a1 1 0 0 0 1-1v-2H4v2a1 1 0 0 0 1 1z" />
          </svg>
        </button>
      ) : (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className="w-[min(300px,calc(100vw-16px))] rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl shadow-black/50 overflow-hidden"
        >
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800 bg-slate-900">
            <div
              data-dialpad-drag
              onPointerDown={onDragStart}
              className="min-w-0 flex-1 cursor-grab active:cursor-grabbing select-none"
            >
              <p id={titleId} className="text-sm font-medium text-slate-100">
                Dialpad
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                Drag to move · Available on all pages
              </p>
            </div>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                closePanel();
              }}
              className="shrink-0 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 text-sm"
              aria-label="Close dialpad"
            >
              ✕
            </button>
          </div>

          <div className="p-3 space-y-3">
            <div className="space-y-1">
              <span className="block text-xs text-slate-400">Contact name (optional)</span>
              <DialerContactInput
                value={contactName}
                onChange={setContactName}
                onSelectContact={({ name, countryCode: code, digits: num }) => {
                  setContactName(name);
                  setCountryCode(code);
                  setDigits(num);
                }}
                placeholder="Type contact or company name…"
              />
            </div>

            <div className="relative">
              <div className="flex gap-2">
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setCountryOpen((v) => !v)}
                    className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-2 text-sm text-slate-200 min-w-[5.25rem]"
                  >
                    {selectedCountry
                      ? `${selectedCountry.flag} ${dialPrefix}`
                      : dialPrefix || "Code"}
                  </button>
                  {countryOpen && (
                    <div className="absolute z-50 mt-1 w-56 rounded-lg border border-slate-700 bg-slate-950 shadow-xl">
                      <div className="p-2 border-b border-slate-800">
                        <input
                          type="search"
                          value={countryQuery}
                          onChange={(e) => setCountryQuery(e.target.value)}
                          placeholder="Search countries…"
                          autoFocus
                          className="w-full rounded-md bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-200"
                        />
                      </div>
                      <ul className="max-h-40 overflow-y-auto py-1">
                        {filteredCountries.map((country) => (
                          <li key={country.code}>
                            <button
                              type="button"
                              onClick={() => {
                                setCountryCode(country.code);
                                setCountryOpen(false);
                                setCountryQuery("");
                              }}
                              className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-900 ${
                                country.code === countryCode
                                  ? "bg-emerald-500/10 text-emerald-300"
                                  : "text-slate-200"
                              }`}
                            >
                              <span className="mr-2">{country.flag}</span>
                              {formatDialCode(country.code)} {country.name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={clearDigits}
                  className="rounded-lg border border-slate-700 px-2 text-xs text-slate-400 hover:bg-slate-900"
                  title="Clear number"
                >
                  Clear
                </button>
              </div>
            </div>

            {voice?.active ? (
              (() => {
                const leg = LEG_UI[voice.legStatus] ?? LEG_UI.unknown;
                return (
                  <div className={`rounded-xl border px-3 py-2.5 min-h-[4.5rem] flex flex-col justify-center ${leg.box}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`flex items-center gap-1.5 text-xs font-semibold ${leg.text}`}>
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${leg.dot} ${leg.pulse ? "animate-pulse" : ""}`}
                        />
                        {leg.label}
                      </span>
                      {voice.legStatus === "answered" ? (
                        <span className="text-[10px] uppercase font-mono tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-200 border border-emerald-700/50">
                          DTMF / Keypad Mode
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 font-mono text-sm text-slate-200 truncate">
                      {voice.activeCall?.phone || contactName || "On Live Call"}
                    </p>
                    {voice.legAttempts > 1 && voice.legStatus !== "answered" ? (
                      <p className="mt-1 text-[11px] text-slate-400">
                        Attempt {voice.legAttempts} — the system keeps retrying automatically
                      </p>
                    ) : null}
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-slate-400 text-[11px]">Sent digits:</span>
                      <span className="font-mono font-bold text-emerald-300 bg-slate-900 border border-emerald-700/60 px-2 py-0.5 rounded min-w-[2.5rem] text-center">
                        {sentDtmfHistory || "—"}
                      </span>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="rounded-xl border border-emerald-700/40 bg-slate-900 px-3 py-3 min-h-[4.5rem] flex flex-col justify-center">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Number</p>
                <p className="font-mono text-xl text-emerald-300 break-all leading-tight">
                  {digits ? (
                    <>
                      <span className="text-slate-500 text-base mr-1">{dialPrefix}</span>
                      {digits}
                    </>
                  ) : (
                    <span className="text-slate-600 text-base">{dialPrefix || "+"}…</span>
                  )}
                </p>
                {formattedNumber && (
                  <p className="mt-1 text-[11px] font-mono text-slate-500">{formattedNumber}</p>
                )}
              </div>
            )}

            <div className="grid grid-cols-3 gap-1.5">
              {DIAL_KEYS.map((key) => {
                const isSent = lastSentDtmf === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleKeyClick(key)}
                    className={`rounded-xl border py-3 text-lg font-semibold transition ${
                      isSent
                        ? "border-emerald-400 bg-emerald-700 text-white scale-95 shadow-md shadow-emerald-900/50"
                        : "border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800 active:bg-slate-700"
                    }`}
                  >
                    {key}
                  </button>
                );
              })}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={backspace}
                disabled={!digits || Boolean(voice?.active)}
                className="flex-1 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 py-2.5 text-sm text-slate-300 disabled:opacity-40"
              >
                Delete
              </button>
              {voice?.active || voice?.dialing ? (
                <button
                  type="button"
                  onClick={() => voice.hangUp()}
                  className="flex-1 rounded-xl bg-red-600 hover:bg-red-500 py-2.5 text-sm text-white font-medium"
                >
                  End call
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleCall()}
                  disabled={!canCall}
                  className="flex-1 rounded-xl bg-sky-600 hover:bg-sky-500 py-2.5 text-sm text-white font-medium disabled:opacity-40"
                >
                  {calling ? "Connecting…" : "Call"}
                </button>
              )}
            </div>

            {voice && !voice.ready && voice.initError && (
              <p className="text-xs text-red-300">{voice.initError}</p>
            )}
          </div>
        </div>
      )}

      {phoneFixCheck && (
        <PhoneFixModal
          checkResult={phoneFixCheck.check}
          contactName={contactName}
          onFixAutoAndCall={(corrected) => {
            setPhoneFixCheck(null);
            const parsed = parsePhoneForDialpad(corrected);
            if (parsed) {
              setCountryCode(parsed.countryCode);
              setDigits(parsed.digits);
            }
            void startCallWithNumber(corrected);
          }}
          onFixManualAndCall={(edited) => {
            setPhoneFixCheck(null);
            const parsed = parsePhoneForDialpad(edited);
            if (parsed) {
              setCountryCode(parsed.countryCode);
              setDigits(parsed.digits);
            }
            void startCallWithNumber(edited);
          }}
          onCancel={() => setPhoneFixCheck(null)}
        />
      )}
    </div>,
    document.body,
  );
}
