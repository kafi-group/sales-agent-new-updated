/** Fetch SMTP login from Sales Agent (same password that powers IMAP inbox).

 * Reps never enter the mailbox password — they only log into Sales Agent.
 * Mailer must use this endpoint; do not rely on stale Vercel MAILBOX_* passwords.
 */

export type SmtpCreds = {
  email: string;
  password: string;
  displayName?: string | null;
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

export async function fetchSmtpCredentialsFromSalesAgent(opts: {
  authToken?: string;
  handoffToken?: string;
}): Promise<SmtpCreds | null> {
  const base = apiBase();
  if (!base) {
    console.error(
      "[mailer] KAFI_API_BASE_URL missing — cannot load mailbox password from Sales Agent",
    );
    return null;
  }

  const authToken = (opts.authToken || "").trim();
  const handoffToken = (opts.handoffToken || "").trim();
  if (!authToken && !handoffToken) return null;

  // Prefer POST so large bulk handoff JWTs are not truncated in query strings.
  const url = `${base}/mailer/smtp-credentials`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(handoffToken ? { token: handoffToken } : {}),
      cache: "no-store",
    });
    if (!res.ok) {
      // Older backends may only expose GET — fall back once.
      if (res.status === 405 || res.status === 404) {
        const getUrl = new URL(url);
        if (handoffToken) getUrl.searchParams.set("token", handoffToken);
        const getRes = await fetch(getUrl.toString(), {
          headers: authToken
            ? { Authorization: `Bearer ${authToken}` }
            : undefined,
          cache: "no-store",
        });
        if (!getRes.ok) {
          const detail = await getRes.text().catch(() => "");
          console.error(
            `[mailer] smtp-credentials HTTP ${getRes.status}: ${detail.slice(0, 200)}`,
          );
          return null;
        }
        const data = (await getRes.json()) as {
          email?: string;
          password?: string;
          display_name?: string | null;
        };
        const email = (data.email || "").trim();
        const password = (data.password || "").trim();
        if (!email || !password) {
          console.error("[mailer] smtp-credentials response missing email/password");
          return null;
        }
        return {
          email,
          password,
          displayName: data.display_name ?? null,
        };
      }
      const detail = await res.text().catch(() => "");
      console.error(
        `[mailer] smtp-credentials HTTP ${res.status}: ${detail.slice(0, 200)}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      email?: string;
      password?: string;
      display_name?: string | null;
    };
    const email = (data.email || "").trim();
    const password = (data.password || "").trim();
    if (!email || !password) {
      console.error("[mailer] smtp-credentials response missing email/password");
      return null;
    }
    return {
      email,
      password,
      displayName: data.display_name ?? null,
    };
  } catch (err) {
    console.error("[mailer] smtp-credentials fetch failed", err);
    return null;
  }
}
