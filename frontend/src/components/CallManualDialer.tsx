import { useMemo, useState } from "react";
import { COUNTRIES, findCountry } from "../data/countries";
import { buildE164, formatDialCode } from "../data/countryDialCodes";
import { useTwilioVoiceOptional } from "../hooks/useTwilioVoice";
import type { CallInitiateResult } from "../api/client";

import { DialerContactInput } from "./DialerContactInput";

interface CallManualDialerProps {
  onError: (message: string) => void;
  onSuccess?: (result: CallInitiateResult) => void;
}

const DIAL_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

export function CallManualDialer({ onError, onSuccess }: CallManualDialerProps) {
  const voice = useTwilioVoiceOptional();
  const [countryCode, setCountryCode] = useState("PK");
  const [digits, setDigits] = useState("");
  const [contactName, setContactName] = useState("");
  const [calling, setCalling] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState("");

  const selectedCountry = useMemo(() => findCountry(countryCode), [countryCode]);

  const filteredCountries = useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (country) =>
        country.name.toLowerCase().includes(q) ||
        country.code.toLowerCase().includes(q),
    );
  }, [countryQuery]);

  const formattedNumber = useMemo(() => {
    const e164 = buildE164(countryCode, digits);
    return e164 ?? "";
  }, [countryCode, digits]);

  const canCall = Boolean(
    voice?.ready && formattedNumber && !voice.active && !voice.dialing && !calling,
  );

  const [lastSentDtmf, setLastSentDtmf] = useState<string | null>(null);

  const handleDigitClick = (key: string) => {
    if (voice?.active) {
      voice.sendDigits(key);
      setLastSentDtmf(key);
      window.setTimeout(() => setLastSentDtmf((curr) => (curr === key ? null : curr)), 800);
    } else {
      appendDigit(key);
    }
  };

  function appendDigit(key: string) {
    setDigits((prev) => `${prev}${key}`);
  }

  function backspace() {
    setDigits((prev) => prev.slice(0, -1));
  }

  async function handleCall() {
    if (!voice || !formattedNumber) return;
    setCalling(true);
    const safetyTimer = window.setTimeout(() => {
      setCalling(false);
    }, 16000);

    try {
      if (!voice.ready) {
        await voice.retryInit();
      }
      const result = await voice.placeManualCall(formattedNumber, {
        contactName: contactName.trim() || undefined,
        country: selectedCountry?.name,
      });
      onSuccess?.(result);
    } catch (e) {
      if (e instanceof Error && e.name === "DialCancelled") return; // user pressed End
      onError(e instanceof Error ? e.message : "Call failed");
    } finally {
      window.clearTimeout(safetyTimer);
      setCalling(false);
    }
  }

  const dialPrefix = formatDialCode(countryCode);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-slate-300">Manual dialer</h3>
        <p className="text-xs text-slate-500 mt-0.5">Dial any number — not limited to leads</p>
      </div>

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
        <span className="text-xs text-slate-400">Country &amp; number</span>
        <div className="mt-1 flex gap-2">
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setCountryOpen((prev) => !prev)}
              className="h-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-2 text-sm text-slate-200 min-w-[5.5rem]"
            >
              {selectedCountry ? `${selectedCountry.flag} ${dialPrefix}` : dialPrefix || "Code"}
            </button>
            {countryOpen && (
              <div className="absolute z-40 mt-1 w-56 rounded-lg border border-slate-700 bg-slate-950 shadow-xl">
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
                <ul className="max-h-48 overflow-y-auto py-1">
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
          <input
            type="tel"
            value={digits}
            onChange={(e) => setDigits(e.target.value.replace(/[^\d+*#]/g, ""))}
            placeholder="Local number"
            className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
          />
        </div>
        <p className="mt-1.5 text-xs text-slate-500 font-mono">
          {formattedNumber || `${dialPrefix || "+"}…`}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {DIAL_KEYS.map((key) => {
          const isSent = lastSentDtmf === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => handleDigitClick(key)}
              className={`rounded-lg border py-2.5 text-base font-medium transition ${
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
          disabled={!digits}
          className="flex-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 py-2 text-sm text-slate-300 disabled:opacity-40"
        >
          Delete
        </button>
        {voice?.active || voice?.dialing ? (
          <button
            type="button"
            onClick={() => voice.hangUp()}
            className="flex-1 rounded-lg bg-red-600 hover:bg-red-500 py-2 text-sm text-white font-medium"
          >
            End call
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleCall()}
            disabled={!canCall}
            className="flex-1 rounded-lg bg-sky-600 hover:bg-sky-500 py-2 text-sm text-white font-medium disabled:opacity-40"
          >
            {calling ? "Connecting…" : "Call"}
          </button>
        )}
      </div>

      {voice && !voice.ready && voice.initError && (
        <p className="text-xs text-red-300">{voice.initError}</p>
      )}
    </div>
  );
}
