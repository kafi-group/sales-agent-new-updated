/** Ask Sales Agent to wrap the outbound body with an open-tracking pixel. */

export type PrepareTrackedResult = {
  body: string;
  html: boolean;
  interaction_id?: number | null;
  tracking_enabled: boolean;
};

function apiBase(): string {
  return (
    process.env.KAFI_API_BASE_URL ||
    process.env.NEXT_PUBLIC_KAFI_API_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
}

/**
 * Best-effort. On failure, returns the original body so SMTP still proceeds.
 */
export async function prepareTrackedBody(options: {
  token?: string;
  authToken?: string;
  to: string;
  subject: string;
  body: string;
  buyer_id?: number;
  send_mode?: "individual" | "bulk";
}): Promise<PrepareTrackedResult> {
  const base = apiBase();
  if (!base) {
    return {
      body: options.body,
      html: true,
      tracking_enabled: false,
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  try {
    const res = await fetch(`${base}/mailer/prepare-tracked-body`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: options.token || undefined,
        to: options.to,
        subject: options.subject,
        body: options.body,
        buyer_id: options.buyer_id,
        send_mode: options.send_mode || "individual",
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[mailer] prepare-tracked-body failed (${res.status}): ${text.slice(0, 200)}`,
      );
      const looksHtml = /<\/?[a-z][\s\S]*>/i.test(options.body || "");
      return { body: options.body, html: looksHtml || true, tracking_enabled: false };
    }
    const data = (await res.json()) as {
      body?: string;
      html?: boolean;
      interaction_id?: number | null;
      tracking_enabled?: boolean;
    };
    return {
      body: (data.body || options.body) as string,
      html: data.html !== false,
      interaction_id: data.interaction_id ?? null,
      tracking_enabled: Boolean(data.tracking_enabled),
    };
  } catch (err) {
    console.warn(
      `[mailer] prepare-tracked-body network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { body: options.body, html: true, tracking_enabled: false };
  }
}
