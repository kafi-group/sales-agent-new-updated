/**
 * Host large compose attachments on Railway so Vercel /api/send stays under
 * the ~4.5 MB serverless body limit. SMTP still runs on Vercel; it fetches
 * file bytes by id/url before nodemailer send.
 */

import { getApiBase, getStoredToken } from "./api";

/**
 * Max raw file bytes for reliable SMTP delivery.
 * Base64 expands ~33%; many hosts also spam-score large attachments (554).
 * 10 MB file ≈ 13–14 MB on the wire — under typical 25 MB caps and safer than 12–18 MB.
 */
export const EMAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Rough MIME size after base64 + small header/body overhead. */
export function estimateEncodedMessageBytes(attachmentBytes: number): number {
  return Math.ceil(attachmentBytes * (4 / 3)) + 64 * 1024;
}

/** Stay under Vercel/proxy body limits when uploading from the browser. */
const CHUNK_BYTES = 2.5 * 1024 * 1024;

export type HostedAttachment = {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
};

export type SendAttachmentRef = {
  filename: string;
  contentType?: string;
  /** Base64 — only for small inline payloads (legacy). */
  content?: string;
  id?: string;
  url?: string;
  size?: number;
};

/** Template attachment metadata from Sales Agent `/email-templates`. */
export type TemplateAttachmentMeta = {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  storage_path?: string | null;
};

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Turn template default attachments into hosted refs the mailer can send. */
export function hostedFromTemplateAttachments(
  items: TemplateAttachmentMeta[] | null | undefined,
): HostedAttachment[] {
  const base = getApiBase().replace(/\/$/, "");
  if (!base || !items?.length) return [];
  const out: HostedAttachment[] = [];
  for (const item of items) {
    const id = String(item.id || "").trim();
    if (!id) continue;
    out.push({
      id,
      url: `${base}/mailer/inline-media/${id}`,
      filename: item.filename || "attachment",
      contentType: item.content_type || "application/octet-stream",
      size: typeof item.size === "number" ? item.size : 0,
    });
  }
  return out;
}

