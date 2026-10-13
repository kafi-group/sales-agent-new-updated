type DashboardUser = {
  full_name?: string | null;
  username?: string;
  role?: string;
  mailbox_email?: string | null;
};

/** Sidebar footer label — legacy Administrator / Khalid mailbox → Mr. Khalid. */
export function displayDashboardUserLabel(user: DashboardUser | null | undefined): string {
  if (!user) return "";
  if (
    user.role === "admin" &&
    (user.full_name === "Administrator" ||
      user.full_name === "Admin" ||
      user.username === "admin" ||
      (user.mailbox_email || "").toLowerCase().includes("khaled.paracha"))
  ) {
    return "Mr. Khalid";
  }
  return user.full_name || user.username || "";
}
