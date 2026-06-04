// Source: FlavorList_5_7_2026.docx (uploaded by Alina).
// Tags: GF = gluten free (manufactured certified), V = vegan,
// (Peanuts) / (Walnuts) / (Pecans) = allergens, * = shared equipment.

export type Flavor = {
  name: string;
  category: "ice_cream" | "non_dairy" | "sorbet";
  gf?: boolean;
  vegan?: boolean;
  allergens?: string[];
};

export const FLAVORS: ReadonlyArray<Flavor> = [
  // Ice cream
  { name: "Black Raspberry Fudge Chunk", category: "ice_cream", gf: true },
  { name: "Butter Pecan", category: "ice_cream", gf: true, allergens: ["Pecans"] },
  { name: "Cherry Garcia", category: "ice_cream", gf: true },
  { name: "Chocolate", category: "ice_cream", gf: true },
  { name: "Chocolate Chip Cookie Dough", category: "ice_cream" },
  { name: "Chocolate Fudge Brownie", category: "ice_cream" },
  { name: "Chocolate PB Chunk", category: "ice_cream", gf: true, allergens: ["Peanuts"] },
  { name: "Chunky Monkey", category: "ice_cream", gf: true, allergens: ["Walnuts"] },
  { name: "Coffee, Coffee BuzzBuzzBuzz!", category: "ice_cream", gf: true },
  { name: "Half Baked", category: "ice_cream" },
  { name: "Honey Graham Latte", category: "ice_cream" },
  { name: "Mango", category: "ice_cream", gf: true },
  { name: "Marshmallow Sky", category: "ice_cream" },
  { name: "Milk & Cookies", category: "ice_cream" },
  { name: "Mint Chocolate Chunk", category: "ice_cream", gf: true },
  { name: "Phish Food", category: "ice_cream", gf: true },
  { name: "Salted Caramel Blondie", category: "ice_cream" },
  { name: "Stephen Colbert's AmeriCone Dream", category: "ice_cream" },
  { name: "Strawberry Cheesecake", category: "ice_cream" },
  { name: "Sweet Cream & Cookies", category: "ice_cream" },
  { name: "The Tonight Dough", category: "ice_cream", allergens: ["Peanuts"] },
  { name: "Ultraviolet", category: "ice_cream", gf: true },
  { name: "Vanilla", category: "ice_cream", gf: true },
  // Non-dairy (oat milk)
  { name: "Non-Dairy Chocolate Chip Cookie Dough", category: "non_dairy", vegan: true },
  { name: "Non-Dairy Key Lime Pie", category: "non_dairy", vegan: true },
  { name: "Non-Dairy Mochaccino Chip", category: "non_dairy", gf: true, vegan: true },
  { name: "Non-Dairy Strawberry Swirl", category: "non_dairy", gf: true, vegan: true },
  // Sorbet
  { name: "Lemonade Sorbet", category: "sorbet", gf: true, vegan: true },
];

export const FLAVOR_NAMES: ReadonlyArray<string> = FLAVORS.map((f) => f.name);

// Map a raw flavor string from the DB to a canonical name we display.
// Strips:
//   - leading "(NNN) " inventory code
//   - trailing " - Original Ice Cream" / " - Sorbet" / " - Non-Dairy ..." category suffix
//   - trailing inline "(GF)" / " GF" / " GF/V" / " V" tags
// Also normalises minor punctuation differences ("Milk and Cookies" → "Milk & Cookies",
// "AmeriCone" capitalisation, etc.) where they map to a known flavor.
const CATEGORY_SUFFIXES = [
  / - Original Ice Cream$/i,
  / - Sorbet$/i,
  / - Non-Dairy Frozen Dessert$/i,
  / - Non-?Dairy.*$/i,
];
const TAG_SUFFIXES = [
  / \(GF\)$/i,
  / GF\/V$/i,
  / GF$/i,
  / \(V\)$/i,
  / V$/i,
];

const NAME_ALIASES: Record<string, string> = {
  "milk and cookies": "Milk & Cookies",
  "sweet cream and cookies": "Sweet Cream & Cookies",
  "americone dream": "Stephen Colbert's AmeriCone Dream",
  "stephen colbert's americone dream": "Stephen Colbert's AmeriCone Dream",
  "strawberry swirl": "Non-Dairy Strawberry Swirl",
  "mochaccino chip": "Non-Dairy Mochaccino Chip",
  "key lime pie": "Non-Dairy Key Lime Pie",
  "lemonade": "Lemonade Sorbet",
  "the tonight dough starring jimmy fallon": "The Tonight Dough",
};

export function normaliseFlavorName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^\(\d+\)\s*/, ""); // strip "(674) " prefix
  for (const re of CATEGORY_SUFFIXES) s = s.replace(re, "");
  for (const re of TAG_SUFFIXES) s = s.replace(re, "");
  s = s.trim();
  const aliased = NAME_ALIASES[s.toLowerCase()];
  return aliased ?? s;
}

