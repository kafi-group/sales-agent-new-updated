import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Call, Device } from "@twilio/voice-sdk";
import { client, type CallInitiateResult } from "../api/client";

export interface PendingCallFollowUp {
  interactionId: number;
  label: string;
  buyerId?: number | null;
  contactId?: number | null;
  dialedPhone?: string | null;
  /** Numbers already tried this session (same lead, before final remarks). */
  triedPhones?: string[];
}

/** Identifies which dialed number currently owns the live call UI. */
export interface ActiveCallTarget {
  buyerId: number | null;
  contactId: number | null;
  phone: string | null;
}

/** Thrown when the user presses End while a call is still being set up. */
export class DialCancelledError extends Error {
  constructor() {
    super("Call cancelled.");
    this.name = "DialCancelled";
  }
}

/** What the CUSTOMER's phone is doing. The browser reaching Twilio is not the customer answering. */
export type CallLegStatus =
  | "dialing"
  | "ringing"
  | "answered"
  | "busy"
  | "no-answer"
  | "failed"
  | "ended"
  | "unknown";

interface TwilioVoiceContextValue {
  ready: boolean;
  active: boolean;
  /** True from the moment a call is requested until it is connected (or cancelled / failed). */
  dialing: boolean;
  activeCall: ActiveCallTarget | null;
  /** State of the customer's end of the live call, and how many times the system has dialled. */
  legStatus: CallLegStatus;
  legAttempts: number;
  initError: string | null;
  /** Last outbound call failure (does not mean the dialer is offline). */
  callError: string | null;
  clearCallError: () => void;
  pendingFollowUp: PendingCallFollowUp | null;
  clearPendingFollowUp: () => void;
  /** Reset multi-number retry tracking after remarks are saved or skipped. */
  clearLeadDialSession: () => void;
  /** When true the global PostCallRemarksModal is suppressed (bulk queue handles it). */
  bulkModeActive: boolean;
  setBulkModeActive: (active: boolean) => void;
  placeCall: (leadId: number, contactId?: number, phone?: string) => Promise<CallInitiateResult>;
  placeManualCall: (
    phone: string,
    options?: { contactName?: string; country?: string },
  ) => Promise<CallInitiateResult>;
  hangUp: () => void;
  sendDigits: (digits: string) => void;
  retryInit: () => Promise<void>;
}

function friendlyCallError(err: unknown): string {
  let raw = "Call failed";
  if (err instanceof Error && err.message) {
    raw = err.message;
  } else if (typeof err === "string" && err.trim()) {
    raw = err;
  } else if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string" && msg.trim()) raw = msg;
    else if (msg != null && msg !== "") raw = String(msg);
  }
  if (/13225|blacklisted|blacklist/i.test(raw)) {
    return (
      "This number is blocked by Twilio (13225). The phone will not ring. " +
      "Check Twilio Debugger, or try another number."
    );
  }
  if (/13224|invalid phone number/i.test(raw)) {
    return "Invalid phone number format or the destination country is blocked in Twilio Voice Geographic Permissions.";
  }
  if (/21215|21214|unverified|not.+verified|trial account/i.test(raw)) {
    return (
      "Twilio blocked this destination (trial / unverified number). " +
      "Verify the number under Twilio → Phone Numbers → Verified Caller IDs, or upgrade the Twilio account."
    );
  }
  if (/21408|permission.+geograph|geo.?permission/i.test(raw)) {
    return (
      "This country is blocked in Twilio Voice Geographic Permissions. " +
      "Enable it in Twilio Console → Voice → Settings → Geographic Permissions."
    );
  }
  if (/31005|gateway in HANGUP|application error/i.test(raw)) {
    return (
      "Call ended before connect (Twilio 31005). Check Voice Geographic Permissions for this country, " +
      "or if the account is Trial — verify the destination number (or upgrade). Then try again."
    );
  }
  // Do not match the word "microphone" alone — our own timeout copy used to mention it
  // and got rewritten as a fake mic failure.
  if (
    /31402|AcquisitionFailed|getting the media failed|NotAllowedError|PermissionDeniedError|NotFoundError|NotReadableError|OverconstrainedError/i.test(
      raw,
    )
  ) {
    return (
      "Microphone access failed. Click Allow on the browser mic prompt (padlock → Site settings), " +
      "close Zoom/Teams/WhatsApp Desktop if they own the mic, then try Call again."
    );
  }
  if (/31000|31002|31003/i.test(raw)) {
    return `${raw}. Check Twilio Debugger and that Voice geo-permissions allow this country.`;
  }
  return raw;
}

