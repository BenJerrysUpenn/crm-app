import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { siteOrigin } from "@/lib/authLinks";
import { runAutoSteps } from "@/lib/staffing/execute";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/staffing/:id/run
// Manager-only. Runs (or retries) the pending automatic steps in order.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const id = Number(params.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const rec = await runAutoSteps(id, { me, origin: siteOrigin(request) });
  if (!rec) return NextResponse.json({ error: "No such record" }, { status: 404 });
  return NextResponse.json({ ok: true, record: rec });
}
