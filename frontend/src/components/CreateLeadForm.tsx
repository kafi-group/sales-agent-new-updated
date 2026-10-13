import { useState, type FormEvent } from "react";
import { CountrySelect } from "../components/CountrySelect";
import { IndustrySelect } from "../components/IndustrySelect";
import { CompanyNameSuggest } from "../components/CompanyNameSuggest";
import {
  client,
  type CompanyNameSuggestion,
  type LeadTableRow,
} from "../api/client";
import {
  autocorrectText,
  capitalizeFirstLetter,
  spellingInputProps,
} from "../utils/spelling";
import {
  composeWebsiteUrl,
  splitWebsiteUrl,
  type WebsitePrefix,
} from "../utils/websiteUrl";

export type CreateLeadFormValues = {
  company_name: string;
  website_domain: string;
  website_prefix: WebsitePrefix;
  country: string;
  industry: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  contact_designation: string;
  address?: string;
  city?: string;
  company_grading?: string;
  product_interest?: string;
  linkedin_company_url?: string;
  facebook_company_url?: string;
  instagram_company_url?: string;
};

interface CreateLeadFormProps {
  onSuccess: (leadId: number) => void;
  onCancel: () => void;
  onError: (message: string) => void;
  /** When user picks an existing master-table match — open that profile instead. */
  onOpenExisting?: (leadId: number) => void;
  /** Buyer source so the lead appears in the right table section (e.g. old_clients). */
  source?: string;
  title?: string;
  /** Pre-fill from Duplicate and Update, AI Research, etc. */
  initialValues?: Partial<CreateLeadFormValues>;
  /**
   * Intentionally create another row for the same company (new department /
   * contact). Skips the master-table duplicate blocker.
   */
  allowDuplicateCompany?: boolean;
  submitLabel?: string;
}

const emptyForm: CreateLeadFormValues = {
  company_name: "",
  website_domain: "",
  website_prefix: "https://",
  country: "",
  industry: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
  contact_designation: "",
};

/** Map a table row into Add Lead form values for Duplicate and Update. */
export function leadRowToDuplicateFormValues(row: LeadTableRow): CreateLeadFormValues {
  const website = splitWebsiteUrl(row.website_url);
  const contactName = (row.contact_name || "").trim();
  return {
    company_name: row.company_name || "",
    website_domain: website.domain,
    website_prefix: website.prefix,
    country: row.country || "",
    industry: row.industry || "",
    contact_name:
      !contactName || contactName.toLowerCase() === "general contact"
        ? ""
        : contactName,
    contact_email: row.contact_email || "",
    contact_phone: row.contact_phone || "",
    contact_designation: row.contact_designation || "",
    address: row.address || "",
    city: row.city || "",
    company_grading: row.company_grading || "",
    product_interest: row.product_interest || "",
    linkedin_company_url: row.linkedin_company_url || "",
    facebook_company_url: row.facebook_company_url || "",
    instagram_company_url: row.instagram_company_url || "",
  };
}

