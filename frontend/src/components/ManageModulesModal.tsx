import React, { useEffect, useState } from "react";
import {
  client,
  type CustomLeadModule,
} from "../api/client";

interface ManageModulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onModulesChanged?: () => void;
  onNavigateToModule?: (key: string) => void;
}

const PRESET_ICONS = ["🧪", "🛒", "🏢", "⭐", "🎯", "📋", "👥", "📞", "📦", "🏷️", "💼", "🚀", "💎", "🌴", "⚡", "🔥"];
const PRESET_COLORS = [
  { name: "Emerald", hex: "#10b981" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Purple", hex: "#8b5cf6" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Red", hex: "#ef4444" },
  { name: "Cyan", hex: "#06b6d4" },
  { name: "Indigo", hex: "#6366f1" },
];

export const ManageModulesModal: React.FC<ManageModulesModalProps> = ({
  isOpen,
  onClose,
  onModulesChanged,
  onNavigateToModule,
}) => {
  const [activeTab, setActiveTab] = useState<"lists" | "create" | "testing">("lists");
  const [modules, setModules] = useState<CustomLeadModule[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form state for creating module
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newIcon, setNewIcon] = useState("📋");
  const [newColor, setNewColor] = useState("#10b981");
  const [creating, setCreating] = useState(false);

  // Form state for staff testing
  const [staffName, setStaffName] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffMobile, setStaffMobile] = useState("+92300");
  const [staffDesignation, setStaffDesignation] = useState("Executive Staff");
  const [staffAdding, setStaffAdding] = useState(false);
  const [seedingStaff, setSeedingStaff] = useState(false);

  const loadModules = async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await client.listCustomModules(true);
      setModules(list);
    } catch (err: any) {
      setError(err?.message || "Failed to load modules");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadModules();
      setSuccessMsg(null);
      setError(null);
    }
  }, [isOpen]);

  const handleToggleEnable = async (mod: CustomLeadModule) => {
    try {
      const nextState = !mod.is_enabled;
      await client.updateCustomModule(mod.key, { is_enabled: nextState });
      setModules((prev) =>
        prev.map((m) => (m.key === mod.key ? { ...m, is_enabled: nextState } : m))
      );
      onModulesChanged?.();
    } catch (err: any) {
      setError(err?.message || "Failed to update module visibility");
    }
  };

  const handleDeleteModule = async (mod: CustomLeadModule) => {
    if (!window.confirm(`Are you sure you want to delete "${mod.name}"? Leads in this module will be safely returned to Old clients.`)) {
      return;
    }
    try {
      await client.deleteCustomModule(mod.key);
      setModules((prev) => prev.filter((m) => m.key !== mod.key));
      setSuccessMsg(`Deleted "${mod.name}" list successfully.`);
      onModulesChanged?.();
    } catch (err: any) {
      setError(err?.message || "Failed to delete module");
    }
  };

  const handleCreateModule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      setCreating(true);
      setError(null);
      const created = await client.createCustomModule({
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        icon: newIcon,
        color: newColor,
      });
      setModules((prev) => [...prev, created]);
      setSuccessMsg(`Created new list "${created.name}" (${created.icon})!`);
      setNewName("");
      setNewDesc("");
      setActiveTab("lists");
      onModulesChanged?.();
    } catch (err: any) {
      setError(err?.message || "Failed to create list");
    } finally {
      setCreating(false);
    }
  };

  const handleSeedStaff = async () => {
    try {
      setSeedingStaff(true);
      setError(null);
      const res = await client.seedModuleStaff("testing");
      setSuccessMsg(`Successfully added / updated ${res.seeded_count} Kafi Commodities staff members in the Testing list!`);
      await loadModules();
      onModulesChanged?.();
    } catch (err: any) {
      setError(err?.message || "Failed to seed staff");
    } finally {
      setSeedingStaff(false);
    }
  };

  const handleAddStaffRecipient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!staffName.trim() && !staffEmail.trim() && !staffMobile.trim()) return;
    try {
      setStaffAdding(true);
      setError(null);
      await client.addModuleRecipient("testing", {
        contact_name: staffName.trim(),
        company_name: `Kafi Commodities (Staff — ${staffName.trim() || "QA"})`,
        email: staffEmail.trim() || undefined,
        primary_mobile: staffMobile.trim() || undefined,
        designation: staffDesignation.trim(),
        country: "Pakistan",
        city: "Karachi",
        remarks: "Staff QA tester for daily morning bulk testing",
      });
      setSuccessMsg(`Added ${staffName || staffEmail} to Testing list!`);
      setStaffName("");
      setStaffEmail("");
      setStaffMobile("+92300");
      await loadModules();
      onModulesChanged?.();
    } catch (err: any) {
      setError(err?.message || "Failed to add recipient");
    } finally {
      setStaffAdding(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-3xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-xl">
              ⚙️
            </div>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                Manage Old Clients Modules & Lists
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-normal">
                  Custom & Built-in
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Add, toggle, or remove lists directly under Old clients for targeted outreach & morning testing
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 px-6 pt-3 border-b border-slate-800 bg-slate-900/50">
          <button
            onClick={() => setActiveTab("lists")}
            className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-2 ${
              activeTab === "lists"
                ? "bg-slate-800 text-emerald-400 border-b-2 border-emerald-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>📋</span> Active Lists ({modules.length})
          </button>
          <button
            onClick={() => setActiveTab("create")}
            className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-2 ${
              activeTab === "create"
                ? "bg-slate-800 text-emerald-400 border-b-2 border-emerald-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>➕</span> Add New List
          </button>
          <button
            onClick={() => setActiveTab("testing")}
            className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-2 ${
              activeTab === "testing"
                ? "bg-slate-800 text-emerald-400 border-b-2 border-emerald-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>🧪</span> Testing List (Staff Numbers)
          </button>
        </div>

        {/* Notifications */}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
            <span>⚠️ {error}</span>
            <button onClick={() => setError(null)} className="text-rose-400 hover:text-white">✕</button>
          </div>
        )}
        {successMsg && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
            <span>✓ {successMsg}</span>
            <button onClick={() => setSuccessMsg(null)} className="text-emerald-400 hover:text-white">✕</button>
          </div>
        )}

        {/* Tab 1: Lists Overview */}
        {activeTab === "lists" && (
          <div className="p-6 overflow-y-auto flex-1 space-y-3">
            <div className="flex items-center justify-between pb-2">
              <span className="text-xs font-semibold text-slate-300">
                Lists appearing in Sidebar & "Move to module" dropdown:
              </span>
              <button
                onClick={() => setActiveTab("create")}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors flex items-center gap-1.5 shadow-sm"
              >
                <span>➕</span> Add List
              </button>
            </div>

            {loading ? (
              <div className="py-12 text-center text-xs text-slate-500">Loading lists...</div>
            ) : modules.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-500">No custom lists yet. Click "Add New List" above.</div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5">
                {modules.map((mod) => (
                  <div
                    key={mod.key}
                    className={`flex items-center justify-between p-3.5 rounded-xl border transition-all ${
                      mod.is_enabled
                        ? "bg-slate-800/60 border-slate-700 hover:border-slate-600"
                        : "bg-slate-900/40 border-slate-800/80 opacity-60"
                    }`}
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-base font-bold shadow-inner"
                        style={{ backgroundColor: `${mod.color || "#3b82f6"}20`, border: `1px solid ${mod.color || "#3b82f6"}40` }}
                      >
                        {mod.icon || "📋"}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-xs font-bold text-white truncate">{mod.name}</h4>
                          {mod.key === "testing" && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-semibold">
                              Testing Staff
                            </span>
                          )}
                          {mod.is_builtin ? (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-700/60 text-slate-400">
                              Built-in
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300">
                              Custom
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 truncate max-w-md">
                          {mod.description || `Module key: ${mod.key}`}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {/* Count Badge */}
                      <span className="text-xs px-2.5 py-1 rounded-lg bg-slate-950 font-mono font-medium text-slate-300 border border-slate-800">
                        {mod.count} leads
                      </span>

                      {/* Navigate button */}
                      {onNavigateToModule && (
                        <button
                          onClick={() => {
                            onNavigateToModule(mod.key);
                            onClose();
                          }}
                          className="px-2.5 py-1 text-xs rounded-lg bg-slate-700/50 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                          title="View this list"
                        >
                          View ↗
                        </button>
                      )}

                      {/* Enable/Disable Toggle */}
                      <button
                        onClick={() => handleToggleEnable(mod)}
                        className={`px-2.5 py-1 text-xs rounded-lg font-medium transition-colors ${
                          mod.is_enabled
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30"
                            : "bg-slate-800 text-slate-400 hover:text-slate-200"
                        }`}
                        title={mod.is_enabled ? "Visible in sidebar (click to hide)" : "Hidden from sidebar (click to show)"}
                      >
                        {mod.is_enabled ? "Shown in Sidebar" : "Hidden"}
                      </button>

                      {/* Delete Custom List */}
                      {!mod.is_builtin && (
                        <button
                          onClick={() => handleDeleteModule(mod)}
                          className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors"
                          title="Delete custom list"
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Create New List */}
        {activeTab === "create" && (
          <form onSubmit={handleCreateModule} className="p-6 overflow-y-auto flex-1 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                List / Module Name *
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Testing, VIP Buyers, Kuwait Importers, Dubai Horeka..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Choose an Icon
              </label>
              <div className="flex flex-wrap gap-2">
                {PRESET_ICONS.map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    onClick={() => setNewIcon(emoji)}
                    className={`w-10 h-10 rounded-xl text-lg flex items-center justify-center transition-all ${
                      newIcon === emoji
                        ? "bg-emerald-500/20 border-2 border-emerald-400 scale-110 shadow-lg"
                        : "bg-slate-800/80 hover:bg-slate-800 border border-slate-700"
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Accent Color
              </label>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    type="button"
                    key={c.hex}
                    onClick={() => setNewColor(c.hex)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-2 border transition-all ${
                      newColor === c.hex
                        ? "border-white scale-105 shadow-md text-white font-bold"
                        : "border-transparent text-slate-400 hover:text-white bg-slate-800"
                    }`}
                    style={{ backgroundColor: newColor === c.hex ? c.hex : undefined }}
                  >
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.hex }} />
                    {c.name}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Description (Optional)
              </label>
              <textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What is this list for? (e.g. Daily testing, Priority accounts, Bulk campaigns)..."
                rows={2}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="pt-2 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setActiveTab("lists")}
                className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating || !newName.trim()}
                className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors flex items-center gap-2 shadow-lg shadow-emerald-900/30"
              >
                {creating ? "Creating..." : "Create List"}
              </button>
            </div>
          </form>
        )}

        {/* Tab 3: Testing List & Staff Members */}
        {activeTab === "testing" && (
          <div className="p-6 overflow-y-auto flex-1 space-y-5">
            {/* Banner */}
            <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-900/40 via-teal-900/30 to-slate-900 border border-emerald-500/30 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <span>🧪</span> Kafi Commodities Staff Testing Module
                </h3>
                <p className="text-xs text-emerald-200/80 mt-0.5">
                  Pre-configured with all Kafi staff numbers and emails so your team can test daily morning bulk email & WhatsApp dispatch safely.
                </p>
              </div>
              <button
                type="button"
                onClick={handleSeedStaff}
                disabled={seedingStaff}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-2 disabled:opacity-50"
              >
                <span>⚡</span> {seedingStaff ? "Syncing..." : "Sync / Add All Staff"}
              </button>
            </div>

            {/* Quick Actions */}
            <div className="flex items-center justify-between text-xs text-slate-400 px-1">
              <span>Add custom test staff number/email to this list:</span>
              {onNavigateToModule && (
                <button
                  onClick={() => {
                    onNavigateToModule("testing");
                    onClose();
                  }}
                  className="text-xs text-emerald-400 hover:text-emerald-300 font-semibold underline flex items-center gap-1"
                >
                  Open "Testing" Table in CRM ↗
                </button>
              )}
            </div>

            {/* Add Custom Test Recipient Form */}
            <form onSubmit={handleAddStaffRecipient} className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Staff Contact Name *
                  </label>
                  <input
                    type="text"
                    value={staffName}
                    onChange={(e) => setStaffName(e.target.value)}
                    placeholder="e.g. Asim / Usman / Khalid"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Designation / Role
                  </label>
                  <input
                    type="text"
                    value={staffDesignation}
                    onChange={(e) => setStaffDesignation(e.target.value)}
                    placeholder="e.g. Sales Executive, Admin"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    WhatsApp / Mobile Number *
                  </label>
                  <input
                    type="text"
                    value={staffMobile}
                    onChange={(e) => setStaffMobile(e.target.value)}
                    placeholder="+923008206633"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Email Address *
                  </label>
                  <input
                    type="email"
                    value={staffEmail}
                    onChange={(e) => setStaffEmail(e.target.value)}
                    placeholder="staff@kafi-group.com"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white focus:outline-none focus:border-emerald-500"
                    required
                  />
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={staffAdding}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {staffAdding ? "Adding..." : "+ Add Staff to Testing List"}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-800 bg-slate-950/80">
          <span className="text-xs text-slate-400">
            Changes to lists and sidebar visibility take effect immediately.
          </span>
          <button
            onClick={onClose}
            className="px-5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
