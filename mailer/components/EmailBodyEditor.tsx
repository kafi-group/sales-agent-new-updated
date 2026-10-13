"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { normalizeEditorTextColor, getComposeDefaultTextColor, getMailerUiTheme } from "../lib/emailTextColor";
import {
  hostDataUriImagesInBrowser,
  htmlHasDataUriImages,
  uploadPastedImageFile,
} from "../lib/hostInlineImagesClient";

export type EmailBodyEditorHandle = {
  /** Insert a hosted image at the last cursor position in the body. */
  insertPicture: (url: string, filename?: string) => void;
  /**
   * Insert an HTML block (e.g. the signature) as its own block at the last cursor
   * position. An empty line is replaced; otherwise the block goes right after the
   * paragraph holding the cursor. Existing message text is never modified.
   */
  insertBlock: (html: string) => void;
  focus: () => void;
};

export type EmailBodyEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
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

export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (!looksLikeHtml(html)) return html;
  if (typeof DOMParser === "undefined") {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trimEnd();
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.innerText || "").replace(/\u00a0/g, " ").trimEnd();
}

export function emailBodyHasContent(html: string): boolean {
  return htmlToPlainText(html).trim().length > 0;
}

function ToolbarButton({
  title,
  disabled,
  onMouseDown,
  children,
}: {
  title: string;
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
      className="rte-tool"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="rte-divider" aria-hidden />;
}

function imgHtml(url: string, filename: string): string {
  const safeUrl = url.replace(/"/g, "");
  const safeName = (filename || "image").replace(/"/g, "");
  return `<p><img src="${safeUrl}" alt="${safeName}" style="max-width:100%;height:auto;border-radius:6px;margin:8px 0;display:block;" /></p>`;
}

export const EmailBodyEditor = forwardRef<EmailBodyEditorHandle, EmailBodyEditorProps>(
  function EmailBodyEditor(
    {
      value,
      onChange,
      placeholder = "Write your message…",
      rows = 10,
      disabled = false,
      className = "",
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    const lastHtml = useRef<string>("");
    const savedRange = useRef<Range | null>(null);
    const reactId = useId();
    const [pasteStatus, setPasteStatus] = useState<string | null>(null);
    const [uiTheme, setUiTheme] = useState<"dark" | "light">("dark");
    const [activeColor, setActiveColor] = useState("#ffffff");

    useEffect(() => {
      const theme = getMailerUiTheme();
      setUiTheme(theme);
      setActiveColor(getComposeDefaultTextColor(theme));
    }, []);

    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      const next = normalizeEditorTextColor(plainTextToEditorHtml(value), uiTheme);
      if (next === lastHtml.current) return;
      if (el.innerHTML === next) {
        lastHtml.current = next;
        return;
      }
      el.innerHTML = next || "";
      lastHtml.current = next;
    }, [value, uiTheme]);

    function saveSelection() {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      savedRange.current = range.cloneRange();
    }

    function restoreSelection() {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      if (savedRange.current) {
        try {
          sel.removeAllRanges();
          sel.addRange(savedRange.current);
          return;
        } catch {
          /* range may be stale after DOM rewrite */
        }
      }
      // Fallback: caret at end
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function emitChange() {
      const el = editorRef.current;
      if (!el) return;
      const html = el.innerHTML === "<br>" ? "" : el.innerHTML;
      lastHtml.current = html;
      onChange(html);
      saveSelection();
    }

    function insertHtmlAtCursor(html: string) {
      const el = editorRef.current;
      if (!el) return;
      restoreSelection();
      const themed = normalizeEditorTextColor(html, uiTheme);
      try {
        document.execCommand("insertHTML", false, themed);
      } catch {
        el.innerHTML += themed;
      }
      emitChange();
      saveSelection();
    }

    function insertBlockAtCursor(html: string) {
      const el = editorRef.current;
      if (!el) return;
      const tpl = document.createElement("template");
      tpl.innerHTML = normalizeEditorTextColor(html, uiTheme);
      const frag = tpl.content;

      // Find the top-level block that holds the last saved cursor.
      let block: Node | null = null;
      const range = savedRange.current;
      if (range && el.contains(range.startContainer)) {
        block = range.startContainer;
        while (block && block.parentNode !== el) block = block.parentNode;
      }

      if (!block || block === el) {
        el.appendChild(frag); // cursor never placed → bottom of the body
      } else {
        const isEmptyLine =
          block.nodeType === Node.ELEMENT_NODE &&
          (block.textContent || "").trim() === "" &&
          !(block as Element).querySelector("img");
        if (isEmptyLine) el.replaceChild(frag, block);
        else el.insertBefore(frag, block.nextSibling);
      }
      savedRange.current = null;
      emitChange();
    }

    useImperativeHandle(ref, () => ({
      insertBlock(html: string) {
        if (disabled || !html) return;
        insertBlockAtCursor(html);
      },
      insertPicture(url: string, filename = "image") {
        if (disabled || !url) return;
        insertHtmlAtCursor(imgHtml(url, filename));
      },
      focus() {
        editorRef.current?.focus();
      },
    }));

    async function onPaste(e: ClipboardEvent<HTMLDivElement>) {
      if (disabled) return;
      const items = Array.from(e.clipboardData?.items || []);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));

      if (imageItems.length) {
        e.preventDefault();
        setPasteStatus("Uploading pasted image…");
        try {
          for (const item of imageItems) {
            const file = item.getAsFile();
            if (!file) continue;
            const url = await uploadPastedImageFile(file);
            if (!url) {
              setPasteStatus("Could not upload image — stay signed in and try again.");
              return;
            }
            insertHtmlAtCursor(imgHtml(url, file.name || "image"));
          }
          setPasteStatus(null);
        } catch (err) {
          setPasteStatus(err instanceof Error ? err.message : "Image paste failed");
        }
        return;
      }

      const htmlClip = e.clipboardData?.getData("text/html") || "";
      if (htmlClip && htmlHasDataUriImages(htmlClip)) {
        e.preventDefault();
        setPasteStatus("Uploading pasted images…");
        try {
          const hosted = await hostDataUriImagesInBrowser(htmlClip);
          insertHtmlAtCursor(hosted);
          setPasteStatus(
            htmlHasDataUriImages(hosted)
              ? "Some images could not upload — try again or use the picture library."
              : null,
          );
        } catch (err) {
          setPasteStatus(err instanceof Error ? err.message : "Image paste failed");
        }
      }
    }

    function run(command: string, commandValue?: string) {
      if (disabled) return;
      editorRef.current?.focus();
      try {
        document.execCommand(command, false, commandValue);
      } catch {
        /* ignore */
      }
      emitChange();
    }

    function onTool(e: MouseEvent, command: string, commandValue?: string) {
      e.preventDefault();
      run(command, commandValue);
    }

    function onColorChange(next: string) {
      setActiveColor(next);
      run("foreColor", next);
    }

    const minHeight = Math.max(8, rows) * 1.5;
    const editorColor = getComposeDefaultTextColor(uiTheme);

    return (
      <div className={`rte ${className}`.trim()}>
        <div className="rte-toolbar" role="toolbar" aria-label="Text formatting">
          <select
            id={`${reactId}-size`}
            disabled={disabled}
            defaultValue="3"
            title="Font size"
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => run("fontSize", e.target.value)}
            className="rte-select"
          >
            {FONT_SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <Divider />

          <ToolbarButton title="Bold" disabled={disabled} onMouseDown={(e) => onTool(e, "bold")}>
            <strong>B</strong>
          </ToolbarButton>
          <ToolbarButton title="Italic" disabled={disabled} onMouseDown={(e) => onTool(e, "italic")}>
            <em>I</em>
          </ToolbarButton>
          <ToolbarButton
            title="Underline"
            disabled={disabled}
            onMouseDown={(e) => onTool(e, "underline")}
          >
            <span style={{ textDecoration: "underline" }}>U</span>
          </ToolbarButton>

          <select
            id={`${reactId}-color`}
            disabled={disabled}
            value={activeColor}
            title="Text color"
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => onColorChange(e.target.value)}
            className="rte-select"
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
            <span className="rte-align" data-align="left" />
          </ToolbarButton>
          <ToolbarButton
            title="Align center"
            disabled={disabled}
            onMouseDown={(e) => onTool(e, "justifyCenter")}
          >
            <span className="rte-align" data-align="center" />
          </ToolbarButton>
          <ToolbarButton
            title="Align right"
            disabled={disabled}
            onMouseDown={(e) => onTool(e, "justifyRight")}
          >
            <span className="rte-align" data-align="right" />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            title="Numbered list"
            disabled={disabled}
            onMouseDown={(e) => onTool(e, "insertOrderedList")}
          >
            1.
          </ToolbarButton>
          <ToolbarButton
            title="Bullet list"
            disabled={disabled}
            onMouseDown={(e) => onTool(e, "insertUnorderedList")}
          >
            •
          </ToolbarButton>
        </div>

        {pasteStatus ? (
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {pasteStatus}
          </p>
        ) : null}

        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onInput={emitChange}
          onKeyUp={saveSelection}
          onMouseUp={saveSelection}
          onBlur={saveSelection}
          onPaste={(e) => void onPaste(e)}
          className="rte-editor"
          style={{ minHeight: `${minHeight}rem`, color: editorColor }}
        />
      </div>
    );
  },
);
