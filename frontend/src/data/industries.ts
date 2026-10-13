/** Buyer industries most likely to purchase Kafi / Essence products. */

/** Max industries selectable in lead discovery (same cap as regions). */
export const MAX_DISCOVERY_INDUSTRIES = 3;

export interface Industry {
  id: string;
  name: string;
  group: string;
}

export const INDUSTRIES: Industry[] = [
  // Import & distribution
  { id: "food_importer", name: "Food importer", group: "Import & distribution" },
  { id: "food_distributor", name: "Food distributor", group: "Import & distribution" },
  {
    id: "wholesale_food",
    name: "Wholesale food distributor",
    group: "Import & distribution",
  },
  { id: "fmcg_distributor", name: "FMCG distributor", group: "Import & distribution" },
  { id: "cash_carry", name: "Cash & carry wholesaler", group: "Import & distribution" },
  {
    id: "halal_food_distributor",
    name: "Halal food distributor",
    group: "Import & distribution",
  },
  // Retail & grocery
  {
    id: "supermarket_chain",
    name: "Supermarket / retail chain",
    group: "Retail & grocery",
  },
  {
    id: "ethnic_grocery",
    name: "Ethnic / Asian / Middle Eastern grocery",
    group: "Retail & grocery",
  },
  {
    id: "specialty_food_retail",
    name: "Specialty food retailer",
    group: "Retail & grocery",
  },
  { id: "gourmet_food", name: "Gourmet food retailer", group: "Retail & grocery" },
  // Food service (HORECA)
  { id: "horeca_supplier", name: "HORECA supplier", group: "Food service (HORECA)" },
  {
    id: "restaurant_wholesale",
    name: "Restaurant / catering supplier",
    group: "Food service (HORECA)",
  },
  {
    id: "hotel_procurement",
    name: "Hotel & hospitality procurement",
    group: "Food service (HORECA)",
  },
  // Product focus
  { id: "rice_importer", name: "Rice importer / trader", group: "Product focus" },
  {
    id: "spices_importer",
    name: "Spices & seasonings importer",
    group: "Product focus",
  },
  {
    id: "condiments_distributor",
    name: "Condiments & sauces distributor",
    group: "Product focus",
  },
  {
    id: "pickles_chutney",
    name: "Pickles & chutney distributor",
    group: "Product focus",
  },
  {
    id: "salt_spices",
    name: "Salt & spices distributor",
    group: "Product focus",
  },
  // Trading
  {
    id: "food_trader",
    name: "Individual food trader / broker",
    group: "Trading",
  },
  {
    id: "private_label",
    name: "Private label / own-brand retailer",
    group: "Trading",
  },
];

const _byName = new Map(INDUSTRIES.map((industry) => [industry.name.toLowerCase(), industry]));

export function findIndustry(value: string | null | undefined): Industry | undefined {
  if (!value) return undefined;
  return _byName.get(value.trim().toLowerCase());
}

export function industryGroups(): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const industry of INDUSTRIES) {
    if (!seen.has(industry.group)) {
      seen.add(industry.group);
      groups.push(industry.group);
    }
  }
  return groups;
}

export function industriesByGroup(group: string): Industry[] {
  return INDUSTRIES.filter((industry) => industry.group === group);
}
