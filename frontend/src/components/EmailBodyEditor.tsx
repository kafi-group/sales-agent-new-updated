import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { IconPaperclip } from "./icons/AppIcons";
import {
  getComposeDefaultTextColor,
  normalizeEditorTextColor,
} from "../lib/emailTextColor";
import {
  hostDataUriImagesInHtml,
  htmlHasDataUriImages,
  uploadPastedImageFile,
} from "../lib/hostInlineImages";
import { useTheme } from "../theme/ThemeContext";

export type EmailBodyEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  /** Extra class on the editable surface */
  editorClassName?: string;
  /** Optional attach button handler in the toolbar */
  onAttachClick?: () => void;
  /** Optional callback when image files are dropped or pasted and user chooses to attach */
  onAttachFiles?: (files: File[]) => void;
  /** Optional count of attachments to show in the toolbar */
  attachmentCount?: number;
  /** Whether an attachment is currently uploading */
  isUploadingAttachment?: boolean;
  /**
   * Email templates only: remap hard-coded white/black body colors so they
   * stay readable when the app theme toggles light ↔ dark.
   */
  adaptTextToTheme?: boolean;
};

const FONT_SIZES = [
  { label: "Small", value: "2" },
  { label: "Medium", value: "3" },
  { label: "Large", value: "5" },
] as const;

const COLORS = [
  { label: "White", value: "#ffffff" },
  { label: "Black", value: "#111827" },
  { label: "Gray", value: "#4b5563" },
  { label: "Red", value: "#b91c1c" },
  { label: "Blue", value: "#1d4ed8" },
  { label: "Green", value: "#047857" },
] as const;

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value || "");
}

/** Convert plain text (or mixed) into simple HTML for the editor. */
export function plainTextToEditorHtml(text: string): string {
  const raw = text || "";
  if (!raw.trim()) return "";
  if (looksLikeHtml(raw)) return raw;
  return raw
    .split(/\n{2,}/)
    .map((block) => {
      const withBreaks = block
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      return `<p>${withBreaks || "<br>"}</p>`;
    })
    .join("");
}

/** Strip tags for WhatsApp / plain-text fallbacks. */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (!looksLikeHtml(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.innerText || "").replace(/\u00a0/g, " ").trimEnd();
}

export function emailBodyHasContent(html: string): boolean {
  return htmlToPlainText(html).trim().length > 0;
}

/** Append a template placeholder into plain or HTML email body. */
export function appendEmailPlaceholder(body: string, token: string): string {
  const t = (token || "").trim();
  if (!t) return body || "";
  const current = body || "";
  if (!current.trim()) return `<p>${t}</p>`;
  if (looksLikeHtml(current)) {
    return `${current.replace(/\s+$/, "")}<p>${t}</p>`;
  }
  return `${current}${current.endsWith("\n") ? "" : "\n"}${t}`;
}