export function CreateLeadForm({
  onSuccess,
  onCancel,
  onError,
  onOpenExisting,
  source = "manual",
  title = "Add new lead",
  initialValues,
  allowDuplicateCompany = false,
  submitLabel,
}: CreateLeadFormProps) {
  const [form, setForm] = useState<CreateLeadFormValues>({
    ...emptyForm,
    ...initialValues,
    website_prefix: initialValues?.website_prefix ?? ("https://" as WebsitePrefix),
  });
  const [submitting, setSubmitting] = useState(false);
  const [existingMatch, setExistingMatch] = useState<CompanyNameSuggestion | null>(
    null,
  );

  function updateField(field: keyof CreateLeadFormValues, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === "company_name") {
      setExistingMatch((prev) => {
        if (!prev) return null;
        return prev.company_name.trim().toLowerCase() === value.trim().toLowerCase()
          ? prev
          : null;
      });
    }
  }

  function handleSelectExisting(suggestion: CompanyNameSuggestion) {
    setForm((prev) => ({
      ...prev,
      company_name: suggestion.company_name,
      country: suggestion.country || prev.country,
      industry: suggestion.industry || prev.industry,
    }));
    if (!allowDuplicateCompany) {
      setExistingMatch(suggestion);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form.company_name.trim()) {
      onError("Company or buyer name is required");
      return;
    }

    if (
      !allowDuplicateCompany &&
      existingMatch &&
      existingMatch.company_name.trim().toLowerCase() ===
        form.company_name.trim().toLowerCase()
    ) {
      onError(
        `"${existingMatch.company_name}" already exists in the master table. Open the existing lead instead of creating a duplicate.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const companyName = autocorrectText(form.company_name, "name");
      const industry = autocorrectText(form.industry, "prose");
      const contactName = autocorrectText(form.contact_name, "name");
      const designation = autocorrectText(form.contact_designation, "prose");

      const lead = await client.createLead({
        company_name: companyName,
        website_url: composeWebsiteUrl(form.website_prefix, form.website_domain),
        country: form.country.trim() || undefined,
        industry: industry || undefined,
        source,
      });

      const tablePatch: Record<string, string | null> = {};
      const address = (initialValues?.address ?? form.address ?? "").trim();
      const city = (initialValues?.city ?? form.city ?? "").trim();
      const grading = (initialValues?.company_grading ?? form.company_grading ?? "").trim();
      const product = (initialValues?.product_interest ?? form.product_interest ?? "").trim();
      const linkedin = (
        initialValues?.linkedin_company_url ??
        form.linkedin_company_url ??
        ""
      ).trim();
      const facebook = (
        initialValues?.facebook_company_url ??
        form.facebook_company_url ??
        ""
      ).trim();
      const instagram = (
        initialValues?.instagram_company_url ??
        form.instagram_company_url ??
        ""
      ).trim();
      if (address) tablePatch.address = address;
      if (city) tablePatch.city = city;
      if (grading) tablePatch.company_grading = grading;
      if (product) tablePatch.product_interest = product;
      if (linkedin) tablePatch.linkedin_company_url = linkedin;
      if (facebook) tablePatch.facebook_company_url = facebook;
      if (instagram) tablePatch.instagram_company_url = instagram;
      if (Object.keys(tablePatch).length > 0) {
        await client.updateLeadTableRow(lead.id, tablePatch);
      }

      if (
        contactName ||
        form.contact_email.trim() ||
        form.contact_phone.trim() ||
        designation
      ) {
        await client.createContact({
          buyer_id: lead.id,
          full_name: contactName || "General contact",
          email: form.contact_email.trim() || undefined,
          phone: form.contact_phone.trim() || undefined,
          designation: designation || undefined,
        });
      }

      setForm(emptyForm);
      setExistingMatch(null);
      onSuccess(lead.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create lead");
    } finally {
      setSubmitting(false);
    }
  }

  const blockedByExisting = Boolean(existingMatch) && !allowDuplicateCompany;
  const primaryLabel =
    submitLabel ??
    (allowDuplicateCompany ? "Save as new contact" : "Create lead");

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-emerald-500/30 bg-slate-900 p-5 space-y-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium text-slate-200">{title}</h3>
          {allowDuplicateCompany ? (
            <p className="text-xs text-slate-500 mt-1">
              Company details are copied from the selected row. Update the contact
              name, phone, email, or designation for the other department, then save.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-slate-400 hover:text-slate-200 shrink-0"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-sm text-slate-400">Company / buyer name *</span>
          <CompanyNameSuggest
            value={form.company_name}
            onChange={(value) => updateField("company_name", value)}
            onSelectExisting={handleSelectExisting}
            disabled={submitting}
          />
          <p className="text-xs text-slate-500 mt-1">
            {allowDuplicateCompany
              ? "Same company is fine — this creates a second row for a different contact/department."
              : "Suggestions come from the master table as you type — pick a match to avoid duplicates."}
          </p>
        </label>

        {existingMatch && !allowDuplicateCompany ? (
          <div className="sm:col-span-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-amber-100/95">
              <span className="font-medium">{existingMatch.company_name}</span> is already
              in the master table
              {existingMatch.country ? ` (${existingMatch.country})` : ""}. Creating again
              would duplicate this lead.
            </p>
            {onOpenExisting ? (
              <button
                type="button"
                onClick={() => onOpenExisting(existingMatch.id)}
                className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/25"
              >
                Open existing
              </button>
            ) : null}
          </div>
        ) : null}

        <CountrySelect
          label="Country"
          multiSelect={false}
          labelClassName="text-sm text-slate-400"
          value={form.country}
          onChange={(value) => updateField("country", value)}
        />

        <IndustrySelect
          label="Industry"
          labelClassName="text-sm text-slate-400"
          value={form.industry}
          onChange={(value) => updateField("industry", value)}
        />

        <div className="block sm:col-span-2">
          <span className="text-sm text-slate-400">Website (optional)</span>
          <div className="mt-1 flex rounded-lg border border-slate-700 bg-slate-950 overflow-hidden focus-within:border-emerald-500/50">
            <label className="sr-only" htmlFor="lead-website-prefix">
              URL prefix
            </label>
            <select
              id="lead-website-prefix"
              value={form.website_prefix}
              onChange={(e) =>
                updateField("website_prefix", e.target.value as WebsitePrefix)
              }
              disabled={submitting}
              className="shrink-0 border-r border-slate-700 bg-slate-900 px-2.5 py-2 text-sm text-slate-300 outline-none"
            >
              <option value="https://">https://</option>
              <option value="http://">http://</option>
              <option value="www.">www.</option>
            </select>
            <input
              type="text"
              inputMode="url"
              value={form.website_domain}
              onChange={(e) => updateField("website_domain", e.target.value)}
              placeholder="example.com"
              disabled={submitting}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 outline-none"
              {...spellingInputProps("off")}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Optional — enter the domain only (e.g. alnoorfoods.com). Leave blank if unknown.
          </p>
        </div>
      </div>

      <fieldset className="border-t border-slate-800 pt-4">
        <legend className="text-sm font-medium text-slate-300 px-1">
          {allowDuplicateCompany
            ? "Contact for the other department"
            : "Primary contact (optional)"}
        </legend>
        <div className="grid gap-4 sm:grid-cols-2 mt-3">
          <label className="block sm:col-span-2">
            <span className="text-sm text-slate-400">Full name</span>
            <input
              type="text"
              value={form.contact_name}
              onChange={(e) =>
                updateField("contact_name", capitalizeFirstLetter(e.target.value))
              }
              onBlur={(e) =>
                updateField("contact_name", autocorrectText(e.target.value, "name"))
              }
              placeholder="e.g. Ahmed Al-Rashid"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("name")}
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-400">Email</span>
            <input
              type="email"
              value={form.contact_email}
              onChange={(e) => updateField("contact_email", e.target.value)}
              placeholder="name@company.com"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("off")}
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-400">Phone</span>
            <input
              type="tel"
              value={form.contact_phone}
              onChange={(e) => updateField("contact_phone", e.target.value)}
              placeholder="+971..."
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("off")}
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="text-sm text-slate-400">Designation</span>
            <input
              type="text"
              value={form.contact_designation}
              onChange={(e) =>
                updateField(
                  "contact_designation",
                  capitalizeFirstLetter(e.target.value),
                )
              }
              onBlur={(e) =>
                updateField(
                  "contact_designation",
                  autocorrectText(e.target.value, "prose"),
                )
              }
              placeholder="e.g. Procurement Manager"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("prose")}
            />
          </label>
        </div>
      </fieldset>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || blockedByExisting}
          className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
          title={
            blockedByExisting
              ? "This company already exists — open the existing lead instead"
              : undefined
          }
        >
          {submitting ? "Saving…" : primaryLabel}
        </button>
      </div>
    </form>
  );
}
