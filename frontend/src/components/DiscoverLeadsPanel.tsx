import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  MAX_DISCOVERY_BATCH,
  type DiscoveryCandidate,
  type DiscoveryRegion,
  type Lead,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { findIndustry, MAX_DISCOVERY_INDUSTRIES } from "../data/industries";
import {
  useColumnVisibility,
  type ColumnDef,
} from "../hooks/useColumnVisibility";
import { ColumnVisibilityMenu } from "./ColumnVisibilityMenu";
import { IndustryMultiSelect } from "./IndustryMultiSelect";

interface DiscoverLeadsPanelProps {
  seedLead?: Lead | null;
  seedCategories?: string[];
  onImported: (createdIds: number[]) => void;
  onError: (message: string) => void;
  onCancel?: () => void;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "web_search":
      return "Web search";
    case "website_links":
      return "Website links";
    case "csv":
      return "CSV";
    default:
      return source;
  }
}

function isFound(value: string | null | undefined): value is string {
  return Boolean(value && value !== "Not found");
}

const DISCOVER_LEADS_COLUMNS: ColumnDef[] = [
  { id: "select", label: "Select", locked: true },
  { id: "company", label: "Company", locked: true },
  { id: "website", label: "Website" },
  { id: "email", label: "Email" },
  { id: "phone", label: "Phone" },
  { id: "socials", label: "Socials" },
  { id: "market", label: "Market" },
  { id: "source", label: "Source" },
  { id: "status", label: "Status" },
];

function matchSeedRegion(
  seedCountry: string | null | undefined,
  regions: DiscoveryRegion[],
): string | null {
  if (!seedCountry) return null;
  const key = seedCountry.trim().toLowerCase();
  const exact = regions.find(
    (region) =>
      region.code === key || region.label.toLowerCase() === key,
  );
  if (exact) return exact.code;
  const partial = regions.find(
    (region) =>
      key.length >= 4 &&
      (key.includes(region.label.toLowerCase()) ||
        region.label.toLowerCase().includes(key)),
  );
  return partial?.code ?? null;
}

function initialSeedIndustries(seedIndustry: string | null | undefined): Set<string> {
  if (!seedIndustry?.trim()) return new Set();
  const matched = findIndustry(seedIndustry);
  if (matched) return new Set([matched.name]);
  return new Set([seedIndustry.trim()]);
}

function candidateToImportPayload(candidate: DiscoveryCandidate) {
  return {
    company_name: candidate.company_name,
    website_url: candidate.website_url ?? undefined,
    contact_name: candidate.contact_name ?? undefined,
    email: isFound(candidate.email) ? candidate.email : undefined,
    phone: isFound(candidate.phone) ? candidate.phone : undefined,
    facebook_url: isFound(candidate.facebook_url) ? candidate.facebook_url : undefined,
    instagram_url: isFound(candidate.instagram_url) ? candidate.instagram_url : undefined,
    linkedin_url: isFound(candidate.linkedin_url) ? candidate.linkedin_url : undefined,
    country: candidate.country ?? undefined,
    industry: candidate.industry ?? undefined,
    source: candidate.source,
  };
}

function groupRegions(regions: DiscoveryRegion[]): [string, DiscoveryRegion[]][] {
  const map = new Map<string, DiscoveryRegion[]>();
  for (const region of regions) {
    if (!map.has(region.group)) map.set(region.group, []);
    map.get(region.group)!.push(region);
  }
  return [...map.entries()];
}

