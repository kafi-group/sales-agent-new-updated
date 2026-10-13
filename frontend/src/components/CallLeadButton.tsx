import { useState } from "react";
import { type CallInitiateResult } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { phonesMatch, useTwilioVoiceOptional } from "../hooks/useTwilioVoice";
import {
  confirmAssignmentCallProceed,
  getAssignmentCallWarning,
} from "../utils/assignmentCallGuard";
import { detectLeadingZeroAfterCountryCode, type PhoneZeroCheckResult } from "../utils/phoneUtils";
import { PhoneFixModal } from "./PhoneFixModal";
import { IconPhone, IconX } from "./icons/AppIcons";

interface CallLeadButtonProps {
  leadId: number;
  phone: string | null | undefined;
  contactId?: number;
  contactName?: string;
  assignedToUserId?: number | null;
  assignedTo?: string | null;
  onError: (message: string) => void;
  onSuccess?: (result: CallInitiateResult) => void;
  compact?: boolean;
}

export function CallLeadButton({
  leadId,
  phone,
  contactId,
  contactName,
  assignedToUserId,
  assignedTo,
  onError,
  onSuccess,
  compact = false,
}: CallLeadButtonProps) {
  const { user } = useAuth();
  const voice = useTwilioVoiceOptional();
  const [calling, setCalling] = useState(false);
  const [phoneFixCheck, setPhoneFixCheck] = useState<{
    check: PhoneZeroCheckResult;
    targetPhone: string;
  } | null>(null);

  if (!phone?.trim()) {
    return null;
  }

  async function proceedWithCall(targetPhone: string) {
    if (!voice) {
      onError("In-app calling is initializing. Please wait a few seconds and try again.");
      return;
    }
    const assignmentWarning = getAssignmentCallWarning(
      assignedToUserId,
      assignedTo,
      user?.id,
    );
    if (assignmentWarning && !confirmAssignmentCallProceed(assignmentWarning)) {
      return;
    }

    setCalling(true);
    const safetyTimer = window.setTimeout(() => {
      setCalling(false);
    }, 45000);

    try {
      // placeCall re-inits the Device if needed — do not gate on stale `ready`.
      const result = await voice.placeCall(leadId, contactId, targetPhone);
      onSuccess?.(result);
    } catch (e) {
      if (e instanceof Error && e.name === "DialCancelled") return; // user pressed End
      onError(e instanceof Error ? e.message : "Call failed");
    } finally {
      window.clearTimeout(safetyTimer);
      setCalling(false);
    }
  }

  async function handleTwilioCall() {
    if (!phone) return;
    const zeroErr = detectLeadingZeroAfterCountryCode(phone);
    if (zeroErr) {
      setPhoneFixCheck({ check: zeroErr, targetPhone: phone });
      return;
    }
    await proceedWithCall(phone);
  }

  const btnClass = compact
    ? "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50"
    : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-50";

  const activeCall = voice?.activeCall ?? null;
  const inCall = Boolean(voice?.active);
  const isThisCall =
    inCall &&
    (phonesMatch(phone, activeCall?.phone) ||
      (activeCall?.buyerId != null && activeCall.buyerId === leadId));

  // Stuck "active" with no matching row End button — still offer hang-up everywhere.
  if (inCall && !isThisCall) {
    return (
      <span className="inline-flex items-center gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => voice?.hangUp()}
          className={
            compact
              ? "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-600 hover:bg-red-500 text-white"
              : "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-red-600 hover:bg-red-500 text-white"
          }
          title="End the call in progress, then dial this contact"
        >
          <IconX size="xs" />
          End
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
      {isThisCall ? (
        <button
          type="button"
          onClick={() => voice?.hangUp()}
          className={
            compact
              ? "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-600 hover:bg-red-500 text-white"
              : "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-red-600 hover:bg-red-500 text-white"
          }
          title="End this call"
        >
          <IconX size="xs" />
          End
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void handleTwilioCall()}
          disabled={calling || Boolean(voice?.dialing)}
          className={btnClass}
          title={
            voice?.ready
              ? "Call from browser. Unanswered: 16s hangup then redial until answered."
              : voice?.initError
                ? voice.initError
                : "Call — dialer will connect when ready"
          }
        >
          <IconPhone size={compact ? "xs" : "sm"} />
          {calling ? "Connecting…" : compact ? "Call" : "Call now"}
        </button>
      )}

      {!isThisCall && (calling || voice?.dialing) && (
        <button
          type="button"
          onClick={() => voice?.hangUp()}
          className={
            compact
              ? "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-600 hover:bg-red-500 text-white"
              : "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-red-600 hover:bg-red-500 text-white"
          }
          title="Cancel this call right now"
        >
          <IconX size="xs" />
          End
        </button>
      )}

      {phoneFixCheck && (
        <PhoneFixModal
          checkResult={phoneFixCheck.check}
          contactName={contactName}
          onFixAutoAndCall={(corrected) => {
            setPhoneFixCheck(null);
            void proceedWithCall(corrected);
          }}
          onFixManualAndCall={(edited) => {
            setPhoneFixCheck(null);
            void proceedWithCall(edited);
          }}
          onCancel={() => setPhoneFixCheck(null)}
        />
      )}
    </span>
  );
}
