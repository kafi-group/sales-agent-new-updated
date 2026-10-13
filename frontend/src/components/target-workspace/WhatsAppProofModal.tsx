import React, { useState } from "react";
import type { WorkspaceLeadItem } from "../../api/client";

interface WhatsAppProofModalProps {
  lead: WorkspaceLeadItem | null;
  isOpen: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onSave: (data: {
    buyer_id: number;
    whatsapp_call_tried: boolean;
    whatsapp_call_proof: string;
  }) => Promise<void>;
}

export const WhatsAppProofModal: React.FC<WhatsAppProofModalProps> = ({
  lead,
  isOpen,
  isAdmin,
  onClose,
  onSave,
}) => {
  const [tried, setTried] = useState(lead?.whatsapp_call_tried ?? true);
  const [proofText, setProofText] = useState(lead?.whatsapp_call_proof ?? "");
  const [isSaving, setIsSaving] = useState(false);

  React.useEffect(() => {
    if (lead) {
      setTried(lead.whatsapp_call_tried ?? true);
      setProofText(lead.whatsapp_call_proof ?? "");
    }
  }, [lead]);

  if (!isOpen || !lead) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        buyer_id: lead.id,
        whatsapp_call_tried: tried,
        whatsapp_call_proof: proofText.trim(),
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-700/80 shadow-2xl p-6 text-slate-100">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 text-lg">
              💬
            </span>
            <div>
              <h3 className="text-base font-bold text-white">WhatsApp Outreach & Call Verification</h3>
              <p className="text-xs text-slate-400">
                {lead.company_name} • {lead.country || "Global"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
          >
            ✕
          </button>
        </div>

        <div className="my-4 space-y-4 text-xs">
          {/* Status Box */}
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
            <div>
              <span className="font-medium text-slate-200 block">Did rep attempt WhatsApp Call/Message?</span>
              <span className="text-[11px] text-slate-400">
                {isAdmin ? "Admin Audit Mode: Verify proof entered by sales agent." : "Logged for admin audit trail & verification."}
              </span>
            </div>
            <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-lg border border-slate-700">
              <button
                type="button"
                onClick={() => setTried(true)}
                className={`px-3 py-1 rounded-md font-semibold transition ${
                  tried ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setTried(false)}
                className={`px-3 py-1 rounded-md font-semibold transition ${
                  !tried ? "bg-rose-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                No
              </button>
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">
              Call Proof / Verification Details {tried && <span className="text-amber-400">*</span>}
            </label>
            <textarea
              rows={3}
              placeholder="e.g. Ringing but no answer / Left voice note at 11:30 AM / Screenshot proof on file..."
              value={proofText}
              onChange={(e) => setProofText(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              Mr. Khalid (Admin) can inspect this proof in the rep's lifecycle history.
            </p>
          </div>

          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] space-y-1">
            <div className="text-slate-400 font-medium">Contact Details:</div>
            <div className="text-slate-300">
              Phone: <strong className="text-white font-mono">{lead.primary_phone || "Not recorded"}</strong>
            </div>
            <div className="text-slate-300">
              Person: <strong className="text-white">{lead.contact_person || "Unknown"}</strong> ({lead.designation || "N/A"})
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-lg shadow-emerald-900/30 transition flex items-center gap-1.5"
          >
            {isSaving ? "Saving..." : "✓ Save & Verify Proof"}
          </button>
        </div>
      </div>
    </div>
  );
};
