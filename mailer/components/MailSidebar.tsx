"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { displayUserName } from "@/lib/displayUserName";
import { useAuth } from "./AuthProvider";

type FolderCounts = {
  inbox: number;
  sent: number;
  trash: number;
  archive: number;
  drafts: number;
  templates: number;
};

const NAV: { href: string; label: string; key: keyof FolderCounts }[] = [
  { href: "/inbox", label: "Inbox", key: "inbox" },
  { href: "/sent", label: "Sent", key: "sent" },
  { href: "/drafts", label: "Drafts", key: "drafts" },
  { href: "/trash", label: "Trash", key: "trash" },
  { href: "/archive", label: "Archive", key: "archive" },
  { href: "/templates", label: "Email templates", key: "templates" },
];

export function MailSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [counts, setCounts] = useState<FolderCounts>({
    inbox: 0,
    sent: 0,
    trash: 0,
    archive: 0,
    drafts: 0,
    templates: 0,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [folders, drafts, templates] = await Promise.all([
          apiFetch<{
            folders: Array<{ key: string; count: number; unread_count: number }>;
          }>("/inbox/folders"),
          apiFetch<{ count: number }>("/inbox/drafts/count").catch(() => ({ count: 0 })),
          apiFetch<unknown[]>("/email-templates").catch(() => []),
        ]);
        if (cancelled) return;
        const next: FolderCounts = {
          inbox: 0,
          sent: 0,
          trash: 0,
          archive: 0,
          drafts: drafts.count,
          templates: Array.isArray(templates) ? templates.length : 0,
        };
        for (const f of folders.folders || []) {
          if (f.key === "inbox" || f.key === "sent" || f.key === "trash" || f.key === "archive") {
            next[f.key] = f.count;
          }
        }
        setCounts(next);
      } catch {
        /* ignore */
      }
    }
    void load();
    const t = window.setInterval(load, 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  return (
    <aside className="mail-sidebar">
      <div className="mail-brand">
        <p className="mail-brand-title">Kafi Mail</p>
        <p className="mail-brand-sub">{user?.mailbox_email || displayUserName(user) || "Mailbox"}</p>
      </div>
      <button type="button" className="btn compose-btn" onClick={() => router.push("/compose")}>
        Compose
      </button>
      <nav className="mail-nav">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`mail-nav-item ${active ? "active" : ""}`}
            >
              <span>{item.label}</span>
              <span className="mail-nav-count">{counts[item.key]}</span>
            </Link>
          );
        })}
      </nav>
      <div className="mail-sidebar-foot">
        <p className="muted small">{displayUserName(user)}</p>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            logout();
            router.replace("/login");
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
