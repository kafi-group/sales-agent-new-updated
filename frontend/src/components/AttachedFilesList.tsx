import { IconPaperclip } from "./icons/AppIcons";
import type { EmailAttachment } from "../api/client";

interface AttachedFilesListProps {
  attachments: EmailAttachment[];
  onRemove: (id: string) => void;
  onClearAll?: () => void;
  uploading?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachedFilesList({
  attachments,
  onRemove,
  onClearAll,
  uploading = false,
}: AttachedFilesListProps) {
  if (attachments.length === 0 && !uploading) return null;

  return (
    <div className="rounded-xl border border-emerald-500/40 bg-slate-900/90 p-3 space-y-2.5 shadow-sm">
      {uploading && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-200 animate-pulse">
          <div className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <span>Uploading attachment(s)… Please wait</span>
        </div>
      )}

      {attachments.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-1.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
              <span className="flex items-center justify-center w-5 h-5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <IconPaperclip size="xs" />
              </span>
              <span>
                Attached Documents ({attachments.length})
              </span>
              <span className="text-[11px] font-normal text-slate-400 hidden sm:inline">
                — Ready to send with this email
              </span>
            </div>
            {onClearAll && attachments.length > 1 && (
              <button
                type="button"
                onClick={onClearAll}
                className="text-[11px] text-slate-400 hover:text-rose-400 transition cursor-pointer"
              >
                Clear all ({attachments.length})
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-2 pt-0.5">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="group flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/90 border border-emerald-500/30 hover:border-emerald-500/60 shadow-sm text-xs text-slate-100 transition"
              >
                <IconPaperclip size="xs" className="text-emerald-400 shrink-0" />
                <span
                  className="font-medium max-w-[200px] sm:max-w-[260px] truncate text-slate-100"
                  title={att.filename}
                >
                  {att.filename}
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  ({formatSize(att.size)})
                </span>
                <span className="text-[10px] text-emerald-400 font-medium bg-emerald-500/15 px-1.5 py-0.5 rounded border border-emerald-500/30">
                  ✓ Attached
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(att.id)}
                  className="text-slate-400 hover:text-rose-400 transition ml-1 p-0.5 rounded hover:bg-slate-700/80 cursor-pointer"
                  title={`Remove ${att.filename}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
