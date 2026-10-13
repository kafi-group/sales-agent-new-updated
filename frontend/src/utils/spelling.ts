/**
 * Spelling assist for lead/contact data entry.
 * Uses browser spellcheck + light common-typo autocorrect on blur/save.
 */

export type SpellingMode = "prose" | "name" | "off";

/**
 * Ensure the first letter in plain text is uppercase (skips leading whitespace).
 * Used live while typing email / WhatsApp / notes so messages always start capitalised.
 */
export function capitalizeFirstLetter(value: string): string {
  if (value == null || value === "") return value ?? "";
  const text = String(value);
  const match = text.match(/^(\s*)(\p{L})/u);
  if (!match) return text;
  const [, leading, letter] = match;
  const upper = letter.toLocaleUpperCase("en");
  if (letter === upper) return text;
  return leading + upper + text.slice(leading.length + letter.length);
}

/** Controlled input/textarea onChange that capitalises the first letter. */
export function capitalizedChange(
  onChange: (value: string) => void,
): (value: string) => void {
  return (value) => onChange(capitalizeFirstLetter(value));
}

/** HTML input/textarea attrs for native spellcheck / mobile autocorrect. */
export function spellingInputProps(mode: SpellingMode = "prose"): {
  spellCheck: boolean;
  autoCorrect: "on" | "off";
  autoCapitalize: "off" | "words" | "sentences";
  lang?: string;
} {
  if (mode === "off") {
    return {
      spellCheck: false,
      autoCorrect: "off",
      autoCapitalize: "off",
    };
  }
  return {
    spellCheck: true,
    autoCorrect: "on",
    autoCapitalize: mode === "name" ? "words" : "sentences",
    lang: "en",
  };
}

/** Common English typos seen in sales notes / designations / product text. */
const COMMON_TYPOS: Record<string, string> = {
  teh: "the",
  thte: "the",
  adn: "and",
  nad: "and",
  recieve: "receive",
  recieved: "received",
  adress: "address",
  addres: "address",
  seperate: "separate",
  seperately: "separately",
  occuring: "occurring",
  occured: "occurred",
  buisness: "business",
  buisiness: "business",
  intersted: "interested",
  intrested: "interested",
  intereseted: "interested",
  procurment: "procurement",
  procuremnt: "procurement",
  managment: "management",
  manger: "manager",
  maneger: "manager",
  sucess: "success",
  succesful: "successful",
  sucessful: "successful",
  availible: "available",
  availabe: "available",
  neccessary: "necessary",
  neccessery: "necessary",
  accomodate: "accommodate",
  accomodation: "accommodation",
  enviroment: "environment",
  goverment: "government",
  definately: "definitely",
  definatly: "definitely",
  tommorow: "tomorrow",
  tommorrow: "tomorrow",
  begining: "beginning",
  untill: "until",
  wich: "which",
  whcih: "which",
  becuase: "because",
  becasue: "because",
  followup: "follow-up",
  folow: "follow",
  quatity: "quantity",
  quanity: "quantity",
  quatotion: "quotation",
  quatation: "quotation",
  inquery: "inquiry",
  enquiery: "enquiry",
  shpiment: "shipment",
  shippment: "shipment",
  packging: "packaging",
  packaing: "packaging",
  certifcation: "certification",
  certifacate: "certificate",
  distributer: "distributor",
  distributers: "distributors",
  wholeale: "wholesale",
  wholesell: "wholesale",
  restuarant: "restaurant",
  resturant: "restaurant",
  restaraunt: "restaurant",
  speical: "special",
  speacil: "special",
  prodcuts: "products",
  prodcut: "product",
  informations: "information",
  pleasee: "please",
  plese: "please",
  thnak: "thank",
  thnaks: "thanks",
  regardds: "regards",
  regrads: "regards",
};

function preserveCase(original: string, replacement: string): string {
  if (!original) return replacement;
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function fixCommonTypos(text: string): string {
  return text.replace(/\b([A-Za-z']+)\b/g, (word) => {
    const key = word.toLowerCase();
    const fix = COMMON_TYPOS[key];
    return fix ? preserveCase(word, fix) : word;
  });
}

/** Normalize whitespace and apply common typo fixes. */
export function autocorrectText(value: string, mode: SpellingMode = "prose"): string {
  if (mode === "off" || value == null) return value ?? "";
  let out = String(value).replace(/\r\n/g, "\n");
  // Collapse runs of spaces/tabs (keep newlines for remarks).
  out = out.replace(/[^\S\n]+/g, " ");
  out = out.replace(/ *\n */g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  if (mode === "prose" || mode === "name") {
    out = fixCommonTypos(out);
    out = capitalizeFirstLetter(out);
  }
  return out.trim();
}

const LEAD_FIELD_SPELLING: Partial<Record<string, SpellingMode>> = {
  company_name: "name",
  contact_name: "name",
  industry: "prose",
  product_interest: "prose",
  company_grading: "prose",
  city: "name",
  address: "prose",
  remarks: "prose",
  contact_designation: "prose",
  website_url: "off",
  contact_email: "off",
  contact_secondary_email: "off",
  contact_phone: "off",
  contact_secondary_phone: "off",
  contact_primary_phone: "off",
  contact_secondary_mobile: "off",
  linkedin_company_url: "off",
  facebook_company_url: "off",
  instagram_company_url: "off",
  legacy_serial_no: "off",
};

export function leadFieldSpellingMode(field: string): SpellingMode {
  return LEAD_FIELD_SPELLING[field] ?? "prose";
}

export function spellingPropsForLeadField(field: string) {
  return spellingInputProps(leadFieldSpellingMode(field));
}

/** Autocorrect all spellcheck-enabled string fields on a lead draft. */
export function autocorrectLeadDraft<T extends object>(draft: T): T {
  const next: T = { ...draft };
  const mutable = next as Record<string, unknown>;
  for (const [field, mode] of Object.entries(LEAD_FIELD_SPELLING)) {
    if (mode === "off") continue;
    if (!(field in mutable)) continue;
    const value = mutable[field];
    if (typeof value === "string") {
      mutable[field] = autocorrectText(value, mode);
    }
  }
  return next;
}
