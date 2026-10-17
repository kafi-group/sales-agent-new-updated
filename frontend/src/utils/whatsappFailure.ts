export type WhatsAppFailureKey =
  | "not_on_whatsapp"
  | "engagement_limit"
  | "undeliverable"
  | "marketing_opt_out"
  | "reengagement"
  | "spam_rate"
  | "eligibility"
  | "other";

export interface WhatsAppFailureInfo {
  key: WhatsAppFailureKey;
  label: string;
  /** What it means and what to do about it, in plain words. */
  hint: string;
}

/** Shown when Meta Cloud or Personal WhatsApp confirms the number has no WhatsApp account. */
export const NOT_ON_WHATSAPP_USER_MESSAGE =
  "This person does not exist on WhatsApp. Check that you are using their personal mobile number (not a landline), then try again.";

export function isNotOnWhatsAppError(message: string | null | undefined): boolean {
  const t = (message || "").toLowerCase();
  if (!t) return false;
  return (
    t.includes("does not exist on whatsapp") ||
    t.includes("not on whatsapp") ||
    t.includes("not a valid whatsapp") ||
    t.includes("not registered on whatsapp") ||
    t.includes("recipient number is not registered") ||
    t.includes("131026") ||
    t.includes("131051") ||
    (t.includes("undeliverable") && !t.includes("healthy ecosystem"))
  );
}

/** Map API / Meta / bridge errors to a clear message for toasts and modals. */
export function formatWhatsAppErrorForUser(message: string | null | undefined): string {
  const trimmed = (message || "").trim();
  if (!trimmed) return trimmed;
  if (isNotOnWhatsAppError(trimmed)) return NOT_ON_WHATSAPP_USER_MESSAGE;
  return trimmed;
}

/**
 * Sorts a WhatsApp delivery error (Meta wording or error code) into a plain category.
 */
export function classifyWhatsAppFailure(message: string | null | undefined): WhatsAppFailureInfo {
  const t = (message || "").toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  if (isNotOnWhatsAppError(message)) {
    return {
      key: "not_on_whatsapp",
      label: "Not on WhatsApp",
      hint: NOT_ON_WHATSAPP_USER_MESSAGE,
    };
  }
  if (has("healthy ecosystem", "131049")) {
    return {
      key: "engagement_limit",
      label: "Healthy ecosystem engagement",
      hint:
        "WhatsApp chose not to deliver this marketing message to this person. The number is fine. " +
        "Try later, message them from your personal WhatsApp, or wait for them to write first.",
    };
  }
  if (has("stopped receiving", "131050", "opted out", "opt out")) {
    return {
      key: "marketing_opt_out",
      label: "Opted out of marketing",
      hint: "This person chose to stop receiving marketing messages from your business.",
    };
  }
  if (has("undeliverable", "131026", "not a valid whatsapp", "not on whatsapp")) {
    return {
      key: "undeliverable",
      label: "Could not deliver",
      hint:
        "WhatsApp blocked delivery. The number may be wrong, or the contact may have blocked the business.",
    };
  }
  if (has("131047", "re-engagement", "24 hour", "24-hour")) {
    return {
      key: "reengagement",
      label: "Outside the 24-hour window",
      hint: "Free-text messages only work within 24 hours of the customer’s last message — use an approved template.",
    };
  }
  if (has("131048", "spam rate")) {
    return {
      key: "spam_rate",
      label: "Sending limited (spam rate)",
      hint: "WhatsApp restricted sending because too many recipients flagged messages. Slow down and review the template.",
    };
  }
  if (has("131042", "payment", "eligibility")) {
    return {
      key: "eligibility",
      label: "Account / billing issue",
      hint: "WhatsApp rejected the send because of a billing or business-eligibility problem. It affects every message, not this contact.",
    };
  }
  return { key: "other", label: "Other error", hint: "" };
}

/** Digits-only phone for a wa.me link ("Check on WhatsApp"). */
export function waDigits(phone: string | null | undefined): string {
  return (phone || "").replace(/\D/g, "");
}
