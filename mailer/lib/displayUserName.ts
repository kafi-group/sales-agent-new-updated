import type { MailerUser } from "./api";

/** Sidebar / footer label — maps legacy Administrator to Mr. Khalid. */
export function displayUserName(user: MailerUser | null | undefined): string {
  if (!user) return "Mailbox";
  if (
    user.full_name === "Administrator" ||
    user.full_name === "Admin" ||
    user.username === "admin" ||
    (user.mailbox_email || "").toLowerCase().includes("khaled.paracha")
  ) {
    return "Mr. Khalid";
  }
  return user.mailbox_display_name || user.full_name || user.username;
}
