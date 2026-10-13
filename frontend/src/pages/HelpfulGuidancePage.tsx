import { useCallback, useEffect, useState } from "react";
import { client, type AppUser } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { SearchableSelect } from "../components/SearchableSelect";

type GuidanceChannel = "calls" | "emails" | "whatsapp" | "telegram";
type PeriodPreset = 1 | 7 | 30 | 90 | "range";

interface MetricTile {
  label: string;
  value: string | number;
}

interface HelpfulGuidanceResponse {
  generated_at: string;
  channel?: GuidanceChannel | string;
  months: number | null;
  days?: number | null;
  period_label?: string;
  since?: string | null;
  until?: string | null;
  user_id: number | null;
  is_team_view: boolean;
  is_agent_view?: boolean;
  connected?: boolean;
  kpi_by_month: Array<{ period_label: string; counts: Record<string, number> }>;
  kpi_totals: Record<string, number>;
  metric_tiles?: MetricTile[];
  remark_patterns: {
    scanned_remarks: number;
    pattern_counts: Record<string, number>;
    samples: Record<string, string[]>;
  };
  strengths: string[];
  gaps: string[];
  recommendations: Array<{ title: string; body: string }>;
  approach_buyers: string[];
  save_phone_bill: string[];
}

interface HelpfulGuidancePageProps {
  onError: (message: string) => void;
}

const CHANNELS: Array<{ id: GuidanceChannel; label: string }> = [
  { id: "calls", label: "Calls" },
  { id: "emails", label: "Emails" },
  { id: "whatsapp", label: "WhatsApp Meta" },
  { id: "telegram", label: "Telegram" },
];

function isoDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultRangeBounds(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  return { from: isoDateLocal(from), to: isoDateLocal(to) };
}