export function DiscoverLeadsPanel({
  seedLead,
  seedCategories = [],
  onImported,
  onError,
  onCancel,
}: DiscoverLeadsPanelProps) {
  const { user } = useAuth();
  const columnsUi = useColumnVisibility(
    "discover_leads",
    DISCOVER_LEADS_COLUMNS,
    user?.id,
  );
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
  const [regionOptions, setRegionOptions] = useState<DiscoveryRegion[]>([]);
  const [maxRegions, setMaxRegions] = useState(3);
  const [regionsLoading, setRegionsLoading] = useState(true);
  const [selectedIndustries, setSelectedIndustries] = useState<Set<string>>(() =>
    initialSeedIndustries(seedLead?.industry),
  );
  const [useWebSearch, setUseWebSearch] = useState(true);
  const [useWebsiteLinks, setUseWebsiteLinks] = useState(true);
  const [autoOnboard, setAutoOnboard] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<
    | { phase: "search" }
    | { phase: "enrich"; current: number; total: number; name: string }
    | null
  >(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    current: number;
    total: number;
    name: string;
  } | null>(null);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [sourcesUsed, setSourcesUsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const importable = useMemo(
    () => candidates.filter((c) => !c.already_exists),
    [candidates],
  );

  const [regionSearch, setRegionSearch] = useState("");

  const filteredRegionOptions = useMemo(() => {
    const query = regionSearch.trim().toLowerCase();
    if (!query) return regionOptions;
    return regionOptions.filter(
      (region) =>
        region.label.toLowerCase().includes(query) ||
        region.code.toLowerCase().includes(query) ||
        region.group.toLowerCase().includes(query),
    );
  }, [regionOptions, regionSearch]);

  const groupedRegions = useMemo(
    () => groupRegions(filteredRegionOptions),
    [filteredRegionOptions],
  );

  const selectedRegionLabels = useMemo(
    () =>
      regionOptions
        .filter((region) => selectedRegions.has(region.code))
        .map((region) => region.label),
    [regionOptions, selectedRegions],
  );

  useEffect(() => {
    setRegionsLoading(true);
    client
      .listDiscoveryRegions()
      .then((data) => {
        setRegionOptions(data.regions);
        setMaxRegions(data.max_regions);
        const seedCode = matchSeedRegion(seedLead?.country, data.regions);
        if (seedCode) {
          setSelectedRegions(new Set([seedCode]));
        }
      })
      .catch(() => onError("Failed to load target regions"))
      .finally(() => setRegionsLoading(false));
  }, [onError, seedLead?.country]);

  useEffect(() => {
    setSelectedIndustries(initialSeedIndustries(seedLead?.industry));
  }, [seedLead?.industry]);

  function toggleRegion(code: string) {
    setSelectedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
        return next;
      }
      if (next.size >= maxRegions) {
        return prev;
      }
      next.add(code);
      return next;
    });
  }

  function toggleIndustry(name: string) {
    setSelectedIndustries((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
        return next;
      }
      if (next.size >= MAX_DISCOVERY_INDUSTRIES) {
        return prev;
      }
      next.add(name);
      return next;
    });
  }

  const handleDiscover = useCallback(async () => {
    if (selectedRegions.size === 0) {
      onError(`Select at least one target region (max ${maxRegions}).`);
      return;
    }
    setDiscovering(true);
    setMessages([]);
    setCandidates([]);
    setSelected(new Set());
    setDiscoveryProgress({ phase: "search" });
    try {
      const result = await client.discoverLeads({
        seed_lead_id: seedLead?.id,
        region_codes: [...selectedRegions],
        industries: [...selectedIndustries],
        categories: seedCategories,
        limit: MAX_DISCOVERY_BATCH,
        use_web_search: useWebSearch,
        use_website_links: useWebsiteLinks,
        skip_enrichment: true,
      });
      setMessages(result.messages);
      setSearchQuery(result.search_query);
      setSourcesUsed(result.sources_used);

      const rawCandidates = result.candidates.slice(0, MAX_DISCOVERY_BATCH);
      if (rawCandidates.length === 0) {
        setCandidates([]);
        return;
      }

      setCandidates(rawCandidates);
      const enriched: DiscoveryCandidate[] = [];

      for (let i = 0; i < rawCandidates.length; i++) {
        const raw = rawCandidates[i];
        setDiscoveryProgress({
          phase: "enrich",
          current: i + 1,
          total: rawCandidates.length,
          name: raw.company_name,
        });
        try {
          const enrichedOne = await client.enrichDiscoveryCandidate(raw);
          enriched.push(enrichedOne);
        } catch {
          enriched.push(raw);
        }
        setCandidates([...enriched, ...rawCandidates.slice(i + 1)]);
      }

      setCandidates(enriched);
      const importableIds = enriched
        .filter((c) => !c.already_exists && c.is_valid_business !== false)
        .map((c) => c.candidate_id)
        .slice(0, MAX_DISCOVERY_BATCH);
      setSelected(new Set(importableIds));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setDiscoveryProgress(null);
      setDiscovering(false);
    }
  }, [
    maxRegions,
    onError,
    seedCategories,
    seedLead?.id,
    selectedIndustries,
    selectedRegions,
    useWebSearch,
    useWebsiteLinks,
  ]);

  async function handleCsvUpload(file: File) {
    setDiscovering(true);
    setMessages([]);
    try {
      const result = await client.discoverLeadsFromCsv(
        file,
        selectedRegionLabels[0],
      );
      setCandidates(result.candidates);
      setMessages(result.messages);
      setSearchQuery(result.search_query);
      setSourcesUsed(result.sources_used);
      setSelected(
        new Set(result.candidates.filter((c) => !c.already_exists).map((c) => c.candidate_id)),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "File upload failed");
    } finally {
      setDiscovering(false);
    }
  }

  async function handleImport() {
    const toImport = candidates
      .filter((c) => selected.has(c.candidate_id) && !c.already_exists)
      .slice(0, MAX_DISCOVERY_BATCH);
    if (toImport.length === 0) {
      onError("Select at least one new candidate to import");
      return;
    }
    if (toImport.length > MAX_DISCOVERY_BATCH) {
      onError(`Import at most ${MAX_DISCOVERY_BATCH} leads per batch`);
      return;
    }

    setImporting(true);
    setImportProgress(null);
    const createdIds: number[] = [];
    let importedCount = 0;
    let skippedCount = 0;

    try {
      for (let i = 0; i < toImport.length; i++) {
        const candidate = toImport[i];
        setImportProgress({
          current: i + 1,
          total: toImport.length,
          name: candidate.company_name,
        });

        try {
          const result = await client.importDiscoveredLeads({
            candidates: [candidateToImportPayload(candidate)],
            auto_onboard: autoOnboard,
          });
          importedCount += result.created_count;
          skippedCount += result.skipped_count;
          createdIds.push(...result.created.map((b) => b.id));
        } catch (e) {
          onError(
            e instanceof Error
              ? `${candidate.company_name}: ${e.message}`
              : `Import failed for ${candidate.company_name}`,
          );
        }
      }

      if (createdIds.length > 0) {
        onImported(createdIds);
      }
      setCandidates((prev) =>
        prev.map((c) =>
          toImport.some((i) => i.candidate_id === c.candidate_id)
            ? { ...c, already_exists: true }
            : c,
        ),
      );
      setSelected(new Set());
      setMessages([
        `Imported ${importedCount} lead(s)${autoOnboard ? " with research & score" : ""}.`,
        ...(skippedCount > 0 ? [`Skipped ${skippedCount} duplicate(s).`] : []),
      ]);
    } finally {
      setImportProgress(null);
      setImporting(false);
    }
  }

  function toggleAll(checked: boolean) {
    if (checked) {
      setSelected(
        new Set(importable.slice(0, MAX_DISCOVERY_BATCH).map((c) => c.candidate_id)),
      );
    } else {
      setSelected(new Set());
    }
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        if (next.size >= MAX_DISCOVERY_BATCH) return prev;
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-slate-200">Discover leads</h3>
          <p className="text-xs text-slate-500 mt-1">
            Find new importers and distributors for the Leads table. Companies already in
            Old clients are flagged and skipped. Up to {MAX_DISCOVERY_BATCH} leads per batch —
            preview before adding — no auto-outreach.
          </p>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        )}
      </div>

      {seedLead && (
        <p className="text-xs text-slate-500 rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
          Seed: <span className="text-slate-300">{seedLead.company_name}</span>
          {seedCategories.length > 0 && (
            <span> · {seedCategories.length} matched product categor{seedCategories.length === 1 ? "y" : "ies"}</span>
          )}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-400">
              Target regions{" "}
              <span className="text-slate-500">
                (select up to {maxRegions})
              </span>
            </p>
            <span className="text-xs text-slate-500">
              {selectedRegions.size}/{maxRegions} selected
            </span>
          </div>
          {regionsLoading ? (
            <p className="mt-2 text-sm text-slate-500">Loading regions…</p>
          ) : (
            <div className="mt-2 space-y-2">
              <input
                type="search"
                value={regionSearch}
                onChange={(e) => setRegionSearch(e.target.value)}
                placeholder="Search countries…"
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-600/50"
              />
              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-3">
              {groupedRegions.length === 0 ? (
                <p className="text-sm text-slate-500">No countries match your search.</p>
              ) : (
              groupedRegions.map(([group, regions]) => (
                <div key={group}>
                  <p className="text-[11px] font-medium text-slate-500 mb-1.5">{group}</p>
                  <div className="flex flex-wrap gap-2">
                    {regions.map((region) => {
                      const checked = selectedRegions.has(region.code);
                      const atMax = selectedRegions.size >= maxRegions;
                      return (
                        <label
                          key={region.code}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs cursor-pointer transition ${
                            checked
                              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                              : atMax
                                ? "border-slate-800 text-slate-600 cursor-not-allowed"
                                : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && atMax}
                            onChange={() => toggleRegion(region.code)}
                            className="sr-only"
                          />
                          {region.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))
              )}
              </div>
            </div>
          )}
        </div>
        <div className="sm:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-400">
              Target industries{" "}
              <span className="text-slate-500">
                (select up to {MAX_DISCOVERY_INDUSTRIES}, optional)
              </span>
            </p>
            <span className="text-xs text-slate-500">
              {selectedIndustries.size}/{MAX_DISCOVERY_INDUSTRIES} selected
            </span>
          </div>
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3">
            <IndustryMultiSelect
              selected={selectedIndustries}
              onToggle={toggleIndustry}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-400">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={useWebSearch}
            onChange={(e) => setUseWebSearch(e.target.checked)}
          />
          Web search (needs SERPAPI_API_KEY)
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={useWebsiteLinks}
            onChange={(e) => setUseWebsiteLinks(e.target.checked)}
            disabled={!seedLead?.website_url}
          />
          Partner links from seed website
        </label>
        <span className="text-xs text-slate-500">
          Max {MAX_DISCOVERY_BATCH} leads per search
        </span>
      </div>

      {(discoveryProgress || importProgress) && (
        <div className="rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-3 text-sm">
            <p className="text-slate-200">
              {discoveryProgress?.phase === "search" && "Searching for leads…"}
              {discoveryProgress?.phase === "enrich" &&
                `Researching lead ${discoveryProgress.current}/${discoveryProgress.total}`}
              {importProgress &&
                `${autoOnboard ? "Importing & scoring" : "Importing"} ${importProgress.current}/${importProgress.total}`}
            </p>
            {(discoveryProgress?.phase === "enrich" || importProgress) && (
              <span className="text-xs text-slate-500 tabular-nums shrink-0">
                {discoveryProgress?.phase === "enrich"
                  ? `${discoveryProgress.current}/${discoveryProgress.total}`
                  : `${importProgress!.current}/${importProgress!.total}`}
              </span>
            )}
          </div>
          {(discoveryProgress?.phase === "enrich" || importProgress) && (
            <p className="text-xs text-emerald-300/90 truncate">
              {discoveryProgress?.phase === "enrich"
                ? discoveryProgress.name
                : importProgress?.name}
            </p>
          )}
          {(discoveryProgress?.phase === "enrich" || importProgress) && (
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{
                  width: `${
                    discoveryProgress?.phase === "enrich"
                      ? (discoveryProgress.current / discoveryProgress.total) * 100
                      : importProgress
                        ? (importProgress.current / importProgress.total) * 100
                        : 0
                  }%`,
                }}
              />
            </div>
          )}
          <p className="text-[11px] text-slate-500">
            One lead at a time for full website scrape and contact lookup — this may take several
            minutes.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleDiscover}
          disabled={discovering || importing || regionsLoading || selectedRegions.size === 0}
          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
        >
          {discovering
            ? discoveryProgress?.phase === "search"
              ? "Searching…"
              : discoveryProgress?.phase === "enrich"
                ? `${discoveryProgress.current}/${discoveryProgress.total}…`
                : "Discovering…"
            : "Find similar leads"}
        </button>
        <label className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm cursor-pointer">
          Upload file
          <input
            type="file"
            accept=".csv,.xlsx,.xls,.xlsm,.tsv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleCsvUpload(file);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {(messages.length > 0 || searchQuery) && (
        <div className="text-xs text-slate-500 space-y-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
          {searchQuery && (
            <p>
              Search query: <span className="text-slate-400">{searchQuery}</span>
            </p>
          )}
          {sourcesUsed.length > 0 && (
            <p>Sources: {sourcesUsed.map(sourceLabel).join(", ")}</p>
          )}
          {messages.map((msg) => (
            <p key={msg}>{msg}</p>
          ))}
        </div>
      )}

      {candidates.length > 0 && (
        <>
          <div className="flex items-center justify-end">
            <ColumnVisibilityMenu
              columns={columnsUi.columns}
              isVisible={columnsUi.isVisible}
              toggle={columnsUi.toggle}
              showAll={columnsUi.showAll}
              resetDefaults={columnsUi.resetDefaults}
              hiddenCount={columnsUi.hiddenCount}
            />
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            {columnsUi.css ? <style>{columnsUi.css}</style> : null}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800 bg-slate-950">
                  <th data-col="select" className="py-2 px-3 w-10">
                    <input
                      type="checkbox"
                      checked={importable.length > 0 && selected.size === importable.length}
                      onChange={(e) => toggleAll(e.target.checked)}
                      aria-label="Select all"
                    />
                  </th>
                  <th data-col="company" className="py-2 pr-4">Company</th>
                  <th data-col="website" className="py-2 pr-4">Website</th>
                  <th data-col="email" className="py-2 pr-4">Email</th>
                  <th data-col="phone" className="py-2 pr-4">Phone</th>
                  <th data-col="socials" className="py-2 pr-4">Socials</th>
                  <th data-col="market" className="py-2 pr-4">Market</th>
                  <th data-col="source" className="py-2 pr-4">Source</th>
                  <th data-col="status" className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.candidate_id} className="border-b border-slate-800/60">
                    <td data-col="select" className="py-2 px-3">
                      <input
                        type="checkbox"
                        checked={selected.has(candidate.candidate_id)}
                        disabled={candidate.already_exists}
                        onChange={(e) => toggleOne(candidate.candidate_id, e.target.checked)}
                      />
                    </td>
                    <td data-col="company" className="py-2 pr-4 text-slate-200">{candidate.company_name}</td>
                    <td data-col="website" className="py-2 pr-4 text-slate-400 max-w-[200px] truncate">
                      {candidate.website_url ? (
                        <a
                          href={candidate.website_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-400 hover:text-emerald-300"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {candidate.website_url.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-col="email" className="py-2 pr-4 text-slate-400 max-w-[180px] truncate">
                      {isFound(candidate.email) ? (
                        <a
                          href={`mailto:${candidate.email}`}
                          className="text-emerald-400 hover:text-emerald-300"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {candidate.email}
                        </a>
                      ) : (
                        "Not found"
                      )}
                    </td>
                    <td data-col="phone" className="py-2 pr-4 text-slate-400 whitespace-nowrap">
                      {isFound(candidate.phone) ? candidate.phone : "Not found"}
                    </td>
                    <td data-col="socials" className="py-2 pr-4 text-xs">
                      <div className="flex flex-wrap gap-1.5">
                        {isFound(candidate.facebook_url) ? (
                          <a
                            href={candidate.facebook_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-400 hover:text-emerald-300"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Facebook
                          </a>
                        ) : (
                          <span className="text-slate-600">Facebook: Not found</span>
                        )}
                        {isFound(candidate.instagram_url) ? (
                          <a
                            href={candidate.instagram_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-400 hover:text-emerald-300"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Instagram
                          </a>
                        ) : (
                          <span className="text-slate-600">Instagram: Not found</span>
                        )}
                        {isFound(candidate.linkedin_url) ? (
                          <a
                            href={candidate.linkedin_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-400 hover:text-emerald-300"
                            onClick={(e) => e.stopPropagation()}
                          >
                            LinkedIn
                          </a>
                        ) : (
                          <span className="text-slate-600">LinkedIn: Not found</span>
                        )}
                      </div>
                    </td>
                    <td data-col="market" className="py-2 pr-4 text-slate-400">
                      {[candidate.country, candidate.industry].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td data-col="source" className="py-2 pr-4 text-slate-500 text-xs">
                      {sourceLabel(candidate.source)}
                    </td>
                    <td data-col="status" className="py-2 text-xs">
                      {candidate.already_exists ? (
                        <span className="text-amber-400/90">Already in leads or Old clients</span>
                      ) : (
                        <span className="text-slate-500">New</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-400">
              <input
                type="checkbox"
                checked={autoOnboard}
                onChange={(e) => setAutoOnboard(e.target.checked)}
                disabled={importing}
              />
              Research &amp; score after import
            </label>
            <p className="text-xs text-slate-500">
              {selected.size}/{MAX_DISCOVERY_BATCH} selected
            </p>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || discovering || selected.size === 0}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {importing && importProgress
                ? `${importProgress.current}/${importProgress.total}…`
                : `Add selected (${selected.size})`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
