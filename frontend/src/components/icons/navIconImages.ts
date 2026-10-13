import adminIcon from "../../assets/nav-icons/admin.png";
import bulkEmailSenderIcon from "../../assets/nav-icons/bulk-email-sender.png";
import callCenterIcon from "../../assets/nav-icons/call-center.png";
import cnfFobIcon from "../../assets/nav-icons/cnf-fob.png";
import emailIcon from "../../assets/nav-icons/email.png";
import emailTemplatesIcon from "../../assets/nav-icons/email-templates.png";
import financeKafiIcon from "../../assets/nav-icons/finance-kafi.png";
import infoKafiIcon from "../../assets/nav-icons/info-kafi.png";
import noReplyGoogleIcon from "../../assets/nav-icons/no-reply-google.png";

const NAV_ICON_SRC: Record<string, string> = {
  inbox: emailIcon,
  "email-templates": emailTemplatesIcon,
  mail: bulkEmailSenderIcon,
  calls: callCenterIcon,
  "quotation-agent": cnfFobIcon,
};

const LABEL_ICON_PATTERNS: { pattern: RegExp; src: string }[] = [
  { pattern: /finance\s*kafi/i, src: financeKafiIcon },
  { pattern: /info\s*kafi/i, src: infoKafiIcon },
  { pattern: /no\s*reply\s*google/i, src: noReplyGoogleIcon },
];

export { adminIcon };

export function resolveNavIconSrc(navId: string, label?: string): string | null {
  if (navId.startsWith("label:") && label) {
    for (const { pattern, src } of LABEL_ICON_PATTERNS) {
      if (pattern.test(label)) return src;
    }
    return null;
  }
  return NAV_ICON_SRC[navId] ?? null;
}
