export const CALL_OUTCOMES = [
  { value: "interested", label: "Client is Interested" },
  { value: "follow_up", label: "Follow up" },
  { value: "not_interested", label: "Not interested" },
  { value: "not_received_call", label: "Did not receive call" },
  { value: "closed_business", label: "Closed Business – Do Not Contact" },
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number]["value"];

/** Sub-options when outcome is "Did not receive call". */
export const NO_ANSWER_VOICE_OPTIONS = [
  { value: "voice_call", label: "Voice call" },
  { value: "no_voice_call", label: "No voice call" },
] as const;

export type NoAnswerVoiceOption = (typeof NO_ANSWER_VOICE_OPTIONS)[number]["value"];

/** Quick remark presets for unanswered calls. */
export const VOICEMAIL_REMARK_OPTIONS = [
  { value: "Voicemail", label: "Voicemail" },
  { value: "No voicemail", label: "No voicemail" },
] as const;

/** Sub-options when outcome is "Not interested". */
export const NOT_INTERESTED_REASON_OPTIONS = [
  { value: "has_supplier", label: "Already has a supplier" },
  { value: "price", label: "Price not competitive" },
  { value: "product_fit", label: "Doesn't deal in these products" },
  { value: "timing", label: "Not buying right now" },
] as const;

export type NotInterestedReasonOption =
  (typeof NOT_INTERESTED_REASON_OPTIONS)[number]["value"];

const VOICE_LABEL_BY_VALUE: Record<NoAnswerVoiceOption, string> = {
  voice_call: "Voice call",
  no_voice_call: "No voice call",
};

const VOICE_VALUE_BY_LABEL: Record<string, NoAnswerVoiceOption> = {
  "voice call": "voice_call",
  "no voice call": "no_voice_call",
};

const NOT_INTERESTED_LABEL_BY_VALUE: Record<NotInterestedReasonOption, string> = {
  has_supplier: "Already has a supplier",
  price: "Price not competitive",
  product_fit: "Doesn't deal in these products",
  timing: "Not buying right now",
};

const NOT_INTERESTED_VALUE_BY_LABEL: Record<string, NotInterestedReasonOption> = {
  "already has a supplier": "has_supplier",
  "price not competitive": "price",
  "doesn't deal in these products": "product_fit",
  "doesnt deal in these products": "product_fit",
  "not buying right now": "timing",
};

const NO_ANSWER_TAG_LABELS = new Set([
  "voice call",
  "no voice call",
  "voicemail",
  "no voicemail",
]);
const NOT_INTERESTED_TAG_LABELS = new Set(Object.keys(NOT_INTERESTED_VALUE_BY_LABEL));

export function noAnswerVoiceLabel(value: NoAnswerVoiceOption | ""): string | null {
  if (!value) return null;
  return VOICE_LABEL_BY_VALUE[value] ?? null;
}

export function notInterestedReasonLabel(
  value: NotInterestedReasonOption | "",
): string | null {
  if (!value) return null;
  return NOT_INTERESTED_LABEL_BY_VALUE[value] ?? null;
}

/** Pull a saved Voice call / No voice call line out of free-text remarks. */
export function parseNoAnswerVoiceFromRemarks(
  remarks: string | null | undefined,
): NoAnswerVoiceOption | "" {
  if (!remarks) return "";
  for (const line of remarks.split(/\r?\n/)) {
    const key = line.trim().toLowerCase();
    if (key in VOICE_VALUE_BY_LABEL) return VOICE_VALUE_BY_LABEL[key];
  }
  return "";
}

/** Pull a saved not-interested reason line out of free-text remarks. */
export function parseNotInterestedReasonFromRemarks(
  remarks: string | null | undefined,
): NotInterestedReasonOption | "" {
  if (!remarks) return "";
  for (const line of remarks.split(/\r?\n/)) {
    const key = line.trim().toLowerCase();
    if (key in NOT_INTERESTED_VALUE_BY_LABEL) {
      return NOT_INTERESTED_VALUE_BY_LABEL[key];
    }
  }
  return "";
}

function stripTaggedLines(remarks: string, labels: Set<string>): string {
  return remarks
    .split(/\r?\n/)
    .filter((line) => !labels.has(line.trim().toLowerCase()))
    .join("\n")
    .replace(/^\n+/, "")
    .trimStart();
}

