/** Browser narrator prefs for email hands-free reader + WhatsApp / alert voiceovers. */

export type NarratorSpeed = "slow" | "normal" | "fast";
export type NarratorGender = "male" | "female";
export type NarratorPause = "short" | "normal" | "long";

export interface NarratorPrefs {
  speed: NarratorSpeed;
  gender: NarratorGender;
  pause: NarratorPause;
  /** Play a short beep after the prompt so the user knows to speak. */
  responseBeep: boolean;
}

const STORAGE_KEY = "kafi.narratorPrefs";

export const DEFAULT_NARRATOR_PREFS: NarratorPrefs = {
  speed: "fast",
  gender: "male",
  pause: "short",
  responseBeep: false,
};

const SPEED_VALUES: NarratorSpeed[] = ["slow", "normal", "fast"];
const GENDER_VALUES: NarratorGender[] = ["male", "female"];
const PAUSE_VALUES: NarratorPause[] = ["short", "normal", "long"];

const prefListeners = new Set<() => void>();

function isSpeed(v: unknown): v is NarratorSpeed {
  return typeof v === "string" && SPEED_VALUES.includes(v as NarratorSpeed);
}
function isGender(v: unknown): v is NarratorGender {
  return typeof v === "string" && GENDER_VALUES.includes(v as NarratorGender);
}
function isPause(v: unknown): v is NarratorPause {
  return typeof v === "string" && PAUSE_VALUES.includes(v as NarratorPause);
}

export function loadNarratorPrefs(): NarratorPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_NARRATOR_PREFS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NARRATOR_PREFS };
    const parsed = JSON.parse(raw) as Partial<NarratorPrefs>;
    return {
      speed: isSpeed(parsed.speed) ? parsed.speed : DEFAULT_NARRATOR_PREFS.speed,
      gender: isGender(parsed.gender) ? parsed.gender : DEFAULT_NARRATOR_PREFS.gender,
      pause: isPause(parsed.pause) ? parsed.pause : DEFAULT_NARRATOR_PREFS.pause,
      responseBeep:
        typeof parsed.responseBeep === "boolean"
          ? parsed.responseBeep
          : DEFAULT_NARRATOR_PREFS.responseBeep,
    };
  } catch {
    return { ...DEFAULT_NARRATOR_PREFS };
  }
}

export function saveNarratorPrefs(next: Partial<NarratorPrefs>): NarratorPrefs {
  const merged = { ...loadNarratorPrefs(), ...next };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* ignore */
  }
  prefListeners.forEach((fn) => fn());
  return merged;
}

export function subscribeNarratorPrefs(listener: () => void) {
  prefListeners.add(listener);
  return () => {
    prefListeners.delete(listener);
  };
}

/** speechSynthesis rate */
export function narratorSpeechRate(speed: NarratorSpeed = loadNarratorPrefs().speed): number {
  if (speed === "slow") return 0.8;
  if (speed === "normal") return 1;
  return 1.2; // fast (previous default feel)
}

/** Delay after TTS ends (and optional beep) before mic listens. */
export function narratorListenDelayMs(pause: NarratorPause = loadNarratorPrefs().pause): number {
  if (pause === "short") return 250;
  if (pause === "normal") return 1100;
  return 2200;
}

/** How long SpeechRecognition waits for an answer. */
export function narratorListenTimeoutMs(pause: NarratorPause = loadNarratorPrefs().pause): number {
  if (pause === "short") return 7000;
  if (pause === "normal") return 14000;
  return 22000;
}

function scoreVoice(voice: SpeechSynthesisVoice, gender: NarratorGender): number {
  const name = `${voice.name} ${voice.lang}`.toLowerCase();
  let score = 0;
  if (voice.lang.toLowerCase().startsWith("en")) score += 5;
  if (gender === "female") {
    if (/female|zira|samantha|victoria|karen|moira|fiona|tessa|susan|hazel|google.*female/.test(name)) {
      score += 20;
    }
    if (/male|david|mark|daniel|alex|fred|google.*male/.test(name)) score -= 15;
  } else {
    if (/male|david|mark|daniel|alex|fred|ravi|google.*male/.test(name)) score += 20;
    if (/female|zira|samantha|victoria|karen|moira|fiona|tessa|susan|hazel|google.*female/.test(name)) {
      score -= 15;
    }
  }
  if (voice.default) score += 1;
  return score;
}

export function pickNarratorVoice(
  gender: NarratorGender = loadNarratorPrefs().gender,
): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -Infinity;
  for (const voice of voices) {
    const s = scoreVoice(voice, gender);
    if (s > bestScore) {
      bestScore = s;
      best = voice;
    }
  }
  return best;
}

/** Ensure voices are loaded (Chrome loads them asynchronously). */
export function ensureNarratorVoicesLoaded(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    const existing = window.speechSynthesis.getVoices();
    if (existing.length) {
      resolve();
      return;
    }
    const done = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", done);
      resolve();
    };
    window.speechSynthesis.addEventListener("voiceschanged", done);
    window.setTimeout(done, 800);
  });
}

export function applyNarratorToUtterance(
  utterance: SpeechSynthesisUtterance,
  prefs: NarratorPrefs = loadNarratorPrefs(),
) {
  utterance.rate = narratorSpeechRate(prefs.speed);
  utterance.pitch = prefs.gender === "female" ? 1.05 : 0.95;
  utterance.volume = 1;
  const voice = pickNarratorVoice(prefs.gender);
  if (voice) utterance.voice = voice;
}

/** Short cue tone so the user knows to start speaking. */
export async function playNarratorResponseBeep(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    if (ctx.state === "suspended") await ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
    await new Promise((r) => window.setTimeout(r, 220));
    void ctx.close();
  } catch {
    /* ignore */
  }
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}
