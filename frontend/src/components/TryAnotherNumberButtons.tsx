import { useEffect, useState } from "react";
import { client } from "../api/client";
import { phonesMatch, useTwilioVoiceOptional } from "../hooks/useTwilioVoice";
import { IconPhone } from "./icons/AppIcons";

interface DialPhoneOption {
  index: number;
  label: string;
  phone: string;
  contact_id?: number;
}

interface TryAnotherNumberButtonsProps {
  buyerId: number;
  triedPhones: string[];
  onError: (message: string) => void;
  /** Called before placing another call (e.g. close modal). */
  onBeforeDial?: () => void;
  /** Bulk queue: redial same lead without saving remarks. */
  onBulkRedial?: (phone: string, contactId?: number) => void;
  disabled?: boolean;
}

export function TryAnotherNumberButtons({
  buyerId,
  triedPhones,
  onError,
  onBeforeDial,
  onBulkRedial,
  disabled = false,
}: TryAnotherNumberButtonsProps) {
  const voice = useTwilioVoiceOptional();
  const [phones, setPhones] = useState<DialPhoneOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialing, setDialing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client
      .getLeadDialPhones(buyerId)
      .then((res) => {
        if (!cancelled) setPhones(res.phones ?? []);
      })
      .catch(() => {
        if (!cancelled) setPhones([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buyerId]);

  const remaining = phones.filter(
    (opt) => !triedPhones.some((tried) => phonesMatch(tried, opt.phone)),
  );

  if (loading || remaining.length === 0) {
    return null;
  }

  async function handleDial(phone: string, contactId?: number) {
    if (disabled || dialing) return;
    if (onBulkRedial) {
      onBulkRedial(phone, contactId);
      return;
    }
    if (!voice) {
      onError("Calling is not available");
      return;
    }
    setDialing(true);
    onBeforeDial?.();
    voice.clearPendingFollowUp();
    try {
      if (!voice.ready) {
        await voice.retryInit();
      }
      await voice.placeCall(buyerId, contactId, phone);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Call failed");
    } finally {
      setDialing(false);
    }
  }

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-2">
      <p className="text-xs font-medium text-sky-200/90">Try another number</p>
      <p className="text-xs text-slate-500 leading-relaxed">
        No answer on this line? Call a different number for the same client — remarks
        are skipped until you finish a connected call.
      </p>
      <div className="flex flex-wrap gap-2">
        {remaining.map((opt) => (
          <button
            key={`${opt.contact_id ?? "c"}-${opt.phone}`}
            type="button"
            disabled={disabled || dialing}
            onClick={() => void handleDial(opt.phone, opt.contact_id)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-600/20 px-3 py-1.5 text-xs text-sky-100 hover:bg-sky-600/35 disabled:opacity-50"
          >
            <IconPhone size="xs" />
            {opt.label}: {opt.phone}
          </button>
        ))}
      </div>
    </div>
  );
}
