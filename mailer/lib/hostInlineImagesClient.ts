/**
 * Browser-side: replace data:image embeds with hosted HTTPS URLs before send/paste.
 * Keeps the /api/send payload small (Vercel ~4.5 MB limit) and Gmail-safe.
 */

import { getApiBase, getStoredToken } from "./api";

const DATA_URI_RE =
  /\bsrc\s*=\s*(['"])(data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\1/gi;

export function htmlHasDataUriImages(html: string): boolean {
  return /data:image\//i.test(html || "");
}

async function uploadOne(
  b64: string,
  contentType: string,
  filename: string,
  authToken: string | null,
  handoffToken?: string,
): Promise<string | null> {
  const base = getApiBase();
  if (!base) return null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${base}/mailer/inline-upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      token: handoffToken || undefined,
      content_base64: b64,
      content_type: contentType,
      filename,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[mailer] inline-upload failed (${res.status}):`, text.slice(0, 200));
    return null;
  }
  const data = (await res.json()) as { url?: string };
  return data.url || null;
}

/** Replace every data:image src with a public Railway URL. */
export async function hostDataUriImagesInBrowser(
  html: string,
  options?: { handoffToken?: string; authToken?: string | null },
): Promise<string> {
  if (!htmlHasDataUriImages(html)) return html;
  const auth = options?.authToken ?? getStoredToken();
  let out = html;
  const matches = [...html.matchAll(DATA_URI_RE)];
  for (const match of matches) {
    const full = match[0];
    const quote = match[1];
    let subtype = (match[3] || "png").toLowerCase().split("+")[0].split(";")[0];
    if (subtype === "jpg") subtype = "jpeg";
    const b64 = (match[4] || "").replace(/\s+/g, "");
    const url = await uploadOne(
      b64,
      `image/${subtype}`,
      `inline.${subtype === "jpeg" ? "jpg" : subtype}`,
      auth,
      options?.handoffToken,
    );
    if (url) {
      out = out.replace(full, `src=${quote}${url}${quote}`);
    }
  }
  return out;
}

/** Upload a pasted File and return a public image URL. */
export async function uploadPastedImageFile(file: File): Promise<string | null> {
  const auth = getStoredToken();
  if (!auth) return null;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = btoa(binary);
  const ctype = file.type || "image/png";
  const name = file.name || "paste.png";
  return uploadOne(b64, ctype, name, auth);
}
