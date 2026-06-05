// Type definitions for the five pricing_* tables that back the Price
// Book tab. Mirrors the columns in Supabase.

export type PricingPackage = {
  name: string;
  price: number;
  flavors_included: number;
  includes_waffle_cones: boolean;
  includes_sauce: boolean;
  includes_whipped_cream: boolean;
  includes_cookies: boolean;
  includes_brownies: boolean;
  dry_toppings_count: number;
  service_style: string;
  sort_order: number;
  updated_at?: string;
};

export type PricingExtra = {
  name: string;
  price: number;
  per_serving_or_flat: string; // "per_serving" | "flat"
  taxable: boolean;
  duplicate_with: string[] | null;
  notes: string | null;
  sort_order: number;
  updated_at?: string;
};

export type PricingTaxRate = {
  code: string;
  rate: number;
  label: string;
  is_default: boolean;
  sort_order: number;
  updated_at?: string;
};

export type PricingScalar = {
  key: string;
  value: number;
  label: string;
  description: string | null;
  sort_order: number;
  updated_at?: string;
};

export type PricingLaborTier = {
  tier: string;
  commute_min: number;
  commute_max: number;
  hours_per_staff: number;
  hours_per_staff_high_headcount: number | null;
  high_headcount_threshold: number | null;
  post_event_buffer_hrs: number | null;
  components: string | null;
  sort_order: number;
  updated_at?: string;
};

// Which extra-row columns count as "advanced" (product definition)
// rather than "price". Hidden behind the Advanced toggle.
export const EXTRA_ADVANCED_FIELDS = [
  "per_serving_or_flat",
  "taxable",
  "duplicate_with",
] as const;

// Which package-row columns are "advanced".
export const PACKAGE_ADVANCED_FIELDS = [
  "flavors_included",
  "includes_waffle_cones",
  "includes_sauce",
  "includes_whipped_cream",
  "includes_cookies",
  "includes_brownies",
  "dry_toppings_count",
  "service_style",
] as const;
