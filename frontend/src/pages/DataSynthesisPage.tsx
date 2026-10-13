import { useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  type AppUser,
  type EnrichmentComparisonReport,
  type SafeMergeResult,
  type SynthesisJobStatus,
  type MissingDataReport,
} from "../api/client";

const ACCEPT = ".csv,.xlsx,.xls,.xlsm,.tsv,.zip,.rar";
const FILE_FILTER = /\.(csv|xlsx|xls|xlsm|tsv|zip|rar)$/i;
const POLL_MS = 800;
const MAX_POLL_FAILURES = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function downloadMissingRowsCsv(report: MissingDataReport) {
  if (!report || !report.missing_rows || report.missing_rows.length === 0) return;
  const headers = ["Row Ref ID", "Company Name", "Assigned To", "Grading", "Country", "City", "Missing Field", "Website", "Contact Person", "Phone", "Email"];
  const rows = report.missing_rows.map((r) => [
    r.legacy_serial_no || r.id,
    `"${(r.company_name || "").replace(/"/g, '""')}"`,
    `"${(r.assigned_to || "").replace(/"/g, '""')}"`,
    `"${(r.company_grading || "").replace(/"/g, '""')}"`,
    `"${(r.country || "").replace(/"/g, '""')}"`,
    `"${(r.city || "").replace(/"/g, '""')}"`,
    `"${(r.missing_column_label || "").replace(/"/g, '""')}"`,
    `"${(r.website_url || "").replace(/"/g, '""')}"`,
    `"${(r.contact_person || "").replace(/"/g, '""')}"`,
    `"${(r.primary_phone || "").replace(/"/g, '""')}"`,
    `"${(r.primary_email || "").replace(/"/g, '""')}"`,
  ]);
  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Missing_${report.column_key}_${report.section}_${(report.user_name || "all").replace(/\s+/g, "_")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function fileKey(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel || file.name;
}

function pickAllowedFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => FILE_FILTER.test(file.name));
}

function mergeFiles(existing: File[], incoming: File[]): File[] {
  const map = new Map<string, File>();
  for (const file of existing) {
    map.set(fileKey(file), file);
  }
  for (const file of incoming) {
    map.set(fileKey(file), file);
  }
  return Array.from(map.values());
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function ProgressPanel({ status }: { status: SynthesisJobStatus }) {
  const done = status.status === "completed";
  const failed = status.status === "failed";
  const percent = done ? 100 : status.percent ?? 0;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-100">
          {failed
            ? "Something went wrong"
            : done
            ? "Ready to download"
            : status.phase_label || "Working…"}
        </p>
        <span className="text-xs tabular-nums text-slate-400">
          {percent}% · {formatElapsed(status.elapsed_seconds)}
        </span>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            failed
              ? "bg-red-500"
              : done
              ? "bg-emerald-500"
              : "bg-gradient-to-r from-cyan-600 to-violet-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {!done && !failed && status.current_company && (
        <p className="text-xs text-slate-500 truncate">
          Row: <span className="text-slate-300">{status.current_company}</span>
        </p>
      )}

      {done && status.output_rows > 0 && (
        <p className="text-xs text-emerald-300">{status.output_rows} row(s) in your cleaned file.</p>
      )}

      {failed && status.error && <p className="text-xs text-red-300">{status.error}</p>}
    </div>
  );
}

interface DataSynthesisPageProps {
  onError: (message: string) => void;
  masterType?: string;
}