async function uploadSmallFile(
  file: File,
  options?: { authToken?: string | null; handoffToken?: string },
): Promise<HostedAttachment> {
  const base = getApiBase();
  if (!base) {
    throw new Error("Sales Agent API URL is not configured — cannot upload attachment.");
  }
  const auth = options?.authToken ?? getStoredToken();
  const form = new FormData();
  form.append("file", file, file.name);
  if (options?.handoffToken) form.append("token", options.handoffToken);

  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;

  let res: Response;
  try {
    res = await fetch(`${base}/mailer/attachment-upload`, {
      method: "POST",
      headers,
      body: form,
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Could not reach Sales Agent to upload the attachment (network/CORS). Try again, or hard-refresh the mailer.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const json = JSON.parse(text) as { detail?: string; error?: string };
      detail = json.detail || json.error || detail;
    } catch {
      /* keep text */
    }
    throw new Error(detail || `Attachment upload failed (${res.status})`);
  }
  const data = (await res.json()) as {
    id?: string;
    url?: string;
    filename?: string;
    content_type?: string;
    size?: number;
  };
  if (!data.id || !data.url) {
    throw new Error("Attachment upload returned no id/url");
  }
  return {
    id: data.id,
    url: data.url,
    filename: data.filename || file.name,
    contentType: data.content_type || file.type || "application/octet-stream",
    size: typeof data.size === "number" ? data.size : file.size,
  };
}

/** Chunked upload via Sales Agent so large PDFs never hit one big Railway POST. */
async function uploadChunkedFile(
  file: File,
  options?: {
    authToken?: string | null;
    onProgress?: (info: { percent: number; label: string }) => void;
  },
): Promise<HostedAttachment> {
  const base = getApiBase().replace(/\/$/, "");
  if (!base) {
    throw new Error("Sales Agent API URL is not configured — cannot upload attachment.");
  }
  const auth = options?.authToken ?? getStoredToken();
  const report = (percent: number, label: string) => {
    options?.onProgress?.({
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      label,
    });
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const totalChunks = Math.ceil(file.size / CHUNK_BYTES);
  report(0, `Starting upload… ${file.name}`);
  let initRes: Response;
  try {
    initRes = await fetch(`${base}/email/attachments/chunk-init`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        filename: file.name,
        content_type: file.type || null,
        size: file.size,
        total_chunks: totalChunks,
      }),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Could not start chunked upload to Sales Agent (network). Hard-refresh and try again.",
    );
  }
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => "");
    throw new Error(text.slice(0, 300) || `Chunk init failed (${initRes.status})`);
  }
  const init = (await initRes.json()) as { upload_id: string };

  for (let index = 0; index < totalChunks; index++) {
    const start = index * CHUNK_BYTES;
    const end = Math.min(file.size, start + CHUNK_BYTES);
    const pct = (end / file.size) * 95;
    report(
      pct,
      `Uploading ${file.name}… ${Math.round(pct)}% (chunk ${index + 1}/${totalChunks})`,
    );
    const blob = file.slice(start, end);
    const form = new FormData();
    form.append("upload_id", init.upload_id);
    form.append("index", String(index));
    form.append("file", blob, `${file.name}.part${index}`);
    const chunkHeaders: Record<string, string> = {};
    if (auth) chunkHeaders.Authorization = `Bearer ${auth}`;

    let chunkRes: Response;
    try {
      chunkRes = await fetch(`${base}/email/attachments/chunk`, {
        method: "POST",
        headers: chunkHeaders,
        body: form,
        cache: "no-store",
      });
    } catch {
      throw new Error(
        `Network error uploading chunk ${index + 1}/${totalChunks}. Try again.`,
      );
    }
    if (!chunkRes.ok) {
      const text = await chunkRes.text().catch(() => "");
      throw new Error(
        text.slice(0, 300) || `Chunk ${index + 1}/${totalChunks} failed (${chunkRes.status})`,
      );
    }
  }

  report(98, `Finishing upload… ${file.name}`);
  let doneRes: Response;
  try {
    doneRes = await fetch(`${base}/email/attachments/chunk-complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ upload_id: init.upload_id }),
      cache: "no-store",
    });
  } catch {
    throw new Error("Network error finishing upload. Try again.");
  }
  if (!doneRes.ok) {
    const text = await doneRes.text().catch(() => "");
    throw new Error(text.slice(0, 300) || `Upload complete failed (${doneRes.status})`);
  }
  const meta = (await doneRes.json()) as {
    id: string;
    filename: string;
    content_type: string;
    size: number;
  };
  report(100, `Uploaded ${file.name}`);
  return {
    id: meta.id,
    url: `${base}/mailer/inline-media/${meta.id}`,
    filename: meta.filename || file.name,
    contentType: meta.content_type || file.type || "application/octet-stream",
    size: meta.size || file.size,
  };
}

export async function uploadAttachmentToSalesAgent(
  file: File,
  options?: {
    authToken?: string | null;
    handoffToken?: string;
    onProgress?: (info: { percent: number; label: string }) => void;
  },
): Promise<HostedAttachment> {
  if (file.size > EMAIL_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `${file.name} is ${formatAttachmentSize(file.size)} — keep each file under ${
        EMAIL_ATTACHMENT_MAX_BYTES / (1024 * 1024)
      } MB (≈${formatAttachmentSize(estimateEncodedMessageBytes(file.size))} on the wire; inboxes reject ~25 MB).`,
    );
  }
  // Large files: chunked path (avoids Failed to fetch on ~20+ MB single POSTs).
  if (file.size > CHUNK_BYTES) {
    return uploadChunkedFile(file, options);
  }
  options?.onProgress?.({ percent: 40, label: `Uploading ${file.name}…` });
  const result = await uploadSmallFile(file, options);
  options?.onProgress?.({ percent: 100, label: `Uploaded ${file.name}` });
  return result;
}

/** Resolve attachment refs to base64 buffers for nodemailer (server-side). */
export async function resolveAttachmentsForSmtp(
  refs: SendAttachmentRef[] | undefined,
): Promise<Array<{ filename: string; content: string; contentType?: string }>> {
  if (!refs?.length) return [];
  const out: Array<{ filename: string; content: string; contentType?: string }> = [];
  for (const ref of refs) {
    if (ref.content) {
      out.push({
        filename: ref.filename,
        content: ref.content,
        contentType: ref.contentType,
      });
      continue;
    }
    const url = (ref.url || "").trim();
    if (!url) {
      throw new Error(`Attachment "${ref.filename}" is missing url/content`);
    }
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(
        `Could not load attachment "${ref.filename}" from Sales Agent (${res.status})`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    out.push({
      filename: ref.filename,
      content: buf.toString("base64"),
      contentType:
        ref.contentType ||
        res.headers.get("content-type")?.split(";")[0]?.trim() ||
        "application/octet-stream",
    });
  }
  return out;
}
