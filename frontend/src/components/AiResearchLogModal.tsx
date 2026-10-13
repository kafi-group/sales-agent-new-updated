import { useEffect, useMemo, useState } from "react";
import { client } from "../api/client";
import {
  clearAiResearchLog,
  contactSearchText,
  formatAiResearchLogTime,
  type AiResearchLogContact,
  type AiResearchLogEntry,
} from "../utils/aiResearchLog";

interface AiResearchLogModalProps {
  entries: AiResearchLogEntry[];
  onClose: () => void;
  onEntriesChange: (entries: AiResearchLogEntry[]) => void;
  /** Jump back to the contact list with these IDs still selected (and filtered). */
  onOpenContacts: (
    leadIds: number[],
    section?: string | null,
    searchHint?: string | null,
  ) => void;
  onError?: (message: string) => void;
}

type DetailMode = "before_after" | "current" | null;
type LogTab = "manual" | "ai_sales";

type DataUpdateFieldChange = {
  field?: string;
  label?: string;
  before?: string;
  after?: string;
};

type DataUpdateLogEntry = {
  at?: string;
  buyer_id?: number;
  label?: string;
  ok?: boolean;
  skipped?: boolean;
  filled?: string[];
  changes?: DataUpdateFieldChange[];
  error?: string | null;
};

type DataUpdateRunReport = {
  finished_at?: string;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  filled_total?: number;
  done?: number;
  total?: number;
  log?: DataUpdateLogEntry[];
  run_id?: string | null;
  partial?: boolean;
  agent: "Sara" | "Rayan";
  persona: "female" | "male";
};

function afterValue(c: AiResearchLogContact, field: string): string | undefined {
  const fromChange = c.changes?.find((ch) => ch.field === field)?.after;
  if (fromChange) return fromChange;
  switch (field) {
    case "company_name":
      return c.after_company_name || c.company_name;
    case "contact_name":
      return c.after_contact_name || c.contact_name;
    case "contact_phone":
      return c.after_phone || c.phone;
    case "contact_email":
      return c.after_email || c.email;
    case "website_url":
      return c.after_website;
    case "address":
      return c.after_address;
    case "country":
      return c.after_country;
    case "contact_designation":
      return c.after_designation;
    case "industry":
      return c.after_industry;
    default:
      return undefined;
  }
}

