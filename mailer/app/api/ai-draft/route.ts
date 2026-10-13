import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const PRODUCTION_API_BASE = "https://kafi-sales-agent-production.up.railway.app/api";

function apiBase(): string {
  const candidates = [
    process.env.KAFI_API_BASE_URL,
    process.env.NEXT_PUBLIC_KAFI_API_BASE_URL,
    PRODUCTION_API_BASE,
  ];
  for (const raw of candidates) {
    const base = (raw || "").trim().replace(/\/$/, "");
    if (base) return base;
  }
  return "";
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ detail: "Not authenticated" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON" }, { status: 400 });
  }

  const base = apiBase();
  if (!base) {
    return NextResponse.json(
      { detail: "KAFI_API_BASE_URL is not configured on the mailer." },
      { status: 500 },
    );
  }

  try {
    const upstream = await fetch(`${base}/email-templates/draft-from-prompt`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("Content-Type") || "application/json";
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": contentType },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upstream request failed";
    return NextResponse.json({ detail: message }, { status: 502 });
  }
}
