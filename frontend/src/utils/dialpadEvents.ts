/** Lightweight bus so tables/contacts can push a number into the floating dialpad. */

export type DialpadNumberPayload = {
  phone: string;
  contactName?: string;
  /** ISO country hint when the number has no +prefix */
  countryHint?: string | null;
};

const EVENT = "kafi:floating-dialpad-number";

export function pushNumberToFloatingDialpad(payload: DialpadNumberPayload): void {
  const phone = (payload.phone || "").trim();
  if (!phone) return;
  window.dispatchEvent(
    new CustomEvent(EVENT, {
      detail: {
        phone,
        contactName: payload.contactName?.trim() || undefined,
        countryHint: payload.countryHint ?? undefined,
      } satisfies DialpadNumberPayload,
    }),
  );
}

export function subscribeFloatingDialpadNumber(
  handler: (payload: DialpadNumberPayload) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DialpadNumberPayload>).detail;
    if (detail?.phone) handler(detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
