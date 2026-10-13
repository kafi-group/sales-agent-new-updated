import React, { useState, useEffect } from "react";
import {
  client,
  type DayCountryTarget,
  type WorkspaceReviewOptionItem,
  type AppUser,
} from "../../api/client";

const DAYS_OF_WEEK = [
  { id: "monday", label: "Monday" },
  { id: "tuesday", label: "Tuesday" },
  { id: "wednesday", label: "Wednesday" },
  { id: "thursday", label: "Thursday" },
  { id: "friday", label: "Friday" },
  { id: "saturday", label: "Saturday" },
  { id: "sunday", label: "Sunday" },
];

export const AdminTargetManagerView: React.FC = () => {
  const [activeDay, setActiveDay] = useState<string>("friday");
  const [targets, setTargets] = useState<DayCountryTarget[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [reviewOptions, setReviewOptions] = useState<WorkspaceReviewOptionItem[]>([]);

  // Form states
  const [newCountry, setNewCountry] = useState("");
  const [selectedUser, setSelectedUser] = useState<string>("unassigned");

  // Review option form
  const [newOptionCategory, setNewOptionCategory] = useState<"follow_up" | "not_interested">("follow_up");
  const [newOptionLabel, setNewOptionLabel] = useState("");
  const [newOptionHint, setNewOptionHint] = useState("");

  const [isLoading, setIsLoading] = useState(false);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [targetsRes, usersRes, optionsRes] = await Promise.all([
        client.getTargetWorkspaceTargets(activeDay),
        client.listUsers(),
        client.getWorkspaceReviewOptions(),
      ]);
      setTargets(targetsRes.targets);
      setUsers(usersRes.filter((u) => u.is_active));
      setReviewOptions(optionsRes.options);
    } catch (err: any) {
      console.error("Failed to load admin workspace data:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeDay]);

  const handleAddTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCountry.trim()) return;
    try {
      const assignedId = selectedUser === "unassigned" ? null : Number(selectedUser);
      await client.addDayCountryTarget({
        day_of_week: activeDay,
        country: newCountry.trim(),
        assigned_user_id: assignedId,
      });
      setNewCountry("");
      setSelectedUser("unassigned");
      await loadData();
    } catch (err: any) {
      alert(err?.message || "Failed to add target country.");
    }
  };

  const handleRemoveTarget = async (targetId: number) => {
    if (!confirm("Are you sure you want to remove this target country?")) return;
    try {
      await client.removeDayCountryTarget(targetId);
      await loadData();
    } catch (err: any) {
      alert(err?.message || "Failed to remove target.");
    }
  };

  const handleAddReviewOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOptionLabel.trim()) return;
    try {
      await client.addWorkspaceReviewOption({
        category: newOptionCategory,
        label: newOptionLabel.trim(),
        action_hint: newOptionHint.trim() || undefined,
      });
      setNewOptionLabel("");
      setNewOptionHint("");
      await loadData();
    } catch (err: any) {
      alert(err?.message || "Failed to add review option.");
    }
  };

  const handleDeleteReviewOption = async (optionId: number) => {
    if (!confirm("Delete this custom review dropdown option?")) return;
    try {
      await client.deleteWorkspaceReviewOption(optionId);
      await loadData();
    } catch (err: any) {
      alert(err?.message || "Cannot delete system default option.");
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Header Banner ── */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span className="text-2xl">⚙️</span>
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Admin Country Assignment & Dropdown Configuration
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Mr. Khalid's schedule matrix: Assign specific target countries to sales agents (Asim, Usman) day-wise, and customize objection & review dropdown options.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 7 cols: Day Schedule & Rep Country Assignment */}
        <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>🗺️</span> Day-wise Country & Sales Rep Target Matrix
            </h3>
            <div className="flex items-center gap-2">
              {isLoading && <span className="animate-spin text-sm">⏳</span>}
              <span className="text-xs text-slate-400 font-medium">Selected: {activeDay.toUpperCase()}</span>
            </div>
          </div>

          {/* Day Selector Pills */}
          <div className="flex items-center gap-1 overflow-x-auto bg-slate-950 p-1.5 rounded-xl border border-slate-800">
            {DAYS_OF_WEEK.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setActiveDay(d.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  activeDay === d.id
                    ? "bg-emerald-600 text-white shadow-md shadow-emerald-950"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          {/* Add New Target Form */}
          <form onSubmit={handleAddTarget} className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
            <div className="text-xs font-semibold text-slate-300">
              + Assign Country to Rep for {activeDay.toUpperCase()}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="sm:col-span-2">
                <input
                  type="text"
                  required
                  placeholder="Country name (e.g. China, Indonesia, Tanzania)..."
                  value={newCountry}
                  onChange={(e) => setNewCountry(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <select
                  value={selectedUser}
                  onChange={(e) => setSelectedUser(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="unassigned">All Reps (Shared)</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name || u.username} ({u.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-950 transition"
              >
                + Save Country Assignment
              </button>
            </div>
          </form>

          {/* Assigned Countries List */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Configured Target Countries for {activeDay.toUpperCase()}:
            </div>

            {targets.length === 0 ? (
              <div className="py-8 text-center text-slate-500 text-xs italic bg-slate-950/40 rounded-xl border border-slate-800/60">
                No countries assigned for {activeDay}. Add countries using the form above.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/60 rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden">
                {targets.map((t) => (
                  <div key={t.id} className="p-3 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5">
                      <span className="text-base">🌍</span>
                      <div>
                        <strong className="text-white block">{t.country}</strong>
                        <span className="text-[11px] text-slate-400">
                          Assigned to:{" "}
                          <span className={t.assigned_user_name ? "text-amber-300 font-semibold" : "text-slate-400"}>
                            {t.assigned_user_name || "All Sales Agents (Shared)"}
                          </span>
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveTarget(t.id)}
                      className="px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20 text-xs font-medium transition"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right 5 cols: Custom Review & Objection Dropdown Manager */}
        <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>🏷️</span> Customizable Review & Objection Dropdowns
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Add common client scenarios (e.g. "Need approval from HO", "Call back later", "Searching for more vendors") and strategic TO DO advice.
            </p>
          </div>

          {/* Add Option Form */}
          <form onSubmit={handleAddReviewOption} className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-slate-400 mb-1">Category:</label>
                <select
                  value={newOptionCategory}
                  onChange={(e) => setNewOptionCategory(e.target.value as any)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                >
                  <option value="follow_up">Needs Follow Up</option>
                  <option value="not_interested">Not Interested (Objection)</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Dropdown Label:</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Currently searching for more vendors"
                  value={newOptionLabel}
                  onChange={(e) => setNewOptionLabel(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 placeholder-slate-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Strategic TO DO Hint (Guidance for Rep):</label>
              <input
                type="text"
                placeholder="e.g. Offer sample kit & emphasize flexible MOQ terms..."
                value={newOptionHint}
                onChange={(e) => setNewOptionHint(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 placeholder-slate-500"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                className="px-4 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-semibold shadow-md transition"
              >
                + Add Dropdown Option
              </button>
            </div>
          </form>

          {/* Review Options List */}
          <div className="space-y-3 text-xs max-h-96 overflow-y-auto pr-1">
            <div>
              <span className="font-semibold text-amber-400 uppercase tracking-wider block mb-1.5">
                Follow Up Scenarios ({reviewOptions.filter((o) => o.category === "follow_up").length})
              </span>
              <div className="space-y-1.5">
                {reviewOptions
                  .filter((o) => o.category === "follow_up")
                  .map((opt) => (
                    <div
                      key={opt.id}
                      className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-start justify-between gap-2"
                    >
                      <div>
                        <strong className="text-slate-100 block">{opt.label}</strong>
                        {opt.action_hint && (
                          <span className="text-[10px] text-slate-400 block mt-0.5 italic">
                            Hint: {opt.action_hint}
                          </span>
                        )}
                      </div>
                      {!opt.is_system && (
                        <button
                          type="button"
                          onClick={() => handleDeleteReviewOption(opt.id)}
                          className="text-slate-500 hover:text-rose-400 transition"
                          title="Delete option"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </div>

            <div className="pt-2">
              <span className="font-semibold text-purple-400 uppercase tracking-wider block mb-1.5">
                Not Interested Objections & TO DO ({reviewOptions.filter((o) => o.category === "not_interested").length})
              </span>
              <div className="space-y-1.5">
                {reviewOptions
                  .filter((o) => o.category === "not_interested")
                  .map((opt) => (
                    <div
                      key={opt.id}
                      className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-start justify-between gap-2"
                    >
                      <div>
                        <strong className="text-slate-100 block">{opt.label}</strong>
                        {opt.action_hint && (
                          <span className="text-[10px] text-purple-300 block mt-0.5">
                            🎯 {opt.action_hint}
                          </span>
                        )}
                      </div>
                      {!opt.is_system && (
                        <button
                          type="button"
                          onClick={() => handleDeleteReviewOption(opt.id)}
                          className="text-slate-500 hover:text-rose-400 transition"
                          title="Delete option"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
