import { NextRequest, NextResponse } from "next/server";
import { verifyHandoff } from "@/lib/handoff";
import {
  ensureDearSalutation,
  personalizeEmailText,
  resolveContactSalutationName,
} from "@/lib/personalizeEmail";
import { prepareTrackedBody } from "@/lib/prepareTrackedBody";
import { hostInlineDataUriImages } from "@/lib/hostInlineImages";
import { resolveMergeContext } from "@/lib/resolveMergeContext";
import { reportMailerActivity } from "@/lib/reportActivity";
import { sendSmtp, smtpBodyHasContent } from "@/lib/smtp";
import { fetchSmtpCredentialsFromSalesAgent } from "@/lib/fetchSmtpCredentials";
import { appendMailerSentCopy } from "@/lib/syncSent";
import { resolveAttachmentsForSmtp } from "@/lib/hostAttachments";

export const runtime = "nodejs";
export const maxDuration = 60;

function apiBase(): string {
  return (
    process.env.KAFI_API_BASE_URL ||
    process.env.NEXT_PUBLIC_KAFI_API_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
}

async function resolveUsernameFromSession(
  authToken: string,
): Promise<{ username: string; mailbox_email?: string | null } | null> {
  const base = apiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const user = (await res.json()) as {
      username?: string;
      mailbox_email?: string | null;
    };
    if (!user.username) return null;
    return { username: user.username, mailbox_email: user.mailbox_email };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: {
      token?: string;
      auth_token?: string;
      to?: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      body?: string;
      html?: boolean;
      buyer_id?: number;
      company_name?: string;
      contact_name?: string;
      designation?: string;
      send_mode?: "individual" | "bulk";
      /** When false, skip Email Activity per-message row (bulk summary only). */
      record_activity?: boolean;
      attachments?: Array<{
        filename: string;
        content?: string;
        contentType?: string;
        id?: string;
        url?: string;
        size?: number;
      }>;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const to = (body.to || "").trim();
    const subject = (body.subject || "").trim();
    const text = body.body || "";
    if (!to.includes("@") || !subject || !smtpBodyHasContent(text)) {
      return NextResponse.json(
        { error: "to, subject, and body are required" },
        { status: 400 },
      );
    }

    let username = "";
    let mailboxEmail: string | undefined;

    const handoffToken = (body.token || "").trim();
    const authToken = (body.auth_token || "").trim();

    if (handoffToken) {
      const secret = process.env.MAILER_HANDOFF_SECRET || "";
      if (!secret) {
        return NextResponse.json(
          { error: "MAILER_HANDOFF_SECRET not configured" },
          { status: 500 },
        );
      }
      try {
        const handoff = await verifyHandoff(handoffToken, secret);
        username = handoff.username;
        mailboxEmail = handoff.mailbox_email;
      } catch {
        return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
      }
    } else if (authToken) {
      const user = await resolveUsernameFromSession(authToken);
      if (!user) {
        return NextResponse.json({ error: "Invalid session" }, { status: 401 });
      }
      username = user.username;
      mailboxEmail = user.mailbox_email || undefined;
    } else {
      return NextResponse.json(
        { error: "auth_token or token required" },
        { status: 401 },
      );
    }

    const sendMode = body.send_mode === "bulk" ? "bulk" : "individual";
    const recordActivity = body.record_activity !== false;
    const buyerId =
      typeof body.buyer_id === "number" && Number.isFinite(body.buyer_id)
        ? body.buyer_id
        : undefined;
    const companyName = (body.company_name || "").trim() || undefined;
    const contactName = (body.contact_name || "").trim() || undefined;
    const designation = (body.designation || "").trim() || undefined;

    const mergeLead = await resolveMergeContext(authToken || "", {
      buyer_id: buyerId,
      to_email: to,
      company_name: companyName,
      contact_name: contactName,
      designation,
    });
    const personalizedSubject = personalizeEmailText(subject, mergeLead);
    const mergedBody = personalizeEmailText(text, mergeLead);
    const personalizedBody = ensureDearSalutation(
      mergedBody,
      resolveContactSalutationName(mergeLead),
    );

    // Upload data:image embeds one-by-one so the tracked-body request stays small
    // and Gmail receives https:// image URLs instead of raw base64.
    const hostedBody = await hostInlineDataUriImages(personalizedBody, {
      authToken: authToken || undefined,
      handoffToken: handoffToken || undefined,
    });

    const cc = (body.cc || "").trim() || undefined;
    const bcc = (body.bcc || "").trim() || undefined;

    // Inject open-tracking pixel (needs PUBLIC_API_BASE_URL / Railway domain on API).
    const tracked = await prepareTrackedBody({
      token: handoffToken || undefined,
      authToken: authToken || undefined,
      to,
      subject: personalizedSubject,
      body: hostedBody,
      buyer_id: buyerId,
      send_mode: sendMode,
    });
    const sendBody = tracked.body || hostedBody;
    const asHtml = tracked.html !== false;

    // Always load mailbox password from Sales Agent (same as Inbox).
    // Never fall back to Vercel MAILBOX_* — those drift and cause SMTP 535.
    const smtpCreds = await fetchSmtpCredentialsFromSalesAgent({
      authToken: authToken || undefined,
      handoffToken: handoffToken || undefined,
    });
    if (!smtpCreds) {
      return NextResponse.json(
        {
          error:
            "Could not load your company mailbox from Sales Agent. " +
            "Every user sends with the mailbox already saved on their Sales Agent login — " +
            "you do not need the email password. If Inbox works, retry after deploy.",
        },
        { status: 502 },
      );
    }

    let smtpAttachments: Array<{
      filename: string;
      content: string;
      contentType?: string;
    }> = [];
    try {
      smtpAttachments = await resolveAttachmentsForSmtp(
        Array.isArray(body.attachments) ? body.attachments : undefined,
      );
    } catch (attErr) {
      const msg =
        attErr instanceof Error ? attErr.message : "Failed to load attachments";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const sent = await sendSmtp({
      username,
      mailboxEmail,
      to,
      cc,
      bcc,
      subject: personalizedSubject,
      body: sendBody,
      html: asHtml,
      credsOverride: smtpCreds,
      attachments: smtpAttachments.length ? smtpAttachments : undefined,
    });

    if (recordActivity) {
      await reportMailerActivity({
        token: handoffToken || undefined,
        authToken: authToken || undefined,
        kind: "send_result",
        ok: sent.ok,
        to_email: to,
        subject: personalizedSubject,
        company_name: mergeLead.company_name || companyName,
        buyer_id: buyerId,
        interaction_id: tracked.interaction_id || undefined,
        error_message: sent.ok ? undefined : sent.message,
        send_mode: sendMode,
        record_send: true,
      });
    }

    if (!sent.ok) {
      return NextResponse.json({ ok: false, error: sent.message }, { status: 502 });
    }

    // cPanel SMTP does not auto-save to Sent — APPEND via Railway IMAP.
    const savedToSent = await appendMailerSentCopy({
      token: handoffToken || undefined,
      authToken: authToken || undefined,
      to,
      cc,
      bcc,
      subject,
      body: text,
      html: asHtml,
    });

    return NextResponse.json({
      ok: true,
      message: sent.message,
      saved_to_sent: savedToSent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Send failed: ${message}` },
      { status: 500 },
    );
  }
}
