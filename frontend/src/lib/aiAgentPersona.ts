/** Canonical Sara = female, Rayan = male — use on every dial / label path. */

export type VoiceGender = "female" | "male";

export function personaVoiceGender(input: {
  id?: string | null;
  name?: string | null;
  gender_label?: string | null;
  voice?: string | null;
}): VoiceGender {
  const id = String(input.id || "").trim().toLowerCase();
  const name = String(input.name || "").trim().toLowerCase();
  const gl = String(input.gender_label || "").trim().toLowerCase();
  const voice = String(input.voice || "");

  if (
    id === "female" ||
    gl === "female" ||
    name === "sara" ||
    name === "sarah" ||
    name.includes("sara") ||
    /Neural2-F|Jenny|Joanna|Female|Savannah|Rachel/i.test(voice)
  ) {
    return "female";
  }
  if (
    id === "male" ||
    gl === "male" ||
    name === "rayan" ||
    name === "ryan" ||
    name.includes("rayan") ||
    /Neural2-D|Guy|Matthew|Male|Elliot|Antoni/i.test(voice)
  ) {
    return "male";
  }
  return id === "female" ? "female" : "male";
}

export function personaDisplayName(input: {
  id?: string | null;
  name?: string | null;
}): string {
  const id = String(input.id || "").trim().toLowerCase();
  const name = String(input.name || "").trim();
  if (id === "female" || name.toLowerCase() === "sara" || name.toLowerCase().includes("sara")) {
    return "Sara";
  }
  if (id === "male" || name.toLowerCase() === "rayan" || name.toLowerCase().includes("rayan")) {
    return "Rayan";
  }
  return name || (id === "female" ? "Sara" : id === "male" ? "Rayan" : id || "Agent");
}
