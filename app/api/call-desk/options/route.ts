import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { FLAVORS, TOPPING_NAMES } from "@/lib/menuOptions";
import {
  OPTIONS_MIGRATION_MISSING,
  type DealFormExtraOption,
  type DealFormOption,
  type DealFormOptionsResponse,
  type DealFormPackageOption,
} from "@/lib/callDesk/options";

export const dynamic = "force-dynamic";

// Scalars the guided form needs out of pricing_scalars.
const MINIMUM_KEY = "MINIMUM_ICE_CREAM";
const MAX_FLAVORS_KEY = "MAX_FLAVORS";
const FLAVORS_INCLUDED_KEY = "PACKAGE_FLAVORS_INCLUDED";

// PostgREST/Postgres "relation does not exist".
const UNDEFINED_TABLE = "42P01";

type OptionRow = {
  field: string;
  value: string;
  label: string;
  hint: string | null;
  sort_order: number;
};

function toOption(row: OptionRow): DealFormOption {
  return { value: row.value, label: row.label, hint: row.hint };
}

// GET /api/call-desk/options
//
// Every enumeration the "Generate deal" form renders, in one round trip:
//   event types + customer profiles  → deal_form_options (crm/001)
//   packages + extras + scalars      → the pricing_* tables (also the Price
//                                      Book's and the Python quote engine's
//                                      single source of truth)
//   flavors + toppings               → lib/menuOptions.ts
//
// Runs as the signed-in user; RLS is the guard.
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const [optionsRes, packagesRes, extrasRes, scalarsRes] = await Promise.all([
    supabase
      .from("deal_form_options")
      .select("field, value, label, hint, sort_order")
      .eq("active", true)
      .order("field")
      .order("sort_order"),
    supabase
      .from("pricing_packages")
      .select(
        "name, price, flavors_included, includes_waffle_cones, includes_sauce, includes_whipped_cream, includes_cookies, includes_brownies, dry_toppings_count, sort_order",
      )
      .order("sort_order"),
    supabase
      .from("pricing_extras")
      .select("name, price, per_serving_or_flat, taxable, notes, sort_order")
      .order("sort_order"),
    supabase.from("pricing_scalars").select("key, value"),
  ]);

  if (optionsRes.error) {
    // The migration is applied by a human; until then say so plainly instead
    // of failing with a raw PostgREST message.
    if (
      optionsRes.error.code === UNDEFINED_TABLE ||
      /deal_form_options/.test(optionsRes.error.message)
    ) {
      return NextResponse.json(
        { error: OPTIONS_MIGRATION_MISSING },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: optionsRes.error.message },
      { status: 500 },
    );
  }
  for (const res of [packagesRes, extrasRes, scalarsRes]) {
    if (res.error)
      return NextResponse.json({ error: res.error.message }, { status: 500 });
  }

  const optionRows = (optionsRes.data ?? []) as OptionRow[];
  const scalars = new Map(
    ((scalarsRes.data ?? []) as { key: string; value: number }[]).map((s) => [
      s.key,
      Number(s.value),
    ]),
  );

  const packages = ((packagesRes.data ?? []) as DealFormPackageOption[]).map(
    (p) => ({ ...p, price: Number(p.price) }),
  );

  // pricing_extras carries alias rows ("Chocolate Chip Cookies" → Cookies,
  // "Dry Toppings" → Extra Toppings) that exist so the quote engine can match
  // messy inbound text. Showing them as separate chips would let the caller
  // write a non-canonical extras value, so they are filtered out here; the
  // `notes` column marks them.
  const extras = ((extrasRes.data ?? []) as DealFormExtraOption[])
    .filter((e) => !/^alias for/i.test(e.notes ?? ""))
    .map((e) => ({ ...e, price: Number(e.price) }));

  const body: DealFormOptionsResponse = {
    event_types: optionRows
      .filter((r) => r.field === "event_type")
      .map(toOption),
    customer_profiles: optionRows
      .filter((r) => r.field === "customer_profile")
      .map(toOption),
    packages,
    extras,
    flavors: FLAVORS.map((f) => ({
      name: f.name,
      category: f.category,
      gf: Boolean(f.gf),
      vegan: Boolean(f.vegan),
      allergens: f.allergens ?? [],
    })),
    toppings: [...TOPPING_NAMES],
    minimum_order: scalars.get(MINIMUM_KEY) ?? 0,
    max_flavors: scalars.get(MAX_FLAVORS_KEY) ?? 0,
    flavors_included: scalars.get(FLAVORS_INCLUDED_KEY) ?? 0,
  };

  return NextResponse.json(body);
}
