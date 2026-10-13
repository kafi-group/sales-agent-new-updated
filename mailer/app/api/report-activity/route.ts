import { NextRequest, NextResponse } from "next/server";
import { reportMailerActivity, type ActivityReport } from "@/lib/reportActivity";

export const runtime = "nodejs";

/**
 * Browser → mailer (server env) → Sales Agent Email Activity.
 * Keeps activity logging off the mailer UI; Sales Agent is the only viewer.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ActivityReport;
    const ok = await reportMailerActivity(body);
    return NextResponse.json({ ok });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
