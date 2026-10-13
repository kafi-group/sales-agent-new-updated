import { client, type LeadTableRow } from "../api/client";

interface EmailLeadButtonProps {
  email: string | null | undefined;
  row: LeadTableRow;
  onError: (message: string) => void;
  disabled?: boolean;
  compact?: boolean;
}

function MailIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="m5.5 7.5 6.1 4.2a1 1 0 0 0 1.1 0L18.8 7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export async function openMailerComposeForLead(
  row: LeadTableRow,
  email: string,
  onError: (message: string) => void,
): Promise<void> {
  const to = email.trim();
  if (!to.includes("@")) return;
  try {
    const session = await client.createMailerSession();
    const composeParams = new URLSearchParams({ to });
    composeParams.set("buyer_id", String(row.id));
    if (row.company_name) composeParams.set("company_name", row.company_name);
    if (row.contact_name) composeParams.set("contact_name", row.contact_name);
    if (row.contact_designation) composeParams.set("designation", row.contact_designation);

    const url = new URL(session.url);
    url.searchParams.set("next", `/compose?${composeParams.toString()}`);
    const opened = window.open(url.toString(), "_blank", "noopener,noreferrer");
    if (!opened) {
      onError("Pop-up blocked. Allow pop-ups for this site, then try again.");
    }
  } catch (e) {
    onError(e instanceof Error ? e.message : "Could not open Kafi Mail compose");
  }
}

/** Compact email action next to addresses — opens Vercel mailer compose (mirrors WA button). */
export function EmailLeadButton({
  email,
  row,
  onError,
  disabled = false,
  compact = true,
}: EmailLeadButtonProps) {
  const address = (email || "").trim();
  if (!address.includes("@")) return null;

  const btnClass = compact
    ? "inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
    : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-sky-700 hover:bg-sky-600 text-white font-medium disabled:opacity-50";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void openMailerComposeForLead(row, address, onError);
      }}
      disabled={disabled}
      className={btnClass}
      title={`Compose email to ${address}`}
      aria-label={`Compose email to ${address}`}
    >
      <MailIcon />
      {compact ? "Email" : "Compose"}
    </button>
  );
}
