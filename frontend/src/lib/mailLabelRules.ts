import type {
  InboxMessageSummary,
  InboxThreadSummary,
  MailLabel,
  MailLabelMessageKey,
} from "../api/client";

export function normSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  return subject
    .replace(/^(re|fw|fwd)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = raw.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (text.includes("@") && !text.includes(" ")) {
    const [, host] = text.split("@");
    return host?.includes(".") ? text : "";
  }
  const host = text.split("/")[0]?.split("?")[0] || text;
  return host.includes(".") ? host.trim() : "";
}

export function normalizeKeyword(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = raw.trim().toLowerCase();
  return text.length >= 2 ? text : "";
}

export function emailMatchesDomainRule(
  email: string | null | undefined,
  rule: string,
): boolean {
  if (!rule || !email) return false;
  const value = email.trim().toLowerCase();
  const token = rule.trim().toLowerCase();
  if (!value || !token) return false;
  if (token.includes("@")) return value === token;
  if (!value.includes("@")) return false;
  const domain = value.split("@")[1] || "";
  return domain === token || domain.endsWith(`.${token}`);
}

export function textMatchesKeyword(
  text: string | null | undefined,
  keyword: string,
): boolean {
  if (!keyword || !text) return false;
  return text.toLowerCase().includes(keyword);
}

export function labelRoutingSummary(
  label: Pick<MailLabel, "match_query" | "match_keyword">,
): { domain: string; keyword: string } {
  return {
    domain: normalizeDomain(label.match_query),
    keyword: normalizeKeyword(label.match_keyword),
  };
}

export function messageMatchesLabelKeys(
  message: InboxMessageSummary,
  keys: MailLabelMessageKey[],
): boolean {
  // Exact folder + UID only — never expand by sender/domain/subject.
  const uid = String(message.uid);
  const folder = (message.folder || "inbox").toLowerCase();
  for (const key of keys) {
    if (String(key.message_uid) === uid && key.folder.toLowerCase() === folder) {
      return true;
    }
  }
  return false;
}

export function messageMatchesLabelRules(
  message: Pick<
    InboxMessageSummary,
    "from_email" | "to" | "subject" | "preview"
  > & {
    from_name?: string | null;
    body_text?: string | null;
  },
  label: MailLabel,
): boolean {
  // Built-in Flagged mailbox is manual-only (exact UID assignments).
  if (label.is_system || label.name.trim().toLowerCase() === "flagged") {
    return false;
  }
  const { domain, keyword } = labelRoutingSummary(label);
  if (!domain && !keyword) return false;
  if (domain) {
    if (emailMatchesDomainRule(message.from_email, domain)) return true;
    if ((message.to || []).some((addr) => emailMatchesDomainRule(addr, domain))) return true;
  }
  if (keyword) {
    if (textMatchesKeyword(message.from_name, keyword)) return true;
    if (textMatchesKeyword(message.subject, keyword)) return true;
    if (textMatchesKeyword(message.preview, keyword)) return true;
    if (textMatchesKeyword(message.body_text, keyword)) return true;
  }
  return false;
}

export function threadMatchesAnyLabelRule(
  thread: InboxThreadSummary,
  labels: MailLabel[],
): boolean {
  return labels.some((label) => {
    const { domain, keyword } = labelRoutingSummary(label);
    if (!domain && !keyword) return false;
    if (domain) {
      if (emailMatchesDomainRule(thread.latest_from_email, domain)) return true;
      if ((thread.participants || []).some((p) => emailMatchesDomainRule(p, domain))) return true;
    }
    if (keyword) {
      if (textMatchesKeyword(thread.latest_from_name, keyword)) return true;
      if (textMatchesKeyword(thread.subject, keyword)) return true;
      if (textMatchesKeyword(thread.latest_preview, keyword)) return true;
    }
    return false;
  });
}

export function countMessagesForLabel(
  messages: InboxMessageSummary[],
  label: MailLabel,
  assignmentKeys: MailLabelMessageKey[] = [],
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const message of messages) {
    const folder = (message.folder || "inbox").toLowerCase();
    const key = `${folder}:${message.uid}`;
    if (seen.has(key)) continue;
    if (
      messageMatchesLabelRules(message, label) ||
      messageMatchesLabelKeys(message, assignmentKeys)
    ) {
      seen.add(key);
      count += 1;
    }
  }
  for (const assignment of assignmentKeys) {
    const key = `${assignment.folder.toLowerCase()}:${assignment.message_uid}`;
    if (!seen.has(key)) {
      seen.add(key);
      count += 1;
    }
  }
  return count;
}

export function mailLabelSectionId(
  label: Pick<MailLabel, "id" | "name">,
): `label:${number}` | `label-linkedin:${number}` {
  return /linkedin/i.test(label.name)
    ? (`label-linkedin:${label.id}` as const)
    : (`label:${label.id}` as const);
}

export function mailLabelIdFromNavId(navId: string): number | null {
  const match = navId.match(/^label(?:-linkedin)?:(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}
