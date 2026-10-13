/** Display labels for market-role API values (consumer/producer → importer/exporter). */

const MARKET_ROLE_LABELS: Record<string, string> = {
  consumer: "Importer",
  producer: "Exporter",
  hybrid: "Hybrid",
  unknown: "Unclassified",
};

export function formatMarketRoleLabel(role: string | null | undefined): string {
  const key = (role || "unknown").toLowerCase();
  return MARKET_ROLE_LABELS[key] ?? role ?? "Unclassified";
}
