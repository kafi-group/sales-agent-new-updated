"use client";

import { RequireAuth } from "@/components/RequireAuth";
import { MailSidebar } from "@/components/MailSidebar";

export default function MailLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <div className="mail-shell">
        <MailSidebar />
        <main className="mail-main">{children}</main>
      </div>
    </RequireAuth>
  );
}
