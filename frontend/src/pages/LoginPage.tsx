import { useEffect, useState, type FormEvent } from "react";
import { client } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ThemeToggle } from "../components/ThemeToggle";
import { AppBrand } from "../components/AppBrand";

const ADMIN_USERNAME = "admin";

type LoginMode = "admin" | "user";

export function LoginPage() {
  const { login } = useAuth();
  const [mode, setMode] = useState<LoginMode>("admin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void client.wakeBackend();
  }, []);

  function switchMode(next: LoginMode) {
    setMode(next);
    setError(null);
    setPassword("");
    setUsername("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const loginUsername = mode === "admin" ? ADMIN_USERNAME : username.trim();
      await login(loginUsername, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    mode === "admin" ? Boolean(password) : Boolean(username.trim() && password);

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-8 bg-slate-950 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle compact />
      </div>
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-6 sm:p-8 shadow-xl shadow-black/30">
        <AppBrand variant="login" />
        <h2 className="mt-6 text-xl font-semibold tracking-tight text-slate-100">
          {mode === "admin" ? "Admin sign in" : "User sign in"}
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          {mode === "admin"
            ? "Enter the admin password to open the full dashboard."
            : "Use the username and password created for you by an admin."}
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4">
          {mode === "user" && (
            <label className="block">
              <span className="text-sm text-slate-300">Username</span>
              <input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-500"
                placeholder="your username"
              />
            </label>
          )}
          <label className="block">
            <span className="text-sm text-slate-300">Password</span>
            <input
              autoFocus={mode === "admin"}
              type="password"
              autoComplete={mode === "admin" ? "current-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-500"
              placeholder="••••"
            />
          </label>

          {error && (
            <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !canSubmit}
            className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2.5 text-sm font-medium text-white"
          >
            {submitting ? "Signing in…" : mode === "admin" ? "Sign in as admin" : "Sign in"}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-slate-800">
          {mode === "admin" ? (
            <button
              type="button"
              onClick={() => switchMode("user")}
              className="w-full text-sm text-slate-300 hover:text-emerald-300 transition"
            >
              Not an admin? Sign in with your user account
            </button>
          ) : (
            <button
              type="button"
              onClick={() => switchMode("admin")}
              className="w-full text-sm text-slate-300 hover:text-emerald-300 transition"
            >
              Back to admin sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
