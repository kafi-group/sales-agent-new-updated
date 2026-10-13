/** Lead assignee helpers — values are app user IDs or "unassigned". */

export const UNASSIGNED = "unassigned";

export type LeadAssigneeOption = {
  value: string;
  label: string;
};

export function leadAssigneeLabel(
  value: string | number | null | undefined,
  options: LeadAssigneeOption[] = [],
): string {
  if (value == null || value === "" || value === UNASSIGNED) return "Unassigned";
  const key = String(value);
  const match = options.find((item) => item.value === key);
  return match?.label ?? key;
}

export function normalizeAssigneeValue(
  userId: number | null | undefined,
): string {
  if (userId == null) return UNASSIGNED;
  return String(userId);
}

export function parseAssigneeUserId(value: string): number | null {
  if (!value || value === UNASSIGNED) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
