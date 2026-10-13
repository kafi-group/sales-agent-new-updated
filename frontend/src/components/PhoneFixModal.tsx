import { useState } from "react";
import type { PhoneZeroCheckResult } from "../utils/phoneUtils";

interface PhoneFixModalProps {
  checkResult: PhoneZeroCheckResult;
  contactName?: string;
  onFixAutoAndCall: (correctedPhone: string) => void;
  onFixManualAndCall: (editedPhone: string) => void;
  onCancel: () => void;
}

export function PhoneFixModal({
  checkResult,
  contactName,
  onFixAutoAndCall,
  onFixManualAndCall,
  onCancel,
}: PhoneFixModalProps) {
  const [editedPhone, setEditedPhone] = useState(checkResult.correctedPhone);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-amber-500/50 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 text-slate-100">
        <div className="flex items-center gap-3 text-amber-400 border-b border-slate-800 pb-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <h3 className="text-lg font-bold">Invalid Phone Country Code</h3>
            <p className="text-xs text-amber-300/80">Leading zero detected after country code</p>
          </div>
        </div>

        <p className="text-sm text-slate-300 leading-relaxed">
          The contact number <strong className="text-rose-400 font-mono">{checkResult.originalPhone}</strong> {contactName ? `for ${contactName}` : ""} contains an invalid <strong className="text-amber-300">0</strong> right after country code <span className="font-mono bg-slate-800 px-1.5 py-0.5 rounded text-amber-300">+{checkResult.dialCode}</span>, which makes it impossible to place the call.
        </p>

        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 space-y-2">
          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
            Suggested Clean Number (or edit manually below):
          </label>
          <input
            type="text"
            value={editedPhone}
            onChange={(e) => setEditedPhone(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 font-mono text-base focus:outline-none focus:border-amber-400"
          />
        </div>

        <div className="flex flex-col gap-2.5 pt-2">
          <button
            type="button"
            onClick={() => onFixAutoAndCall(checkResult.correctedPhone)}
            className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2.5 px-4 rounded-xl shadow-lg shadow-amber-500/20 transition flex items-center justify-center gap-2 text-sm"
          >
            <span>⚡ Fix Automatically & Place Call</span>
          </button>

          {editedPhone !== checkResult.correctedPhone && (
            <button
              type="button"
              onClick={() => onFixManualAndCall(editedPhone)}
              className="w-full bg-sky-600 hover:bg-sky-500 text-white font-semibold py-2.5 px-4 rounded-xl shadow transition text-sm"
            >
              <span>Use Edited Number ({editedPhone}) & Call</span>
            </button>
          )}

          <button
            type="button"
            onClick={onCancel}
            className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-2 px-4 rounded-xl transition text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
