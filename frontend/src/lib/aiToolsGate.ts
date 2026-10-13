/** Admin-only AI Mode / Searched by AI — unlocked via Settings password for this browser session. */

export const AI_TOOLS_PASSWORD = "786786";
export const AI_TOOLS_UNLOCK_KEY = "kafi.aiToolsUnlocked";

export function areAiToolsUnlocked(): boolean {
  try {
    return sessionStorage.getItem(AI_TOOLS_UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function unlockAiTools(): void {
  try {
    sessionStorage.setItem(AI_TOOLS_UNLOCK_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function lockAiTools(): void {
  try {
    sessionStorage.removeItem(AI_TOOLS_UNLOCK_KEY);
  } catch {
    /* ignore */
  }
}

export function canOpenRestrictedAiTab(isAdmin: boolean): boolean {
  return Boolean(isAdmin && areAiToolsUnlocked());
}
