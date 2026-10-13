/** After Vercel SMTP succeeds, ask Railway to IMAP-APPEND a copy into Sent. */

function apiBase(): string {
  return (
    process.env.KAFI_API_BASE_URL ||
    process.env.NEXT_PUBLIC_KAFI_API_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
}

export type AppendSentPayload = {
  token?: string;
  authToken?: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
};

/**
 * Best-effort: never throw — Sent sync must not undo a successful SMTP delivery.
 */
export async function appendMailerSentCopy(
  payload: AppendSentPayload,
): Promise<boolean> {
  const base = apiBase();
  if (!base) return false;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (payload.authToken) {
    headers.Authorization = `Bearer ${payload.authToken}`;
  }

  try {
    const res = await fetch(`${base}/mailer/append-sent`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: payload.token || undefined,
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
        cc: payload.cc || undefined,
        bcc: payload.bcc || undefined,
        html: payload.html !== false,
      }),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}
