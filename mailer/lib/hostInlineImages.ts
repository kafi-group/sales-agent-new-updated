/**
 * Replace data:image base64 embeds with public HTTPS URLs on Sales Agent.
 * Gmail blanks or shows raw <img src="data:..."> for huge data-URI images.
 */

function apiBase(): string {
  return (
    process.env.KAFI_API_BASE_URL ||
    process.env.NEXT_PUBLIC_KAFI_API_BASE_URL ||
    "https://kafi-sales-agent-production.up.railway.app/api"
  )
    .trim()
    .replace(/\/$/, "");
}

const DATA_URI_RE =
  /\bsrc\s*=\s*(['"])(data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\1/gi;

export async function hostInlineDataUriImages(
  html: string,
  options: { authToken?: string; handoffToken?: string },
): Promise<string> {
  if (!html || !/data:image\//i.test(html)) return html;

  const base = apiBase();
  if (!base) return html;

  const matches = [...html.matchAll(DATA_URI_RE)];
  if (!matches.length) return html;

  let out = html;
  for (const match of matches) {
    const full = match[0];
    const quote = match[1];
    const subtypeRaw = (match[3] || "png").toLowerCase();
    const b64 = (match[4] || "").replace(/\s+/g, "");
    let subtype = subtypeRaw.split("+")[0].split(";")[0] || "png";
    if (subtype === "jpg") subtype = "jpeg";
    const contentType = `image/${subtype}`;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (options.authToken) {
        headers.Authorization = `Bearer ${options.authToken}`;
      }
      const res = await fetch(`${base}/mailer/inline-upload`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          token: options.handoffToken || undefined,
          content_base64: b64,
          content_type: contentType,
          filename: `inline.${subtype === "jpeg" ? "jpg" : subtype}`,
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        console.warn(
          `[mailer] inline-upload failed (${res.status}):`,
          (await res.text().catch(() => "")).slice(0, 200),
        );
        continue;
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) continue;
      out = out.replace(full, `src=${quote}${data.url}${quote}`);
    } catch (err) {
      console.warn(
        `[mailer] inline-upload error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}
