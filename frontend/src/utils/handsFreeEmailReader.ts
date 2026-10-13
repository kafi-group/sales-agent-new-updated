/**
 * Hands-free inbox reader: speak offer → listen yes/no (EN + Roman Urdu) → read emails one-by-one.
 * Browser SpeechSynthesis + SpeechRecognition only (no backend).
 */

import {
  applyNarratorToUtterance,
  ensureNarratorVoicesLoaded,
  loadNarratorPrefs,
  narratorListenDelayMs,
  narratorListenTimeoutMs,
  playNarratorResponseBeep,
  sleepMs,
} from "./narratorPrefs";

export type HandsFreePhase =
  | "idle"
  | "offering"
  | "listening_offer"
  | "reading"
  | "asking_next"
  | "listening_next"
  | "done";

export interface HandsFreeEmailItem {
  uid: string;
  folder?: string;
  from: string;
  subject: string;
  body: string;
}

export interface HandsFreeSessionStatus {
  phase: HandsFreePhase;
  index: number;
  total: number;
  lastHeard: string;
  statusLine: string;
}

type StatusListener = (status: HandsFreeSessionStatus) => void;

const statusListeners = new Set<StatusListener>();

let phase: HandsFreePhase = "idle";
let queue: HandsFreeEmailItem[] = [];
let index = 0;
let lastHeard = "";
let statusLine = "";
let active = false;
let recognition: SpeechRecognition | null = null;
let sessionToken = 0;

function emitStatus() {
  const payload: HandsFreeSessionStatus = {
    phase,
    index,
    total: queue.length,
    lastHeard,
    statusLine,
  };
  statusListeners.forEach((listener) => listener(payload));
}

export function subscribeHandsFreeEmailReader(listener: StatusListener) {
  statusListeners.add(listener);
  listener({
    phase,
    index,
    total: queue.length,
    lastHeard,
    statusLine,
  });
  return () => {
    statusListeners.delete(listener);
  };
}

export function isHandsFreeEmailReaderActive() {
  return active && phase !== "idle" && phase !== "done";
}

function stopRecognition() {
  if (!recognition) return;
  try {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.stop();
  } catch {
    /* ignore */
  }
  recognition = null;
}

function stopSpeech() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

export function stopHandsFreeEmailReader(reason = "Stopped.") {
  sessionToken += 1;
  active = false;
  stopRecognition();
  stopSpeech();
  phase = "idle";
  queue = [];
  index = 0;
  lastHeard = "";
  statusLine = reason;
  emitStatus();
}

function normalizeHeard(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Affirmative replies (English + Roman Urdu). */
export function isAffirmativeReply(raw: string): boolean {
  const t = normalizeHeard(raw);
  if (!t) return false;
  if (isNegativeReply(t)) return false;
  const hits = [
    "yes",
    "yeah",
    "yep",
    "yup",
    "sure",
    "ok",
    "okay",
    "of course",
    "ofcourse",
    "go ahead",
    "please",
    "read",
    "read out",
    "read out loud",
    "read aloud",
    "read the email",
    "read the emails",
    "read them",
    "ha",
    "haan",
    "han",
    "ji",
    "jee",
    "bilkul",
    "parho",
    "parhao",
    "parh do",
    "parh lo",
    "ha parho",
    "haan parho",
    "yes read",
    "yes read out loud",
    "yes read the emails",
  ];
  return hits.some((h) => t === h || t.includes(h));
}

/** Negative replies (English + Roman Urdu). */
export function isNegativeReply(raw: string): boolean {
  const t = normalizeHeard(raw);
  if (!t) return false;
  const hits = [
    "no",
    "nope",
    "nah",
    "not now",
    "later",
    "don't",
    "dont",
    "do not",
    "do not read",
    "dont read",
    "don't read",
    "i will read",
    "i'll read",
    "myself later",
    "nahi",
    "nahe",
    "naheen",
    "mat",
    "mat parho",
    "mat parhao",
    "nahi parho",
    "nahi mujhay",
    "nahi mujhe",
    "ni karna",
    "nahi karna",
    "read ni karna",
    "read nahi karna",
  ];
  return hits.some((h) => t === h || t.includes(h));
}

function speakAsync(text: string, token: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    try {
      stopSpeech();
      const prefs = loadNarratorPrefs();
      const utterance = new SpeechSynthesisUtterance(text);
      applyNarratorToUtterance(utterance, prefs);
      utterance.onend = () => {
        if (token === sessionToken) resolve();
      };
      utterance.onerror = () => {
        if (token === sessionToken) resolve();
      };
      window.speechSynthesis.speak(utterance);
    } catch {
      resolve();
    }
  });
}

async function prepareListen(token: number): Promise<void> {
  if (token !== sessionToken) return;
  const prefs = loadNarratorPrefs();
  if (prefs.responseBeep) {
    statusLine = "Beep — your turn to speak…";
    emitStatus();
    await playNarratorResponseBeep();
    if (token !== sessionToken) return;
  }
  await sleepMs(narratorListenDelayMs(prefs.pause));
}

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function handsFreeSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    Boolean(getSpeechRecognitionCtor())
  );
}

