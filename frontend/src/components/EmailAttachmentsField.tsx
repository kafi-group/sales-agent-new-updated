import { useRef, useState } from "react";
import { client, type EmailAttachment } from "../api/client";
import { IconBookOpen, IconPaperclip } from "./icons/AppIcons";
import { AttachCatalogueModal } from "./AttachCatalogueModal";
import { AttachCnfCardModal } from "./AttachCnfCardModal";

interface EmailAttachmentsFieldProps {
  attachments: EmailAttachment[];
  onChange: (attachments: EmailAttachment[]) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmailAttachmentsField({
  attachments,
  onChange,
  disabled = false,
  label = "Attachments",
  hint = "PDF, Office, ZIP, images — up to ~10 MB each (email encoding adds ~33%). Larger files often bounce as spam even when upload works. Executables blocked. Max 8 files.",
}: EmailAttachmentsFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAttachCatalogue, setShowAttachCatalogue] = useState(false);
  const [showAttachCnf, setShowAttachCnf] = useState(false);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList?.length || disabled) return;
    setError(null);
    setUploading(true);
    setUploadPercent(0);
    setUploadLabel("Preparing upload…");
    const next = [...attachments];
    try {
      for (const file of Array.from(fileList)) {
        if (next.length >= 8) {
          setError("Maximum 8 attachments per email.");
          break;
        }
        const uploaded = await client.uploadEmailAttachment(file, {
          onProgress: ({ percent, label: progressLabel }) => {
            setUploadPercent(percent);
            setUploadLabel(progressLabel);
          },
        });
        next.push(uploaded);
      }
      onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadPercent(0);
      setUploadLabel(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function removeAttachment(id: string) {
    onChange(attachments.filter((a) => a.id !== id));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-300">{label}</span>
          {attachments.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300 font-semibold">
              {attachments.length} attached
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            disabled={disabled || uploading || attachments.length >= 8}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 disabled:opacity-50 transition cursor-pointer"
          >
            <IconPaperclip size="xs" className="text-emerald-400" />
            <span>{uploading ? "Attaching…" : "+ Files"}</span>
          </button>
          <button
            type="button"
            disabled={disabled || uploading || attachments.length >= 8}
            onClick={() => setShowAttachCatalogue(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 disabled:opacity-50 transition cursor-pointer"
          >
            <IconBookOpen size="xs" className="text-emerald-400" />
            <span>+ Catalogue</span>
          </button>
          <button
            type="button"
            disabled={disabled || uploading || attachments.length >= 8}
            onClick={() => setShowAttachCnf(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-800/60 text-xs font-medium text-cyan-300 disabled:opacity-50 transition cursor-pointer"
          >
            <span>🏷️</span>
            <span>+ Live Price Card</span>
          </button>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
      {uploading && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs text-emerald-200">
            <span className="truncate min-w-0">
              {uploadLabel || "Uploading attachment(s)…"}
            </span>
            <span className="font-mono font-semibold shrink-0 tabular-nums">
              {uploadPercent}%
            </span>
          </div>
          <div
            className="h-2 rounded-full bg-slate-950/60 overflow-hidden border border-emerald-500/20"
            role="progressbar"
            aria-valuenow={uploadPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-emerald-400 transition-[width] duration-300 ease-out"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="rounded-xl border border-emerald-500/30 bg-slate-900/90 p-2.5 space-y-2">
          <div className="flex flex-wrap gap-2">
            {attachments.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-emerald-500/30 text-xs text-slate-100 shadow-sm"
              >
                <IconPaperclip size="xs" className="text-emerald-400 shrink-0" />
                <span className="font-medium max-w-[220px] truncate" title={file.filename}>
                  {file.filename}
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  ({formatSize(file.size)})
                </span>
                <span className="text-[10px] text-emerald-400 font-medium bg-emerald-500/15 px-1.5 py-0.5 rounded border border-emerald-500/30">
                  ✓ Attached
                </span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeAttachment(file.id)}
                    className="text-slate-400 hover:text-rose-400 transition ml-1 p-0.5 rounded cursor-pointer"
                    title={`Remove ${file.filename}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {showAttachCatalogue && (
        <AttachCatalogueModal
          onClose={() => setShowAttachCatalogue(false)}
          onAttach={(newAtts) => onChange([...attachments, ...newAtts])}
          onError={(msg) => setError(msg)}
        />
      )}
      {showAttachCnf && (
        <AttachCnfCardModal
          onClose={() => setShowAttachCnf(false)}
          onAttach={(newAtts) => onChange([...attachments, ...newAtts])}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}
