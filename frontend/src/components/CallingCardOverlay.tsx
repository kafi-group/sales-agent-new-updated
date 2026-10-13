import { useEffect, useState } from "react";
import { useTwilioVoiceOptional } from "../hooks/useTwilioVoice";
import { CallingCard } from "./CallingCard";
import { DraggableFloat } from "./DraggableFloat";

/**
 * Floating calling card for one-off (non-bulk) browser calls.
 * Bulk queue renders its own card so it can follow skip/next without waiting on Twilio state.
 */
export function CallingCardOverlay() {
  const voice = useTwilioVoiceOptional();
  const [dismissedLeadId, setDismissedLeadId] = useState<number | null>(null);

  const leadId = voice?.activeCall?.buyerId ?? null;
  const active = Boolean(voice?.active && leadId && !voice.bulkModeActive);

  useEffect(() => {
    if (leadId !== dismissedLeadId) {
      setDismissedLeadId(null);
    }
  }, [leadId, dismissedLeadId]);

  if (!active || !leadId || dismissedLeadId === leadId) return null;

  return (
    <DraggableFloat storageKey="kafi_calling_card_pos">
      <CallingCard
        leadId={leadId}
        fallback={{ phone: voice?.activeCall?.phone }}
        onDismiss={() => setDismissedLeadId(leadId)}
      />
    </DraggableFloat>
  );
}
