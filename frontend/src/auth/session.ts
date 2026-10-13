/** Persist lightweight user profile; session cookie is primary, Bearer token is backup. */

export type AppRole = "admin" | "user";

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: AppRole;
  is_active: boolean;
}

/** Bearer backup when httpOnly cookie is missing (some proxy / browser edge cases). */
const TOKEN_KEY = "kafi_auth_token";
const USER_KEY = "kafi_auth_user";
const IMPERSONATOR_TOKEN_KEY = "kafi_impersonator_token";
const IMPERSONATOR_USER_KEY = "kafi_impersonator_user";

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    if (!parsed?.id || !parsed?.role) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Cache display profile only. */
export function storeUser(user: AuthUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** Persist profile + Bearer token from /auth/login (cookie is still set by the API). */
export function storeSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getImpersonatorSnapshot(): { token: string; user: AuthUser } | null {
  try {
    const token = localStorage.getItem(IMPERSONATOR_TOKEN_KEY);
    const raw = localStorage.getItem(IMPERSONATOR_USER_KEY);
    if (!token || !raw) return null;
    const user = JSON.parse(raw) as AuthUser;
    if (!user?.id) return null;
    return { token, user };
  } catch {
    return null;
  }
}

export function storeImpersonatorSnapshot(token: string, user: AuthUser): void {
  localStorage.setItem(IMPERSONATOR_TOKEN_KEY, token);
  localStorage.setItem(IMPERSONATOR_USER_KEY, JSON.stringify(user));
}

export function clearImpersonatorSnapshot(): void {
  localStorage.removeItem(IMPERSONATOR_TOKEN_KEY);
  localStorage.removeItem(IMPERSONATOR_USER_KEY);
}

export function isAdmin(user: AuthUser | null | undefined): boolean {
  return user?.role === "admin";
}

/** Asim, Usman, and Sadia work in Target and Workspace — hide outcome-bucket tables. */
export function isWorkspaceOnlySalesUser(user: AuthUser | null | undefined): boolean {
  const blob = `${user?.username ?? ""} ${user?.full_name ?? ""}`.toLowerCase();
  const compact = blob.replace(/[^a-z]/g, "");
  if (!compact) return false;
  return compact.includes("asim") || compact.includes("usman") || compact.includes("sadia");
}

export const WORKSPACE_HIDDEN_TABLE_SECTIONS = [
  "interested_clients",
  "sales_interested_clients",
  "not_interested_clients",
  "not_received_call_clients",
] as const;
