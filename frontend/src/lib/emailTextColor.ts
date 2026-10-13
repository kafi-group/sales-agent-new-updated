/** Remap hard-coded body text colors for the email template editor chrome. */

export type EditorUiTheme = "dark" | "light";

const DARK_TEXT = "#ffffff";
const LIGHT_TEXT = "#111827";
const WRAP_ATTR = "data-kafi-compose-color";

const TEXT_TAGS = new Set([
  "P",
  "DIV",
  "SPAN",
  "LI",
  "TD",
  "TH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "A",
  "LABEL",
  "FONT",
  "STRONG",
  "EM",
  "B",
  "I",
  "U",
  "BLOCKQUOTE",
  "PRE",
]);

function cleanColorToken(color: string): string {
  return String(color || "")
    .replace(/\s*!important\s*/gi, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function parseRgb(color: string): [number, number, number] | null {
  const raw = cleanColorToken(color).toLowerCase();
  if (!raw) return null;

  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  if (short) {
    const h = short[1];
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  const full = /^#([0-9a-f]{6})$/i.exec(raw);
  if (full) {
    const h = full[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const bare = /^([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (bare) return parseRgb(`#${bare[1]}`);

  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }

  const hsl = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i.exec(raw);
  if (hsl) {
    const h = Number(hsl[1]) / 360;
    const s = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    const hue2rgb = (p: number, q: number, t: number) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    let r: number;
    let g: number;
    let b: number;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  if (raw === "black" || raw === "windowtext" || raw === "text" || raw === "canvastext") {
    return [0, 0, 0];
  }
  if (raw === "white" || raw === "canvas") return [255, 255, 255];
  return null;
}

function luminance(color: string): number | null {
  const rgb = parseRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isLightColor(color: string): boolean {
  const lum = luminance(color);
  if (lum == null) return false;
  return lum > 0.72;
}

function isDarkColor(color: string): boolean {
  const lum = luminance(color);
  if (lum == null) return false;
  return lum < 0.55;
}

export function getComposeDefaultTextColor(theme: EditorUiTheme): string {
  return theme === "dark" ? DARK_TEXT : LIGHT_TEXT;
}

function shouldForceColor(cssColor: string, theme: EditorUiTheme): boolean {
  const v = cleanColorToken(cssColor);
  if (!v || v === "inherit" || v === "currentcolor" || v === "transparent") {
    return false;
  }
  if (theme === "dark") {
    if (isLightColor(v)) return false;
    return true;
  }
  if (isDarkColor(v)) return false;
  return true;
}

function rewriteColorProps(style: string, theme: EditorUiTheme, target: string): string {
  let next = style.replace(
    /(^|;)\s*(-webkit-text-fill-)?color\s*:\s*([^;]+)/gi,
    (full, lead: string, webkit: string | undefined, value: string) => {
      if (!shouldForceColor(value, theme)) return full;
      const prop = webkit ? "-webkit-text-fill-color" : "color";
      return `${lead} ${prop}: ${target}`;
    },
  );
  if (theme === "dark") {
    next = next.replace(/(^|;)\s*-webkit-text-fill-color\s*:\s*([^;]+)/gi, (full, lead, value) => {
      if (!shouldForceColor(value, theme)) return full;
      return `${lead} -webkit-text-fill-color: ${target}`;
    });
  }
  return next;
}

function unwrapComposeWrappers(root: HTMLElement) {
  while (root.children.length === 1) {
    const only = root.children[0] as HTMLElement;
    if (only?.getAttribute?.(WRAP_ATTR)) {
      root.innerHTML = only.innerHTML;
      continue;
    }
    break;
  }
}

function forceElementColor(el: Element, target: string, theme: EditorUiTheme) {
  const st = el.getAttribute("style") || "";
  const rewritten = rewriteColorProps(st, theme, target);
  if (/color\s*:/i.test(rewritten)) {
    el.setAttribute("style", rewritten);
    return;
  }
  el.setAttribute("style", `color:${target}${rewritten ? `;${rewritten}` : ""}`);
}

/**
 * Force template body text to be readable on the editor chrome:
 * dark UI → white text; light UI → dark text.
 */
export function normalizeEditorTextColor(html: string, theme: EditorUiTheme): string {
  if (!html) return html;
  const target = getComposeDefaultTextColor(theme);

  if (typeof DOMParser === "undefined") {
    return (
      `<div ${WRAP_ATTR}="${target}" style="color:${target}">` +
      html
        .replace(/color\s*:\s*[^;)"']+/gi, `color:${target}`)
        .replace(/color\s*=\s*["']?[^"'\s>]+/gi, `color="${target}"`) +
      `</div>`
    );
  }

  const doc = new DOMParser().parseFromString(
    `<div id="kafi-compose-root">${html}</div>`,
    "text/html",
  );
  const root = doc.getElementById("kafi-compose-root");
  if (!root) return html;

  unwrapComposeWrappers(root);
  root.querySelectorAll("style").forEach((node) => node.remove());

  const walk = (el: Element) => {
    if (el.hasAttribute("style")) {
      el.setAttribute(
        "style",
        rewriteColorProps(el.getAttribute("style") || "", theme, target),
      );
    }
    if (el.tagName === "FONT" && el.hasAttribute("color")) {
      const c = el.getAttribute("color") || "";
      if (shouldForceColor(c, theme) || (theme === "dark" && !isLightColor(c))) {
        el.setAttribute("color", target);
      }
    }
    if (TEXT_TAGS.has(el.tagName)) {
      forceElementColor(el, target, theme);
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);

  return `<div ${WRAP_ATTR}="${target}" style="color:${target} !important">${root.innerHTML}</div>`;
}
