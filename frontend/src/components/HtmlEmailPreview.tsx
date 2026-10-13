import { useEffect, useRef, useState } from "react";
import { emailMediaApiBase } from "../lib/hostInlineImages";

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value || "");
}

/** Make relative /api/… image URLs load inside a srcdoc iframe. */
function absolutizeMediaUrls(html: string): string {
  const apiOrigin = emailMediaApiBase();
  if (!html || !apiOrigin) return html;
  return html
    .replace(
      /\bsrc\s*=\s*(['"])(\/api\/mailer\/inline-media\/[^'"]+)\1/gi,
      (_m, q: string, path: string) => `src=${q}${apiOrigin}${path}${q}`,
    )
    .replace(
      /\bsrc\s*=\s*(['"])(api\/mailer\/inline-media\/[^'"]+)\1/gi,
      (_m, q: string, path: string) => `src=${q}${apiOrigin}/${path}${q}`,
    );
}

function escapePlain(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toPreviewHtml(body: string): string {
  const raw = (body || "").trim();
  if (!raw) return '<p style="color:#64748b">(empty body)</p>';
  if (looksLikeHtml(raw)) return absolutizeMediaUrls(raw);
  return raw
    .split(/\n/)
    .map((line) =>
      line.trim() ? `<p>${escapePlain(line)}</p>` : "<p><br/></p>",
    )
    .join("");
}

/** Renders email HTML (images, tables, formatting) like a real inbox client. */
export function HtmlEmailPreview({
  html,
  className = "",
  maxHeight = 420,
}: {
  html: string;
  className?: string;
  maxHeight?: number;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(120);
  const bodyHtml = toPreviewHtml(html);
  const baseHref = `${emailMediaApiBase()}/`;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    setHeight(120);
    iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><base href="${baseHref}" target="_blank" rel="noopener"><style>
      html,body{margin:0;padding:0;background:#ffffff;}
      body{font-family:Segoe UI,system-ui,-apple-system,sans-serif;color:#0f172a;padding:12px 14px;font-size:14px;line-height:1.55;word-break:break-word;}
      img,video{max-width:100%;height:auto;display:inline-block;vertical-align:middle;}
      table{max-width:100%;border-collapse:collapse;}
      td,th{vertical-align:top;}
      a{color:#0369a1;}
      pre,code{white-space:pre-wrap;word-break:break-word;}
      p{margin:0 0 0.65em;}
      p:last-child{margin-bottom:0;}
    </style></head><body>${bodyHtml}</body></html>`;
  }, [bodyHtml, baseHref]);

  return (
    <div
      className={`overflow-hidden rounded-lg border border-slate-700 bg-white ${className}`}
    >
      <iframe
        referrerPolicy="no-referrer"
        ref={iframeRef}
        title="Email preview"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        onLoad={() => {
          try {
            const doc = iframeRef.current?.contentDocument;
            const next =
              doc?.body?.scrollHeight || doc?.documentElement?.scrollHeight || 0;
            if (next > 0) {
              setHeight(Math.min(Math.max(next + 8, 80), maxHeight));
            }
            // After images load, grow once more so tall product sheets fit.
            const imgs = doc?.images ? Array.from(doc.images) : [];
            imgs.forEach((img) => {
              if (img.complete) return;
              img.addEventListener(
                "load",
                () => {
                  try {
                    const h =
                      doc?.body?.scrollHeight ||
                      doc?.documentElement?.scrollHeight ||
                      0;
                    if (h > 0) {
                      setHeight(Math.min(Math.max(h + 8, 80), maxHeight));
                    }
                  } catch {
                    /* ignore */
                  }
                },
                { once: true },
              );
            });
          } catch {
            setHeight(Math.min(220, maxHeight));
          }
        }}
        style={{ height, maxHeight, width: "100%" }}
        className="block border-0 bg-white"
      />
    </div>
  );
}
