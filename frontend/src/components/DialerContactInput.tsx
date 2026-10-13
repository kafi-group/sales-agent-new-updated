import { useEffect, useRef, useState } from "react";
import {
  client,
  type CallFilterSectionOption,
  type DialableContactSuggestion,
} from "../api/client";
import { parsePhoneForDialpad } from "../data/countryDialCodes";
import { findCountry } from "../data/countries";
import { SearchableSelect } from "./SearchableSelect";

interface DialerContactInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelectContact: (info: { name: string; countryCode: string; digits: string }) => void;
  placeholder?: string;
  className?: string;
}

export function DialerContactInput({
  value,
  onChange,
  onSelectContact,
  placeholder = "Search contact or company name…",
  className = "",
}: DialerContactInputProps) {
  const [suggestions, setSuggestions] = useState<DialableContactSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Multi-filter states
  const [sectionFilter, setSectionFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState("");
  const [designationFilter, setDesignationFilter] = useState("");

  // Options loaded from backend
  const [availableSections, setAvailableSections] = useState<CallFilterSectionOption[]>([]);
  const [availableCountries, setAvailableCountries] = useState<string[]>([]);
  const [availableGrades, setAvailableGrades] = useState<string[]>([]);
  const [availableDesignations, setAvailableDesignations] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Load filter options on mount
  useEffect(() => {
    let active = true;
    client
      .getCallFilterOptions()
      .then((res) => {
        if (!active) return;
        if (res.sections?.length) setAvailableSections(res.sections);
        if (res.countries?.length) setAvailableCountries(res.countries);
        if (res.grades?.length) setAvailableGrades(res.grades);
        if (res.designations?.length) setAvailableDesignations(res.designations);
      })
      .catch(() => {
        if (!active) return;
        setAvailableSections([
          { id: "", label: "All Sections / Master", icon: "🌐" },
          { id: "targeted_distributor", label: "Targeted Distributors", icon: "🎯" },
          { id: "old_clients", label: "Old clients", icon: "👥" },
          { id: "hyperstore_targeted", label: "Hyperstore Target", icon: "🛒" },
          { id: "all", label: "New search lead", icon: "🆕" },
          { id: "interested_clients", label: "Follow up clients", icon: "⏰" },
          { id: "sales_interested_clients", label: "Interested Clients", icon: "⭐" },
          { id: "not_received_call_clients", label: "Did not receive call", icon: "📞" },
          { id: "not_interested_clients", label: "Not interested", icon: "🚫" },
        ]);
        setAvailableCountries([
          "Pakistan",
          "United Arab Emirates",
          "Saudi Arabia",
          "United States",
          "United Kingdom",
          "Russia",
          "China",
          "Afghanistan",
        ]);
        setAvailableGrades(["AAAA", "AAA", "AA", "A", "B", "Ungraded"]);
        setAvailableDesignations(["Managing Director", "Director", "CEO", "Owner", "Manager"]);
      });
    return () => {
      active = false;
    };
  }, []);

  const hasActiveFilters = Boolean(
    sectionFilter || countryFilter || gradeFilter || designationFilter || value.trim(),
  );

  // Query suggestions when search or any filter changes
  useEffect(() => {
    const query = value.trim();
    // Only search if user typed something OR if any filter is active
    if (!query && !sectionFilter && !countryFilter && !gradeFilter && !designationFilter) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await client.suggestDialableContacts({
          q: query || undefined,
          section: sectionFilter || undefined,
          country: countryFilter || undefined,
          grade: gradeFilter || undefined,
          designation: designationFilter || undefined,
          limit: 30,
        });
        const rows = res.rows || [];
        setSuggestions(rows);
        setOpen(rows.length > 0);
      } catch {
        setSuggestions([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [value, sectionFilter, countryFilter, gradeFilter, designationFilter]);

  // Click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(item: DialableContactSuggestion) {
    const contactName = item.company_name || item.contact_name || item.label;
    onChange(contactName);
    setOpen(false);

    if (item.phone) {
      const parsed = parsePhoneForDialpad(
        item.phone,
        item.country ? findCountry(item.country)?.code ?? item.country : undefined,
      );
      if (parsed) {
        onSelectContact({
          name: contactName,
          countryCode: parsed.countryCode,
          digits: parsed.digits,
        });
      }
    }
  }

  function handleClearFilters() {
    setSectionFilter("");
    setCountryFilter("");
    setGradeFilter("");
    setDesignationFilter("");
    onChange("");
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative w-full space-y-2">
      {/* Top Filter: Lead List / Section Selector */}
      <div>
        <label className="block text-[11px] font-medium text-slate-300 mb-1 flex items-center justify-between">
          <span>📂 Filter by Lead List / Pool</span>
          {sectionFilter && (
            <span className="text-[10px] text-emerald-300 font-mono">Scoped Search Active</span>
          )}
        </label>
        <select
          value={sectionFilter}
          onChange={(e) => {
            setSectionFilter(e.target.value);
          }}
          className="w-full rounded-md bg-slate-900 border border-slate-600 px-2.5 py-1.5 text-xs text-slate-100 font-medium focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 transition cursor-pointer"
        >
          <option value="">🌐 All Sections / Master Table</option>
          {availableSections.map((sec) => (
            <option key={sec.id} value={sec.id}>
              {sec.icon ? `${sec.icon} ` : ""}{sec.label}{sec.count != null ? ` (${sec.count.toLocaleString()})` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Filter Row 2: Country & Grade Selectors */}
      <div className="grid grid-cols-2 gap-1.5">
        <SearchableSelect
          label="Filter Country"
          labelClassName="block text-[11px] font-medium text-slate-400 mb-1"
          value={countryFilter}
          onChange={setCountryFilter}
          options={availableCountries.map((c) => {
            const info = findCountry(c);
            return { value: c, label: info ? `${info.flag} ${c}` : c };
          })}
          allowEmpty
          emptyLabel="🌍 All Countries"
          placeholder="Search countries…"
          multiSelect={false}
        />
        <SearchableSelect
          label="Filter Grade"
          labelClassName="block text-[11px] font-medium text-slate-400 mb-1"
          value={gradeFilter}
          onChange={setGradeFilter}
          options={[
            ...availableGrades.map((g) => ({ value: g, label: `Grade ${g}` })),
            ...(!availableGrades.includes("Ungraded")
              ? [{ value: "Ungraded", label: "Ungraded" }]
              : []),
          ]}
          allowEmpty
          emptyLabel="⭐ All Grades"
          placeholder="Search grades…"
          multiSelect={false}
        />
      </div>

      {/* Filter Row 3: Designation Selector */}
      <SearchableSelect
        label="Filter Designation"
        labelClassName="block text-[11px] font-medium text-slate-400 mb-1"
        value={designationFilter}
        onChange={setDesignationFilter}
        options={availableDesignations.map((d) => ({ value: d, label: d }))}
        allowEmpty
        emptyLabel="👔 All Designations"
        placeholder="Search designations…"
        multiSelect={false}
      />

      {/* Contact / Company Search Input */}
      <div className="relative">
        <div className="flex items-center justify-between mb-1">
          <label className="block text-[11px] font-medium text-slate-400">
            Search Contact / Company / Phone
          </label>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="text-[10px] text-rose-400 hover:text-rose-300 transition underline cursor-pointer"
            >
              Reset Filters
            </button>
          )}
        </div>
        <div className="relative">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => {
              if (suggestions.length > 0) setOpen(true);
            }}
            placeholder={
              sectionFilter
                ? `Search within ${availableSections.find((s) => s.id === sectionFilter)?.label || "selected pool"}…`
                : placeholder
            }
            className={`w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 transition ${className}`}
          />
          {loading && (
            <div className="absolute right-3 top-2.5 text-xs text-slate-500 animate-pulse">
              Searching…
            </div>
          )}
          {value && !loading && (
            <button
              type="button"
              onClick={() => onChange("")}
              className="absolute right-2.5 top-2.5 text-xs text-slate-400 hover:text-slate-200 p-0.5 rounded"
            >
              ✕
            </button>
          )}
        </div>

        {/* Suggestion Dropdown with Rich Badges */}
        {open && suggestions.length > 0 && (
          <div className="absolute z-50 left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 shadow-2xl divide-y divide-slate-800/80">
            <div className="px-3 py-1.5 bg-slate-900/90 text-[10px] text-slate-400 font-medium flex items-center justify-between sticky top-0 backdrop-blur z-10">
              <span>
                Matching Contacts ({suggestions.length})
                {sectionFilter && ` • ${availableSections.find((s) => s.id === sectionFilter)?.label || ""}`}
              </span>
              <span>Click to Dial</span>
            </div>
            {suggestions.map((item, idx) => {
              const countryInfo = item.country ? findCountry(item.country) : null;
              return (
                <button
                  key={`${item.buyer_id}-${item.contact_id}-${idx}`}
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => handleSelect(item)}
                  className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-emerald-950/70 hover:text-emerald-300 transition flex flex-col gap-1 group"
                >
                  <div className="flex items-center justify-between font-medium text-slate-100 group-hover:text-emerald-200">
                    <span className="truncate max-w-[65%] font-semibold">
                      {item.company_name || "(Company Name N/A)"}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      {item.grading && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium">
                          {item.grading}
                        </span>
                      )}
                      {item.country && (
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {countryInfo?.flag ? `${countryInfo.flag} ` : ""}
                          {item.country}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-slate-400 group-hover:text-slate-300">
                    <div className="flex items-center gap-1.5 truncate max-w-[60%]">
                      <span className="truncate">{item.contact_name}</span>
                      {item.designation && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-800/40 shrink-0">
                          {item.designation}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-emerald-400 text-[11px] shrink-0 ml-2 font-medium">
                      {item.phone}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
