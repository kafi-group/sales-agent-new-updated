import { useMemo, useState } from "react";
import { client, type DiscoveryCandidate, type ImportJobStatus } from "../api/client";

// Import saves rows as-is (no per-row scraping). Large selections are split into
// small background jobs so a proxy/DB blip mid-way does not strand half the sheet
// (e.g. interrupted at ~130/284 left only ~100 rows after the last commit).
const MAX_CSV_IMPORT = 20000;
/** Rows per backend job — keep small enough for Railway/proxy + DB lock windows. */
const IMPORT_BATCH_SIZE = 40;
const IMPORT_PREVIEW_ROWS = 50;
const IMPORT_FILE_ACCEPT = ".csv,.xlsx,.xls,.xlsm,.tsv";
const JOB_POLL_INTERVAL_MS = 800;
const MAX_POLL_FAILURES = 12;
const BATCH_PAUSE_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

interface LeadsTableCsvImportProps {
  onClose: () => void;
  onImported: () => void;
  onError: (message: string) => void;
  /** Stored on buyer.source — use "old_clients" for the Old clients section. */
  importSource?: string;
  /** UI label for the destination table (e.g. "Clients" for sales users). */
  tableLabel?: string;
  title?: string;
  description?: string;
}

interface ImportRowResult {
  candidate_id: string;
  company_name: string;
  status: "success" | "failed" | "skipped" | "invalid";
  error?: string;
}

function isFound(value: string | null | undefined): value is string {
  return Boolean(value && value !== "Not found");
}

function displayOrDash(value: string | null | undefined): string {
  if (!value || value === "Not found") return "—";
  return value;
}

function candidateToImportPayload(candidate: DiscoveryCandidate, importSource: string) {
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
    legacy_serial_no: candidate.legacy_serial_no ?? undefined,
    company_grading: candidate.company_grading ?? undefined,
    designation: candidate.designation ?? undefined,
    secondary_mobile: candidate.secondary_mobile ?? undefined,
    primary_phone: candidate.primary_phone ?? undefined,
    secondary_phone: candidate.secondary_phone ?? undefined,
    secondary_email: candidate.secondary_email ?? undefined,
    product_interest: candidate.product_interest ?? undefined,
    city: candidate.city ?? undefined,
    address: candidate.address ?? undefined,
    remarks: candidate.remarks ?? undefined,
    source: importSource,
  };
}

function mappingLooksBroken(candidates: DiscoveryCandidate[]): boolean {
  if (candidates.length === 0) return false;
  const sample = candidates.slice(0, 5);
  const hasCompany = sample.some((row) => row.company_name?.trim());
  if (!hasCompany) return false;
  const hasMappedDetail = sample.some(
    (row) =>
      row.industry ||
      row.company_grading ||
      row.legacy_serial_no != null ||
      isFound(row.phone) ||
      row.primary_phone ||
      isFound(row.email) ||
      row.product_interest ||
      row.remarks,
  );
  return !hasMappedDetail;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sourceDisplayName(source: string, tableLabel?: string): string {
  if (tableLabel) return tableLabel;
  if (source === "old_clients") return "Old clients";
  return source.replace(/_/g, " ");
}

function ImportProgressPanel({
  status,
  sourceLabel,
  tableLabel,
  batchInfo,
}: {
  status: ImportJobStatus;
  sourceLabel: string;
  tableLabel?: string;
  batchInfo?: { current: number; total: number } | null;
}) {
  const done = status.status === "completed";
  const settling = status.status === "committing" || status.status === "verifying";
  const percent = done
    ? 100
    : status.total > 0
      ? Math.min(99, Math.floor((status.processed / status.total) * 100))
      : 0;
  const tableName = sourceDisplayName(status.import_source ?? sourceLabel, tableLabel);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-100">
          {done
            ? `Import complete — saved to ${tableName}`
            : batchInfo && batchInfo.total > 1
              ? `Batch ${batchInfo.current} of ${batchInfo.total} — ${status.phase_label}`
              : status.phase_label}
        </p>
        <span className="text-xs tabular-nums text-slate-400">
          {percent}% · {formatElapsed(status.elapsed_seconds)}
        </span>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            done
              ? "bg-emerald-500"
              : settling
                ? "bg-violet-500 animate-pulse"
                : "bg-gradient-to-r from-violet-600 to-emerald-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
        <span className="text-slate-300">
          {Math.min(status.processed, status.total)} / {status.total} rows
        </span>
        <span className="text-emerald-300">{status.created_count} added</span>
        {status.replaced_count > 0 && (
          <span className="text-violet-300">{status.replaced_count} replaced</span>
        )}
        {status.skipped_count > 0 && (
          <span className="text-amber-300">{status.skipped_count} skipped</span>
        )}
      </div>

      {!done && !settling && status.current_company && (
        <p className="text-xs text-slate-500 truncate">
          Processing: <span className="text-slate-300">{status.current_company}</span>
        </p>
      )}
      {settling && (
        <p className="text-xs text-slate-500">
          {status.status === "committing"
            ? "Batch processed — writing rows to the database…"
            : `Counting rows in the ${tableName} table to confirm the import landed…`}
        </p>
      )}
      {done && status.verified_source_total != null && (
        <p className="text-xs text-emerald-300/90">
          Verified in database — the {tableName} table now holds{" "}
          <strong>{status.verified_source_total.toLocaleString()}</strong> leads
          {status.created_count > 0 ? ` (+${status.created_count.toLocaleString()} from this import)` : ""}.
        </p>
      )}
    </div>
  );
}