function listenOnce(token: number, timeoutMs?: number): Promise<string> {
  return new Promise((resolve) => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      resolve("");
      return;
    }
    stopRecognition();
    let settled = false;
    const limit = timeoutMs ?? narratorListenTimeoutMs();
    const finish = (text: string) => {
      if (settled || token !== sessionToken) return;
      settled = true;
      window.clearTimeout(timer);
      stopRecognition();
      resolve(text);
    };

    const rec = new Ctor();
    recognition = rec;
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    rec.continuous = false;

    const timer = window.setTimeout(() => finish(""), limit);

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let best = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result?.isFinal) continue;
        for (let j = 0; j < result.length; j++) {
          const alt = result[j]?.transcript?.trim() || "";
          if (alt.length > best.length) best = alt;
        }
      }
      finish(best);
    };
    rec.onerror = () => finish("");
    rec.onend = () => {
      if (!settled) finish("");
    };

    try {
      rec.start();
    } catch {
      finish("");
    }
  });
}

function emailSpeakText(item: HandsFreeEmailItem, position: number, total: number): string {
  const from = item.from || "unknown sender";
  const subject = item.subject || "no subject";
  const body = (item.body || "").replace(/\s+/g, " ").trim();
  const clipped = body.length > 500 ? `${body.slice(0, 500)}. End of preview.` : body;
  const prefix =
    total > 1 ? `Email ${position} of ${total}.` : "Here is your email.";
  return `${prefix} From ${from}. Subject: ${subject}. ${clipped || "No message body."}`;
}

async function runSession(token: number) {
  if (!queue.length) {
    await speakAsync("You have no new emails to read.", token);
    stopHandsFreeEmailReader();
    return;
  }

  const n = queue.length;
  phase = "offering";
  statusLine =
    n === 1
      ? "You have 1 new email. Asking if you want it read…"
      : `You have ${n} new emails. Asking if you want them read…`;
  emitStatus();

  const offer =
    n === 1
      ? "You have 1 new email in your inbox. Would you like me to read it for you?"
      : `You have ${n} new emails in your inbox. Would you like me to read them for you?`;
  await speakAsync(offer, token);
  if (token !== sessionToken) return;

  phase = "listening_offer";
  statusLine = "Listening for yes or no…";
  emitStatus();
  await prepareListen(token);
  if (token !== sessionToken) return;
  const heardOffer = await listenOnce(token);
  if (token !== sessionToken) return;
  lastHeard = heardOffer;
  emitStatus();

  if (isNegativeReply(heardOffer)) {
    phase = "done";
    statusLine = "OK, understood.";
    emitStatus();
    await speakAsync("OK, understood.", token);
    stopHandsFreeEmailReader("OK, understood.");
    return;
  }
  if (!isAffirmativeReply(heardOffer)) {
    phase = "done";
    statusLine = "Didn't catch a clear yes — leaving emails for you.";
    emitStatus();
    await speakAsync("I did not catch a clear yes. OK, I'll leave them for you.", token);
    stopHandsFreeEmailReader(statusLine);
    return;
  }

  while (index < queue.length && token === sessionToken) {
    const item = queue[index];
    phase = "reading";
    statusLine = `Reading email ${index + 1} of ${queue.length}…`;
    emitStatus();
    await speakAsync(emailSpeakText(item, index + 1, queue.length), token);
    if (token !== sessionToken) return;

    const nextIndex = index + 1;
    if (nextIndex >= queue.length) break;

    phase = "asking_next";
    statusLine = `Ask: read email ${nextIndex + 1}?`;
    emitStatus();
    await speakAsync(
      `Shall I read the next email as well? That would be email ${nextIndex + 1} of ${queue.length}.`,
      token,
    );
    if (token !== sessionToken) return;

    phase = "listening_next";
    statusLine = "Listening for yes or no…";
    emitStatus();
    await prepareListen(token);
    if (token !== sessionToken) return;
    const heardNext = await listenOnce(token);
    if (token !== sessionToken) return;
    lastHeard = heardNext;
    emitStatus();

    if (isNegativeReply(heardNext) || !isAffirmativeReply(heardNext)) {
      phase = "done";
      statusLine = "OK, understood.";
      emitStatus();
      await speakAsync("OK, understood.", token);
      stopHandsFreeEmailReader("OK, understood.");
      return;
    }
    index = nextIndex;
  }

  phase = "done";
  statusLine = "Finished reading.";
  emitStatus();
  await speakAsync("That was the last email.", token);
  stopHandsFreeEmailReader("Finished reading.");
}

export async function startHandsFreeEmailReader(emails: HandsFreeEmailItem[]) {
  stopHandsFreeEmailReader();
  const items = (emails || []).filter((e) => e?.uid);
  if (!items.length) return;

  if (!handsFreeSpeechSupported()) {
    statusLine = "Voice read-aloud needs a browser with speech + microphone support.";
    emitStatus();
    return;
  }

  active = true;
  sessionToken += 1;
  const token = sessionToken;
  queue = items.slice(0, 10);
  index = 0;
  lastHeard = "";
  statusLine = "Starting hands-free reader…";
  phase = "offering";
  emitStatus();

  try {
    await ensureNarratorVoicesLoaded();
    await runSession(token);
  } catch {
    if (token === sessionToken) {
      stopHandsFreeEmailReader("Hands-free reader stopped.");
    }
  }
}