// Extras pricing per Alina's spec.
// `unit`: "flat" = one-time fee, "per_guest" = priced per guest_count.
// `defaultQty`:
//   - "one"        → qty defaults to 1 on add (Ice Cream Cart, Additional
//                    Flavor, Extra Toppings, Umbrella Rental, Tent Rental).
//   - "per_guest"  → qty defaults to the deal's guest_count on add
//                    (Waffle cones, Personalized Pints, Bottled Water,
//                    Brownies, Cookies).
export type Extra = {
  key: string;
  label: string;
  price: number;
  unit: "flat" | "per_guest";
  defaultQty: "one" | "per_guest";
};

// Labels MUST match the canonical keys in
// `Catering Automations/v2/modules/pricing_data.py::_EXTRAS_RAW`. The
// quote module looks up extras by exact label, so a mismatch silently
// drops the item from the priced breakdown (it lands in "unknown
// extras" and bills $0). Keep these in lockstep with pricing_data.py.
//
// price=0 entries don't have a canonical line item — the quote module
// will warn "unknown extra" and you bill manually. They're still in the
// dropdown so the deal record reflects what the customer requested.
export const EXTRAS: ReadonlyArray<Extra> = [
  { key: "ice_cream_cart", label: "Ice Cream Cart", price: 500, unit: "flat", defaultQty: "one" },
  { key: "waffle_cones", label: "Waffle cones/bowls", price: 2, unit: "per_guest", defaultQty: "per_guest" },
  { key: "additional_flavor", label: "Additional Flavor", price: 25, unit: "flat", defaultQty: "one" },
  { key: "extra_toppings", label: "Extra Toppings", price: 0, unit: "per_guest", defaultQty: "one" },
  { key: "personalized_pints", label: "Personalized Pints", price: 15.95, unit: "flat", defaultQty: "per_guest" },
  { key: "bottled_water", label: "Bottled Water", price: 0, unit: "per_guest", defaultQty: "per_guest" },
  { key: "brownies", label: "Brownies", price: 4, unit: "per_guest", defaultQty: "per_guest" },
  { key: "cookies", label: "Cookies", price: 2, unit: "per_guest", defaultQty: "per_guest" },
  { key: "umbrella", label: "Umbrella Rental", price: 75, unit: "flat", defaultQty: "one" },
  { key: "tent", label: "Tent Rental", price: 175, unit: "flat", defaultQty: "one" },
];

export const EXTRA_BY_LABEL: ReadonlyMap<string, Extra> = new Map(
  EXTRAS.map((e) => [e.label, e]),
);

export function defaultExtraQuantity(
  label: string,
  guestCount: number | null | undefined,
): number {
  const extra = EXTRA_BY_LABEL.get(label);
  if (!extra) return 1;
  if (extra.defaultQty === "per_guest") {
    const g = guestCount && guestCount > 0 ? guestCount : 1;
    return g;
  }
  return 1;
}

// Note (2026-06-04): the previous DUPLICABLE_EXTRAS allowlist was
// retired. The extras MultiSelect now uses `quantityMode` so every
// extra supports a quantity (default 1). Storage stays as a flat list
// of repeated names — the catering quote module already iterates and
// accumulates per occurrence.

export const EXTRA_LABELS: ReadonlyArray<string> = EXTRAS.map((e) => e.label);

const EXTRA_ALIASES: Record<string, string> = {
  "ice cream cart": "Ice Cream Cart",
  "icecream cart": "Ice Cream Cart",
  "ice cream cart upgrade": "Ice Cream Cart",
  "waffles": "Waffle cones/bowls",
  "waffle cone": "Waffle cones/bowls",
  "waffle cones": "Waffle cones/bowls",
  "waffle cones/bowls": "Waffle cones/bowls",
  "additional flavor": "Additional Flavor",
  "additional flavour": "Additional Flavor",
  "extra flavor": "Additional Flavor",
  "extra flavour": "Additional Flavor",
  "extra toppings": "Extra Toppings",
  "extra topping": "Extra Toppings",
  "dry toppings": "Extra Toppings",
  "personalized pints": "Personalized Pints",
  "personalised pints": "Personalized Pints",
  "bottled water": "Bottled Water",
  "umbrella": "Umbrella Rental",
  "umbrella rental": "Umbrella Rental",
  "ben & jerry's umbrella": "Umbrella Rental",
  "tent": "Tent Rental",
  "tent rental": "Tent Rental",
  "ben & jerry's tent": "Tent Rental",
  "brownies": "Brownies",
  "cookies": "Cookies",
  "chocolate chip cookies": "Cookies",
};

export function normaliseExtraLabel(raw: string): string {
  const s = raw.trim();
  const aliased = EXTRA_ALIASES[s.toLowerCase()];
  return aliased ?? s;
}

// Canonical package list, per Alina's spec.
// `description` is rendered as a small hint in the dropdown so the team
// remembers what each tier includes; the saved value is just `value`.
export type Package = {
  value: string;
  description: string;
};

