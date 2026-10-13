/** Inbox alerts — popup, chime, optional voiceover, or fully off (user preference). */

import { applyNarratorToUtterance, ensureNarratorVoicesLoaded } from "./narratorPrefs";

export type NotificationMode =
  | "popup_sound"
  | "popup_voiceover"
  | "handsfree_email"
  | "off";

export interface InboxPopupPayload {
  id: string;
  from: string;
  subject: string;
  count: number;
}

export interface WhatsAppPopupPayload {
  id: string;
  from: string;
  preview: string;
  count: number;
  contactId?: number;
}

export interface InterestedFollowUpPopupPayload {
  id: string;
  buyerId: number;
  companyName: string;
  contactName: string | null;
  dueAt: string;
  daysSincePlacement: number;
  tableSection?: "interested_clients" | "not_received_call_clients" | "sales_interested_clients";
}

export interface InterestedClientsActivityPopupPayload {
  id: string;
  message: string;
  count: number;
  isSelf: boolean;
  userLabel?: string;
}

export interface QuotationMeetingPopupPayload {
  id: string;
  buyerId: number;
  companyName: string;
  contactName: string | null;
  meetingAt: string;
  minutesUntil: number;
}

const MODE_STORAGE_KEY = "kafi.notificationMode";
const MODE_VALUES: NotificationMode[] = [
  "popup_sound",
  "popup_voiceover",
  "handsfree_email",
  "off",
];

let audioCtx: AudioContext | null = null;
let audioUnlocked = false;
const popupListeners = new Set<(payload: InboxPopupPayload) => void>();
const whatsappPopupListeners = new Set<(payload: WhatsAppPopupPayload) => void>();
const followUpListeners = new Set<(payload: InterestedFollowUpPopupPayload) => void>();
const interestedClientsListeners = new Set<
  (payload: InterestedClientsActivityPopupPayload) => void
>();
const quotationMeetingListeners = new Set<(payload: QuotationMeetingPopupPayload) => void>();
const prefListeners = new Set<() => void>();

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

export function getNotificationMode(): NotificationMode {
  if (typeof window === "undefined") return "popup_sound";
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    if (raw && MODE_VALUES.includes(raw as NotificationMode)) {
      return raw as NotificationMode;
    }
  } catch {
    /* ignore */
  }
  return "popup_sound";
}

export function setNotificationMode(mode: NotificationMode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  prefListeners.forEach((listener) => listener());
}

export function subscribeNotificationPrefs(listener: () => void) {
  prefListeners.add(listener);
  return () => {
    prefListeners.delete(listener);
  };
}

export function subscribeInboxPopup(listener: (payload: InboxPopupPayload) => void) {
  popupListeners.add(listener);
  return () => {
    popupListeners.delete(listener);
  };
}

export function subscribeWhatsAppPopup(listener: (payload: WhatsAppPopupPayload) => void) {
  whatsappPopupListeners.add(listener);
  return () => {
    whatsappPopupListeners.delete(listener);
  };
}

export function subscribeInterestedFollowUpPopup(
  listener: (payload: InterestedFollowUpPopupPayload) => void,
) {
  followUpListeners.add(listener);
  return () => {
    followUpListeners.delete(listener);
  };
}

export function subscribeInterestedClientsActivityPopup(
  listener: (payload: InterestedClientsActivityPopupPayload) => void,
) {
  interestedClientsListeners.add(listener);
  return () => {
    interestedClientsListeners.delete(listener);
  };
}

export function subscribeQuotationMeetingPopup(
  listener: (payload: QuotationMeetingPopupPayload) => void,
) {
  quotationMeetingListeners.add(listener);
  return () => {
    quotationMeetingListeners.delete(listener);
  };
}

function emitInboxPopup(payload: InboxPopupPayload) {
  popupListeners.forEach((listener) => listener(payload));
}

