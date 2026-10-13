import { useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CustomLeadModule } from "../api/client";

export type MasterMoveSection =
  | { mode: "keep" }
  | { mode: "existing"; key: string }
  | { mode: "new"; name: string };

interface MoveToMasterListModalProps {
  count: number;
  fromLabel: string;
  toLabel: string;
  /** User-created lists the leads can be put into (built-in lists are not offered). */
  lists: CustomLeadModule[];
  busy?: boolean;
  onConfirm: (section: MasterMoveSection) => void;
  onCancel: () => void;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Asks where the moved leads should go inside the new master list, so they do not get mixed into
 * its existing clients: keep their section, an existing list, or a brand-new list (named after the
 * master list they came from by default, e.g. "Minerals and Ores").
 */
export function MoveToMasterListModal({
  count,
  fromLabel,
  toLabel,
  lists,
  busy = false,
  onConfirm,
  onCancel,
}: MoveToMasterListModalProps) {
  const titleId = useId();
  const cameFromFmcg = /fmcg/i.test(fromLabel);
  const sameNamed = useMemo(() => lists.find((l) => sameName(l.name, fromLabel)), [lists, fromLabel]);

  const [mode, setMode] = useState<MasterMoveSection["mode"]>(
    cameFromFmcg ? "keep" : sameNamed ? "existing" : "new",
  );
  const [existingKey, setExistingKey] = useState(sameNamed?.key || lists[0]?.key || "");
  const [newName, setNewName] = useState(cameFromFmcg ? "" : fromLabel);

  const canConfirm =
    !busy &&
    (mode === "keep" || (mode === "existing" && existingKey) || (mode === "new" && newName.trim().length > 0));

  function confirm() {
    if (!canConfirm) return;
    if (mode === "keep") onConfirm({ mode: "keep" });
    else if (mode === "existing") onConfirm({ mode: "existing", key: existingKey });
    else onConfirm({ mode: "new", name: newName.trim() });
  }

  const option = (value: MasterMoveSection["mode"], title: string, hint: string, children?: ReactNode) => (
    <label
      className={`block rounded-xl border px-4 py-3 cursor-pointer transition ${
        mode === value ? "border-emerald-500/60 bg-emerald-500/10" : "border-slate-700 hover:border-slate-600"
      }`}
    >
      <span className="flex items-start gap-3">
        <input
          type="radio"
          name="master-move-section"
          checked={mode === value}
          onChange={() => setMode(value)}
          className="mt-1"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-100">{title}</span>
          <span className="block text-xs text-slate-400 mt-0.5">{hint}</span>
          {mode === value ? children : null}
        </span>
      </span>
    </label>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
      onClick={busy ? undefined : onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="px-5 py-4 border-b border-slate-800">
          <h3 id={titleId} className="text-base font-semibold text-slate-100">
            Move {count} lead{count === 1 ? "" : "s"} to “{toLabel}”
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            From “{fromLabel}”. Contacts, emails, calls, WhatsApp history and assignments stay with each
            lead. You can move them back the same way.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Where should they go in {toLabel}?</p>
          {option(
            "new",
            "A new list",
            "Creates a list in the sidebar so these leads stay together and easy to find.",
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={60}
              placeholder="List name"
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              autoFocus
            />,
          )}
          {lists.length > 0
            ? option(
                "existing",
                "An existing list",
                "Put them into a list you already created.",
                <select
                  value={existingKey}
                  onChange={(e) => setExistingKey(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                >
                  {lists.map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.icon || "📋"} {l.name}
                    </option>
                  ))}
                </select>,
              )
            : null}
          {option(
            "keep",
            "Keep their current section",
            "They stay in the same section (for example Old clients), mixed with what is already there.",
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-slate-700 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Moving…" : `Move ${count} lead${count === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
