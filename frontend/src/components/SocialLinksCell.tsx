import type { ReactNode } from "react";

type SocialField = "facebook_company_url" | "instagram_company_url" | "linkedin_company_url";

interface SocialLinksCellProps {
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  companyName: string;
  editMode?: boolean;
  onFieldChange?: (field: SocialField, value: string) => void;
}

const EDIT_INPUT =
  "w-full min-w-[140px] rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200";

function SocialIconLink({
  href,
  label,
  children,
  className,
}: {
  href: string;
  label: string;
  children: ReactNode;
  className: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${label} — ${href}`}
      title={label}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition hover:scale-105 ${className}`}
    >
      {children}
    </a>
  );
}

function DisabledSocialIcon({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-label={`${label} not found`}
      title={`${label} not found`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-800/60 text-slate-600"
    >
      {children}
    </span>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073c0 6.02 4.388 11.013 10.125 11.91v-8.42H7.078v-3.49h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.234 2.686.234v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.49h-2.796v8.42C19.612 23.086 24 18.093 24 12.073z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.17.054 1.97.24 2.427.403a4.92 4.92 0 0 1 1.77 1.153 4.92 4.92 0 0 1 1.153 1.77c.163.457.349 1.257.403 2.427.058 1.266.07 1.646.07 4.85s-.012 3.584-.07 4.85c-.054 1.17-.24 1.97-.403 2.427a4.92 4.92 0 0 1-1.153 1.77 4.92 4.92 0 0 1-1.77 1.153c-.457.163-1.257.349-2.427.403-1.266.058-1.646.07-4.85.07s-3.584-.012-4.85-.07c-1.17-.054-1.97-.24-2.427-.403a4.92 4.92 0 0 1-1.77-1.153 4.92 4.92 0 0 1-1.153-1.77c-.163-.457-.349-1.257-.403-2.427C2.175 15.747 2.163 15.367 2.163 12s.012-3.584.07-4.85c.054-1.17.24-1.97.403-2.427a4.92 4.92 0 0 1 1.153-1.77 4.92 4.92 0 0 1 1.77-1.153c.457-.163 1.257-.349 2.427-.403C8.416 2.175 8.796 2.163 12 2.163zm0 1.622c-3.15 0-3.523.012-4.758.069-1.02.047-1.574.218-1.942.363-.488.19-.836.417-1.202.783a3.36 3.36 0 0 0-.783 1.202c-.145.368-.316.922-.363 1.942-.057 1.235-.069 1.608-.069 4.758s.012 3.523.069 4.758c.047 1.02.218 1.574.363 1.942.19.488.417.836.783 1.202.366.366.714.593 1.202.783.368.145.922.316 1.942.363 1.235.057 1.608.069 4.758.069s3.523-.012 4.758-.069c1.02-.047 1.574-.218 1.942-.363a3.36 3.36 0 0 0 1.202-.783 3.36 3.36 0 0 0 .783-1.202c.145-.368.316-.922.363-1.942.057-1.235.069-1.608.069-4.758s-.012-3.523-.069-4.758c-.047-1.02-.218-1.574-.363-1.942a3.36 3.36 0 0 0-.783-1.202 3.36 3.36 0 0 0-1.202-.783c-.368-.145-.922-.316-1.942-.363-1.235-.057-1.608-.069-4.758-.069zm0 3.89a4.325 4.325 0 1 1 0 8.65 4.325 4.325 0 0 1 0-8.65zm0 1.622a2.703 2.703 0 1 0 0 5.406 2.703 2.703 0 0 0 0-5.406zm5.338-3.205a1.01 1.01 0 1 1-2.02 0 1.01 1.01 0 0 1 2.02 0z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function SocialUrlField({
  field,
  label,
  icon,
  iconClass,
  value,
  onFieldChange,
}: {
  field: SocialField;
  label: string;
  icon: ReactNode;
  iconClass: string;
  value: string;
  onFieldChange?: (field: SocialField, value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconClass}`}
      >
        {icon}
      </span>
      <input
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onFieldChange?.(field, e.target.value)}
        onBlur={(e) => onFieldChange?.(field, e.target.value)}
        placeholder={`${label} URL`}
        className={EDIT_INPUT}
      />
    </label>
  );
}

export function SocialLinksCell({
  facebookUrl,
  instagramUrl,
  linkedinUrl,
  editMode = false,
  onFieldChange,
}: SocialLinksCellProps) {
  if (editMode) {
    return (
      <div className="space-y-1.5 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
        <SocialUrlField
          field="facebook_company_url"
          label="Facebook"
          icon={<FacebookIcon />}
          iconClass="bg-[#1877F2]/15 text-[#1877F2]"
          value={facebookUrl ?? ""}
          onFieldChange={onFieldChange}
        />
        <SocialUrlField
          field="instagram_company_url"
          label="Instagram"
          icon={<InstagramIcon />}
          iconClass="bg-[#E4405F]/15 text-[#E4405F]"
          value={instagramUrl ?? ""}
          onFieldChange={onFieldChange}
        />
        <SocialUrlField
          field="linkedin_company_url"
          label="LinkedIn"
          icon={<LinkedInIcon />}
          iconClass="bg-[#0A66C2]/15 text-[#0A66C2]"
          value={linkedinUrl ?? ""}
          onFieldChange={onFieldChange}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {facebookUrl ? (
        <SocialIconLink
          href={facebookUrl}
          label="Facebook"
          className="bg-[#1877F2]/15 text-[#1877F2] hover:bg-[#1877F2]/25"
        >
          <FacebookIcon />
        </SocialIconLink>
      ) : (
        <DisabledSocialIcon label="Facebook">
          <FacebookIcon />
        </DisabledSocialIcon>
      )}

      {instagramUrl ? (
        <SocialIconLink
          href={instagramUrl}
          label="Instagram"
          className="bg-[#E4405F]/15 text-[#E4405F] hover:bg-[#E4405F]/25"
        >
          <InstagramIcon />
        </SocialIconLink>
      ) : (
        <DisabledSocialIcon label="Instagram">
          <InstagramIcon />
        </DisabledSocialIcon>
      )}

      {linkedinUrl ? (
        <SocialIconLink
          href={linkedinUrl}
          label="LinkedIn"
          className="bg-[#0A66C2]/15 text-[#0A66C2] hover:bg-[#0A66C2]/25"
        >
          <LinkedInIcon />
        </SocialIconLink>
      ) : (
        <DisabledSocialIcon label="LinkedIn">
          <LinkedInIcon />
        </DisabledSocialIcon>
      )}
    </div>
  );
}
