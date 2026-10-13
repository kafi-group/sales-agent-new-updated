import React, { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { OutreachFunnelView } from "../components/target-workspace/OutreachFunnelView";
import { InboundDealsView } from "../components/target-workspace/InboundDealsView";
import { AdminTargetManagerView } from "../components/target-workspace/AdminTargetManagerView";

interface TargetWorkspacePageProps {
  onOpenCall?: (phone: string, companyName: string, leadId?: number) => void;
  onOpenEmailComposer?: (email: string, companyName: string, contactName?: string) => void;
  onEditLead?: (leadId: number, companyName: string) => void;
  onError?: (message: string) => void;
  /** Active Master List — workspace outreach is scoped to this pool. */
  masterType?: string;
}

export const TargetWorkspacePage: React.FC<TargetWorkspacePageProps> = ({
  onOpenCall,
  onOpenEmailComposer,
  onEditLead,
  onError,
  masterType = "fmcg",
}) => {
  const { user, isAdmin } = useAuth();
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<"outreach" | "inbound" | "admin">("outreach");

  const [selectedDay, setSelectedDay] = useState<string>(() => {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    return days[new Date().getDay()] || "friday";
  });

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="h-10 w-10 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-xl shadow-lg shadow-emerald-950">
            🎯
          </div>
          <div>
            <h1 className="text-2xl font-black text-white tracking-tight">
              Target and Workspace
            </h1>
            <p className="text-xs text-slate-400">
              International daily sales workspace, day-wise country target schedules, and the 4-stage outreach funnel.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto bg-slate-900/90 p-1.5 rounded-2xl border border-slate-800 shadow-inner">
          <button
            type="button"
            onClick={() => setActiveWorkspaceTab("outreach")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeWorkspaceTab === "outreach"
                ? "bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-950"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
            }`}
          >
            <span>🎯</span>
            <span>Outreach Funnel</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveWorkspaceTab("inbound")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeWorkspaceTab === "inbound"
                ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-indigo-950"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
            }`}
          >
            <span>⚡</span>
            <span>Interested/Potential</span>
          </button>

          {isAdmin && (
            <button
              type="button"
              onClick={() => setActiveWorkspaceTab("admin")}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 whitespace-nowrap ${
                activeWorkspaceTab === "admin"
                  ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-md shadow-purple-950"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              <span>⚙️</span>
              <span>Target & Schedule Admin</span>
            </button>
          )}
        </div>
      </div>

      {activeWorkspaceTab === "outreach" && (
        <OutreachFunnelView
          currentUser={user}
          isAdmin={isAdmin}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          masterType={masterType}
          onOpenCall={onOpenCall}
          onOpenEmailComposer={onOpenEmailComposer}
          onEditLead={onEditLead}
          onError={onError}
        />
      )}

      {activeWorkspaceTab === "inbound" && (
        <InboundDealsView onOpenEmailComposer={onOpenEmailComposer} />
      )}

      {activeWorkspaceTab === "admin" && <AdminTargetManagerView />}
    </div>
  );
};