function emitWhatsAppPopup(payload: WhatsAppPopupPayload) {
  whatsappPopupListeners.forEach((listener) => listener(payload));
}

function emitInterestedFollowUpPopup(payload: InterestedFollowUpPopupPayload) {
  followUpListeners.forEach((listener) => listener(payload));
}

function emitInterestedClientsActivityPopup(
  payload: InterestedClientsActivityPopupPayload,
) {
  interestedClientsListeners.forEach((listener) => listener(payload));
}

function emitQuotationMeetingPopup(payload: QuotationMeetingPopupPayload) {
  quotationMeetingListeners.forEach((listener) => listener(payload));
}

/** Call once after a user click/keypress so browsers allow sound. */
export function unlockNotificationAudio() {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  if (audioUnlocked) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.01);
  audioUnlocked = true;
}

function playTone(
  ctx: AudioContext,
  freq: number,
  start: number,
  duration: number,
  volume: number,
  type: OscillatorType = "square",
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const end = start + duration;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

/** Short alert chime — popup + sound only (no spoken dictation). */
export function playNotificationChime() {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();

  const now = ctx.currentTime;
  const pattern = [
    { freq: 880, start: 0, duration: 0.22 },
    { freq: 1174.66, start: 0.28, duration: 0.22 },
    { freq: 880, start: 0.56, duration: 0.22 },
    { freq: 1174.66, start: 0.84, duration: 0.35 },
    { freq: 1318.51, start: 1.3, duration: 0.45 },
  ];

  for (const tone of pattern) {
    playTone(ctx, tone.freq, now + tone.start, tone.duration, 0.75, "square");
  }
}

function stopAnySpeech() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

function speakAlert(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    stopAnySpeech();
    void ensureNarratorVoicesLoaded().then(() => {
      const utterance = new SpeechSynthesisUtterance(text);
      applyNarratorToUtterance(utterance);
      window.speechSynthesis.speak(utterance);
    });
  } catch {
    /* ignore */
  }
}

