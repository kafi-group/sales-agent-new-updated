/**
 * Edge / other browsers often keep a stale index.html that points at an old
 * hashed JS bundle. When a newer deploy is live, reload once so everyone
 * lands on the same UI without manual cache clears.
 */

function currentBundleName(): string | null {
  const scripts = Array.from(document.getElementsByTagName("script"));
  for (const el of scripts) {
    const src = el.getAttribute("src") || "";
    const m = src.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    if (m) return m[1];
  }
  return null;
}

export function watchForNewDeploy(): void {
  if (typeof window === "undefined") return;
  if (import.meta.env.DEV) return;

  const mine = currentBundleName();
  const metaEl = document.querySelector('meta[name="kafi-build"]');
  const myBuild = metaEl?.getAttribute("content") || null;
  if (!mine && !myBuild) return;

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const res = await fetch(`/?_deploy_check=${Date.now()}`, {
        cache: "no-store",
        headers: { Pragma: "no-cache", "Cache-Control": "no-cache" },
      });
      if (!res.ok) return;
      const html = await res.text();
      const latestBundle = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] || null;
      const latestBuild = html.match(/name="kafi-build"\s+content="([^"]+)"/)?.[1] || null;
      const bundleChanged = Boolean(mine && latestBundle && latestBundle !== mine);
      const buildChanged = Boolean(myBuild && latestBuild && latestBuild !== myBuild);
      if (bundleChanged || buildChanged) {
        try {
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch {
          /* ignore */
        }
        window.location.reload();
      }
    } catch {
      /* ignore network blips */
    } finally {
      checking = false;
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  window.addEventListener("focus", () => void check());
  window.setTimeout(() => void check(), 1500);
  window.setInterval(() => void check(), 2 * 60 * 1000);
}
