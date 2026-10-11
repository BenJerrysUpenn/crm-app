import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isMissingTable } from "@/lib/storeHours";
import { cleanName, cleanWidgets } from "@/lib/metrics/views";
import { NOT_ENABLED, VIEW_COLUMNS, rowToView } from "@/lib/metrics/viewsServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const UNIQUE_VIOLATION = "23505";

type Body = { name?: unknown; widgets?: unknown; position?: unknown; archived?: unknown };

// PATCH /api/metrics/views/:id   Body: any of { name, widgets, position, archived: true }
//
// Renames, re-lays-out, reorders or archives one of the signed-in manager's
// own views (bj-finance #671). "Delete view" on the page archives: the row
// stays, out of sight, as the house rule has it for anything a person made.
// Another manager's view, or an archived one, is a 404 (RLS hides it).
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed") return NextResponse.json({ error: "Managers only" }, { status: 403 });
  if (!/^\d{1,18}$/.test(params.id)) return NextResponse.json({ error: "No such view." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
    patch.name = name.name;
  }
  if (body.widgets !== undefined) {
    if (!Array.isArray(body.widgets)) return NextResponse.json({ error: "widgets must be a list." }, { status: 400 });
    patch.widgets = cleanWidgets(body.widgets);
  }
  if (body.position !== undefined) {
    if (typeof body.position !== "number" || !Number.isInteger(body.position) || body.position < 0 || body.position > 1000)
      return NextResponse.json({ error: "position must be a whole number from 0 to 1000." }, { status: 400 });
    patch.position = body.position;
  }
  if (body.archived !== undefined) {
    if (body.archived !== true) return NextResponse.json({ error: "A view can be archived, not restored, here." }, { status: 400 });
    patch.archived_at = new Date().toISOString();
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const { data, error } = await createClient()
    .from("metric_views")
    .update(patch)
    .eq("id", params.id)
    .eq("owner_id", me.id)
    .is("archived_at", null)
    .select(VIEW_COLUMNS);
  if (error) {
    if (isMissingTable(error)) return NextResponse.json(NOT_ENABLED, { status: 503 });
    if (error.code === UNIQUE_VIOLATION)
      return NextResponse.json({ error: `You already have a view called "${String(patch.name)}".` }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const row = (data ?? [])[0];
  if (!row) return NextResponse.json({ error: "No such view." }, { status: 404 });
  return NextResponse.json({ view: rowToView(row) });
}