function applyAlertEffects(
  mode: NotificationMode,
  spokenText: string,
  options?: { emailHandsFree?: boolean },
) {
  if (mode === "off") return;
  unlockNotificationAudio();
  if (mode === "popup_sound") {
    stopAnySpeech();
    playNotificationChime();
  } else if (mode === "popup_voiceover") {
    speakAlert(spokenText);
  } else if (mode === "handsfree_email") {
    // Email hands-free session speaks the offer; other alerts still get a short voiceover.
    if (options?.emailHandsFree) {
      playNotificationChime();
    } else {
      speakAlert(spokenText);
    }
  }
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

export function showDesktopNotification(
  title: string,
  body: string,
  options?: { tag?: string },
) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (getNotificationMode() === "off") return;
  try {
    const notification = new Notification(title, {
      body,
      tag: options?.tag || "kafi-inbox",
      requireInteraction: true,
      silent: true, // we already play our own chime / voiceover
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    /* ignore */
  }
}

export function alertNewInboxMessage(details: {
  from?: string | null;
  subject?: string | null;
  count?: number;
}) {
  const mode = getNotificationMode();
  if (mode === "off") return;

  const sender = details.from?.trim() || "a contact";
  const subject = details.subject?.trim() || "New message";
  const count = details.count ?? 1;

  const body =
    count > 1
      ? `${count} new emails waiting`
      : subject
        ? `${sender}: ${subject}`
        : `New email from ${sender}`;

  const spoken =
    count > 1
      ? `You have ${count} new inbox messages.`
      : `New inbox message from ${sender}. ${subject}.`;

  applyAlertEffects(mode, spoken, {
    emailHandsFree: mode === "handsfree_email",
  });
  showDesktopNotification("New inbox message", body, { tag: "kafi-inbox" });

  emitInboxPopup({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: sender,
    subject,
    count,
  });
}

/** Same gearbox preference as email — off disables WhatsApp popups too. */
export function alertNewWhatsAppMessage(details: {
  from?: string | null;
  preview?: string | null;
  count?: number;
  contactId?: number;
}) {
  const mode = getNotificationMode();
  if (mode === "off") return;

  const sender = details.from?.trim() || "a WhatsApp contact";
  const preview = details.preview?.trim() || "New WhatsApp message";
  const count = details.count ?? 1;

  const body =
    count > 1 ? `${count} new WhatsApp messages` : `${sender}: ${preview}`;

  const spoken =
    count > 1
      ? `You have ${count} new WhatsApp messages.`
      : `New WhatsApp message from ${sender}. ${preview}.`;

  applyAlertEffects(mode, spoken);
  showDesktopNotification("New WhatsApp message", body, { tag: "kafi-whatsapp" });

  emitWhatsAppPopup({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: sender,
    preview,
    count,
    contactId: details.contactId,
  });
}

export function alertInterestedFollowUp(details: {
  id: string;
  buyerId: number;
  companyName: string;
  contactName?: string | null;
  dueAt: string;
  daysSincePlacement?: number;
  tableSection?: "interested_clients" | "not_received_call_clients" | "sales_interested_clients";
}) {
  const mode = getNotificationMode();
  if (mode === "off") return;

  const label = details.contactName?.trim()
    ? `${details.contactName} (${details.companyName})`
    : details.companyName;
  const dueDate = new Date(details.dueAt);
  const dueLabel = Number.isNaN(dueDate.getTime())
    ? "today"
    : dueDate.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

  applyAlertEffects(
    mode,
    `Follow up reminder. ${label}. Follow-up due ${dueLabel}.`,
  );

  showDesktopNotification(
    "Follow up client reminder",
    `${label} — follow-up due (${dueLabel})`,
  );

  emitInterestedFollowUpPopup({
    id: details.id,
    buyerId: details.buyerId,
    companyName: details.companyName,
    contactName: details.contactName ?? null,
    dueAt: details.dueAt,
    daysSincePlacement: details.daysSincePlacement ?? 0,
    tableSection: details.tableSection,
  });
}

export function alertQuotationMeeting(details: {
  id: string;
  buyerId: number;
  companyName: string;
  contactName?: string | null;
  meetingAt: string;
  minutesUntil?: number;
}) {
  const mode = getNotificationMode();
  if (mode === "off") return;

  const label = details.contactName?.trim()
    ? `${details.contactName} (${details.companyName})`
    : details.companyName;
  const meetingDate = new Date(details.meetingAt);
  const timeLabel = Number.isNaN(meetingDate.getTime())
    ? "soon"
    : meetingDate.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  const minutesUntil = details.minutesUntil ?? 0;
  const soonLabel =
    minutesUntil > 0 ? `in ${minutesUntil} minute${minutesUntil === 1 ? "" : "s"}` : "now";

  applyAlertEffects(
    mode,
    `Meeting reminder. ${label}. Scheduled for ${timeLabel}, starting ${soonLabel}.`,
  );

  showDesktopNotification(
    "Meeting starting soon",
    `${label} — ${timeLabel} (${soonLabel})`,
  );

  emitQuotationMeetingPopup({
    id: details.id,
    buyerId: details.buyerId,
    companyName: details.companyName,
    contactName: details.contactName ?? null,
    meetingAt: details.meetingAt,
    minutesUntil,
  });
}

export function alertInterestedClientsActivity(details: {
  id: string;
  message: string;
  count: number;
  isSelf: boolean;
  userLabel?: string;
}) {
  const mode = getNotificationMode();
  if (mode === "off") return;

  applyAlertEffects(mode, details.message);

  showDesktopNotification(
    details.isSelf ? "Interested Clients update" : "Team Interested Clients update",
    details.message,
  );

  emitInterestedClientsActivityPopup({
    id: details.id,
    message: details.message,
    count: details.count,
    isSelf: details.isSelf,
    userLabel: details.userLabel,
  });
}