export function LeadsTableCsvImport({
  onClose,
  onImported,
  onError,
  importSource = "old_clients",
  tableLabel,
  title = "Import leads",
  description = "Upload CSV or Excel (.xlsx). Columns are mapped to the leads table. Import only saves rows as-is — research and score later from the table.",
}: LeadsTableCsvImportProps) {
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobStatus, setJobStatus] = useState<ImportJobStatus | null>(null);
  const [batchInfo, setBatchInfo] = useState<{ current: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportRowResult[] | null>(null);

  const importable = useMemo(() => candidates, [candidates]);
  const previewCandidates = useMemo(
    () => candidates.slice(0, IMPORT_PREVIEW_ROWS),
    [candidates],
  );

  async function handleFileUpload(file: File) {
    setParsing(true);
    setMessages([]);
    setResults(null);
    setJobStatus(null);
    try {
      const result = await client.discoverLeadsFromCsv(file, undefined, true, importSource);
      setCandidates(result.candidates);
      setMessages(result.messages);

      if (result.import_parser && result.import_parser !== "old_clients_v2") {
        onError(
          `Backend import parser is outdated (${result.import_parser}). Stop old API servers and run only one backend on port 8001.`,
        );
      } else if (mappingLooksBroken(result.candidates)) {
        onError(
          "Spreadsheet columns were not mapped. Your UI is likely talking to an old backend. Stop extra processes, keep only port 8001 running, then restart the frontend and upload again.",
        );
      }

      const allIds = result.candidates.map((candidate) => candidate.candidate_id);
      setSelected(new Set(allIds.slice(0, MAX_CSV_IMPORT)));
      if (allIds.length > MAX_CSV_IMPORT) {
        setMessages((prev) => [
          ...prev,
          `Only the first ${MAX_CSV_IMPORT} rows can be imported per batch.`,
        ]);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "File import failed");
    } finally {
      setParsing(false);
    }
  }

  function toggleAll(checked: boolean) {
    if (checked) {
      setSelected(new Set(importable.slice(0, MAX_CSV_IMPORT).map((c) => c.candidate_id)));
    } else {
      setSelected(new Set());
    }
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        if (next.size >= MAX_CSV_IMPORT) return prev;
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function handleImport() {
    const toImport = candidates.filter((candidate) => selected.has(candidate.candidate_id));
    if (toImport.length === 0) {
      onError("Select at least one row to import");
      return;
    }
    if (toImport.length > MAX_CSV_IMPORT) {
      onError(`Import at most ${MAX_CSV_IMPORT} leads per batch`);
      return;
    }

    const batches = chunkArray(toImport, IMPORT_BATCH_SIZE);
    const batchNote =
      batches.length > 1
        ? `\n• Upload runs in ${batches.length} batches of up to ${IMPORT_BATCH_SIZE} rows (safer for large sheets).`
        : "";

    const confirmed = window.confirm(
      `Import ${toImport.length} lead${toImport.length === 1 ? "" : "s"} as-is?\n\n` +
        `• Spreadsheet rows are copied exactly (including blank/sparse fields).\n` +
        `• Same company name is allowed many times (e.g. Al Jaleel × several people).\n` +
        `• Only true contact duplicates are skipped (same person+email or same person+phone).\n` +
        `• Use Research & score later to enrich missing details.` +
        batchNote +
        `\n\nContinue?`,
    );
    if (!confirmed) return;

    setImporting(true);
    setResults(null);
    setJobStatus(null);
    setBatchInfo(batches.length > 1 ? { current: 1, total: batches.length } : null);

    const startedAt = Date.now();
    let overallCreated = 0;
    let overallSkipped = 0;
    let overallReplaced = 0;
    let lastVerifiedTotal: number | null = null;
    const allSkipped: Array<{ company_name: string; reason: string }> = [];
    const allCreatedNames = new Set<string>();
    const skipReasonCounts: Record<string, number> = {};
    let failedBatchError: string | null = null;

    const publishProgress = (
      baseProcessed: number,
      batchStatus: ImportJobStatus | null,
      batchIndex: number,
      complete: boolean,
    ) => {
      const batchProcessed = batchStatus
        ? Math.min(batchStatus.processed, batchStatus.total)
        : 0;
      const processed = complete
        ? toImport.length
        : Math.min(toImport.length, baseProcessed + batchProcessed);
      setJobStatus({
        job_id: batchStatus?.job_id ?? "batched-import",
        status: complete
          ? "completed"
          : batchStatus?.status === "committing" || batchStatus?.status === "verifying"
            ? batchStatus.status
            : "running",
        total: toImport.length,
        processed,
        created_count: overallCreated + (batchStatus?.created_count ?? 0),
        skipped_count: overallSkipped + (batchStatus?.skipped_count ?? 0),
        replaced_count: overallReplaced + (batchStatus?.replaced_count ?? 0),
        current_company: batchStatus?.current_company ?? null,
        error: null,
        import_source: batchStatus?.import_source ?? importSource,
        verified_source_total: lastVerifiedTotal,
        created: null,
        skipped: null,
        replaced: null,
        skip_reason_counts: null,
        phase_label: complete
          ? "Import complete"
          : batchStatus?.phase_label ||
            (batches.length > 1
              ? `Saving batch ${batchIndex + 1} of ${batches.length}…`
              : "Saving leads into the table…"),
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      });
    };

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const baseProcessed = batchIndex * IMPORT_BATCH_SIZE;
      setBatchInfo(
        batches.length > 1 ? { current: batchIndex + 1, total: batches.length } : null,
      );
      publishProgress(baseProcessed, null, batchIndex, false);

      let jobId: string;
      try {
        const job = await client.startLeadsImportJob({
          candidates: batch.map((candidate) =>
            candidateToImportPayload(candidate, importSource),
          ),
          auto_onboard: false,
          replace_duplicates: true,
          skip_enrichment: true,
        });
        jobId = job.job_id;
      } catch (e) {
        failedBatchError =
          e instanceof Error
            ? e.message
            : `Could not start import batch ${batchIndex + 1}`;
        await sleep(BATCH_PAUSE_MS);
        continue;
      }

      let finalStatus: ImportJobStatus | null = null;
      let pollFailures = 0;
      while (finalStatus === null) {
        await sleep(JOB_POLL_INTERVAL_MS);
        try {
          const status = await client.getLeadsImportJob(jobId);
          pollFailures = 0;
          publishProgress(baseProcessed, status, batchIndex, false);
          if (status.status === "completed" || status.status === "failed") {
            finalStatus = status;
          }
        } catch {
          pollFailures += 1;
          if (pollFailures >= MAX_POLL_FAILURES) {
            failedBatchError =
              `Lost connection during batch ${batchIndex + 1} of ${batches.length}. ` +
              `${overallCreated} lead(s) from earlier batches were saved — refresh the table, then re-import the rest.`;
            break;
          }
        }
      }

      if (!finalStatus) {
        // Connection lost — keep going with remaining batches; duplicates will skip.
        failedBatchError =
          (failedBatchError ? `${failedBatchError} ` : "") +
          `Batch ${batchIndex + 1} may be incomplete; continuing with the next batch…`;
        await sleep(BATCH_PAUSE_MS);
        continue;
      }

      if (finalStatus.status === "failed") {
        overallCreated += finalStatus.created_count ?? 0;
        overallSkipped += finalStatus.skipped_count ?? 0;
        overallReplaced += finalStatus.replaced_count ?? 0;
        if (finalStatus.verified_source_total != null) {
          lastVerifiedTotal = finalStatus.verified_source_total;
        }
        for (const row of finalStatus.created ?? []) {
          allCreatedNames.add(row.company_name.trim().toLowerCase());
        }
        for (const item of finalStatus.skipped ?? []) {
          allSkipped.push(item);
          skipReasonCounts[item.reason] = (skipReasonCounts[item.reason] ?? 0) + 1;
        }
        // Partial batch failure: keep importing later batches (re-run skips dupes).
        failedBatchError =
          finalStatus.error ||
          `Batch ${batchIndex + 1} of ${batches.length} had errors; continuing…`;
        publishProgress(
          baseProcessed + batch.length,
          {
            ...finalStatus,
            created_count: 0,
            skipped_count: 0,
            replaced_count: 0,
          },
          batchIndex,
          false,
        );
        if (batchIndex < batches.length - 1) {
          await sleep(BATCH_PAUSE_MS);
        }
        continue;
      }

      overallCreated += finalStatus.created_count ?? 0;
      overallSkipped += finalStatus.skipped_count ?? 0;
      overallReplaced += finalStatus.replaced_count ?? 0;
      if (finalStatus.verified_source_total != null) {
        lastVerifiedTotal = finalStatus.verified_source_total;
      }
      for (const row of finalStatus.created ?? []) {
        allCreatedNames.add(row.company_name.trim().toLowerCase());
      }
      for (const item of finalStatus.skipped ?? []) {
        allSkipped.push(item);
        skipReasonCounts[item.reason] = (skipReasonCounts[item.reason] ?? 0) + 1;
      }
      // Counts on the last completed batch are already folded into overall*;
      // clear batch deltas before the next publish so we don't double-count.
      publishProgress(
        baseProcessed + batch.length,
        {
          ...finalStatus,
          created_count: 0,
          skipped_count: 0,
          replaced_count: 0,
        },
        batchIndex,
        batchIndex === batches.length - 1,
      );

      if (batchIndex < batches.length - 1) {
        await sleep(BATCH_PAUSE_MS);
      }
    }

    // Warn if any batch had issues, but still show results when something landed.
    if (failedBatchError && overallCreated === 0 && allCreatedNames.size === 0) {
      onError(failedBatchError);
      setImporting(false);
      return;
    }
    if (failedBatchError) {
      onError(
        `${failedBatchError} Saved ${overallCreated} new lead(s) so far. ` +
          `Re-import the same file to fill any remaining rows (duplicates skip).`,
      );
    }

    publishProgress(toImport.length, null, batches.length - 1, true);
    setJobStatus((prev) =>
      prev
        ? {
            ...prev,
            status: "completed",
            processed: toImport.length,
            created_count: overallCreated,
            skipped_count: overallSkipped,
            replaced_count: overallReplaced,
            verified_source_total: lastVerifiedTotal,
            skip_reason_counts: skipReasonCounts,
            phase_label: "Import complete",
            current_company: null,
            elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
          }
        : prev,
    );

    const skippedByName = new Map(
      allSkipped.map((item) => [item.company_name.toLowerCase(), item.reason]),
    );

    const rowResults: ImportRowResult[] = [];
    for (const candidate of toImport) {
      const key = candidate.company_name.trim().toLowerCase();
      if (allCreatedNames.has(key)) {
        rowResults.push({
          candidate_id: candidate.candidate_id,
          company_name: candidate.company_name,
          status: "success",
        });
        continue;
      }
      const reason = skippedByName.get(key) ?? "Skipped";
      rowResults.push({
        candidate_id: candidate.candidate_id,
        company_name: candidate.company_name,
        status: "skipped",
        error: reason,
      });
    }

    setImporting(false);
    setBatchInfo(null);
    setResults(rowResults);
    setCandidates((prev) =>
      prev.map((candidate) =>
        rowResults.some(
          (result) =>
            result.candidate_id === candidate.candidate_id && result.status === "success",
        )
          ? { ...candidate, already_exists: true }
          : candidate,
      ),
    );
    setSelected(new Set());
    onImported();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60">
      <div className="w-full sm:max-w-6xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-xl border border-slate-700 bg-slate-900 shadow-xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-800 bg-slate-900 px-5 py-4">
          <div>
            <h3 className="text-base font-medium text-slate-100">{title}</h3>
            <p className="text-xs text-slate-500 mt-1">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            className="text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium cursor-pointer disabled:opacity-50">
              {parsing ? "Reading file…" : "Choose file"}
              <input
                type="file"
                accept={IMPORT_FILE_ACCEPT}
                className="hidden"
                disabled={parsing || importing}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileUpload(file);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="text-xs text-slate-500">
              Up to {MAX_CSV_IMPORT} rows · auto-batched in groups of {IMPORT_BATCH_SIZE} · live
              progress
            </span>
          </div>

          {parsing && (
            <p className="text-xs text-slate-300 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2">
              Reading and mapping columns from your file…
            </p>
          )}

          {messages.length > 0 && (
            <div className="text-xs text-slate-500 space-y-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
              {messages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          )}

          {jobStatus && (importing || jobStatus.status === "completed") && (
            <ImportProgressPanel
              status={jobStatus}
              sourceLabel={importSource}
              tableLabel={tableLabel}
              batchInfo={batchInfo}
            />
          )}

          {results && results.length > 0 && (
            <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 space-y-2">
              <p className="text-sm text-slate-200">
                Import complete — {results.filter((r) => r.status === "success").length} added,{" "}
                {results.filter((r) => r.status === "failed").length} failed,{" "}
                {results.filter((r) => r.status === "skipped").length} skipped
                {jobStatus?.verified_source_total != null
                  ? ` · table now holds ${jobStatus.verified_source_total} row(s) with this source`
                  : ""}
              </p>
              {jobStatus?.skip_reason_counts &&
                Object.keys(jobStatus.skip_reason_counts).length > 0 && (
                  <div className="text-xs text-amber-200/90 space-y-0.5 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
                    <p className="font-medium text-amber-100">Skip reasons</p>
                    {Object.entries(jobStatus.skip_reason_counts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, count]) => (
                        <p key={reason}>
                          {count}× {reason}
                        </p>
                      ))}
                  </div>
                )}
              <ul className="max-h-32 overflow-y-auto space-y-1 text-xs">
                {results.map((result) => (
                  <li key={result.candidate_id} className="flex items-center gap-2 text-slate-400">
                    <span
                      className={`px-2 py-0.5 rounded text-xs border ${
                        result.status === "success"
                          ? "border-emerald-500/30 text-emerald-300"
                          : result.status === "invalid"
                            ? "border-amber-500/30 text-amber-300"
                            : "border-red-500/30 text-red-300"
                      }`}
                    >
                      {result.status === "success"
                        ? "Added"
                        : result.status === "invalid"
                          ? "Not valid"
                          : result.status === "skipped"
                            ? "Skipped"
                            : "Failed"}
                    </span>
                    <span className="text-slate-300 truncate">{result.company_name}</span>
                    {result.error && <span className="text-red-400 truncate">{result.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {candidates.length > 0 && (
            <>
              <p className="text-xs text-slate-500">
                {candidates.length} row{candidates.length === 1 ? "" : "s"} loaded
                {candidates.length > IMPORT_PREVIEW_ROWS
                  ? ` · showing first ${IMPORT_PREVIEW_ROWS} in preview (all selected rows still import)`
                  : ""}
                {" · "}
                {selected.size} selected
              </p>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full min-w-[1600px] text-sm">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-slate-800 bg-slate-950">
                      <th className="py-2 px-3 w-10">
                        <input
                          type="checkbox"
                          checked={
                            importable.length > 0 &&
                            selected.size === Math.min(importable.length, MAX_CSV_IMPORT)
                          }
                          onChange={(e) => toggleAll(e.target.checked)}
                          disabled={importing}
                          aria-label="Select all"
                        />
                      </th>
                      <th className="py-2 pr-3 whitespace-nowrap">S. No</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Company Name</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Business Type</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Grading</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Designation</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Contact Person</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Primary Mobile</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Secondary Mobile</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Primary Phone</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Secondary Phone</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Primary Email</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Secondary Email</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Country</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Product</th>
                      <th className="py-2 pr-3 whitespace-nowrap">City</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Address</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Remarks</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewCandidates.map((candidate) => (
                      <tr key={candidate.candidate_id} className="border-b border-slate-800/60">
                        <td className="py-2 px-3">
                          <input
                            type="checkbox"
                            checked={selected.has(candidate.candidate_id)}
                            disabled={importing}
                            onChange={(e) => toggleOne(candidate.candidate_id, e.target.checked)}
                          />
                        </td>
                        <td className="py-2 pr-3 text-slate-400">
                          {candidate.legacy_serial_no ?? "—"}
                        </td>
                        <td className="py-2 pr-3 text-slate-200">
                          {(candidate.company_name || "").trim() || (
                            <span className="text-slate-500 italic">Unnamed</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 max-w-[140px] truncate">
                          {displayOrDash(candidate.industry)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400">
                          {displayOrDash(candidate.company_grading)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400">
                          {displayOrDash(candidate.designation)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400">
                          {displayOrDash(candidate.contact_name)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">
                          {isFound(candidate.phone) ? candidate.phone : "—"}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">
                          {displayOrDash(candidate.secondary_mobile)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">
                          {displayOrDash(candidate.primary_phone)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">
                          {displayOrDash(candidate.secondary_phone)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 max-w-[160px] truncate">
                          {isFound(candidate.email) ? candidate.email : "—"}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 max-w-[160px] truncate">
                          {displayOrDash(candidate.secondary_email)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400">
                          {displayOrDash(candidate.country)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 max-w-[120px] truncate">
                          {displayOrDash(candidate.product_interest)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400">{displayOrDash(candidate.city)}</td>
                        <td className="py-2 pr-3 text-slate-400 max-w-[180px] truncate">
                          {displayOrDash(candidate.address)}
                        </td>
                        <td className="py-2 pr-3 text-slate-400 max-w-[160px] truncate">
                          {displayOrDash(candidate.remarks)}
                        </td>
                        <td className="py-2 text-xs">
                          {candidate.already_exists ? (
                            <span className="text-amber-400/90">Duplicate — replace if sparse</span>
                          ) : (
                            <span className="text-slate-500">Ready</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={importing}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleImport()}
                  disabled={importing || selected.size === 0}
                  className="px-3 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-600 text-sm font-medium disabled:opacity-50"
                >
                  {importing
                    ? jobStatus
                      ? `Importing ${Math.min(jobStatus.processed, jobStatus.total)}/${jobStatus.total}…`
                      : "Starting…"
                    : `Import only (${selected.size})`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