function formatSalesModeTime(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function AiResearchLogModal({
  entries,
  onClose,
  onEntriesChange,
  onOpenContacts,
  onError,
}: AiResearchLogModalProps) {
  const [tab, setTab] = useState<LogTab>("manual");
  const [detail, setDetail] = useState<{
    entry: AiResearchLogEntry;
    contact: AiResearchLogContact;
    mode: Exclude<DetailMode, null>;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesRuns, setSalesRuns] = useState<DataUpdateRunReport[]>([]);
  const [openSalesRunKey, setOpenSalesRunKey] = useState<string | null>(null);
  const [salesContactView, setSalesContactView] = useState<DataUpdateLogEntry | null>(null);

  useEffect(() => {
    if (tab !== "ai_sales") return;
    let cancelled = false;
    setSalesLoading(true);
    client
      .getAiSalesDataUpdate()
      .then((status) => {
        if (cancelled) return;
        const runs: DataUpdateRunReport[] = [];
        for (const [persona, agent] of [
          ["female", "Sara"],
          ["male", "Rayan"],
        ] as const) {
          const st = status.run_state?.[persona];
          const history = Array.isArray(st?.run_history)
            ? (st!.run_history as DataUpdateRunReport[])
            : [];
          const last = st?.last_report as DataUpdateRunReport | null | undefined;
          const source = history.length > 0 ? history : last ? [last] : [];
          if (st?.status === "running" && Array.isArray(st.log) && st.log.length > 0) {
            runs.push({
              finished_at: st.updated_at || new Date().toISOString(),
              succeeded: st.progress?.succeeded,
              failed: st.progress?.failed,
              skipped: st.progress?.skipped,
              filled_total: st.progress?.filled_total,
              done: st.progress?.done,
              total: st.progress?.total,
              log: st.log as DataUpdateLogEntry[],
              run_id: st.run_id || `live-${persona}`,
              partial: true,
              agent,
              persona,
            });
          }
          for (const h of source) {
            if (!h || typeof h !== "object") continue;
            runs.push({
              ...h,
              agent,
              persona,
              log: Array.isArray(h.log) ? (h.log as DataUpdateLogEntry[]) : [],
            });
          }
        }
        runs.sort((a, b) => {
          const ta = a.finished_at ? Date.parse(a.finished_at) : 0;
          const tb = b.finished_at ? Date.parse(b.finished_at) : 0;
          return tb - ta;
        });
        setSalesRuns(runs);
      })
      .catch((e) => {
        if (!cancelled) {
          onError?.(e instanceof Error ? e.message : "Failed to load AI Sales Mode logs");
        }
      })
      .finally(() => {
        if (!cancelled) setSalesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, onError]);

  const salesRunKeys = useMemo(
    () =>
      salesRuns.map(
        (r, i) => `${r.persona}-${r.run_id || r.finished_at || i}-${r.partial ? "live" : "done"}`,
      ),
    [salesRuns],
  );

  async function copySearch(c: AiResearchLogContact) {
    const text = contactSearchText(c);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this to search the contact list:", text);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
        <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl flex flex-col">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">AI Research log</h2>
              <p className="text-sm text-slate-400 mt-0.5">
                {tab === "manual" ? (
                  <>
                    Use <span className="text-slate-200">View before/after</span> to see what
                    changed, or <span className="text-slate-200">Current details</span> to copy
                    values and find the contact in the list. Updated fields stay yellow in the
                    table.
                  </>
                ) : (
                  <>
                    Automatic Data Update runs by{" "}
                    <span className="text-slate-200">Sara</span> /{" "}
                    <span className="text-slate-200">Rayan</span>. Each box is one start — open it
                    to see contacts cleaned in that run.
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="px-5 pt-3 flex gap-2 border-b border-slate-800/80">
            <button
              type="button"
              onClick={() => setTab("manual")}
              className={`px-3 pb-2 text-sm font-semibold border-b-2 transition ${
                tab === "manual"
                  ? "border-amber-500 text-amber-200"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              Manual
            </button>
            <button
              type="button"
              onClick={() => setTab("ai_sales")}
              className={`px-3 pb-2 text-sm font-semibold border-b-2 transition ${
                tab === "ai_sales"
                  ? "border-cyan-500 text-cyan-200"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              AI Sales Mode
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {tab === "manual" ? (
              entries.length === 0 ? (
                <p className="text-sm text-slate-500">No research sessions logged yet.</p>
              ) : (
                entries.map((entry) => {
                  const ids = entry.contacts.map((c) => c.id).filter((id) => id > 0);
                  return (
                    <div
                      key={entry.id}
                      className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-amber-200">
                          {formatAiResearchLogTime(entry.at)}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border border-slate-600 text-slate-300 uppercase tracking-wide">
                          {entry.action}
                        </span>
                        {entry.section ? (
                          <span className="text-slate-500">list: {entry.section}</span>
                        ) : null}
                      </div>
                      {entry.note ? <p className="text-xs text-slate-400">{entry.note}</p> : null}
                      <ul className="space-y-2.5">
                        {entry.contacts.map((c) => (
                          <li
                            key={`${entry.id}-${c.id}`}
                            className="rounded-md border border-slate-800/80 bg-slate-900/50 p-2.5 space-y-2"
                          >
                            <div className="text-sm text-slate-200">
                              <span className="font-medium">{c.label}</span>
                              <span className="text-slate-500 text-xs"> · #{c.id}</span>
                              {(c.after_contact_name || c.contact_name) && (
                                <span className="text-slate-400 text-xs">
                                  {" "}
                                  · {c.after_contact_name || c.contact_name}
                                </span>
                              )}
                              {(c.after_phone || c.phone) && (
                                <span className="text-slate-400 text-xs">
                                  {" "}
                                  · {c.after_phone || c.phone}
                                </span>
                              )}
                              {(c.after_email || c.email) && (
                                <span className="text-slate-400 text-xs">
                                  {" "}
                                  · {c.after_email || c.email}
                                </span>
                              )}
                              {c.filled_fields?.length ? (
                                <div className="text-[11px] text-emerald-300/90 mt-0.5">
                                  Filled: {c.filled_fields.join(", ")}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setDetail({ entry, contact: c, mode: "before_after" })
                                }
                                className="px-2 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-[11px] text-sky-100 hover:bg-sky-500/20"
                              >
                                View before/after
                              </button>
                              <button
                                type="button"
                                onClick={() => setDetail({ entry, contact: c, mode: "current" })}
                                className="px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-100 hover:bg-amber-500/20"
                              >
                                Current details
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {ids.length > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            onOpenContacts(ids, entry.section, String(ids[0] ?? ""))
                          }
                          className="text-[11px] text-emerald-300/90 hover:text-emerald-200 border border-emerald-500/30 rounded px-2 py-1"
                        >
                          Open list with these contacts selected
                        </button>
                      ) : null}
                    </div>
                  );
                })
              )
            ) : salesLoading ? (
              <p className="text-sm text-slate-500">Loading AI Sales Mode runs…</p>
            ) : salesRuns.length === 0 ? (
              <p className="text-sm text-slate-500">
                No Sara / Rayan Data Update runs yet. Runs appear here when Data Update Start
                processes contacts.
              </p>
            ) : (
              salesRuns.map((run, idx) => {
                const key = salesRunKeys[idx];
                const open = openSalesRunKey === key;
                const log = Array.isArray(run.log) ? run.log : [];
                return (
                  <div
                    key={key}
                    className="rounded-lg border border-slate-700 bg-slate-950/60 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenSalesRunKey(open ? null : key)}
                      className="w-full text-left px-3 py-2.5 flex flex-wrap items-center gap-2 hover:bg-slate-900/70"
                      aria-expanded={open}
                    >
                      <span className="text-slate-400 text-xs w-3">{open ? "▾" : "▸"}</span>
                      <span className="text-xs font-semibold text-amber-200">
                        {formatSalesModeTime(run.finished_at)}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                          run.persona === "female"
                            ? "border-emerald-500/40 text-emerald-200 bg-emerald-500/10"
                            : "border-sky-500/40 text-sky-200 bg-sky-500/10"
                        }`}
                      >
                        {run.agent}
                      </span>
                      <span className="px-1.5 py-0.5 rounded border border-cyan-500/40 text-cyan-200 bg-cyan-500/10 text-[10px] font-semibold">
                        Data Update
                      </span>
                      {run.partial ? (
                        <span className="px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-200 text-[10px]">
                          In progress
                        </span>
                      ) : null}
                      <span className="ml-auto text-xs tabular-nums text-slate-300">
                        {run.done ?? log.length}/{run.total ?? log.length}
                        {run.succeeded != null ? ` · ok ${run.succeeded}` : ""}
                        {run.filled_total != null ? ` · filled ${run.filled_total}` : ""}
                      </span>
                    </button>
                    {open ? (
                      <div className="border-t border-slate-800 px-3 py-2.5 space-y-1.5">
                        {log.length === 0 ? (
                          <p className="text-xs text-slate-500">No per-contact lines in this run.</p>
                        ) : (
                          [...log].reverse().map((entry, i) => (
                            <div
                              key={`${key}-${entry.buyer_id ?? i}-${entry.at ?? i}`}
                              className="rounded border border-slate-800 px-2 py-1.5 text-xs"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-slate-100">
                                  {entry.label || `Lead #${entry.buyer_id ?? "?"}`}
                                </span>
                                {entry.buyer_id ? (
                                  <span className="text-slate-500">#{entry.buyer_id}</span>
                                ) : null}
                                <span
                                  className={
                                    entry.skipped
                                      ? "text-slate-400"
                                      : entry.ok && (entry.filled?.length || entry.changes?.length)
                                        ? "text-emerald-300"
                                        : entry.ok
                                          ? "text-slate-400"
                                          : "text-rose-300"
                                  }
                                >
                                  {entry.skipped
                                    ? "Skipped"
                                    : entry.ok && (entry.filled?.length || entry.changes?.length)
                                      ? "Updated"
                                      : entry.ok
                                        ? "OK"
                                        : "Failed"}
                                </span>
                                {entry.changes?.length || entry.filled?.length ? (
                                  <button
                                    type="button"
                                    onClick={() => setSalesContactView(entry)}
                                    className="ml-auto px-2 py-0.5 rounded border border-sky-500/40 text-sky-200 text-[10px] hover:bg-sky-500/15"
                                  >
                                    View
                                  </button>
                                ) : null}
                              </div>
                              {entry.filled?.length ? (
                                <p className="text-emerald-300/90 mt-0.5">
                                  Filled: {entry.filled.join(", ")}
                                </p>
                              ) : null}
                              {entry.error ? (
                                <p className="text-rose-300/90 mt-0.5 break-words">
                                  {String(entry.error)}
                                </p>
                              ) : null}
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          <div className="px-5 py-3 border-t border-slate-800 flex justify-between gap-2">
            {tab === "manual" ? (
              <button
                type="button"
                onClick={() => {
                  clearAiResearchLog();
                  onEntriesChange([]);
                }}
                className="px-3 py-1.5 rounded-lg border border-rose-500/40 text-xs text-rose-200 hover:bg-rose-500/10"
              >
                Clear log
              </button>
            ) : (
              <span className="text-[11px] text-slate-500 self-center">
                AI Sales Mode history is kept on the server (not cleared here).
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {detail ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75">
          <div className="w-full max-w-lg max-h-[80vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl flex flex-col">
            <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  {detail.mode === "before_after" ? "Before / after" : "Current details"}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {detail.contact.label} · #{detail.contact.id} ·{" "}
                  {formatAiResearchLogTime(detail.entry.at)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="text-slate-400 hover:text-slate-200 text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {detail.mode === "before_after" ? (
                (detail.contact.changes?.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {detail.contact.changes!.map((ch) => (
                      <li
                        key={`${detail.contact.id}-${ch.field}`}
                        className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs"
                      >
                        <p className="font-semibold text-slate-200 mb-2">{ch.label || ch.field}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                              Before
                            </p>
                            <p className="text-slate-400 break-words">{ch.before || "(empty)"}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-emerald-400/80 mb-1">
                              After
                            </p>
                            <p className="text-emerald-200 break-words">{ch.after || "(empty)"}</p>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : detail.contact.filled_fields?.length ? (
                  <div className="text-xs text-slate-300 space-y-1">
                    <p>Fields filled (before/after not stored for this older entry):</p>
                    <ul className="list-disc pl-4 text-emerald-300">
                      {detail.contact.filled_fields.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                    <p className="text-slate-500 pt-1">
                      Save again from AI Research to store full before/after values.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">No field changes recorded for this contact.</p>
                )
              ) : (
                <div className="space-y-3 text-sm">
                  <p className="text-xs text-slate-400">
                    Use these values in the list search box, or open the list with this contact
                    selected.
                  </p>
                  <dl className="space-y-2 text-xs">
                    {(
                      [
                        ["Lead ID", `#${detail.contact.id}`],
                        ["Company", afterValue(detail.contact, "company_name")],
                        ["Contact person", afterValue(detail.contact, "contact_name")],
                        ["Phone", afterValue(detail.contact, "contact_phone")],
                        ["Email", afterValue(detail.contact, "contact_email")],
                        ["Website", afterValue(detail.contact, "website_url")],
                        ["Address", afterValue(detail.contact, "address")],
                        ["Country", afterValue(detail.contact, "country")],
                        ["Business type", afterValue(detail.contact, "industry")],
                        ["Designation", afterValue(detail.contact, "contact_designation")],
                      ] as Array<[string, string | undefined]>
                    )
                      .filter(([, v]) => (v ?? "").toString().trim())
                      .map(([label, value]) => (
                        <div
                          key={label}
                          className="grid grid-cols-[110px_1fr] gap-2 rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-2"
                        >
                          <dt className="text-slate-500">{label}</dt>
                          <dd className="text-slate-100 break-words font-medium">{value}</dd>
                        </div>
                      ))}
                  </dl>
                  <p className="text-[11px] text-slate-500 font-mono break-all rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1.5">
                    {contactSearchText(detail.contact)}
                  </p>
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-800 flex flex-wrap justify-end gap-2">
              {detail.mode === "current" ? (
                <>
                  <button
                    type="button"
                    onClick={() => void copySearch(detail.contact)}
                    className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-100 hover:bg-amber-500/20"
                  >
                    {copied ? "Copied!" : "Copy for search"}
                  </button>
                  {detail.contact.id > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenContacts(
                          [detail.contact.id],
                          detail.entry.section,
                          String(detail.contact.id),
                        );
                        setDetail(null);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-100 hover:bg-emerald-500/20"
                    >
                      Find in list
                    </button>
                  ) : null}
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {salesContactView ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75">
          <div className="w-full max-w-lg max-h-[80vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl flex flex-col">
            <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">Before / after</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {salesContactView.label || `Lead #${salesContactView.buyer_id ?? "?"}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSalesContactView(null)}
                className="text-slate-400 hover:text-slate-200 text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {(salesContactView.changes?.length ?? 0) > 0 ? (
                salesContactView.changes!.map((ch) => (
                  <div
                    key={`${ch.field}-${ch.label}`}
                    className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs"
                  >
                    <p className="font-semibold text-slate-200 mb-2">{ch.label || ch.field}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                          Before
                        </p>
                        <p className="text-slate-400 break-words">{ch.before || "(empty)"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-emerald-400/80 mb-1">
                          After
                        </p>
                        <p className="text-emerald-200 break-words">{ch.after || "(empty)"}</p>
                      </div>
                    </div>
                  </div>
                ))
              ) : salesContactView.filled?.length ? (
                <ul className="list-disc pl-4 text-sm text-emerald-300">
                  {salesContactView.filled.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-500">No field changes recorded.</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-800 flex justify-end gap-2">
              {salesContactView.buyer_id ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenContacts(
                      [salesContactView.buyer_id!],
                      null,
                      String(salesContactView.buyer_id),
                    );
                    setSalesContactView(null);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-100 hover:bg-emerald-500/20"
                >
                  Find in list
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setSalesContactView(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
