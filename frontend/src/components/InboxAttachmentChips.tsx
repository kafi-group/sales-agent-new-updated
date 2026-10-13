import { useState } from "react";
import { client, type InboxMessageDetail } from "../api/client";
import { IconDownload } from "./icons/AppIcons";

interface InboxAttachmentChipsProps {
  message: InboxMessageDetail;
  mailboxUserId?: number | null;
  onError: (message: string) => void;
  className?: string;
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The files attached to a received message — click one to download it. */
export function InboxAttachmentChips({
  message,
  mailboxUserId,
  onError,
  className = "mt-2 flex flex-wrap gap-1.5",
}: InboxAttachmentChipsProps) {
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return null;

  async function download(index: number, filename: string) {
    if (busyIndex !== null) return;
    setBusyIndex(index);
    try {
      const blob = await client.fetchInboxAttachmentBlob(
        message.uid,
        index,
        message.folder || "INBOX",
        mailboxUserId,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not download the attachment");
    } finally {
      setBusyIndex(null);
    }
  }

  return (
    <div className={className}>
      {attachments.map((a, idx) => {
        const name = a.filename || `attachment-${idx + 1}`;
        const size = formatSize(a.size);
        const busy = busyIndex === idx;
        return (
          <button
            key={`${name}-${idx}`}
            type="button"
            onClick={() => void download(idx, name)}
            disabled={busyIndex !== null}
            title={`Download ${name}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded border border-slate-700 bg-slate-950/60 px-2 py-1 text-[11px] text-slate-300 hover:border-emerald-500/50 hover:text-emerald-200 disabled:opacity-60"
          >
            <IconDownload size="xs" className="shrink-0" />
            <span className="truncate">{busy ? "Downloading…" : name}</span>
            {size && !busy ? <span className="shrink-0 text-slate-500">{size}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
