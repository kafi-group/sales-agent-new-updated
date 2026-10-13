import { NextRequest, NextResponse } from "next/server";
import { verifyHandoff } from "@/lib/handoff";
import {
  ensureDearSalutation,
  personalizeEmailText,
  resolveContactSalutationName,
} from "@/lib/personalizeEmail";
import { reportMailerActivity } from "@/lib/reportActivity";
import { sendSmtp, sleep } from "@/lib/smtp";
import { fetchSmtpCredentialsFromSalesAgent } from "@/lib/fetchSmtpCredentials";
import { appendMailerSentCopy } from "@/lib/syncSent";

export const runtime = "nodejs";
export const maxDuration = 60;

type Lead = {
  buyer_id: number;
  company_name: string;
  contact_name?: string | null;
  contact_email: string;
};

function renderTemplate(template: string, lead: Lead, salutation = false): string {
  const merged = personalizeEmailText(template, lead);
  return salutation ? ensureDearSalutation(merged, resolveContactSalutationName(lead)) : merged;
}

function jsonError(error: string, status: number) {
  return NextResponse.json({ error, sent: 0, failed: 0, results: [] }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.MAILER_HANDOFF_SECRET || "";
    if (!secret) {
      return jsonError("MAILER_HANDOFF_SECRET not configured on mailer", 500);
    }

    let body: {
      token?: string;
      subject?: string;
      body?: string;
      leads?: Lead[];
      message_delay_seconds?: number;
    };
    try {
      body = await req.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const token = (body.token || "").trim();
    if (!token) {
      return jsonError("token required", 400);
    }

    let handoff;
    try {
      handoff = await verifyHandoff(token, secret);
    } catch {
      return jsonError("Invalid or expired token — reopen bulk send from Sales Agent", 401);
    }

    const subjectTpl = (body.subject || "").trim();
    const bodyTpl = (body.body || "").trim();
    if (!subjectTpl || !bodyTpl) {
      return jsonError("subject and body required", 400);
    }

    const leads = (body.leads?.length ? body.leads : handoff.leads || []).filter(
      (l) => l.contact_email && l.contact_email.includes("@"),
    );
    if (!leads.length) {
      return jsonError("No leads with email in this batch", 400);
    }
    if (leads.length > 15) {
      return jsonError(
        "Max 15 emails per batch request (raise batch size carefully)",
        400,
      );
    }

    const delayMs = Math.max(
      0,
      Math.round((body.message_delay_seconds ?? 2) * 1000),
    );

    // Always load mailbox password from Sales Agent (same as Inbox).
    // Never fall back to Vercel MAILBOX_* — those drift and cause SMTP 535.
    const smtpCreds = await fetchSmtpCredentialsFromSalesAgent({
      handoffToken: token,
    });
    if (!smtpCreds) {
      return jsonError(
        "Could not load your company mailbox from Sales Agent. " +
          "Every user sends with the mailbox already saved on their Sales Agent login — " +
          "you do not need the email password. If Inbox works, retry after deploy.",
        502,
      );
    }

    const isBulk = leads.length > 1;
    if (isBulk) {
      await reportMailerActivity({
        token,
        kind: "bulk_started",
        selected_count: leads.length,
        send_mode: "bulk",
      });
    }

    const { hostInlineDataUriImages } = await import("@/lib/hostInlineImages");
    const hostedTemplate = await hostInlineDataUriImages(bodyTpl, {
      handoffToken: token,
    });

    const results: Array<{
      buyer_id: number;
      email: string;
      ok: boolean;
      message: string;
    }> = [];

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      try {
        const subject = renderTemplate(subjectTpl, lead);
        const text = renderTemplate(hostedTemplate, lead, true);
        const { prepareTrackedBody } = await import("@/lib/prepareTrackedBody");
        const tracked = await prepareTrackedBody({
          token,
          to: lead.contact_email,
          subject,
          body: text,
          buyer_id: lead.buyer_id,
          send_mode: isBulk ? "bulk" : "individual",
        });
        const sendBody = tracked.body || text;
        const sent = await sendSmtp({
          username: handoff.username,
          mailboxEmail: handoff.mailbox_email,
          to: lead.contact_email,
          subject,
          body: sendBody,
          html: tracked.html !== false,
          credsOverride: smtpCreds,
        });
        results.push({
          buyer_id: lead.buyer_id,
          email: lead.contact_email,
          ok: sent.ok,
          message: sent.message,
        });
        // Match in-app bulk: only per-message activity when a single recipient.
        await reportMailerActivity({
          token,
          kind: "send_result",
          ok: sent.ok,
          to_email: lead.contact_email,
          subject,
          company_name: lead.company_name,
          buyer_id: lead.buyer_id,
          interaction_id: tracked.interaction_id || undefined,
          error_message: sent.ok ? undefined : sent.message,
          send_mode: isBulk ? "bulk" : "individual",
          record_send: !isBulk,
        });
        // Bulk: keep one Sent copy only (saves mailbox + DB space). Recipients still get full mail.
        if (sent.ok && (!isBulk || i === 0)) {
          await appendMailerSentCopy({
            token,
            to: lead.contact_email,
            subject,
            body: sendBody,
            html: tracked.html !== false,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          buyer_id: lead.buyer_id,
          email: lead.contact_email,
          ok: false,
          message,
        });
        await reportMailerActivity({
          token,
          kind: "send_result",
          ok: false,
          to_email: lead.contact_email,
          company_name: lead.company_name,
          buyer_id: lead.buyer_id,
          error_message: message,
          send_mode: isBulk ? "bulk" : "individual",
          record_send: !isBulk,
        });
      }
      if (i < leads.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    if (isBulk) {
      await reportMailerActivity({
        token,
        kind: "bulk_finished",
        selected_count: leads.length,
        sent_count: sent,
        failed_count: failed,
        send_mode: "bulk",
        subject: subjectTpl || undefined,
        failures: results
          .filter((r) => !r.ok)
          .slice(0, 50)
          .map((r) => ({
            to_email: r.email,
            company_name: leads.find((l) => l.buyer_id === r.buyer_id)?.company_name,
            buyer_id: r.buyer_id,
            error: r.message,
          })),
      });
    }
    return NextResponse.json({ sent, failed, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: `Bulk send crashed: ${message}`,
        sent: 0,
        failed: 0,
        results: [],
      },
      { status: 500 },
    );
  }
}
