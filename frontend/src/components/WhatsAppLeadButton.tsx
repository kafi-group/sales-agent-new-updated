interface WhatsAppLeadButtonProps {
  phone: string | null | undefined;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}

function WhatsAppIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.75 1.53 5.28L2 22l4.94-1.62a9.83 9.83 0 0 0 5.1 1.4h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2Zm5.79 14.06c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.1.11-1.77-.11a15.4 15.4 0 0 1-1.6-.6c-2.82-1.22-4.66-4.07-4.8-4.26-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.35.26-.28.57-.35.76-.35.19 0 .38 0 .55.01.18.01.42-.07.65.5.24.58.81 2 .88 2.14.07.14.12.31.02.5-.1.19-.15.31-.29.48-.14.17-.3.37-.43.5-.14.14-.29.29-.13.57.17.28.75 1.24 1.62 2.01 1.11 1 2.05 1.31 2.34 1.46.29.14.46.12.63-.07.17-.19.72-.83.91-1.12.19-.28.38-.24.65-.14.26.1 1.68.79 1.97.93.29.14.48.21.55.33.07.12.07.71-.17 1.39Z" />
    </svg>
  );
}

/** Compact WhatsApp action next to phone numbers (mirrors CallLeadButton). */
export function WhatsAppLeadButton({
  phone,
  onClick,
  disabled = false,
  compact = true,
}: WhatsAppLeadButtonProps) {
  if (!phone?.trim()) return null;

  const btnClass = compact
    ? "inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
    : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-emerald-700 hover:bg-emerald-600 text-white font-medium disabled:opacity-50";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className={btnClass}
      title={`Send WhatsApp to ${phone.trim()}`}
      aria-label={`Send WhatsApp to ${phone.trim()}`}
    >
      <WhatsAppIcon />
      {compact ? "WA" : "WhatsApp"}
    </button>
  );
}