/** Ask for the mic during the Call click — before the slow prepare request — so Chrome
 * still treats it as a user gesture. Twilio Device.connect needs this later. */
async function requestMicAccess(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "This browser cannot access the microphone. Use Chrome or Edge on HTTPS.",
    );
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    throw new Error(friendlyCallError(err));
  }
}

/** PSTN failures that mean the client's phone never rang. Remarks stay closed. */
const BLOCKED_DIAL = /13225|13224|21215|21214|21408|31005/;

function isBlockedDialError(err: unknown): boolean {
  if (err instanceof Error && err.message) return BLOCKED_DIAL.test(err.message);
  if (typeof err === "string") return BLOCKED_DIAL.test(err);
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return BLOCKED_DIAL.test(msg);
    if (msg && typeof msg === "object" && "message" in (msg as object)) {
      const inner = (msg as { message: unknown }).message;
      if (typeof inner === "string") return BLOCKED_DIAL.test(inner);
    }
  }
  return false;
}

function customerWasReached(
  status: string,
  twilioStatus: string | null,
  errorCode: string | null,
): boolean {
  if (errorCode && BLOCKED_DIAL.test(errorCode)) return false;
  if (status === "ringing" || status === "answered" || status === "no-answer" || status === "busy") {
    return true;
  }
  // Completed child leg means the network finished a real dial (answered, then hung up).
  return twilioStatus === "completed" && status === "ended";
}

const TwilioVoiceContext = createContext<TwilioVoiceContextValue | null>(null);

function normalizePhoneDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

/** True when two phone strings refer to the same dialed number. */
export function phonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  // Match when one is a national form of the other (last 8–12 digits).
  const shorter = da.length <= db.length ? da : db;
  const longer = da.length <= db.length ? db : da;
  return shorter.length >= 8 && longer.endsWith(shorter);
}

