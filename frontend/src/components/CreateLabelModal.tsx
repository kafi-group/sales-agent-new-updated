import { useState } from "react";
import { ActionButton } from "./ui/ActionButton";
import { IconTag, IconX } from "./icons/AppIcons";

interface CreateLabelModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    domain: string;
    keyword: string;
  }) => Promise<void>;
  creating?: boolean;
}

export function CreateLabelModal({
  open,
  onClose,
  onCreate,
  creating = false,
}: CreateLabelModalProps) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [keyword, setKeyword] = useState("");

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await onCreate({ name: name.trim(), domain: domain.trim(), keyword: keyword.trim() });
    setName("");
    setDomain("");
    setKeyword("");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 shadow-xl p-5 space-y-4"
        role="dialog"
        aria-labelledby="create-label-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="create-label-title" className="text-base font-medium text-slate-100">
              Create label
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Set domain and/or keyword — label name alone does not route mail.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            <IconX size="sm" />
          </button>
        </div>
        <form className="space-y-3" onSubmit={(e) => void handleSubmit(e)}>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Label name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              placeholder="e.g. LinkedIn"
              autoFocus
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Domain / email</span>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              placeholder="e.g. kafi-group.com"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Keyword</span>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              placeholder="e.g. KAFI"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <ActionButton type="button" icon={IconX} variant="ghost" size="md" onClick={onClose}>
              Cancel
            </ActionButton>
            <ActionButton
              icon={IconTag}
              type="submit"
              size="md"
              disabled={creating || !name.trim() || (!domain.trim() && !keyword.trim())}
            >
              {creating ? "Creating…" : "Create label"}
            </ActionButton>
          </div>
        </form>
      </div>
    </div>
  );
}
