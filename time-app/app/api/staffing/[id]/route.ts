import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { setLifecycleStatus } from "@/lib/staffing/execute";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// PATCH /api/staffing/:id   Body: { status: 'open' | 'cancelled' }
// Manager-only. Cancels a record (its steps stay as they were) or reopens
// a cancelled one. 'done' is never set by hand; it follows from the steps.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  const status = body.status === "cancelled" ? "cancelled" : body.status === "open" ? "open" : null;
  if (!status) return NextResponse.json({ error: "status must be open or cancelled" }, { status: 400 });
  const rec = await setLifecycleStatus(id, status);
  if (!rec) return NextResponse.json({ error: "No such record" }, { status: 404 });
  return NextResponse.json({ ok: true, record: rec });
}
