import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { DialablePhoneOption } from "../api/client";
import { CallLeadButton } from "./CallLeadButton";
import { IconX } from "./icons/AppIcons";

interface CallPhonePickerProps {
  leadId: number;
  companyName: string;
  phones: DialablePhoneOption[];
  onClose: () => void;
  onError: (message: string) => void;
}

export function CallPhonePicker({
  leadId,
  companyName,
  phones,
  onClose,
  onError,
}: CallPhonePickerProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="call-phone-picker-title"
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="call-phone-picker-title" className="text-base font-medium text-slate-100">
              Choose number to dial
            </h3>
            <p className="text-sm text-slate-400 mt-1">{companyName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            <IconX size="sm" />
          </button>
        </div>
        <ul className="space-y-2">
          {phones.map((option) => (
            <li
              key={`${option.index}-${option.phone}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm text-slate-200">
                  #{option.index}{" "}
                  <span className="text-slate-400">{option.label}</span>
                </p>
                <p className="text-sm text-sky-300 tabular-nums truncate">{option.phone}</p>
              </div>
              <CallLeadButton
                leadId={leadId}
                phone={option.phone}
                contactId={option.contact_id ?? undefined}
                compact
                onError={onError}
                onSuccess={onClose}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
