import { NextResponse } from "next/server";
import { resolveMailbox } from "@/lib/smtp";

export async function GET() {
  const users = ["admin", "asim", "usmankhan", "sadia", "finance"].map((u) => ({
    username: u,
    mailbox_ready: Boolean(resolveMailbox(u)),
  }));
  return NextResponse.json({
    status: "ok",
    service: "kafi-mailer",
    handoff_secret_set: Boolean(process.env.MAILER_HANDOFF_SECRET),
    smtp_host: process.env.MAILBOX_SMTP_HOST || null,
    smtp_port: Number(process.env.MAILBOX_SMTP_PORT || 465),
    users,
  });
}