export function TwilioVoiceProvider({ children }: { children: ReactNode }) {
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const activePrepRef = useRef<CallInitiateResult | null>(null);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [dialing, setDialing] = useState(false);
  const dialingRef = useRef(false);
  const dialAttemptRef = useRef<{ cancelled: boolean; connectStarted: boolean } | null>(null);
  /** True once the customer's phone actually rang or answered this attempt. */
  const customerRangRef = useRef(false);
  const lastLegErrorRef = useRef<string | null>(null);
  const endedByUserRef = useRef(false);
  const [activeCall, setActiveCall] = useState<ActiveCallTarget | null>(null);
  const [legStatus, setLegStatus] = useState<CallLegStatus>("dialing");
  const [legAttempts, setLegAttempts] = useState(0);
  const [initError, setInitError] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [pendingFollowUp, setPendingFollowUp] = useState<PendingCallFollowUp | null>(null);

  const [bulkModeActive, setBulkModeActive] = useState(false);
  const leadDialSessionRef = useRef<{ buyerId: number; triedPhones: string[] } | null>(null);

  const clearPendingFollowUp = useCallback(() => {
    setPendingFollowUp(null);
  }, []);

  const clearLeadDialSession = useCallback(() => {
    leadDialSessionRef.current = null;
  }, []);

  const clearCallError = useCallback(() => {
    setCallError(null);
  }, []);

  const refreshToken = useCallback(async (device: Device) => {
    const { token } = await client.getVoiceToken();
    device.updateToken(token);
  }, []);

  const initDevice = useCallback(async () => {
    setInitError(null);
    let cfg;
    try {
      cfg = await client.getCallConfig();
    } catch (e) {
      setReady(false);
      const msg = e instanceof Error ? e.message : "Calling service warming up";
      setInitError(msg);
      throw e;
    }

    if (!cfg.browser_ready) {
      setReady(false);
      deviceRef.current?.destroy();
      deviceRef.current = null;
      setInitError(cfg.setup_message ?? "Twilio browser calling is not configured");
      throw new Error(cfg.setup_message ?? "Twilio browser calling is not configured");
    }

    const { token } = await client.getVoiceToken();
    const device = new Device(token, {
      codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      logLevel: "warn",
    });

    device.on("registered", () => {
      setReady(true);
      setInitError(null);
    });
    device.on("unregistered", () => setReady(false));
    device.on("error", (err) => {
      console.error("Twilio device error:", err);
      const message = err?.message || "Twilio device error";
      // Per-call gateway hangups (31005) must not disable the whole dialer.
      if (/31005|HANGUP/i.test(message)) {
        setCallError(friendlyCallError(err));
        return;
      }
      setInitError(friendlyCallError(err));
      setReady(false);
    });
    device.on("tokenWillExpire", () => {
      void refreshToken(device);
    });

    deviceRef.current?.destroy();
    deviceRef.current = device;
    await device.register();
    setReady(true);
    setInitError(null);
  }, [refreshToken]);

  // Mount once — do not re-run when callback identities change (would hang up live calls).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDevice();
        if (cancelled) {
          deviceRef.current?.destroy();
          deviceRef.current = null;
          setReady(false);
        }
      } catch (e) {
        if (!cancelled) {
          setReady(false);
          const message = e instanceof Error ? e.message : "Failed to initialize calling";
          if (/cannot reach the api|failed to fetch|network|502|failed to respond/i.test(message)) {
            setInitError("Calling is warming up — auto-reconnecting in a moment.");
            window.setTimeout(() => {
              if (!cancelled) {
                void initDevice().catch(() => undefined);
              }
            }, 3000);
          } else {
            setInitError(message);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      callRef.current?.disconnect();
      deviceRef.current?.destroy();
      deviceRef.current = null;
      callRef.current = null;
      setActive(false);
      setActiveCall(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-once init
  }, []);

  const retryInit = useCallback(async () => {
    try {
      await initDevice();
    } catch (e) {
      setReady(false);
      setInitError(e instanceof Error ? e.message : "Failed to initialize calling");
      throw e;
    }
  }, [initDevice]);

  const hangUp = useCallback(() => {
    // End must stop EVERYTHING immediately, including a call that is still being set up
    // (server round-trip / connecting): mark it cancelled so it can never connect later,
    // release the dial lock, then drop any live call.
    endedByUserRef.current = true;
    if (dialAttemptRef.current) {
      dialAttemptRef.current.cancelled = true;
      dialAttemptRef.current = null;
    }
    dialingRef.current = false;
    setDialing(false);
    const call = callRef.current;
    try {
      call?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      deviceRef.current?.disconnectAll();
    } catch {
      /* ignore */
    }
    callRef.current = null;
    activePrepRef.current = null;
    setActive(false);
    setActiveCall(null);
  }, []);

  const sendDigits = useCallback((digits: string) => {
    const call = callRef.current;
    if (call && digits) {
      try {
        call.sendDigits(digits);
      } catch (e) {
        console.error("Failed to send DTMF digits:", e);
      }
    }
  }, []);

  const connectPreparedCall = useCallback(
    async (
      activeDevice: Device,
      prep: CallInitiateResult,
      isCancelled: () => boolean = () => false,
    ) => {
    activePrepRef.current = prep;
    setCallError(null);
    customerRangRef.current = false;
    lastLegErrorRef.current = null;
    endedByUserRef.current = false;

    // Capture prep in closure so a later dial cannot steal this call's follow-up.
    const prepForThisCall = prep;
    let finished = false;
    const finishCall = (call: Call, err?: unknown) => {
      if (finished) return;
      finished = true;
      if (callRef.current === call) {
        callRef.current = null;
      }
      setActive(false);
      setActiveCall(null);
      if (activePrepRef.current?.id === prepForThisCall.id) {
        activePrepRef.current = null;
      }
      const blocked = Boolean(err && isBlockedDialError(err));
      const buyerId = prepForThisCall.buyer_id ?? null;
      const dialedPhone = prepForThisCall.lead_phone ?? null;
      void (async () => {
        let errorCode = lastLegErrorRef.current;
        let reached = customerRangRef.current;
        const sid = (call as unknown as { parameters?: Record<string, string> }).parameters?.CallSid;
        if (sid && (!reached || !errorCode)) {
          try {
            const res = await client.getCallLegStatus(sid);
            if (res.error_code) {
              errorCode = res.error_code;
              lastLegErrorRef.current = res.error_code;
            }
            if (
              customerWasReached(res.status, res.twilio_status, res.error_code ?? null)
            ) {
              reached = true;
              customerRangRef.current = true;
            }
          } catch {
            /* decide from what we already saw */
          }
        }
        const pstnBlocked = Boolean(errorCode && BLOCKED_DIAL.test(errorCode));
        if (pstnBlocked || blocked || !reached) {
          if (!pstnBlocked && !blocked && !reached && endedByUserRef.current) {
            return;
          }
          const msg = pstnBlocked
            ? friendlyCallError(errorCode)
            : blocked
              ? friendlyCallError(err)
              : "Call ended before the client's phone rang. Nothing was connected.";
          setCallError(msg);
          return;
        }
        let triedPhones: string[] = [];
        if (buyerId != null && dialedPhone) {
          const session = leadDialSessionRef.current;
          if (session?.buyerId === buyerId) {
            triedPhones = [...session.triedPhones];
            if (!triedPhones.some((p) => phonesMatch(p, dialedPhone))) {
              triedPhones.push(dialedPhone);
            }
          } else {
            triedPhones = [dialedPhone];
          }
          leadDialSessionRef.current = { buyerId, triedPhones };
        }
        setPendingFollowUp({
          interactionId: prepForThisCall.id,
          label:
            prepForThisCall.company_name ||
            prepForThisCall.contact_name ||
            prepForThisCall.subject?.replace(/^Call to /, "") ||
            "this call",
          buyerId,
          contactId: prepForThisCall.contact_id ?? null,
          dialedPhone,
          triedPhones,
        });
      })();
    };

    try {
      // Re-register this same device if it dropped during the slow prepare request.
      // Creating a new Device here would destroy an in-flight dial.
      let device = activeDevice;
      if (device.state !== "registered") {
        const { token } = await client.getVoiceToken();
        device.updateToken(token);
        await device.register();
      }
      if (isCancelled()) throw new DialCancelledError();
      if (device.state !== "registered") {
        throw new Error(
          "Twilio calling is not ready. Refresh the page, or check Settings → Twilio.",
        );
      }
      if (dialAttemptRef.current) {
        dialAttemptRef.current.connectStarted = true;
      }
      // If signaling never finishes, hang up the late call so it cannot open remarks.
      let connectSettled = false;
      const call = await new Promise<Call>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (connectSettled) return;
          connectSettled = true;
          reject(
            new Error(
              "Call connection timed out. The client's phone was not reached. Check your network and try again.",
            ),
          );
        }, 40000);
        device
          .connect({
            params: {
              To: prep.lead_phone!,
              leadPhone: prep.lead_phone!,
              interaction_id: String(prep.id),
            },
          })
          .then(
            (connected) => {
              if (connectSettled || isCancelled()) {
                try {
                  connected.disconnect();
                } catch {
                  /* ignore */
                }
                if (!connectSettled) {
                  connectSettled = true;
                  window.clearTimeout(timer);
                  reject(new DialCancelledError());
                }
                return;
              }
              connectSettled = true;
              window.clearTimeout(timer);
              resolve(connected);
            },
            (connectErr: unknown) => {
              if (connectSettled) return;
              connectSettled = true;
              window.clearTimeout(timer);
              reject(connectErr);
            },
          );
      });
      if (isCancelled()) {
        try {
          call.disconnect();
        } catch {
          /* ignore */
        }
        throw new DialCancelledError();
      }
      callRef.current = call;

      // Attach lifecycle listeners before flipping UI to "in call".
      call.on("error", (err) => {
        console.error("Twilio call error:", err);
        const friendly = friendlyCallError(err);
        setCallError(friendly);
        finishCall(call, err);
      });
      call.on("disconnect", () => finishCall(call));
      call.on("cancel", () => finishCall(call));
      call.on("reject", () => finishCall(call));

      setActive(true);
      setActiveCall({
        buyerId: prep.buyer_id ?? null,
        contactId: prep.contact_id ?? null,
        phone: prep.lead_phone ?? null,
      });

      return prep;
    } catch (err) {
      activePrepRef.current = null;
      callRef.current = null;
      setActive(false);
      setActiveCall(null);
      if (err instanceof DialCancelledError || isCancelled()) {
        throw new DialCancelledError();
      }
      const friendly = friendlyCallError(err);
      setCallError(friendly);
      throw new Error(friendly);
    }
  },
  [],
  );

  const ensureRegisteredDevice = useCallback(async () => {
    let device = deviceRef.current;
    if (!device || device.state !== "registered") {
      await initDevice();
      device = deviceRef.current;
    }
    if (!device || device.state !== "registered") {
      throw new Error(
        "Twilio calling is not ready. Refresh the page, or check Settings → Twilio.",
      );
    }
    return device;
  }, [initDevice]);

  /**
   * One lock for every Call button: only one call can be set up or live at a time. It is held
   * from the click until Twilio connect starts. If the server is still preparing after 20s,
   * the attempt is cancelled and nothing is dialed. End releases it immediately.
   */
  const withDialLock = useCallback(
    async <T,>(fn: (isCancelled: () => boolean) => Promise<T>): Promise<T> => {
      if (dialingRef.current || callRef.current) {
        throw new Error("A call is already in progress — end it (or wait) before dialing again.");
      }
      const attempt = { cancelled: false, connectStarted: false };
      dialingRef.current = true;
      dialAttemptRef.current = attempt;
      setDialing(true);
      const release = () => {
        if (dialAttemptRef.current === attempt) {
          dialAttemptRef.current = null;
          dialingRef.current = false;
          setDialing(false);
        }
      };
      const guard = window.setTimeout(() => {
        if (attempt.connectStarted) return;
        attempt.cancelled = true;
        release();
      }, 20000);
      try {
        return await fn(() => attempt.cancelled);
      } finally {
        window.clearTimeout(guard);
        release();
      }
    },
    [],
  );

  const placeCall = useCallback(
    (leadId: number, contactId?: number, phone?: string) =>
      withDialLock(async (isCancelled) => {
        // Start mic + device registration immediately (same click) before the slow
        // prepare API — otherwise Chrome drops the user-gesture and getUserMedia fails.
        const micReady = requestMicAccess();
        const deviceReady = ensureRegisteredDevice();
        const [device] = await Promise.all([deviceReady, micReady]);
        if (isCancelled()) throw new DialCancelledError();

        const prep = await client.initiateLeadCall(leadId, {
          contact_id: contactId,
          phone: phone?.trim() || undefined,
        });
        if (isCancelled()) {
          throw new Error("The server was too slow, so nothing was dialed. Please try again.");
        }
        if (!prep.lead_phone) {
          throw new Error("Lead phone number missing");
        }

        return connectPreparedCall(device, { ...prep, buyer_id: leadId }, isCancelled);
      }),
    [connectPreparedCall, ensureRegisteredDevice, withDialLock],
  );

  const placeManualCall = useCallback(
    (phone: string, options?: { contactName?: string; country?: string }) =>
      withDialLock(async (isCancelled) => {
        const micReady = requestMicAccess();
        const deviceReady = ensureRegisteredDevice();
        const [device] = await Promise.all([deviceReady, micReady]);
        if (isCancelled()) throw new DialCancelledError();

        const prep = await client.initiateManualCall({
          phone,
          contact_name: options?.contactName,
          country: options?.country,
        });
        if (isCancelled()) {
          throw new Error("The server was too slow, so nothing was dialed. Please try again.");
        }
        if (!prep.lead_phone) {
          throw new Error("Phone number missing");
        }

        return connectPreparedCall(device, prep, isCancelled);
      }),
    [connectPreparedCall, ensureRegisteredDevice, withDialLock],
  );

  // While a call is up, ask the server (read-only) what the customer's phone is doing.
  useEffect(() => {
    if (!active) {
      setLegStatus("dialing");
      setLegAttempts(0);
      return;
    }
    let stopped = false;
    const poll = async () => {
      const sid = (callRef.current as unknown as { parameters?: Record<string, string> } | null)
        ?.parameters?.CallSid;
      if (!sid) return;
      try {
        const res = await client.getCallLegStatus(sid);
        if (stopped) return;
        setLegStatus(res.status as CallLegStatus);
        setLegAttempts(res.attempts);
        if (res.error_code) {
          lastLegErrorRef.current = res.error_code;
          if (BLOCKED_DIAL.test(res.error_code)) {
            setCallError(friendlyCallError(res.error_code));
          }
        }
        if (customerWasReached(res.status, res.twilio_status, res.error_code ?? null)) {
          customerRangRef.current = true;
        }
      } catch {
        /* keep the last known status */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active]);

  return (
    <TwilioVoiceContext.Provider
      value={{
        ready,
        active,
        dialing,
        activeCall,
        legStatus,
        legAttempts,
        initError,
        callError,
        clearCallError,
        pendingFollowUp,
        clearPendingFollowUp,
        clearLeadDialSession,
        bulkModeActive,
        setBulkModeActive,
        placeCall,
        placeManualCall,
        hangUp,
        sendDigits,
        retryInit,
      }}
    >
      {children}
    </TwilioVoiceContext.Provider>
  );
}

export function useTwilioVoice(): TwilioVoiceContextValue {
  const ctx = useContext(TwilioVoiceContext);
  if (!ctx) {
    throw new Error("useTwilioVoice must be used within TwilioVoiceProvider");
  }
  return ctx;
}

/** Safe hook — returns null when provider is missing (e.g. tests). */
export function useTwilioVoiceOptional(): TwilioVoiceContextValue | null {
  return useContext(TwilioVoiceContext);
}
