import type { InboxMessageDetail } from "../api/client";
import { plainTextToEditorHtml } from "../components/EmailBodyEditor";

/** "Fwd: subject" without stacking prefixes ("Fwd: Fwd: ..."). */
export function forwardSubject(original: string | null | undefined): string {
  const subject = (original || "").trim();
  if (!subject) return "Fwd:";
  if (/^(fwd?|fw):/i.test(subject)) return subject;
  return `Fwd: ${subject}`;
}

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "small", "center", "p", "br",
  "div", "span", "ul", "ol", "li", "blockquote", "table", "caption", "colgroup", "col", "thead",
  "tbody", "tfoot", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre", "code",
  "img", "font",
]);

// Removed together with everything inside them.
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select",
  "link", "meta", "head", "title", "svg", "math", "audio", "video", "base", "noscript",
]);

// Layout attributes older HTML emails (and Outlook / Word) use for tables, e.g. <table border="1">.
const LAYOUT_ATTRS = new Set([
  "border", "bordercolor", "cellpadding", "cellspacing", "width", "height", "align", "valign",
  "bgcolor", "colspan", "rowspan", "nowrap", "size",
]);
const LAYOUT_ATTR_TAGS = new Set([
  "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th", "p", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "center",
]);
const SAFE_ATTR_VALUE = /^[\w#%.\s,()-]{0,60}$/;

// Visual style properties that are safe to keep. Anything else (position, float, background images,
// behaviours, Word-only "mso-*" ...) is dropped.
const SAFE_STYLE_PROP =
  /^(color|background-color|font(-.+)?|text-(align|decoration.*|indent|transform)|vertical-align|line-height|letter-spacing|white-space|word-break|width|height|min-width|max-width|min-height|border-(top|right|bottom|left)-(width|style|color)|border-(collapse|spacing|radius)|(padding|margin)(-(top|right|bottom|left))?|list-style-(type|position)|table-layout)$/;
const UNSAFE_STYLE_VALUE = /url\s*\(|expression|javascript:|@import|behavio|binding|\\/i;

/**
 * Copies the rules of the email's own <style> blocks onto the elements they match (as inline
 * style), because <style> blocks are dropped when the HTML is pasted into the compose editor.
 * Outlook / Word emails keep most of their table borders and spacing there.
 */
function inlineStyleSheets(doc: Document): void {
  if (typeof CSSStyleSheet === "undefined") return;
  const css = Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent || "")
    .join("\n")
    .replace(/@import[^;]*;/gi, "");
  if (!css.trim()) return;

  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return;
  }

  const fromSheet = new Map<HTMLElement, string>();
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule)) continue;
    let matches: Element[];
    try {
      matches = Array.from(doc.querySelectorAll(rule.selectorText));
    } catch {
      continue; // selector the browser can't evaluate (e.g. vendor pseudo-classes)
    }
    for (const el of matches) {
      if (!(el instanceof HTMLElement)) continue;
      fromSheet.set(el, `${fromSheet.get(el) || ""}${rule.style.cssText};`);
    }
  }
  // The element's own inline style comes last so it still wins over the stylesheet.
  fromSheet.forEach((sheetCss, el) => {
    el.setAttribute("style", `${sheetCss}${el.getAttribute("style") || ""}`);
  });
}

/** Keeps only the safe visual properties of an element's inline style. */
function cleanInlineStyle(el: Element): void {
  if (!el.hasAttribute("style")) return;
  const style = (el as HTMLElement).style;
  if (!style) {
    el.removeAttribute("style");
    return;
  }
  for (const prop of Array.from(style)) {
    if (!SAFE_STYLE_PROP.test(prop) || UNSAFE_STYLE_VALUE.test(style.getPropertyValue(prop))) {
      style.removeProperty(prop);
    }
  }
  if (style.length === 0) el.removeAttribute("style");
  else el.setAttribute("style", style.cssText);
}

/**
 * Cleans a received email's HTML before it is placed into the compose editor: keeps the look of
 * the original (tables, borders, fonts, colours, spacing) and drops scripts/forms and everything
 * unsafe — only safe links, https images and a whitelist of style properties survive.
 */
export function sanitizeForwardHtml(html: string): string {
  if (!html || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  inlineStyleSheets(doc);

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        node.removeChild(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        node.removeChild(el);
        continue;
      }

      walk(el); // clean the children first

      if (!ALLOWED_TAGS.has(tag)) {
        // Unknown wrapper: keep its (already cleaned) content, drop the tag.
        while (el.firstChild) node.insertBefore(el.firstChild, el);
        node.removeChild(el);
        continue;
      }

      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name === "style") continue; // filtered property by property below
        if (tag === "a" && name === "href" && /^(https?:|mailto:)/i.test(value)) continue;
        if (tag === "img" && name === "src" && /^https:/i.test(value)) continue;
        if (tag === "img" && name === "alt") continue;
        if (LAYOUT_ATTR_TAGS.has(tag) && LAYOUT_ATTRS.has(name) && SAFE_ATTR_VALUE.test(value)) continue;
        if (tag === "font" && (name === "color" || name === "face" || name === "size") && SAFE_ATTR_VALUE.test(value)) continue;
        el.removeAttribute(attr.name);
      }
      cleanInlineStyle(el);

      if (tag === "img" && !el.getAttribute("src")) {
        node.removeChild(el); // image whose source was unsafe — drop it instead of a broken box
        continue;
      }
      if (tag === "a") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  };

  walk(doc.body);
  return doc.body.innerHTML;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Standard "Forwarded message" block (headers + the original text) as editor HTML.
 *
 * `notIncluded` is the list of original attachments that could NOT be re-attached: pass `null`
 * when none were carried over at all (the note then names every original file), or the names
 * that were skipped when the rest were attached.
 */
export function buildForwardBodyHtml(
  msg: InboxMessageDetail,
  notIncluded: string[] | null = null,
): string {
  const sender = msg.from_name
    ? `${esc(msg.from_name)} &lt;${esc(msg.from_email || "")}&gt;`
    : esc(msg.from_email || "Unknown sender");

  let dateLabel = msg.date || "";
  if (dateLabel) {
    const parsed = new Date(dateLabel);
    if (!Number.isNaN(parsed.getTime())) dateLabel = parsed.toLocaleString();
  }

  const lines = [
    "---------- Forwarded message ----------",
    `From: ${sender}`,
    `Date: ${esc(dateLabel)}`,
    `Subject: ${esc(msg.subject || "(no subject)")}`,
    `To: ${esc((msg.to || []).join(", "))}`,
  ];
  if (msg.cc && msg.cc.length) lines.push(`Cc: ${esc(msg.cc.join(", "))}`);

  const attachmentNames =
    notIncluded ??
    (msg.attachments || []).map((a) => (a.filename || "").trim()).filter(Boolean);
  const attachmentNote = attachmentNames.length
    ? `<p><em>Original attachments (not included — please re-attach if needed): ${esc(
        attachmentNames.join(", "),
      )}</em></p>`
    : "";

  const original = msg.body_html
    ? sanitizeForwardHtml(msg.body_html)
    : plainTextToEditorHtml(msg.body_text || "");

  // A plain <div> (not <blockquote>) so the original keeps its own layout instead of being
  // indented — this is how Outlook / Gmail forward it.
  return `<p><br></p><p>${lines.join("<br>")}</p>${attachmentNote}<div>${original}</div>`;
}
