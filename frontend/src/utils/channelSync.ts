/** Keep Email and WhatsApp customer messages synchronized (same information). */

import { htmlToPlainText } from "../components/EmailBodyEditor";

const WHATSAPP_MAX_LEN = 2000;

/** Derive WhatsApp text from the email body (email is source of truth). */
export function deriveWhatsAppFromEmail(emailBody: string): string {
  let text = htmlToPlainText(emailBody || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  while (text.includes("\n\n\n")) {
    text = text.replace(/\n\n\n/g, "\n\n");
  }
  if (text.length > WHATSAPP_MAX_LEN) {
    const cut = text.slice(0, WHATSAPP_MAX_LEN - 1);
    const atSpace = cut.lastIndexOf(" ");
    text = `${(atSpace > 40 ? cut.slice(0, atSpace) : cut).trimEnd()}…`;
  }
  return text;
}