// Canonical topping list, matches CANONICAL_TOPPINGS in
// `Catering Automations/v2/modules/pricing_data.py`. The catering
// automation uses these exact strings on quote / picklist templates.
export const TOPPING_NAMES: ReadonlyArray<string> = [
  "Rainbow Sprinkles",
  "Chocolate Sprinkles",
  "M&M's",
  "Reese's Pieces",
  "Oreo Crumbles",
  "Peanuts",
  "Walnuts",
  "Gummy Bears",
];

// Alias map: lowercased messy variants → canonical label. Covers the
// historical noise visible in the DB (apostrophe variants, "Oreos" vs
// "Oreo Crumbles", "Reeses" vs "Reese's Pieces", mini-* variants, etc.).
const TOPPING_ALIASES: Record<string, string> = {
  "rainbow sprinkles": "Rainbow Sprinkles",
  "rainbow sprinkles ": "Rainbow Sprinkles",
  "chocolate sprinkles": "Chocolate Sprinkles",
  "chocolate chips": "Chocolate Sprinkles",
  "m&ms": "M&M's",
  "m&m's": "M&M's",
  "m&m": "M&M's",
  "m&ms's": "M&M's",
  "mini m&ms": "M&M's",
  "mini m&m's": "M&M's",
  "mini m&m": "M&M's",
  "reese's pieces": "Reese's Pieces",
  "reeses pieces": "Reese's Pieces",
  "reeses": "Reese's Pieces",
  "reese's": "Reese's Pieces",
  "oreo crumbles": "Oreo Crumbles",
  "oreos": "Oreo Crumbles",
  "oreo": "Oreo Crumbles",
  "oreo's": "Oreo Crumbles",
  "crushed oreos": "Oreo Crumbles",
  "peanuts": "Peanuts",
  "walnuts": "Walnuts",
  "gummy bears": "Gummy Bears",
  "gummi bears": "Gummy Bears",
};

export function normaliseToppingName(raw: string): string {
  let s = raw.trim();
  // Strip trademark symbols + encoding-corrupted curly punctuation.
  s = s.replace(/[®™]/g, "");
  // "M&M?s" → "M&M's" (Mac copy/paste sometimes mangles smart quotes).
  s = s.replace(/M&M\?s/gi, "M&M's").replace(/Reese\?s/gi, "Reese's");
  s = s.trim();
  const key = s.toLowerCase().replace(/\s+/g, " ");
  return TOPPING_ALIASES[key] ?? s;
}

// Split a single list item that combined multiple toppings with "and"
// or "&" (e.g. "Gummy Bears and M&Ms" → ["Gummy Bears", "M&M's"]).
function splitCombinedToppings(s: string): string[] {
  // Don't split if "&" is INSIDE a topping name we know (e.g. "M&M's").
  // The pattern below only splits on " and " (word boundary) or " & "
  // surrounded by spaces.
  if (!/\sand\s|\s&\s/i.test(s)) return [s];
  return s
    .split(/\s+(?:and|&)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

export const PACKAGES: ReadonlyArray<Package> = [
  { value: "Cup or Cone Party", description: "" },
  { value: "Waffle Cone Party", description: "" },
  { value: "Sundae Party", description: "4 toppings" },
  { value: "Super Sundae Party", description: "6 toppings" },
  {
    value: "Deluxe Sundae Party",
    description: "cookies, brownies, 4 toppings",
  },
  {
    value: "Super Deluxe Sundae Party",
    description: "cookies, brownies, 6 toppings",
  },
];

export const PACKAGE_NAMES: ReadonlyArray<string> = PACKAGES.map((p) => p.value);

export function packageDescription(value: string | null | undefined): string {
  if (!value) return "";
  return PACKAGES.find((p) => p.value === value)?.description ?? "";
}

export const PAYMENT_STATUSES = [
  "None",
  "Deposit Paid",
  "Paid in Full",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// Generic list-field parser. Handles JSON arrays, CSV strings, the literal
// "None Selected", and stray "[]"/null. Returns a clean string[] suitable
// for a MultiSelect value.
function parseListField(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (/^none selected$/i.test(trimmed)) return [];
  // JSON path
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => (typeof x === "string" ? x : String(x)))
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } catch {
      // fall through to CSV
    }
  }
  // CSV path
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseFlavorsField(raw: string | null | undefined): string[] {
  return parseListField(raw).map(normaliseFlavorName);
}

export function parseExtrasField(raw: string | null | undefined): string[] {
  return parseListField(raw).map(normaliseExtraLabel);
}

export function parseToppingsField(raw: string | null | undefined): string[] {
  return parseListField(raw)
    .flatMap(splitCombinedToppings)
    .map(normaliseToppingName)
    .filter(Boolean);
}

// Canonical write form: JSON array of strings. Matches the format the
// catering automation has been writing since 2026-05-27. Empty selection
// serialises to "[]" (not "") so the quote module's required-field check
// — which uses `is None` — passes on an explicit empty list.
export function serializeMultiselect(values: string[]): string {
  return JSON.stringify(values);
}
