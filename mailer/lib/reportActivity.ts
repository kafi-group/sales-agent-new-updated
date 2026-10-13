/** Report Vercel mailer sends to Sales Agent Email Activity. */

export type ActivityFailure = {
  to_email?: string;
  email?: string;
  company_name?: string;
  buyer_id?: number;
  error?: string;
  message?: string;
};

export type ActivityReport = {
  token?: string;
  authToken?: string;
  kind: "send_result" | "bulk_started" | "bulk_finished";
  ok?: boolean;
  to_email?: string;
  subject?: string;
  company_name?: string;
  buyer_id?: number;
  interaction_id?: number;
  error_message?: string;
  send_mode?: "individual" | "bulk";
  /** When false, skip per-message rows (bulk uses summary events only). */
  record_send?: boolean;
  selected_count?: number;
  sent_count?: number;
  failed_count?: number;
  skipped_count?: number;
  failures?: ActivityFailure[];
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
 * Best-effort: never throw — a failed activity log must not block SMTP success.
 * Returns whether the Sales Agent accepted the event.
 */
export async function reportMailerActivity(
  report: ActivityReport,
): Promise<boolean> {
  const base = apiBase();
  if (!base) {
    console.warn("[mailer] KAFI_API_BASE_URL missing — cannot report email activity");
    return false;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (report.authToken) {
    headers.Authorization = `Bearer ${report.authToken}`;
  }

  const body = {
    token: report.token || undefined,
    kind: report.kind,
    ok: report.ok,
    to_email: report.to_email,
    subject: report.subject,
    company_name: report.company_name,
    buyer_id: report.buyer_id,
    interaction_id: report.interaction_id,
    error_message: report.error_message,
    send_mode: report.send_mode || "individual",
    record_send: report.record_send !== false,
    selected_count: report.selected_count,
    sent_count: report.sent_count,
    failed_count: report.failed_count,
    skipped_count: report.skipped_count,
    failures: report.failures,
  };

  try {
    const res = await fetch(`${base}/mailer/report-activity`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[mailer] report-activity failed (${res.status}): ${text.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `[mailer] report-activity network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
