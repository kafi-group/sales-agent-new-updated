/** Build Reply / Reply All recipient lists from an inbound (or sent) message. */

export type ReplyAddressMessage = {
  from_email?: string | null;
  to?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  direction?: string | null;
};

export type ReplyRecipients = {
  to: string;
  cc: string;
  bcc: string;
};

export function extractEmail(raw?: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const match = trimmed.match(/<([^>]+@[^>]+)>/);
  if (match?.[1]) return match[1].trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return "";
}

function uniqueEmails(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const email = extractEmail(value);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Reply → only the From address (or first To if this is our outbound message).
 * Reply All → From in To; other To/Cc in Cc; original Bcc stays in Bcc.
 */
export function buildReplyRecipients(
  message: ReplyAddressMessage,
  mailboxEmail: string | null | undefined,
  mode: "reply" | "reply_all",
): ReplyRecipients {
  const self = extractEmail(mailboxEmail);
  const from = extractEmail(message.from_email);
  const toList = uniqueEmails(message.to || []);
  const ccList = uniqueEmails(message.cc || []);
  const bccList = uniqueEmails(message.bcc || []);

  if ((message.direction || "").toLowerCase() === "outbound") {
    const primary = toList[0] || "";
    if (mode === "reply" || !primary) {
      return { to: primary, cc: "", bcc: "" };
    }
    const cc = uniqueEmails([...toList.slice(1), ...ccList]).filter(
      (email) => email !== self && email !== primary,
    );
    const bcc = bccList.filter(
      (email) => email !== self && email !== primary && !cc.includes(email),
    );
    return { to: primary, cc: cc.join(", "), bcc: bcc.join(", ") };
  }

  if (mode === "reply") {
    return { to: from, cc: "", bcc: "" };
  }

  const cc = uniqueEmails([...toList, ...ccList]).filter(
    (email) => email !== self && email !== from,
  );
  const bcc = bccList.filter(
    (email) => email !== self && email !== from && !cc.includes(email),
  );
  return { to: from, cc: cc.join(", "), bcc: bcc.join(", ") };
}

export function hasReplyAllTargets(
  message: ReplyAddressMessage,
  mailboxEmail: string | null | undefined,
): boolean {
  const recipients = buildReplyRecipients(message, mailboxEmail, "reply_all");
  return Boolean(recipients.cc.trim() || recipients.bcc.trim());
}