/** Keep remarks free-text in sync with the Voice call / No voice call dropdown. */
export function applyNoAnswerVoiceToRemarks(
  remarks: string,
  voice: NoAnswerVoiceOption | "",
): string {
  const withoutVoice = stripTaggedLines(
    remarks,
    new Set(["voice call", "no voice call"]),
  );
  const label = noAnswerVoiceLabel(voice);
  if (!label) return withoutVoice.trim();
  if (!withoutVoice.trim()) return label;
  return `${label}\n${withoutVoice.trim()}`;
}

/** Keep remarks free-text in sync with the Not interested reason dropdown. */
export function applyNotInterestedReasonToRemarks(
  remarks: string,
  reason: NotInterestedReasonOption | "",
): string {
  const withoutReason = stripTaggedLines(remarks, NOT_INTERESTED_TAG_LABELS);
  const label = notInterestedReasonLabel(reason);
  if (!label) return withoutReason.trim();
  if (!withoutReason.trim()) return label;
  return `${label}\n${withoutReason.trim()}`;
}

/** Remove outcome-specific tagged lines when switching away from that outcome. */
export function clearOutcomeTagsFromRemarks(
  remarks: string,
  outcome: CallOutcome | "",
): string {
  if (outcome === "not_received_call") {
    return stripTaggedLines(remarks, NO_ANSWER_TAG_LABELS).trim();
  }
  if (outcome === "not_interested") {
    return stripTaggedLines(remarks, NOT_INTERESTED_TAG_LABELS).trim();
  }
  return remarks;
}

/** Toggle a Voicemail / No voicemail preset inside remarks. */
export function toggleVoicemailRemark(remarks: string, preset: string): string {
  const lines = remarks
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line === "" && index === all.length - 1));

  const presetLower = preset.toLowerCase();
  const other =
    presetLower === "voicemail"
      ? "no voicemail"
      : presetLower === "no voicemail"
        ? "voicemail"
        : null;

  const hasPreset = lines.some((line) => line.trim().toLowerCase() === presetLower);
  const withoutPair = lines.filter((line) => {
    const key = line.trim().toLowerCase();
    return key !== presetLower && key !== other;
  });

  if (hasPreset) {
    return withoutPair.join("\n").trim();
  }
  // Keep Voice call / No voice call lines first when present.
  const voiceIdx = withoutPair.findIndex((line) => {
    const key = line.trim().toLowerCase();
    return key === "voice call" || key === "no voice call";
  });
  if (voiceIdx >= 0) {
    const next = [...withoutPair];
    next.splice(voiceIdx + 1, 0, preset);
    return next.join("\n").trim();
  }
  return [preset, ...withoutPair].join("\n").trim();
}

export function remarksHasVoicemailPreset(
  remarks: string,
  preset: string,
): boolean {
  return remarks
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === preset.toLowerCase());
}

export function callOutcomeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return CALL_OUTCOMES.find((item) => item.value === value)?.label ?? value;
}

export function callOutcomeBadge(value: string | null | undefined): string {
  if (value === "interested") {
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  }
  if (value === "follow_up") {
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  }
  if (value === "not_interested") {
    return "bg-red-500/15 text-red-300 border-red-500/30";
  }
  if (value === "not_received_call") {
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  }
  if (value === "closed_business") {
    return "bg-rose-900/40 text-rose-200 border-rose-700/50";
  }
  return "bg-slate-700/50 text-slate-300 border-slate-600";
}

export function callOutcomeListNotice(value: string | null | undefined): string | null {
  if (value === "interested") return "Client moved to Interested Clients.";
  if (value === "follow_up") return "Client moved to Follow up clients.";
  if (value === "not_interested") return "Client moved to Not interested.";
  if (value === "not_received_call") return "Client moved to Did not receive call.";
  if (value === "closed_business") return "Marked as Closed Business – Do Not Contact.";
  return null;
}

export function callOutcomeSectionHint(value: CallOutcome | ""): string | null {
  if (value === "interested") {
    return "Client moves to Interested Clients — they want to buy / continue.";
  }
  if (value === "follow_up") {
    return "Client moves to Follow up clients — schedule the next call (does not mean they are interested).";
  }
  if (value === "not_interested") {
    return "Client moves from Leads table or Old clients to Not interested.";
  }
  if (value === "not_received_call") {
    return "Client moves from Leads table or Old clients to Did not receive call.";
  }
  if (value === "closed_business") {
    return "The business has closed or must not be contacted — it leaves Interested and Follow up.";
  }
  return null;
}
