"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  clearSession,
  fetchMe,
  getStoredToken,
  getStoredUser,
  login as apiLogin,
  storeSession,
  type MailerUser,
} from "@/lib/api";

type AuthState = {
  user: MailerUser | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  /** Apply a session from handoff-login without requiring /auth/me. */
  adoptSession: (token: string, user: MailerUser) => void;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MailerUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const adoptSession = useCallback((nextToken: string, nextUser: MailerUser) => {
    storeSession(nextToken, nextUser);
    setToken(nextToken);
    setUser(nextUser);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    const stored = getStoredToken();
    if (!stored) {
      setUser(null);
      setToken(null);
      setLoading(false);
      return;
    }
    try {
      const me = await fetchMe();
      setUser(me);
      setToken(stored);
    } catch {
      // Keep handoff/local session — /auth/me can fail while /mailer/* still works.
      const cachedUser = getStoredUser();
      setToken(stored);
      setUser(cachedUser);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUser(getStoredUser());
    setToken(getStoredToken());
    void refresh();
  }, [refresh]);

  // Stay in sync when storeSession/clearSession run outside React state.
  useEffect(() => {
    function onSession() {
      setToken(getStoredToken());
      setUser(getStoredUser());
    }
    window.addEventListener("kafi-mailer-session", onSession);
    window.addEventListener("storage", onSession);
    return () => {
      window.removeEventListener("kafi-mailer-session", onSession);
      window.removeEventListener("storage", onSession);
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiLogin(username, password);
    setUser(result.user);
    setToken(result.token);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
    setToken(null);
  }, []);

  const value = useMemo(
    () => ({ user, token, loading, login, adoptSession, logout, refresh }),
    [user, token, loading, login, adoptSession, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
