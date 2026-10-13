import type { WhatsAppConversation } from "../api/client";

function seenStorageKey(contactId: number): string {
  return `kafi.wa.seen.${contactId}`;
}

/** Mark a thread read up to the latest message timestamp. */
export function markWhatsAppThreadSeen(
  contactId: number,
  lastMessageAt: string | null | undefined,
): void {
  if (!lastMessageAt) return;
  try {
    sessionStorage.setItem(seenStorageKey(contactId), lastMessageAt);
  } catch {
    /* ignore */
  }
}

export function isWhatsAppThreadSeen(conv: WhatsAppConversation): boolean {
  if (!conv.last_message_at) return false;
  try {
    const seen = sessionStorage.getItem(seenStorageKey(conv.contact_id));
    if (!seen) return false;
    return seen >= conv.last_message_at;
  } catch {
    return false;
  }
}

export function whatsAppThreadUnread(conv: WhatsAppConversation): number {
  if (isWhatsAppThreadSeen(conv)) return 0;
  return Math.max(0, conv.unread_count ?? 0);
}

export function sumWhatsAppInboxUnread(rows: WhatsAppConversation[]): number {
  return rows.reduce((sum, row) => sum + whatsAppThreadUnread(row), 0);
}
