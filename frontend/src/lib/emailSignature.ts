/** Per-user email signature for manual (non-bulk) compose. */

export type SignatureUser = {
  username?: string | null;
  full_name?: string | null;
  mailbox_email?: string | null;
  mailbox_display_name?: string | null;
};

const COMPANY_LINE = "KAFI Commodities Pvt Ltd.";
const WEBSITE_LINE = "www.kafi-group.com";
export const SIG_HTML_START = "<!--kafi-email-sig-->";
export const SIG_HTML_END = "<!--/kafi-email-sig-->";

type SigProfile = { name: string; cell: string };

/**
 * Login profile → public email alias + cell.
 * Usman Khan signs as Asad Ali; Asim signs as Anjum Ali.
 */
const PROFILE_BY_KEY: Record<string, SigProfile> = {
  // Khalid / admin
  admin: { name: "Khalid Paracha", cell: "+92-300-8206633" },
  khalid: { name: "Khalid Paracha", cell: "+92-300-8206633" },
  "khalid.paracha": { name: "Khalid Paracha", cell: "+92-300-8206633" },
  "khaled.paracha": { name: "Khalid Paracha", cell: "+92-300-8206633" },
  "khalid@kafi-group.com": { name: "Khalid Paracha", cell: "+92-300-8206633" },
  "khalid.paracha@kafi-group.com": { name: "Khalid Paracha", cell: "+92-300-8206633" },
  "khaled.paracha@kafi-group.com": { name: "Khalid Paracha", cell: "+92-300-8206633" },
  // Usman Khan → Asad Ali
  usman: { name: "Asad Ali", cell: "+92-333-0313518" },
  "usman.khan": { name: "Asad Ali", cell: "+92-333-0313518" },
  "usman khan": { name: "Asad Ali", cell: "+92-333-0313518" },
  "usman@kafi-group.com": { name: "Asad Ali", cell: "+92-333-0313518" },
  "asad ali": { name: "Asad Ali", cell: "+92-333-0313518" },
  // Asim → Anjum Ali
  asim: { name: "Anjum Ali", cell: "+92-333-0313513" },
  "asim@kafi-group.com": { name: "Anjum Ali", cell: "+92-333-0313513" },
  "anjum ali": { name: "Anjum Ali", cell: "+92-333-0313513" },
};

function norm(raw: string | null | undefined): string {
  return (raw || "").trim().toLowerCase();
}

function lookupProfile(user: SignatureUser | null | undefined): SigProfile | null {
  if (!user) return null;
  const keys = [
    norm(user.username),
    norm(user.mailbox_email),
    norm(user.full_name),
    norm(user.mailbox_display_name),
  ].filter(Boolean);

  for (const key of keys) {
    if (PROFILE_BY_KEY[key]) return PROFILE_BY_KEY[key];
  }

  const blob = keys.join(" ");
  if (blob.includes("usman")) return PROFILE_BY_KEY.usman;
  if (blob.includes("asim")) return PROFILE_BY_KEY.asim;
  if (blob.includes("khalid") || blob.includes("khaled.paracha")) return PROFILE_BY_KEY.khalid;
  if (blob.includes("asad")) return PROFILE_BY_KEY["asad ali"];
  if (blob.includes("anjum")) return PROFILE_BY_KEY["anjum ali"];
  return null;
}

export function signatureDisplayName(user: SignatureUser | null | undefined): string {
  const profile = lookupProfile(user);
  if (profile) return profile.name;

  if (!user) return "KAFI Team";
  const full = (user.full_name || "").trim();
  const display = (user.mailbox_display_name || "").trim();

  if (
    norm(user.username) === "admin" ||
    full === "Administrator" ||
    full === "Admin"
  ) {
    return "Khalid Paracha";
  }

  if (display && !/^admin(istrator)?$/i.test(display)) {
    return display.replace(/^mr\.?\s+/i, "").trim() || display;
  }
  if (full && full !== "Administrator" && full !== "Admin") {
    return full.replace(/^mr\.?\s+/i, "").trim() || full;
  }
  return user.username?.trim() || "KAFI Team";
}

function cellForUser(user: SignatureUser | null | undefined): string | null {
  return lookupProfile(user)?.cell ?? null;
}

export function buildEmailSignaturePlain(user: SignatureUser | null | undefined): string {
  const lines = [signatureDisplayName(user), COMPANY_LINE];
  const cell = cellForUser(user);
  if (cell) lines.push(`Cell: ${cell}`);
  lines.push(WEBSITE_LINE);
  return lines.join("\n");
}

export function stripEmailSignatureHtml(html: string): string {
  if (!html?.trim()) return "";
  let out = html.replace(
    new RegExp(`${SIG_HTML_START}[\\s\\S]*?${SIG_HTML_END}`, "gi"),
    "",
  );

  const lower = out.toLowerCase();
  const companyIdx = lower.lastIndexOf("kafi commodities");
  if (companyIdx >= 0) {
    const before = out.slice(0, companyIdx);
    let cut = before.toLowerCase().lastIndexOf("<p");
    if (cut < 0) cut = companyIdx;
    const nameProbe = before.slice(0, cut).toLowerCase().lastIndexOf("<p");
    if (nameProbe >= 0) {
      const nameChunk = before.slice(nameProbe, cut);
      const nameText = nameChunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (
        nameText &&
        nameText.length < 80 &&
        !nameText.includes("@") &&
        !/^dear\b/i.test(nameText)
      ) {
        cut = nameProbe;
      }
    }
    out = out.slice(0, cut);
  }

  return out.replace(/(<p><br\s*\/?><\/p>\s*)+$/i, "").trimEnd();
}

export function bodyHasCurrentUserSignature(
  html: string,
  user: SignatureUser | null | undefined,
  plainTextOf: (html: string) => string,
): boolean {
  const plain = plainTextOf(html || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const name = signatureDisplayName(user).toLowerCase();
  const cell = cellForUser(user)?.replace(/\s+/g, "") || "";
  const plainCompact = plain.replace(/\s+/g, "");
  return (
    plain.includes(name) &&
    plain.includes("kafi commodities") &&
    plain.includes("kafi-group.com") &&
    (!cell || plainCompact.includes(cell.replace(/\s+/g, "")))
  );
}

export function applyEmailSignatureHtml(
  html: string,
  user: SignatureUser | null | undefined,
  toHtml: (plain: string) => string,
): string {
  const cleaned = stripEmailSignatureHtml(html);
  const sigHtml = `${SIG_HTML_START}${toHtml(buildEmailSignaturePlain(user))}${SIG_HTML_END}`;
  const spacer = cleaned.trim() ? "<p><br></p>" : "";
  return `${cleaned}${spacer}${sigHtml}`;
}
