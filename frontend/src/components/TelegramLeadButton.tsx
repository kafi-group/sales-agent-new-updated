interface TelegramLeadButtonProps {
  phone: string | null | undefined;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}

function TelegramIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06-.01.24-.05.37z" />
    </svg>
  );
}

/** Compact Telegram action next to phone numbers (mirrors WhatsAppLeadButton). */
export function TelegramLeadButton({
  phone,
  onClick,
  disabled = false,
  compact = true,
}: TelegramLeadButtonProps) {
  if (!phone?.trim()) return null;

  const btnClass = compact
    ? "inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
    : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-sky-700 hover:bg-sky-600 text-white font-medium disabled:opacity-50";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className={btnClass}
      title={`Send Telegram to ${phone.trim()}`}
      aria-label={`Send Telegram to ${phone.trim()}`}
    >
      <TelegramIcon />
      {compact ? "TG" : "Telegram"}
    </button>
  );
}
