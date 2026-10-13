/**
 * Host pasted data:image embeds as public HTTPS URLs before save/send.
 * Avoids Vercel FUNCTION_PAYLOAD_TOO_LARGE (~4.5 MB) on template create.
 */

import { client } from "../api/client";

const DATA_URI_RE =
  /\bsrc\s*=\s*(['"])(data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\1/gi;

const RAILWAY_API =
  "https://kafi-sales-agent-production.up.railway.app/api";

export function htmlHasDataUriImages(html: string): boolean {
  return /data:image\//i.test(html || "");
}

export function inlineMediaPublicUrl(attachmentId: string): string {
  return `${RAILWAY_API}/mailer/inline-media/${attachmentId}`;
}

/** Absolute API origin used for inline email images in previews/sends. */
export function emailMediaApiBase(): string {
  return RAILWAY_API.replace(/\/api$/, "");
}

/** Shrink large pastes so each upload fits under Vercel's proxy body limit. */
export async function compressImageBlob(
  source: Blob,
  maxEdge = 1400,
  quality = 0.72,
): Promise<File> {
  const type = (source.type || "image/jpeg").split(";")[0] || "image/jpeg";
  const fallbackName = type.includes("png") ? "inline.png" : "inline.jpg";
  try {
    const bitmap = await createImageBitmap(source);
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return new File([source], fallbackName, { type });
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      const outType = type === "image/png" && scale === 1 ? "image/png" : "image/jpeg";
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), outType, quality),
      );
      if (!blob) {
        return new File([source], fallbackName, { type: "image/jpeg" });
      }
      const ext = outType === "image/png" ? "png" : "jpg";
      return new File([blob], `inline.${ext}`, { type: outType });
    } finally {
      bitmap.close();
    }
  } catch {
    return new File([source], fallbackName, { type });
  }
}

async function uploadImageBlob(source: Blob, filenameHint?: string): Promise<string | null> {
  const file = await compressImageBlob(source);
  const named =
    filenameHint && /\.(png|jpe?g|webp|gif)$/i.test(filenameHint)
      ? new File([file], filenameHint.replace(/\.[^.]+$/, file.name.split(".").pop() || "jpg"), {
          type: file.type,
        })
      : file;
  try {
    const meta = await client.uploadEmailAttachment(named);
    return inlineMediaPublicUrl(String(meta.id));
  } catch (err) {
    console.warn("inline image upload failed", err);
    return null;
  }
}

/** Replace every data:image src with a public Railway HTTPS URL. */
export async function hostDataUriImagesInHtml(html: string): Promise<string> {
  if (!htmlHasDataUriImages(html)) return html;
  let out = html;
  const matches = [...html.matchAll(DATA_URI_RE)];
  for (const match of matches) {
    const full = match[0];
    const quote = match[1];
    let subtype = (match[3] || "png").toLowerCase().split("+")[0].split(";")[0];
    if (subtype === "jpg") subtype = "jpeg";
    const b64 = (match[4] || "").replace(/\s+/g, "");
    try {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: `image/${subtype}` });
      const url = await uploadImageBlob(
        blob,
        `inline.${subtype === "jpeg" ? "jpg" : subtype}`,
      );
      if (url) {
        out = out.replace(full, `src=${quote}${url}${quote}`);
      }
    } catch (err) {
      console.warn("inline image host failed", err);
    }
  }
  return out;
}

export async function uploadPastedImageFile(file: File): Promise<string | null> {
  return uploadImageBlob(file, file.name);
}

/** Rough JSON body size check (Vercel ~4.5 MB). */
export function estimateJsonBytes(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
