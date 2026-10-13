/**
 * Vercel Edge Middleware — fail-fast auth gate for /api/* at the CDN edge.
 * Full session validation still happens on Railway; this blocks anonymous noise
 * before a cold backend wake when neither cookie nor Bearer is present.
 */

export const config = {
  matcher: ["/api/:path*"],
};

const PUBLIC_EXACT = new Set(["/api/health", "/api/auth/login"]);
const PUBLIC_PREFIXES = ["/api/webhooks/", "/api/track/"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return /(?:^|;\s*)kafi_session=/.test(cookieHeader);
}

function hasBearer(authorization: string | null): boolean {
  if (!authorization) return false;
  return /^bearer\s+\S+/i.test(authorization);
}

export default function middleware(request: Request): Response | undefined {
  const { pathname } = new URL(request.url);
  if (request.method === "OPTIONS" || isPublic(pathname)) {
    return undefined;
  }

  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  if (hasSessionCookie(cookie) || hasBearer(authorization)) {
    return undefined;
  }

  return new Response(JSON.stringify({ detail: "Not authenticated" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