export function DataSynthesisPage({ onError, masterType = "fmcg" }: DataSynthesisPageProps) {
  const [mode, setMode] = useState<"clean" | "enrichment" | "missing_report">("enrichment");

  const masterLabel = useMemo(() => {
    if (masterType === "minerals_ores") return "Master Table (Minerals & Ores)";
    if (masterType === "other_items") return "Master Table (Other Items)";
    return "Master Table (ALL)";
  }, [masterType]);

  // State for Missing Data Report
  const [missingSection, setMissingSection] = useState("master");
  const [missingColumnKey, setMissingColumnKey] = useState("contact_name");
  const [missingUserId, setMissingUserId] = useState("");
  const [missingReportData, setMissingReportData] = useState<MissingDataReport | null>(null);
  const [loadingMissingReport, setLoadingMissingReport] = useState(false);

  const fetchMissingReport = async (sec = missingSection, col = missingColumnKey, uId = missingUserId) => {
    setLoadingMissingReport(true);
    try {
      const parsedUserId = uId && !isNaN(Number(uId)) && Number(uId) > 0 ? Number(uId) : undefined;
      const res = await client.getMissingDataReport(sec, col, parsedUserId, masterType);
      setMissingReportData(res);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not fetch missing data report");
    } finally {
      setLoadingMissingReport(false);
    }
  };

  // State for Smart Data Clean & Merge
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [jobStatus, setJobStatus] = useState<SynthesisJobStatus | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // State for AI Enrichment Comparison & Safe Merge
  const [assignees, setAssignees] = useState<AppUser[]>([]);
  const [userFilter, setUserFilter] = useState("");
  const [tableSource, setTableSource] = useState("master_table");
  const [enrichmentFile, setEnrichmentFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [report, setReport] = useState<EnrichmentComparisonReport | null>(null);
  const [mergeResult, setMergeResult] = useState<SafeMergeResult | null>(null);
  const [safeFillMode, setSafeFillMode] = useState(true);
  const enrichmentFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    client
      .listAssignees()
      .then(setAssignees)
      .catch(() => setAssignees([]));
  }, []);

  const sourceSummary = useMemo(() => {
    if (sourceFiles.length === 0) return null;
    if (sourceFiles.length === 1) return sourceFiles[0].name;
    const names = sourceFiles.map((file) => file.name).slice(0, 2);
    const extra = sourceFiles.length - 2;
    return extra > 0
      ? `${sourceFiles.length} files — ${names.join(", ")} +${extra} more`
      : `${sourceFiles.length} files — ${names.join(", ")}`;
  }, [sourceFiles]);

  function addFiles(incoming: FileList | File[]) {
    const allowed = pickAllowedFiles(incoming);
    if (allowed.length === 0) {
      onError("No Excel, CSV, ZIP, or RAR files found in that selection.");
      return;
    }
    setSourceFiles((prev) => mergeFiles(prev, allowed));
  }

  async function pollJob(id: string): Promise<SynthesisJobStatus> {
    let failures = 0;
    for (;;) {
      try {
        const status = await client.getSynthesisJob(id);
        setJobStatus(status);
        failures = 0;
        if (status.status === "completed" || status.status === "failed") {
          return status;
        }
      } catch (e) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          throw e;
        }
      }
      await sleep(POLL_MS);
    }
  }

  async function handleStart() {
    if (sourceFiles.length === 0) {
      onError("Select at least one Excel file, folder, ZIP, or RAR.");
      return;
    }
    setRunning(true);
    setJobStatus(null);
    setJobId(null);
    try {
      const start = await client.startDataSynthesis(sourceFiles);
      setJobId(start.job_id);
      const finalStatus = await pollJob(start.job_id);
      if (finalStatus.status === "failed") {
        onError(finalStatus.error || "Could not clean the file. Try again.");
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not clean the file. Try again.");
    } finally {
      setRunning(false);
    }
  }

  function handleDownload() {
    if (!jobId || jobStatus?.status !== "completed") return;
    window.open(client.synthesisDownloadUrl(jobId), "_blank", "noopener,noreferrer");
  }

  function clearSelection() {
    setSourceFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }

  async function handleRunComparison() {
    if (!enrichmentFile) {
      onError("Please select an enriched Excel (.xlsx) or CSV file first.");
      return;
    }
    setAnalyzing(true);
    setReport(null);
    setMergeResult(null);
    try {
      const uId = userFilter ? Number(userFilter) : undefined;
      const res = await client.compareEnrichmentFile(enrichmentFile, uId, tableSource);
      setReport(res);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Comparison analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleExecuteSafeMerge() {
    if (!enrichmentFile) {
      onError("Please select an enriched Excel (.xlsx) or CSV file first.");
      return;
    }
    if (!safeFillMode) {
      if (!window.confirm("Safe Fill Mode is unchecked! Do you want to continue with safe merge?")) {
        return;
      }
    }
    setMerging(true);
    setMergeResult(null);
    try {
      const uId = userFilter ? Number(userFilter) : undefined;
      const res = await client.safeMergeEnrichmentFile(enrichmentFile, uId, tableSource);
      setMergeResult(res);
      // Refresh comparison report after merge
      void handleRunComparison();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Safe merge failed");
    } finally {
      setMerging(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
            <span aria-hidden>🧩</span>
            Smart Data Clean & Merge
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Clean raw Excel/CSV files or run read-only AI enrichment comparison reports for Usman & Asim’s contacts.
          </p>
        </div>

        {/* Mode Selector */}
        <div className="flex items-center rounded-lg bg-slate-950 p-1 border border-slate-800 gap-1">
          <button
            type="button"
            onClick={() => setMode("enrichment")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
              mode === "enrichment"
                ? "bg-cyan-600 text-white shadow-md font-semibold"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>🔍 AI Enrichment Comparison & Safe Merge</span>
          </button>

          <button
            type="button"
            onClick={() => setMode("clean")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
              mode === "clean"
                ? "bg-violet-600 text-white shadow-md font-semibold"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>🧩 Clean Raw Files</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setMode("missing_report");
              void fetchMissingReport();
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
              mode === "missing_report"
                ? "bg-amber-600 text-white shadow-md font-semibold"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>📊 Missing Data Report</span>
          </button>
        </div>
      </div>

      {mode === "missing_report" ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <span>📊</span>
                Column-Wise Missing Data Inspector
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Select a search source section, user rep scope, and single column to calculate exact missing row counts and inspect row references.
              </p>
            </div>

            {/* Step 1 & Scope Selectors */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Step 1: Search Source */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider flex items-center gap-1">
                  <span className="w-4 h-4 rounded-full bg-amber-500/20 text-amber-400 text-[10px] flex items-center justify-center font-bold">1</span>
                  Select Search Source Section:
                </label>
                <select
                  value={missingSection}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMissingSection(val);
                    void fetchMissingReport(val, missingColumnKey, missingUserId);
                  }}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="master">{masterLabel}</option>
                  <option value="old_clients">Old Clients</option>
                  <option value="new_search_lead">New Search Lead</option>
                  <option value="khalid_focused">Khalid Focused Sales</option>
                  <option value="all">All Combined Sections</option>
                </select>
              </div>

              {/* Rep Scope Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider flex items-center gap-1">
                  <span className="w-4 h-4 rounded-full bg-cyan-500/20 text-cyan-400 text-[10px] flex items-center justify-center font-bold">👤</span>
                  Assigned User / Rep Scope:
                </label>
                <select
                  value={missingUserId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMissingUserId(val);
                    void fetchMissingReport(missingSection, missingColumnKey, val);
                  }}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="">All Users (Entire Table Scope)</option>
                  {assignees.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name || u.username} ({u.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Step 2: Single Column Selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider flex items-center gap-1">
                <span className="w-4 h-4 rounded-full bg-amber-500/20 text-amber-400 text-[10px] flex items-center justify-center font-bold">2</span>
                Select Column to Check Missing Data (Only 1 Column Selected at a Time):
              </label>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {(missingReportData?.available_columns || [
                  { key: "contact_name", label: "Contact Person / Name" },
                  { key: "designation", label: "Designation / Title" },
                  { key: "phone", label: "Primary Phone Number" },
                  { key: "secondary_phone", label: "Secondary Phone / Mobile" },
                  { key: "email", label: "Primary Email Address" },
                  { key: "secondary_email", label: "Secondary Email Address" },
                  { key: "website_url", label: "Website URL" },
                  { key: "country", label: "Country" },
                  { key: "city", label: "City" },
                  { key: "address", label: "Address" },
                  { key: "company_grading", label: "Company Grading" },
                  { key: "product_interest", label: "Product / Remarks" },
                ]).map((col) => {
                  const isSelected = missingColumnKey === col.key;
                  return (
                    <button
                      key={col.key}
                      type="button"
                      onClick={() => {
                        setMissingColumnKey(col.key);
                        void fetchMissingReport(missingSection, col.key, missingUserId);
                      }}
                      className={`px-3 py-2 text-xs font-medium rounded-lg border text-left transition-all flex items-center justify-between gap-1.5 ${
                        isSelected
                          ? "bg-amber-500/20 border-amber-500 text-amber-300 shadow-sm font-semibold ring-1 ring-amber-500"
                          : "bg-slate-950/70 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                      }`}
                    >
                      <span className="truncate">{col.label}</span>
                      {isSelected && <span className="text-amber-400 font-bold text-xs">✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Report Metrics Dashboard */}
          {loadingMissingReport ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
              <div className="inline-block animate-spin text-2xl mb-2">⏳</div>
              <p className="text-sm font-medium">Analyzing database contacts for missing {missingColumnKey}...</p>
            </div>
          ) : missingReportData ? (
            <div className="space-y-6">
              {/* KPI Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-xs font-medium text-slate-400">Total Contacts Analyzed</p>
                  <p className="text-2xl font-bold text-slate-100 mt-1 tabular-nums">
                    {missingReportData.total_contacts.toLocaleString()}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1">{missingReportData.section_label}</p>
                </div>

                <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4">
                  <p className="text-xs font-medium text-amber-400">Missing {missingReportData.column_label}</p>
                  <p className="text-2xl font-bold text-amber-300 mt-1 tabular-nums">
                    {missingReportData.missing_count.toLocaleString()}
                  </p>
                  <p className="text-[11px] text-amber-400/80 mt-1 font-semibold">
                    {missingReportData.missing_percentage}% Missing Rate
                  </p>
                </div>

                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4">
                  <p className="text-xs font-medium text-emerald-400">Populated / Filled</p>
                  <p className="text-2xl font-bold text-emerald-300 mt-1 tabular-nums">
                    {missingReportData.populated_count.toLocaleString()}
                  </p>
                  <p className="text-[11px] text-emerald-400/80 mt-1">
                    {(100 - missingReportData.missing_percentage).toFixed(2)}% Complete
                  </p>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-xs font-medium text-slate-400">Target Rep Scope</p>
                  <p className="text-sm font-semibold text-cyan-300 mt-1 truncate">
                    {missingReportData.user_name}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1 truncate">{missingReportData.column_label}</p>
                </div>
              </div>

              {/* Missing Rows Table Header & Export */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                      <span>📋</span>
                      Details of Rows Missing <span className="text-amber-400">{missingReportData.column_label}</span>
                    </h4>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Showing exact row references ({missingReportData.missing_count} rows) in {missingReportData.section_label} ({missingReportData.user_name}).
                    </p>
                  </div>

                  {missingReportData.missing_count > 0 && (
                    <button
                      type="button"
                      onClick={() => downloadMissingRowsCsv(missingReportData)}
                      className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition-all flex items-center gap-1.5"
                    >
                      <span>📥</span>
                      <span>Export {missingReportData.missing_count} Missing Rows (CSV/Excel)</span>
                    </button>
                  )}
                </div>

                {/* Missing Rows Grid */}
                {missingReportData.missing_rows.length === 0 ? (
                  <div className="py-8 text-center space-y-2">
                    <span className="text-3xl">🎉</span>
                    <p className="text-sm font-semibold text-emerald-400">
                      Zero missing rows! 100% of contacts in this section have populated {missingReportData.column_label}.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-lg border border-slate-800">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950 text-slate-300 sticky top-0 border-b border-slate-800 font-semibold">
                        <tr>
                          <th className="px-3 py-2.5 w-16">Row ID</th>
                          <th className="px-3 py-2.5">Company Name</th>
                          <th className="px-3 py-2.5">Assigned To</th>
                          <th className="px-3 py-2.5">Grading</th>
                          <th className="px-3 py-2.5">Country / City</th>
                          <th className="px-3 py-2.5">Missing Column</th>
                          <th className="px-3 py-2.5">Website</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 bg-slate-900/40 text-slate-300">
                        {missingReportData.missing_rows.map((r) => (
                          <tr key={r.id} className="hover:bg-slate-800/40 transition-colors">
                            <td className="px-3 py-2 font-mono text-slate-400">{r.legacy_serial_no || r.id}</td>
                            <td className="px-3 py-2 font-medium text-slate-100">{r.company_name}</td>
                            <td className="px-3 py-2 text-cyan-400">{r.assigned_to}</td>
                            <td className="px-3 py-2">
                              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]">
                                {r.company_grading}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-slate-400">
                              {r.country} {r.city !== "-" ? `(${r.city})` : ""}
                            </td>
                            <td className="px-3 py-2">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                <span>⚠️</span> MISSING {r.missing_column_label}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-slate-400 truncate max-w-[150px]">{r.website_url}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : mode === "clean" ? (
        <div className="space-y-6 max-w-xl">
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-3">
            <p className="text-sm font-medium text-slate-200">
              Select 1 or more excel file(s), a folder, or ZIP/RAR (50+ files OK).
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              multiple
              disabled={running}
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              accept={ACCEPT}
              multiple
              disabled={running}
              className="hidden"
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={running}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              >
                Choose files
              </button>
              <button
                type="button"
                disabled={running}
                onClick={() => folderInputRef.current?.click()}
                className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
              >
                Choose folder
              </button>
              {sourceFiles.length > 0 && !running && (
                <button
                  type="button"
                  onClick={clearSelection}
                  className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-slate-200"
                >
                  Clear
                </button>
              )}
            </div>

            {sourceSummary && <p className="text-xs text-slate-500">{sourceSummary}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={running || sourceFiles.length === 0}
              onClick={() => void handleStart()}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {running ? "Please wait…" : "Start"}
            </button>
            {jobStatus?.status === "completed" && jobId && (
              <button
                type="button"
                onClick={handleDownload}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/20"
              >
                Download Excel file
              </button>
            )}
          </div>

          {jobStatus && <ProgressPanel status={jobStatus} />}
        </div>
      ) : (
        /* AI ENRICHMENT COMPARISON REPORT & SAFE MERGE VIEW */
        <div className="space-y-6">
          <div className="rounded-xl border border-cyan-800/40 bg-slate-900/60 p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <span>🔍 AI Enrichment Comparison Report & Safe Merge</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Upload ChatGPT, Claude, Gemini or Meta AI enriched files for Usman (795 contacts) or Asim (1400+ contacts).
                </p>
              </div>
            </div>

            {/* Target Selectors */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                  Assigned User / Rep Scope:
                </label>
                <select
                  value={userFilter}
                  onChange={(e) => setUserFilter(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 font-medium"
                >
                  <option value="">All Users (Entire Table Scope)</option>
                  {assignees.map((u) => (
                    <option key={u.id} value={u.id}>
                      👤 {u.full_name || u.username} {u.username.toLowerCase().includes("usman") ? "(795 Contacts)" : u.username.toLowerCase().includes("asim") ? "(1400+ Contacts)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                  Target Database Table:
                </label>
                <select
                  value={tableSource}
                  onChange={(e) => setTableSource(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 font-medium"
                >
                  <option value="master_table">{masterLabel}</option>
                  <option value="old_clients">Old Clients</option>
                </select>
              </div>
            </div>

            {/* Upload File Input */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                Upload Enriched File (.xlsx, .csv):
              </label>
              <input
                ref={enrichmentFileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,.xlsm"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) setEnrichmentFile(e.target.files[0]);
                }}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => enrichmentFileInputRef.current?.click()}
                  className="rounded-lg border border-cyan-600/50 bg-cyan-950/40 hover:bg-cyan-900/50 px-4 py-2 text-sm font-medium text-cyan-200 transition-all flex items-center gap-2"
                >
                  <span>📁 Choose Enriched File</span>
                </button>
                <span className="text-sm font-mono text-slate-300">
                  {enrichmentFile ? enrichmentFile.name : "No file selected"}
                </span>
              </div>
            </div>

            {/* Safe Fill Mode Checkbox */}
            <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-3 flex items-start gap-3">
              <input
                id="safeFillCheck"
                type="checkbox"
                checked={safeFillMode}
                onChange={(e) => setSafeFillMode(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-amber-600 bg-slate-950 text-amber-500 focus:ring-amber-500"
              />
              <label htmlFor="safeFillCheck" className="text-xs text-amber-200/90 leading-relaxed">
                <strong className="text-amber-300 font-semibold uppercase">✓ Safe Fill Mode Enabled:</strong> Only populates missing/blank fields in Sales Agent database. Existing non-empty data is <span className="underline decoration-amber-400">100% protected and NEVER replaced or overwritten</span>.
              </label>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                disabled={analyzing || !enrichmentFile}
                onClick={() => void handleRunComparison()}
                className="rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-all flex items-center gap-2"
              >
                <span>{analyzing ? "Analyzing Gap Report…" : "🔍 Run Read-Only Comparison Report"}</span>
              </button>

              <button
                type="button"
                disabled={merging || !enrichmentFile}
                onClick={() => void handleExecuteSafeMerge()}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-all flex items-center gap-2"
              >
                <span>{merging ? "Safely Merging…" : "🚀 Apply Safe Merge to Sales Agent"}</span>
              </button>
            </div>
          </div>

          {/* Merge Result Banner */}
          {mergeResult && (
            <div className="rounded-xl border border-emerald-500/50 bg-emerald-950/40 p-4 space-y-1">
              <h4 className="text-sm font-bold text-emerald-200 flex items-center gap-2">
                <span>🎉 Safe Merge Complete!</span>
              </h4>
              <p className="text-sm text-emerald-100">{mergeResult.message}</p>
            </div>
          )}

          {/* Read-Only Comparison Report Results */}
          {report && (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-xs text-slate-400 uppercase font-medium">Scope Contacts</p>
                  <p className="text-2xl font-bold text-slate-100 tabular-nums mt-1">{report.db_total_contacts}</p>
                  <p className="text-[11px] text-slate-500 mt-1">{report.user_name}</p>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-xs text-slate-400 uppercase font-medium">Uploaded File Rows</p>
                  <p className="text-2xl font-bold text-slate-100 tabular-nums mt-1">{report.uploaded_file_contacts}</p>
                  <p className="text-[11px] text-slate-500 mt-1">{report.filename}</p>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <p className="text-xs text-slate-400 uppercase font-medium">Matched Contacts</p>
                  <p className="text-2xl font-bold text-emerald-400 tabular-nums mt-1">{report.matched_contacts_count}</p>
                  <p className="text-[11px] text-emerald-500/80 mt-1">Matched by Company/Email/Phone</p>
                </div>

                <div className="rounded-xl border border-cyan-700/50 bg-cyan-950/40 p-4">
                  <p className="text-xs text-cyan-300 uppercase font-semibold">New Missing Fields Found</p>
                  <p className="text-2xl font-bold text-cyan-200 tabular-nums mt-1">+{report.total_potential_new_fills}</p>
                  <p className="text-[11px] text-cyan-400 mt-1">Ready to safely populate</p>
                </div>
              </div>

              {/* Sample Field Fills Preview */}
              {report.sample_fills.length > 0 && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Sample Missing Fields Discovered (Ready to Fill):
                  </h4>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {report.sample_fills.map((s, idx) => (
                      <div key={idx} className="rounded-lg border border-slate-800 bg-slate-950 p-2.5 text-xs space-y-1">
                        <p className="font-semibold text-slate-200 truncate">{s.company_name}</p>
                        <p className="text-slate-400">
                          <span className="text-cyan-400 font-medium">{s.field_name}:</span>{" "}
                          <span className="text-emerald-300 font-mono">{s.new_value}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Column-by-Column Analysis Table */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
                  Column-by-Column Field Fill Analysis Report:
                </h4>
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-sm text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950 text-xs uppercase text-slate-400">
                        <th className="px-4 py-3 font-semibold">Database Field</th>
                        <th className="px-4 py-3 font-semibold text-center">Current DB Populated</th>
                        <th className="px-4 py-3 font-semibold text-center">Current DB Missing</th>
                        <th className="px-4 py-3 font-semibold text-center">Enriched File Populated</th>
                        <th className="px-4 py-3 font-semibold text-center text-cyan-300 bg-cyan-950/40">New Fill Potential</th>
                        <th className="px-4 py-3 font-semibold text-center text-amber-300 bg-amber-950/20">Protected Existing DB Values</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80 bg-slate-900/30">
                      {report.column_analysis.map((col) => (
                        <tr key={col.field_key} className="hover:bg-slate-800/30">
                          <td className="px-4 py-2.5 font-medium text-slate-100">
                            {col.field_label}
                          </td>
                          <td className="px-4 py-2.5 text-center text-slate-300 tabular-nums">
                            {col.db_populated_count}
                          </td>
                          <td className="px-4 py-2.5 text-center text-slate-400 tabular-nums">
                            {col.db_missing_count}
                          </td>
                          <td className="px-4 py-2.5 text-center text-slate-300 tabular-nums">
                            {col.file_populated_count}
                          </td>
                          <td className="px-4 py-2.5 text-center font-bold text-cyan-300 bg-cyan-950/20 tabular-nums">
                            {col.new_fill_count > 0 ? `+${col.new_fill_count}` : "0"}
                          </td>
                          <td className="px-4 py-2.5 text-center text-amber-300/90 font-mono bg-amber-950/10 tabular-nums">
                            {col.protected_count} preserved
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
