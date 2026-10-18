import { NextResponse } from "next/server";
import { loadPfApiForOwner, savePfOverride } from "@/lib/pf/access";
import { correctableCategories, parseOverrideInput } from "@/lib/pf/overrides";

export const dynamic = "force-dynamic";

// POST /api/pf/overrides  { scope, txn_id, merchant, category }
//
// Saves one category correction from /money (bj-finance #223). Only an owner
// (profiles.role, time-app migration 42) gets past lib/pf/access; everyone
// else gets the same 401/404 the pages give. The write goes through the
// service role because the table admits only that role (SELECT, INSERT; crm/011).
//
// The category must be one of the names the current feed publishes in
// meta.categories, byte for byte. Corrections are append-only: a later one
// for the same transaction or merchant wins.
export async function POST(request: Request) {
  const viewer = await loadPfApiForOwner();
  if (!viewer.ok)
    return NextResponse.json(
      { error: viewer.status === 401 ? "Not signed in" : "Not found" },
      { status: viewer.status },
    );

  const categories = viewer.feed.ok
    ? correctableCategories(viewer.feed.data.meta)
    : [];
  if (categories.length === 0)
    return NextResponse.json(
      { error: "The feed has no category list yet" },
      { status: 409 },
    );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const parsed = parseOverrideInput(body, categories);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const saved = await savePfOverride(parsed.input, viewer.userId);
  if (!saved.ok) {
    // The table not being there yet (503) is expected before crm/011; a real
    // save failure (500) must not pass unnoticed (CODING_STANDARDS.md
    // fail-loudly), so log the DB message the caller never sees.
    if (saved.reason === "failed")
      console.error("POST /api/pf/overrides: could not save correction", saved.message);
    return NextResponse.json(
      {
        error:
          saved.reason === "missing_table"
            ? "Corrections are not switched on yet. Nothing was saved."
            : "Could not save the correction",
      },
      { status: saved.reason === "missing_table" ? 503 : 500 },
    );
  }
  return NextResponse.json({ override: saved.override }, { status: 201 });
}