function ToolbarButton({
  title,
  active,
  disabled,
  onMouseDown,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onMouseDown: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={onMouseDown}
      className={`min-w-8 h-8 px-1.5 rounded-md text-sm font-semibold inline-flex items-center justify-center border transition-colors ${
        active
          ? "bg-slate-700 border-slate-500 text-white"
          : "bg-transparent border-transparent text-slate-300 hover:bg-slate-800 hover:border-slate-700"
      } disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-slate-700 shrink-0" aria-hidden />;
}

/** Collect every image file from a paste or drop (Explorer multi-copy, etc.). No max. */
function collectImageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: File[] = [];
  const push = (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  for (const file of Array.from(data.files || [])) push(file);
  if (out.length === 0) {
    for (const item of Array.from(data.items || [])) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        push(item.getAsFile());
      }
    }
  }
  return out;
}

function imgHtmlTag(url: string, name: string): string {
  const safeName = name.replace(/"/g, "");
  return `<p><img src="${url}" alt="${safeName}" style="max-width: 100%; height: auto; border-radius: 6px; margin: 8px 0; display: block;" /></p>`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
      done += 1;
      onProgress?.(done, total);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export function EmailBodyEditor({
  value,
  onChange,
  placeholder = "Write your message…",
  rows = 10,
  disabled = false,
  className = "",
  editorClassName = "",
  onAttachClick,
  onAttachFiles,
  attachmentCount,
  isUploadingAttachment = false,
  adaptTextToTheme = false,
}: EmailBodyEditorProps) {
  const { theme } = useTheme();
  const editorRef = useRef<HTMLDivElement>(null);
  const lastHtml = useRef<string>("");
  const reactId = useId();
  const multiImageInputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const defaultTextColor = adaptTextToTheme
    ? getComposeDefaultTextColor(theme)
    : "#ffffff";

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [pendingPreviews, setPendingPreviews] = useState<string[]>([]);
  const [imageBusy, setImageBusy] = useState<{ done: number; total: number } | null>(null);
  const savedRangeRef = useRef<Range | null>(null);

  function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }

  function queueImages(files: File[]) {
    if (!files.length) return;
    setPendingPreviews((prev) => {
      for (const url of prev) URL.revokeObjectURL(url);
      return files.map((f) => URL.createObjectURL(f));
    });
    setPendingImages(files);
  }

  function handleDragOver(e: React.DragEvent) {
    if (disabled) return;
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      setIsDraggingOver(true);
    }
  }

  function handleDragLeave() {
    setIsDraggingOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    if (disabled) return;
    setIsDraggingOver(false);
    const files = collectImageFiles(e.dataTransfer);
    if (files.length > 0) {
      e.preventDefault();
      saveSelection();
      queueImages(files);
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (disabled) return;
    const files = collectImageFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      saveSelection();
      queueImages(files);
      return;
    }

    // Rich HTML paste (PRODUCT RANGE, etc.) often embeds data:image — host before insert.
    const htmlClip = e.clipboardData.getData("text/html") || "";
    if (htmlClip && htmlHasDataUriImages(htmlClip)) {
      e.preventDefault();
      saveSelection();
      void (async () => {
        try {
          const hosted = await hostDataUriImagesInHtml(htmlClip);
          insertHtmlAtSelection(hosted);
        } catch (err) {
          console.warn(err);
        }
      })();
    }
  }

  function insertHtmlAtSelection(html: string) {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (savedRangeRef.current && sel) {
      try {
        sel.removeAllRanges();
        sel.addRange(savedRangeRef.current);
        document.execCommand("insertHTML", false, html);
      } catch {
        el.innerHTML += html;
      }
    } else {
      el.innerHTML += html;
    }
    emitChange();
  }

  function closeImageModal() {
    for (const url of pendingPreviews) URL.revokeObjectURL(url);
    setPendingImages([]);
    setPendingPreviews([]);
    setImageBusy(null);
  }

  function handleChooseAttach() {
    if (!pendingImages.length) return;
    if (onAttachFiles) {
      onAttachFiles(pendingImages);
    } else if (onAttachClick) {
      onAttachClick();
    }
    closeImageModal();
  }

  function handleChoosePasteInline() {
    if (!pendingImages.length || imageBusy) return;
    const files = [...pendingImages];
    void (async () => {
      setImageBusy({ done: 0, total: files.length });
      try {
        const urls = await mapPool(
          files,
          4,
          async (file) => {
            const url = await uploadPastedImageFile(file);
            if (url) return { url, name: file.name, file };
            // Fallback data URI for this file only
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ""));
              reader.onerror = () => reject(new Error("read failed"));
              reader.readAsDataURL(file);
            });
            return { url: dataUrl, name: file.name, file };
          },
          (done, total) => setImageBusy({ done, total }),
        );
        const html = urls.map((u) => imgHtmlTag(u.url, u.name)).join("");
        insertHtmlAtSelection(html);
        closeImageModal();
      } catch (err) {
        console.warn(err);
        setImageBusy(null);
      }
    })();
  }

  function handleMultiImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    if (!files.length) return;
    saveSelection();
    queueImages(files);
  }

  // Sync external value → editor (avoid cursor jumps when unchanged).
  // When adaptTextToTheme is on, remap hard-coded colors for the current theme.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const raw = plainTextToEditorHtml(value);
    const next =
      adaptTextToTheme && raw
        ? normalizeEditorTextColor(raw, theme)
        : raw;
    if (next === lastHtml.current) return;
    if (el.innerHTML === next) {
      lastHtml.current = next;
      return;
    }
    el.innerHTML = next || "";
    lastHtml.current = next;
    if (adaptTextToTheme && next !== raw) {
      onChangeRef.current(next);
    }
  }, [value, adaptTextToTheme, theme]);

  /** Uppercase the first letter in the contentEditable document (live typing). */
  function ensureLeadingCapital(root: HTMLElement) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!/\p{L}/u.test(ch)) continue;
        const upper = ch.toLocaleUpperCase("en");
        if (ch === upper) return;
        const sel = window.getSelection();
        const anchorNode = sel?.anchorNode ?? null;
        const anchorOffset = sel?.anchorOffset ?? 0;
        node.textContent = text.slice(0, i) + upper + text.slice(i + 1);
        if (sel && anchorNode && root.contains(anchorNode)) {
          try {
            const range = document.createRange();
            const target = anchorNode === node || anchorNode.parentNode === node
              ? node
              : anchorNode;
            const len = (target.textContent || "").length;
            range.setStart(target, Math.min(anchorOffset, len));
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          } catch {
            /* ignore selection restore failures */
          }
        }
        return;
      }
    }
  }

  function emitChange() {
    const el = editorRef.current;
    if (!el) return;
    ensureLeadingCapital(el);
    const html = el.innerHTML === "<br>" ? "" : el.innerHTML;
    lastHtml.current = html;
    onChange(html);
  }

  function run(command: string, commandValue?: string) {
    if (disabled) return;
    editorRef.current?.focus();
    try {
      document.execCommand(command, false, commandValue);
    } catch {
      /* ignore unsupported commands */
    }
    emitChange();
  }

  function onTool(e: MouseEvent, command: string, commandValue?: string) {
    e.preventDefault();
    run(command, commandValue);
  }

  const minHeight = Math.max(8, rows) * 1.5;

  return (
    <div
      className={`rounded-lg border border-slate-700 bg-slate-950 overflow-hidden ${className}`}
    >
      <div
        className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-slate-800 bg-slate-900/80"
        role="toolbar"
        aria-label="Text formatting"
      >
        <label className="sr-only" htmlFor={`${reactId}-size`}>
          Font size
        </label>
        <select
          id={`${reactId}-size`}
          disabled={disabled}
          defaultValue="3"
          title="Font size"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => run("fontSize", e.target.value)}
          className="h-8 rounded-md bg-slate-950 border border-slate-700 text-xs text-slate-200 px-1.5 mr-0.5"
        >
          {FONT_SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <Divider />

        <ToolbarButton title="Bold" disabled={disabled} onMouseDown={(e) => onTool(e, "bold")}>
          <span className="font-bold">B</span>
        </ToolbarButton>
        <ToolbarButton title="Italic" disabled={disabled} onMouseDown={(e) => onTool(e, "italic")}>
          <span className="italic font-serif">I</span>
        </ToolbarButton>
        <ToolbarButton
          title="Underline"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "underline")}
        >
          <span className="underline">U</span>
        </ToolbarButton>

        <label className="sr-only" htmlFor={`${reactId}-color`}>
          Text color
        </label>
        <select
          key={adaptTextToTheme ? `color-${theme}` : "color"}
          id={`${reactId}-color`}
          disabled={disabled}
          defaultValue={defaultTextColor}
          title="Text color"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => run("foreColor", e.target.value)}
          className="h-8 rounded-md bg-slate-950 border border-slate-700 text-xs text-slate-200 px-1.5"
        >
          {COLORS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        <Divider />

        <ToolbarButton
          title="Align left"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyLeft")}
        >
          <AlignIcon align="left" />
        </ToolbarButton>
        <ToolbarButton
          title="Align center"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyCenter")}
        >
          <AlignIcon align="center" />
        </ToolbarButton>
        <ToolbarButton
          title="Align right"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyRight")}
        >
          <AlignIcon align="right" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton
          title="Numbered list"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "insertOrderedList")}
        >
          <span className="text-[11px] tracking-tight">1.</span>
        </ToolbarButton>
        <ToolbarButton
          title="Bullet list"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "insertUnorderedList")}
        >
          <span className="text-base leading-none">•</span>
        </ToolbarButton>

        <Divider />
        <input
          ref={multiImageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleMultiImagePick}
        />
        <ToolbarButton
          title="Add many images at once (no limit)"
          disabled={disabled || !!imageBusy}
          onMouseDown={(e) => {
            e.preventDefault();
            saveSelection();
            multiImageInputRef.current?.click();
          }}
        >
          <span className="text-[11px] font-semibold whitespace-nowrap px-0.5">+ Images</span>
        </ToolbarButton>

        {onAttachClick && (
          <>
            <Divider />
            <button
              type="button"
              title="Attach Document / Files"
              disabled={disabled || isUploadingAttachment}
              onMouseDown={(e) => {
                e.preventDefault();
                onAttachClick();
              }}
              className="h-8 px-2.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 transition-colors cursor-pointer disabled:opacity-40 ml-auto"
            >
              <IconPaperclip size="xs" className="text-emerald-400" />
              <span>{isUploadingAttachment ? "Attaching…" : "Attach file"}</span>
              {attachmentCount != null && attachmentCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/30 border border-emerald-400/50 text-[10px] text-white font-bold">
                  {attachmentCount}
                </span>
              )}
            </button>
          </>
        )}
      </div>

      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emitChange}
        onBlur={emitChange}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
        className={`email-body-editor w-full px-3 py-2 text-sm outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-slate-600 transition-colors ${
          isDraggingOver ? "bg-emerald-950/20 ring-2 ring-emerald-500/50" : ""
        } ${editorClassName}`}
        style={{ minHeight: `${minHeight}rem`, color: defaultTextColor }}
      />

      {pendingImages.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl space-y-4"
            role="dialog"
            aria-labelledby="image-choice-title"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h4 id="image-choice-title" className="text-sm font-semibold text-white">
                  Add {pendingImages.length} image{pendingImages.length === 1 ? "" : "s"} to email
                </h4>
                <p className="text-xs text-slate-400 mt-0.5">
                  {pendingImages.length === 1
                    ? pendingImages[0].name
                    : `${pendingImages.length} files selected — paste or attach all at once (no limit)`}
                </p>
              </div>
              <button
                type="button"
                onClick={closeImageModal}
                disabled={!!imageBusy}
                className="text-slate-400 hover:text-white text-lg leading-none disabled:opacity-40"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {pendingPreviews.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-2">
                <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
                  {pendingPreviews.slice(0, 20).map((src, i) => (
                    <div
                      key={`${src}-${i}`}
                      className="aspect-square rounded-md border border-slate-800 bg-slate-900 flex items-center justify-center overflow-hidden"
                      title={pendingImages[i]?.name}
                    >
                      <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                    </div>
                  ))}
                </div>
                {pendingPreviews.length > 20 ? (
                  <p className="text-[11px] text-slate-500 mt-2 text-center">
                    +{pendingPreviews.length - 20} more not shown in preview
                  </p>
                ) : null}
              </div>
            )}

            {imageBusy ? (
              <p className="text-xs text-emerald-300 font-medium">
                Uploading {imageBusy.done}/{imageBusy.total}…
              </p>
            ) : (
              <p className="text-xs text-slate-300">
                How would you like to add{" "}
                {pendingImages.length === 1 ? "this image" : "these images"}?
              </p>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleChooseAttach}
                disabled={!!imageBusy || (!onAttachFiles && !onAttachClick)}
                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 hover:border-slate-600 text-slate-100 text-xs font-medium transition cursor-pointer disabled:opacity-40"
              >
                <span className="text-xl">📎</span>
                <span className="font-semibold">
                  Attach all as files
                </span>
                <span className="text-[10px] text-slate-400">
                  {pendingImages.length} attachment{pendingImages.length === 1 ? "" : "s"}
                </span>
              </button>
              <button
                type="button"
                onClick={handleChoosePasteInline}
                disabled={!!imageBusy}
                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border border-emerald-500/50 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-200 text-xs font-semibold transition cursor-pointer disabled:opacity-40"
              >
                <span className="text-xl">🖼️</span>
                <span className="font-semibold">
                  {imageBusy ? "Inserting…" : "Paste all in body"}
                </span>
                <span className="text-[10px] text-emerald-300/70">Insert all inline images</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AlignIcon({ align }: { align: "left" | "center" | "right" }) {
  const widths =
    align === "left"
      ? ["w-3.5", "w-2.5", "w-3", "w-2"]
      : align === "right"
        ? ["w-3.5 ml-auto", "w-2.5 ml-auto", "w-3 ml-auto", "w-2 ml-auto"]
        : ["w-3.5 mx-auto", "w-2.5 mx-auto", "w-3 mx-auto", "w-2 mx-auto"];
  return (
    <span className="flex flex-col gap-0.5 w-3.5" aria-hidden>
      {widths.map((w, i) => (
        <span key={i} className={`block h-0.5 rounded-full bg-current ${w}`} />
      ))}
    </span>
  );
}
