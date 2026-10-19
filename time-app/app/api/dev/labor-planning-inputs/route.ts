import { readFile, rename, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { applySeedAction, type Seed } from "@/lib/metrics/laborPlanningSeed";
import { previewEnabled, seedPath } from "@/lib/metrics/laborPlanningPreview";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// LOCAL PREVIEW ONLY (bj-finance #742). POST /api/dev/labor-planning-inputs
// Body: one InputAction (lib/controlBoard/planningInputs.ts).
//
// The planning inputs editor on /dev/labor-hours-planning saves here: the
// change is checked by the routes' own rules and written to the local inputs
// file (LABOR_PLANNING_SEED, outside every repo), which the preview's chart
// reads. Nothing touches the database. A 404 unless the dev server runs with
// LOCAL_PREVIEW=1 (`next dev` only: a production build is always a 404).
export async function POST(request: Request) {
  if (!previewEnabled()) return new NextResponse(null, { status: 404 });
  const path = seedPath();
  let seed: Seed = {};
  try {
    seed = JSON.parse(await readFile(path, "utf8")) as Seed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return NextResponse.json({ error: `The inputs file could not be read: ${(e as Error).message}` }, { status: 500 });
  }
  const action = await request.json().catch(() => null);
  const next = applySeedAction(seed, action, new Date().toISOString());
  if (!next.ok) return NextResponse.json({ error: next.error }, { status: 400 });
  // Written whole, then swapped in, so a failed write never leaves half a file.
  await writeFile(`${path}.tmp`, `${JSON.stringify(next.value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
  return NextResponse.json({ ok: true });
}
