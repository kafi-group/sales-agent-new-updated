import { pushNumberToFloatingDialpad } from "../utils/dialpadEvents";

interface DialpadPhoneTextProps {
  phone: string;
  contactName?: string | null;
  countryHint?: string | null;
  className?: string;
  title?: string;
}

/** Clickable phone text that loads the number into the floating dialpad. */
export function DialpadPhoneText({
  phone,
  contactName,
  countryHint,
  className = "truncate text-sky-300 hover:text-sky-200 hover:underline cursor-pointer",
  title = "Copy to dialpad",
}: DialpadPhoneTextProps) {
  return (
    <button
      type="button"
      title={title}
      className={`bg-transparent border-0 p-0 text-left font-inherit ${className}`}
      onClick={(e) => {
        // Keep row click (open profile) while also filling the dialpad
        pushNumberToFloatingDialpad({
          phone,
          contactName: contactName ?? undefined,
          countryHint,
        });
        // Don't stopPropagation — parent row still opens the buyer profile
        e.currentTarget.blur();
      }}
    >
      {phone}
    </button>
  );
}
