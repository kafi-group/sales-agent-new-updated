import type { EmailAttachment } from "../api/client";

export const PLACEHOLDER_HINTS = [
  "[company_name]",
  "[contact_name]",
  "[country]",
  "[industry]",
  "[designation]",
  "[website_url]",
];

export const DEFAULT_TEMPLATE_SUBJECT = "Kafi Commodities — for [company_name]";
export const DEFAULT_TEMPLATE_BODY = `Dear [contact_name],

I hope this message finds you well. We at Kafi Commodities would like to connect with [company_name] regarding our ESSENCE product range.

Please let us know if you would like specifications or pricing.

Best regards,
Kafi Commodities Export Team`;

export function emptyTemplateForm() {
  return {
    name: "",
    subject: DEFAULT_TEMPLATE_SUBJECT,
    body: DEFAULT_TEMPLATE_BODY,
    attachments: [] as EmailAttachment[],
  };
}