export function HelpfulGuidancePage({ onError }: HelpfulGuidancePageProps) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<HelpfulGuidanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [assignees, setAssignees] = useState<AppUser[]>([]);
  const [userFilter, setUserFilter] = useState("");
  const [viewCategory, setViewCategory] = useState<"users" | "agents">("users");
  const [channel, setChannel] = useState<GuidanceChannel>("calls");
  const [period, setPeriod] = useState<PeriodPreset>(30);
  const [rangeFrom, setRangeFrom] = useState(() => defaultRangeBounds().from);
  const [rangeTo, setRangeTo] = useState(() => defaultRangeBounds().to);

  const load = useCallback(async () => {
    if (period === "range" && !rangeFrom && !rangeTo) return;
    setLoading(true);
    try {
      const result = await client.getHelpfulGuidance({
        channel,
        user_id: userFilter || undefined,
        ...(period === "range"
          ? { date_from: rangeFrom || undefined, date_to: rangeTo || undefined }
          : { days: period }),
      });
      setData(result as unknown as HelpfulGuidanceResponse);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load guidance");
    } finally {
      setLoading(false);
    }
  }, [channel, onError, period, rangeFrom, rangeTo, userFilter]);

  useEffect(() => {
    if (isAdmin) {
      void client.listAssignees().then(setAssignees).catch(() => setAssignees([]));
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return <p className="text-sm text-slate-400 p-6">Loading helpful guidance…</p>;
  }

  if (!data) return null;

  const tiles =
    data.metric_tiles && data.metric_tiles.length > 0
      ? data.metric_tiles
      : [
          { label: "Calls logged", value: data.kpi_totals.calls_logged ?? 0 },
          { label: "Interested", value: data.kpi_totals.outcomes_interested ?? 0 },
          { label: "Follow up", value: data.kpi_totals.outcomes_follow_up ?? 0 },
          { label: "No answer", value: data.kpi_totals.outcomes_not_received_call ?? 0 },
        ];

  const defaultHumanUsers = [
    { value: "", label: "Team rollup (All Human Reps)" },
    { value: "khalid", label: "Khalid (Admin/Rep)" },
    { value: "sadia", label: "Sadia (Sales Rep)" },
    { value: "asim", label: "Asim (Sales Rep)" },
    { value: "usman", label: "Usman (Sales Rep)" },
  ];

  const humanUserOptions =
    assignees.length > 0
      ? [
          { value: "", label: "Team rollup (All Human Reps)" },
          ...assignees.map((u) => ({ value: String(u.id), label: u.username })),
        ]
      : defaultHumanUsers;

  const aiAgentOptions = [
    { value: "agent_all", label: "All AI Sales Agents (Sara & Rayan)" },
    { value: "agent_sara", label: "Sara (AI Sales Agent)" },
    { value: "agent_rayan", label: "Rayan (AI Sales Agent)" },
  ];

  function handleCategoryChange(category: "users" | "agents") {
    setViewCategory(category);
    if (category === "users") {
      setUserFilter("");
    } else {
      setUserFilter("agent_all");
    }
  }

  const periodLabel = data.period_label || (data.days ? `Last ${data.days} days` : `Last ${data.months} months`);
  const channelLabel =
    CHANNELS.find((c) => c.id === (data.channel || channel))?.label || "Calls";

  return (
    <section className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-medium text-slate-100">SALES HELP MANAGER</h2>
        <p className="text-sm text-slate-400 mt-1">
          Coaching for <span className="text-slate-200">{channelLabel}</span>
          {" · "}
          {periodLabel}
          {data.is_team_view ? " (team view)" : ""}.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-800 bg-slate-950/50 p-1.5">
        {CHANNELS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setChannel(item.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
              channel === item.id
                ? "bg-emerald-600 border-emerald-500 text-white"
                : "bg-transparent border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {item.label}
            {item.id === "telegram" ? (
              <span className="ml-1 opacity-70">(soon)</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              [1, "1d"],
              [7, "7d"],
              [30, "30d"],
              [90, "90d"],
              ["range", "Range"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                if (value === "range") {
                  const bounds = defaultRangeBounds();
                  setRangeFrom((prev) => prev || bounds.from);
                  setRangeTo((prev) => prev || bounds.to);
                }
                setPeriod(value);
              }}
              className={`px-2.5 py-1 rounded-md text-xs border ${
                period === value
                  ? "bg-sky-600 border-sky-500 text-white"
                  : "bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {period === "range" ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>From</span>
              <input
                type="date"
                value={rangeFrom}
                max={rangeTo || undefined}
                onChange={(e) => setRangeFrom(e.target.value)}
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>To</span>
              <input
                type="date"
                value={rangeTo}
                min={rangeFrom || undefined}
                onChange={(e) => setRangeTo(e.target.value)}
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
              />
            </label>
          </div>
        ) : null}
      </div>

      {isAdmin && (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Select Performance View:
            </span>
            <div className="flex items-center rounded-lg bg-slate-950 p-1 border border-slate-800">
              <button
                type="button"
                onClick={() => handleCategoryChange("users")}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                  viewCategory === "users"
                    ? "bg-sky-600 text-white shadow-md"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>Human Sales Reps</span>
              </button>

              <button
                type="button"
                onClick={() => handleCategoryChange("agents")}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                  viewCategory === "agents"
                    ? "bg-emerald-600 text-white shadow-md"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>AI Sales Agents</span>
              </button>
            </div>
          </div>

          <SearchableSelect
            label={viewCategory === "users" ? "Select Human Sales Rep" : "Select AI Sales Agent"}
            value={userFilter}
            onChange={setUserFilter}
            options={viewCategory === "users" ? humanUserOptions : aiAgentOptions}
            allowEmpty={false}
          />
        </div>
      )}

      {data.connected === false ? (
        <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-sm text-amber-100/90">
          Telegram reply coaching is not connected yet. Use Calls, Emails, or WhatsApp Meta for now.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3"
          >
            <p className="text-xs text-slate-500">{tile.label}</p>
            <p className="text-2xl font-semibold text-slate-100 tabular-nums">{tile.value}</p>
          </div>
        ))}
      </div>

      {loading ? (
        <p className="text-xs text-slate-500">Refreshing guidance…</p>
      ) : null}

      <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-4">
        <h3 className="text-sm font-medium text-emerald-200">Strengths</h3>
        <ul className="mt-2 space-y-1 text-sm text-emerald-100/90 list-disc list-inside">
          {data.strengths.length > 0 ? (
            data.strengths.map((s) => <li key={s}>{s}</li>)
          ) : (
            <li>No strengths flagged for this channel yet.</li>
          )}
        </ul>
      </div>

      <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-4">
        <h3 className="text-sm font-medium text-amber-200">Where we are lacking</h3>
        <ul className="mt-2 space-y-1 text-sm text-amber-100/90 list-disc list-inside">
          {data.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-slate-200">Recommendations</h3>
        {data.recommendations.map((rec) => (
          <div key={rec.title} className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
            <p className="text-sm font-medium text-sky-200">{rec.title}</p>
            <p className="text-sm text-slate-300 mt-1">{rec.body}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-800 p-4">
          <h3 className="text-sm font-medium text-slate-200">How to approach buyers</h3>
          <ul className="mt-2 space-y-1 text-sm text-slate-400 list-disc list-inside">
            {data.approach_buyers.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-slate-800 p-4">
          <h3 className="text-sm font-medium text-slate-200">
            {channel === "calls" ? "Save telephone / voicemail cost" : "Save time & cost"}
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-slate-400 list-disc list-inside">
            {data.save_phone_bill.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
