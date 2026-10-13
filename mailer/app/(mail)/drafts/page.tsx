"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

type Draft = {
  id: number;
  to_addrs: string;
  cc_addrs?: string;
  subject: string;
  body: string;
  updated_at?: string;
};

export default function DraftsPage() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<Draft[]>("/inbox/drafts");
      setDrafts(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load drafts");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: number) {
    await apiFetch(`/inbox/drafts/${id}`, { method: "DELETE" });
    void load();
  }

  return (
    <div className="pad">
      <h2 className="folder-title">Drafts</h2>
      {error && <p className="bad">{error}</p>}
      <ul className="simple-list">
        {drafts.map((d) => (
          <li key={d.id} className="card-row">
            <div>
              <p className="msg-subject">{d.subject || "(no subject)"}</p>
              <p className="muted small">To: {d.to_addrs || "—"}</p>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const q = new URLSearchParams({
                    draft_id: String(d.id),
                    to: d.to_addrs || "",
                    subject: d.subject || "",
                    body: d.body || "",
                  });
                  if (d.cc_addrs) q.set("cc", d.cc_addrs);
                  router.push(`/compose?${q.toString()}`);
                }}
              >
                Open
              </button>
              <button type="button" className="btn ghost" onClick={() => void remove(d.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
        {drafts.length === 0 && <li className="muted">No drafts</li>}
      </ul>
    </div>
  );
}
