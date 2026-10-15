/** Browser client for Railway API (Bearer auth). */

export type MailerUser = {
  id: number;
  username: string;
  full_name: string;
  role: string;
  mailbox_email?: string | null;
  mailbox_display_name?: string | null;
};

const TOKEN_KEY = "kafi_mailer_token";
const USER_KEY = "kafi_mailer_user";

export const PRODUCTION_API_BASE =
  "https://sales-agent-new-updated-production.up.railway.app/api";

const STALE_API_HOSTS = new Set([
  "kafi-sales-agent.vercel.app",
  "kafi-sales-agent.up.railway.app",
  "kafi-sales-agent-production.up.railway.app",
]);

function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/$/, "");
}

/** Browser must not call Vercel frontends as API — POST often returns 405 Method Not Allowed. */
function isMisconfiguredPublicApiBase(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (STALE_API_HOSTS.has(host)) return true;
    if (host.endsWith(".vercel.app") && host.includes("mailer")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

const INLINE_MEDIA_RE = /\/(?:api\/)?mailer\/inline-media\/([^/?#]+)/i;

/** Point library / pasted images at the live Railway host (old URLs 404). */
export function rewriteInlineMediaUrl(url: string): string {
  const raw = (url || "").trim();
  const match = raw.match(INLINE_MEDIA_RE);
  if (!match) return raw;
  const base = getApiBase() || PRODUCTION_API_BASE;
  return `${base}/mailer/inline-media/${match[1]}`;
}

export function rewriteInlineMediaInHtml(html: string): string {
  return (html || "").replace(
    /src\s*=\s*(['"])([^'"]*mailer\/inline-media\/[^'"]+)\1/gi,
    (_full, quote: string, src: string) => `src=${quote}${rewriteInlineMediaUrl(src)}${quote}`,
  );
}

export function getApiBase(): string {
  const pub = normalizeBase(process.env.NEXT_PUBLIC_KAFI_API_BASE_URL || "");
  if (pub && !isMisconfiguredPublicApiBase(pub)) return pub;
  const serverSide = normalizeBase(process.env.KAFI_API_BASE_URL || "");
  if (serverSide && !isMisconfiguredPublicApiBase(serverSide)) return serverSide;
  if (process.env.NODE_ENV === "production") return PRODUCTION_API_BASE;
  return "";
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): MailerUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as MailerUser) : null;
  } catch {
    return null;
  }
}

export function storeSession(token: string, user: MailerUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("kafi-mailer-session"));
  }
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("kafi-mailer-session"));
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = getApiBase();
  if (!base) {
    throw new ApiError(
      500,
      "KAFI_API_BASE_URL / NEXT_PUBLIC_KAFI_API_BASE_URL is not set on the mailer.",
    );
  }
  const token = getStoredToken();
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const detail =
      data && typeof data === "object" && data !== null && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : text || res.statusText;
    // Do not clearSession() here — a single 401 (e.g. stale /auth/me) was wiping
    // the bulk handoff session and breaking picture-library uploads.
    throw new ApiError(res.status, detail);
  }
  return data as T;
}

export async function login(username: string, password: string) {
  const result = await apiFetch<{ token: string; user: MailerUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  storeSession(result.token, result.user);
  return result;
}

export async function redeemSessionCode(code: string) {
  const result = await apiFetch<{ token: string; user: MailerUser }>(
    "/mailer/session/redeem",
    {
      method: "POST",
      body: JSON.stringify({ code }),
    },
  );
  storeSession(result.token, result.user);
  return result;
}

export async function loginFromHandoff(token: string) {
  const result = await apiFetch<{ token: string; user: MailerUser }>(
    "/mailer/handoff-login",
    {
      method: "POST",
      body: JSON.stringify({ token }),
    },
  );
  storeSession(result.token, result.user);
  return result;
}

export async function fetchMe() {
  return apiFetch<MailerUser>("/auth/me");
}
