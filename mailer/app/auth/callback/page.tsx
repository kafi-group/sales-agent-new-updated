"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { redeemSessionCode, clearSession } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";

function safeMailerNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/inbox";
  return raw;
}

function CallbackInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { refresh, adoptSession } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    if (!code) {
      setError("Missing session code");
      return;
    }
    const nextPath = safeMailerNext(params.get("next"));
    const expectedUser = (params.get("u") || "").trim().toLowerCase();
    let cancelled = false;
    void (async () => {
      try {
        clearSession();
        const result = await redeemSessionCode(code);
        if (
          expectedUser &&
          result.user.username.toLowerCase() !== expectedUser
        ) {
          clearSession();
          throw new Error(
            `Expected mailer login as ${expectedUser}, got ${result.user.username}`,
          );
        }
        if (cancelled) return;
        adoptSession(result.token, result.user);
        await refresh();
        if (!cancelled) router.replace(nextPath);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not open mail session");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, refresh, adoptSession, router]);

  return (
    <div className="wrap">
      <div className="card">
        <h1>Kafi Mail</h1>
        {error ? (
          <>
            <p className="bad">{error}</p>
            <button type="button" className="btn" onClick={() => router.replace("/login")}>
              Go to login
            </button>
          </>
        ) : (
          <p className="muted">Opening your mailbox…</p>
        )}
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<div className="wrap muted">Loading…</div>}>
      <CallbackInner />
    </Suspense>
  );
}
