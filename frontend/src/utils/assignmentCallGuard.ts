/** Warn when a lead is assigned to another sales user before placing a call. */
export function getAssignmentCallWarning(
  assignedToUserId: number | null | undefined,
  assignedTo: string | null | undefined,
  currentUserId: number | null | undefined,
): string | null {
  if (assignedToUserId == null || currentUserId == null) return null;
  if (assignedToUserId === currentUserId) return null;
  const label = (assignedTo || "another user").trim() || "another user";
  return `This contact is already assigned to ${label}. Please coordinate with that user before calling.`;
}

export function confirmAssignmentCallProceed(warning: string): boolean {
  return window.confirm(`${warning}\n\nDo you still want to call?`);
}
