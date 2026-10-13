import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LeadTableRow } from "../api/client";
import { CallPhonePicker } from "./CallPhonePicker";
import { openMailerComposeForLead } from "./EmailLeadButton";
import { ToolbarDropdown, ToolbarMenuItem } from "./ui/ToolbarDropdown";
import { IconMail, IconPhone, IconTelegram, IconWhatsApp, IconX } from "./icons/AppIcons";

export type WhatsAppComposeMode = "personal" | "template";
export type TelegramComposeMode = "message" | "template";

interface PhoneOption {
  label: string;
  phone: string;
}

interface EmailOption {
  label: string;
  email: string;
}

interface SelectedContactQuickActionsProps {
  row: LeadTableRow;
  disabled?: boolean;
  onError: (message: string) => void;
  /** Opens the same Bulk WhatsApp Message flow as Action → WhatsApp. */
  onWhatsApp: () => void;
  onTelegram?: (phone: string, mode?: TelegramComposeMode) => void;
}

function uniquePhones(row: LeadTableRow): PhoneOption[] {
  const candidates: PhoneOption[] = [
    { label: "Primary phone", phone: (row.contact_phone || "").trim() },
    { label: "Primary (alt)", phone: (row.contact_primary_phone || "").trim() },
    { label: "Secondary mobile", phone: (row.contact_secondary_mobile || "").trim() },
    { label: "Secondary phone", phone: (row.contact_secondary_phone || "").trim() },
  ];
  const seen = new Set<string>();
  const out: PhoneOption[] = [];
  for (const c of candidates) {
    if (!c.phone) continue;
    const key = c.phone.replace(/\D/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function uniqueEmails(row: LeadTableRow): EmailOption[] {
  const candidates: EmailOption[] = [
    { label: "Primary email", email: (row.contact_email || "").trim() },
    { label: "Secondary email", email: (row.contact_secondary_email || "").trim() },
  ];
  const seen = new Set<string>();
  const out: EmailOption[] = [];
  for (const c of candidates) {
    if (!c.email.includes("@")) continue;
    const key = c.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function TelegramPhonePicker({
  companyName,
  mode,
  phones,
  onClose,
  onPick,
}: {
  companyName: string;
  mode: TelegramComposeMode;
  phones: PhoneOption[];
  onClose: () => void;
  onPick: (phone: string) => void;
}) {
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
        role="dialog"
        aria-labelledby="tg-phone-picker-title"
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="tg-phone-picker-title" className="text-base font-medium text-slate-100">
              Choose Telegram number
            </h3>
            <p className="text-sm text-slate-400 mt-1">
              {companyName} · {mode === "template" ? "Template" : "Message"}
            </p>
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
          {phones.map((p) => (
            <li key={p.phone}>
              <button
                type="button"
                onClick={() => onPick(p.phone)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-left hover:border-sky-500/50 hover:bg-slate-900"
              >
                <span className="block text-sm font-medium text-slate-100">{p.label}</span>
                <span className="block text-xs font-mono text-slate-400 mt-0.5">{p.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

export function SelectedContactQuickActions({
  row,
  disabled = false,
  onError,
  onWhatsApp,
  onTelegram,
}: SelectedContactQuickActionsProps) {
  const phones = uniquePhones(row);
  const emails = uniqueEmails(row);
  const [showCallPicker, setShowCallPicker] = useState(false);
  const [tgPhonePick, setTgPhonePick] = useState<TelegramComposeMode | null>(null);

  function startTelegram(mode: TelegramComposeMode = "message") {
    if (!onTelegram) return;
    if (phones.length === 0) {
      onError("This contact has no phone number for Telegram.");
      return;
    }
    if (phones.length === 1) {
      onTelegram(phones[0].phone, mode);
      return;
    }
    setTgPhonePick(mode);
  }

  return (
    <>
      <div
        className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-950/40 px-2 py-1"
        role="group"
        aria-label="Contact actions"
        title={`${row.company_name || "Contact"} — Call, WhatsApp, or Email`}
      >
        <span className="hidden sm:inline text-[10px] font-semibold uppercase tracking-wide text-sky-300/90 px-1">
          1 contact
        </span>

        <button
          type="button"
          disabled={disabled || phones.length === 0}
          onClick={() => {
            if (phones.length === 0) {
              onError("This contact has no phone number to call.");
              return;
            }
            setShowCallPicker(true);
          }}
          className="inline-flex items-center justify-center font-medium transition px-2.5 py-1.5 text-xs gap-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 text-white border border-sky-600/50 disabled:opacity-40 disabled:cursor-not-allowed"
          title={phones.length === 0 ? "No phone on file" : "Choose which number to call"}
        >
          <IconPhone size="xs" className="shrink-0 opacity-95" />
          Call
        </button>

        <button
          type="button"
          disabled={disabled || phones.length === 0}
          onClick={() => {
            if (phones.length === 0) {
              onError("This contact has no phone number for WhatsApp.");
              return;
            }
            onWhatsApp();
          }}
          className="inline-flex items-center justify-center font-medium transition px-2.5 py-1.5 text-xs gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white border border-emerald-600/50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Open Bulk WhatsApp Message (same as Action → WhatsApp)"
        >
          <IconWhatsApp size="xs" className="shrink-0 opacity-95" />
          WhatsApp
        </button>

        {onTelegram ? (
          <ToolbarDropdown label="Telegram" icon={IconTelegram} variant="sky">
            <ToolbarMenuItem
              icon={IconTelegram}
              tone="sky"
              disabled={disabled || phones.length === 0}
              title="Send via your connected Telegram Mobile"
              onClick={() => startTelegram("message")}
            >
              Telegram message
            </ToolbarMenuItem>
            <ToolbarMenuItem
              icon={IconTelegram}
              tone="sky"
              disabled={disabled || phones.length === 0}
              title="Send a saved Telegram template"
              onClick={() => startTelegram("template")}
            >
              Telegram template
            </ToolbarMenuItem>
          </ToolbarDropdown>
        ) : null}

        <ToolbarDropdown label="Email" icon={IconMail} variant="sky">
          {emails.length === 0 ? (
            <ToolbarMenuItem disabled title="No email on file" onClick={() => undefined}>
              No email on file
            </ToolbarMenuItem>
          ) : (
            emails.map((e) => (
              <ToolbarMenuItem
                key={`email-${e.email}`}
                icon={IconMail}
                tone="sky"
                disabled={disabled}
                title={`Email ${e.email}`}
                onClick={() => void openMailerComposeForLead(row, e.email, onError)}
              >
                {e.label}: {e.email}
              </ToolbarMenuItem>
            ))
          )}
        </ToolbarDropdown>
      </div>

      {showCallPicker ? (
        <CallPhonePicker
          leadId={row.id}
          companyName={row.company_name || "Contact"}
          phones={phones.map((p, i) => ({
            index: i + 1,
            label: p.label,
            phone: p.phone,
            contact_id: row.contact_id,
          }))}
          onClose={() => setShowCallPicker(false)}
          onError={onError}
        />
      ) : null}

      {tgPhonePick && onTelegram ? (
        <TelegramPhonePicker
          companyName={row.company_name || "Contact"}
          mode={tgPhonePick}
          phones={phones}
          onClose={() => setTgPhonePick(null)}
          onPick={(phone) => {
            const mode = tgPhonePick;
            setTgPhonePick(null);
            onTelegram(phone, mode);
          }}
        />
      ) : null}
    </>
  );
}
