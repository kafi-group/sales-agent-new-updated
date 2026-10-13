import { client } from "../api/client";
import type { ParsedBrandLead } from "./parseBrandAssistantLead";

function normEmail(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normPhone(value: string | null | undefined): string {
  return (value || "").replace(/\D/g, "");
}

/** Short summary when Master Table may already have this company or contact. */
export async function summarizeBrandAssistantDuplicates(
  parsed: ParsedBrandLead,
): Promise<string | null> {
  const lines: string[] = [];
  const company = parsed.company_name.trim();

  if (company.length >= 2) {
    try {
      const { rows } = await client.suggestCompanyNames(company, 8);
      const companyLower = company.toLowerCase();
      const exact = rows.filter((r) => r.company_name.toLowerCase() === companyLower);
      const similar = rows
        .filter((r) => r.company_name.toLowerCase() !== companyLower)
        .slice(0, 3);
      if (exact.length) {
        lines.push(
          `Company already in Master Table: ${exact
            .map((r) => `${r.company_name} (#${r.id}${r.country ? `, ${r.country}` : ""})`)
            .join("; ")}`,
        );
      } else if (similar.length) {
        lines.push(
          `Similar companies found: ${similar
            .map((r) => `${r.company_name} (#${r.id})`)
            .join(", ")}`,
        );
      }
    } catch {
      /* ignore suggestion errors */
    }
  }

  const email = normEmail(parsed.contact_email);
  const phone = normPhone(parsed.contact_phone);

  if (email || phone) {
    try {
      const search = email || parsed.contact_phone || company;
      if (search.length >= 3) {
        const result = await client.listLeadsTable({
          master: true,
          q: search,
          page_size: 10,
        });
        for (const row of result.rows) {
          if (email) {
            const emails = [row.contact_email, row.contact_secondary_email].map(normEmail);
            if (emails.includes(email)) {
              lines.push(
                `Email ${parsed.contact_email} matches ${row.company_name} (#${row.id}) in Master Table.`,
              );
              break;
            }
          }
          if (phone && phone.length >= 7) {
            const phones = [
              row.contact_phone,
              row.contact_primary_phone,
              row.contact_secondary_phone,
              row.contact_secondary_mobile,
            ].map(normPhone);
            if (phones.some((p) => p && (p === phone || p.endsWith(phone.slice(-9))))) {
              lines.push(
                `Phone matches ${row.company_name} (#${row.id}) in Master Table.`,
              );
              break;
            }
          }
        }
      }
    } catch {
      /* ignore search errors */
    }
  }

  if (!lines.length) return null;
  return lines.join("\n");
}
