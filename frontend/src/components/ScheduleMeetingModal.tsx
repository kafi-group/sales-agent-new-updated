import { useEffect, useMemo, useState } from "react";
import { client, type LeadTableRow } from "../api/client";
import { CountrySelect } from "./CountrySelect";
import { SearchableSelect, stringOptions } from "./SearchableSelect";
import { ActionButton } from "./ui/ActionButton";
import { IconCheck, IconXCircle } from "./icons/AppIcons";
import {
  formatInTimezone,
  formatTimezoneShort,
  PKT_TIMEZONE,
  timezoneForCountry,
  toLocalInputValue,
  wallTimeInZoneToDate,
} from "../utils/meetingTimezone";

type Props = {
  row: LeadTableRow;
  onClose: () => void;
  onError: (message: string) => void;
  onSaved: (row: LeadTableRow) => void;
};

export function ScheduleMeetingModal({ row, onClose, onError, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [meetingLocal, setMeetingLocal] = useState("");
  const [address, setAddress] = useState(row.meeting_location || row.address || "");
  const [country, setCountry] = useState(row.country || "");
  const [city, setCity] = useState(row.city || "");
  const [notes, setNotes] = useState(row.meeting_notes || "");
  const [priority, setPriority] = useState(String(row.meeting_priority ?? ""));
  const [captionHint, setCaptionHint] = useState<string | null>(null);
  const [cityOptions, setCityOptions] = useState<string[]>([]);

  const stayTz = useMemo(() => timezoneForCountry(country), [country]);
  const stayTzLabel = useMemo(
    () => formatTimezoneShort(stayTz),
    [stayTz],
  );

  const pktPreview = useMemo(() => {
    if (!meetingLocal.trim()) return null;
    try {
      const utc = wallTimeInZoneToDate(meetingLocal, stayTz);
      return {
        local: formatInTimezone(utc, stayTz),
        pkt: formatInTimezone(utc, PKT_TIMEZONE),
        tzShort: formatTimezoneShort(stayTz, utc),
        pktShort: formatTimezoneShort(PKT_TIMEZONE, utc),
      };
    } catch {
      return null;
    }
  }, [meetingLocal, stayTz]);

  const nowInStay = useMemo(() => {
    const now = new Date();
    return {
      local: formatInTimezone(now, stayTz),
      pkt: formatInTimezone(now, PKT_TIMEZONE),
    };
  }, [stayTz, meetingLocal]); // refresh when country or form changes

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [suggest, filters] = await Promise.all([
          client.suggestLeadMeeting(row.id),
          client.listLeadTableFilters(),
        ]);
        if (cancelled) return;
        setCityOptions(
          Array.from(
            new Set(
              [...(filters.cities ?? []), row.city || ""].map((c) => c.trim()).filter(Boolean),
            ),
          ).sort((a, b) => a.localeCompare(b)),
        );
        const nextCountry = row.country || "";
        const tz = timezoneForCountry(nextCountry);
        if (suggest.current.meeting_at) {
          setMeetingLocal(toLocalInputValue(new Date(suggest.current.meeting_at), tz));
        } else {
          setMeetingLocal(toLocalInputValue(new Date(), tz));
        }
        setAddress(
          suggest.current.meeting_location ||
            suggest.suggested_location ||
            row.address ||
            "",
        );
        setCountry(nextCountry);
        setCity(row.city || "");
        setNotes(
          suggest.current.meeting_notes ||
            suggest.suggested_notes ||
            "",
        );
        setPriority(
          suggest.current.meeting_priority != null
            ? String(suggest.current.meeting_priority)
            : "",
        );
        const cap =
          suggest.caption?.transcript || suggest.caption?.call_notes || null;
        setCaptionHint(cap);
      } catch (e) {
        if (!cancelled) {
          onError(e instanceof Error ? e.message : "Could not load meeting suggestions");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id, row.address, row.country, row.city, onError]);

  /** Keep the same wall-clock time when country/timezone changes; PKT preview updates. */
  function handleCountryChange(next: string) {
    setCountry(next);
  }

  async function handleSave(confirm: boolean) {
    if (!meetingLocal.trim()) {
      onError("Pick a meeting date and time before scheduling.");
      return;
    }
    if (!country.trim()) {
      onError("Select the country of stay for the meeting timezone.");
      return;
    }
    let at: Date;
    try {
      at = wallTimeInZoneToDate(meetingLocal, stayTz);
    } catch {
      onError("Invalid date/time.");
      return;
    }
    setSaving(true);
    try {
      const saved = await client.scheduleLeadMeeting(row.id, {
        meeting_at: at.toISOString(),
        meeting_location: address.trim() || null,
        meeting_notes: notes.trim() || null,
        meeting_priority: priority.trim() ? Number(priority) : null,
        country: country.trim() || null,
        city: city.trim() || null,
        confirm,
      });
      onSaved(saved);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save meeting");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4">
      <div
        className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-meeting-title"
      >
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-3">
          <div>
            <h3 id="schedule-meeting-title" className="text-lg font-semibold text-slate-100">
              Schedule meeting
            </h3>
            <p className="text-sm text-slate-400 mt-1">
              {row.company_name}
              {row.contact_name ? ` · ${row.contact_name}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <p className="text-sm text-slate-400">Loading suggestions from call captions…</p>
          ) : null}

          {captionHint ? (
            <div className="rounded-xl border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs text-teal-100/90 max-h-28 overflow-y-auto whitespace-pre-wrap">
              <p className="font-semibold text-teal-200 mb-1">From closed captions / call notes</p>
              {captionHint.slice(0, 800)}
              {captionHint.length > 800 ? "…" : ""}
            </div>
          ) : null}

          <CountrySelect
            label="Country of stay"
            labelClassName="text-xs font-semibold text-slate-300 uppercase tracking-wide"
            value={country}
            onChange={handleCountryChange}
            allowEmpty
            emptyLabel="Select country"
            placeholder="Search countries…"
            multiSelect={false}
          />

          <SearchableSelect
            label="City"
            labelClassName="text-xs font-semibold text-slate-300 uppercase tracking-wide"
            value={city}
            onChange={setCity}
            options={stringOptions(cityOptions)}
            allowEmpty
            emptyLabel="Select city"
            placeholder="Search cities…"
            multiSelect={false}
          />

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
              Address
            </span>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Office / street / venue"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
              Date &amp; time ({country || "local"} · {stayTzLabel})
            </span>
            <input
              type="datetime-local"
              value={meetingLocal}
              onChange={(e) => setMeetingLocal(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100"
            />
          </label>

          <div className="rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 text-xs space-y-1.5">
            <p className="text-slate-400">
              Now in {country || "selected country"}:{" "}
              <span className="text-slate-200 font-medium">{nowInStay.local}</span>
            </p>
            {pktPreview ? (
              <>
                <p className="text-slate-300">
                  Meeting local ({pktPreview.tzShort}):{" "}
                  <span className="text-slate-100 font-medium">{pktPreview.local}</span>
                </p>
                <p className="text-emerald-300/90">
                  Pakistan ({pktPreview.pktShort}):{" "}
                  <span className="text-emerald-200 font-semibold">{pktPreview.pkt}</span>
                </p>
              </>
            ) : (
              <p className="text-slate-500">Enter date &amp; time to see Pakistan conversion.</p>
            )}
            {country === "Canada" || country === "United States" || country === "Australia" ? (
              <p className="text-slate-500">
                Uses primary business timezone for this country (e.g. Canada → Toronto / Eastern).
              </p>
            ) : null}
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
              Notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Agenda, who to meet, parking, etc."
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 resize-y"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
              Priority (optional, lower = sooner)
            </span>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              placeholder="e.g. 1"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100"
            />
          </label>

          <p className="text-xs text-slate-500">
            Status now:{" "}
            <span className="text-slate-300 font-medium">
              {row.meeting_status === "scheduled" ? "Scheduled (visible to PA)" : "Pending confirmation"}
            </span>
            . Confirming pushes this meetup to PA Travel &amp; Loyalty.
          </p>
        </div>

        <div className="p-5 border-t border-slate-800 flex flex-col sm:flex-row gap-2 sm:justify-end">
          <ActionButton icon={IconXCircle} variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </ActionButton>
          <ActionButton
            icon={IconCheck}
            variant="ghost"
            disabled={saving || loading}
            onClick={() => void handleSave(false)}
            title="Save draft without sending to PA yet"
          >
            {saving ? "Saving…" : "Save draft"}
          </ActionButton>
          <ActionButton
            icon={IconCheck}
            variant="emerald"
            disabled={saving || loading}
            onClick={() => void handleSave(true)}
            title="Confirm schedule — appears on PA"
          >
            {saving ? "Scheduling…" : "Confirm schedule → PA"}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
