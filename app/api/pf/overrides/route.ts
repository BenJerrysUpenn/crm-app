import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pfApiViewer } from "@/lib/pf/guard";
import { parseOverrideInput, saveOverride } from "@/lib/pf/overrides";

export const dynamic = "force-dynamic";

// POST /api/pf/overrides  { scope, txn_id, merchant, category }
//
// Saves one category correction from /money (bj-finance #223). Only the
// household accounts in PF_ALLOWED_USER_IDS get past lib/pf/guard; everyone
// else gets the same 401/404 the pages give. The write goes through the
// service role because the table admits only that role (SELECT, INSERT; crm/011).
//
// The category must be one of the names the current feed publishes in
// meta.categories, byte for byte. Corrections are append-only: a later one
// for the same transaction or merchant wins.
export async function POST(request: Request) {
  const viewer = await pfApiViewer();
  if (!viewer.ok)
    return NextResponse.json(
      { error: viewer.status === 401 ? "Not signed in" : "Not found" },
      { status: viewer.status },
    );

  const categories = viewer.feed.ok ? viewer.feed.data.meta.categories ?? [] : [];
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

  const saved = await saveOverride(
    createAdminClient(),
    parsed.input,
    viewer.userId,
  );
  if (!saved.ok)
    return NextResponse.json(
      {
        error:
          saved.reason === "missing_table"
            ? "Corrections are not switched on yet. Nothing was saved."
            : "Could not save the correction",
      },
      { status: saved.reason === "missing_table" ? 503 : 500 },
    );
  return NextResponse.json({ override: saved.override }, { status: 201 });
}
