// PATCH /api/profiles/:id (the Team page's saves), driven through the real
// route handler: On schedule and Archive/Unarchive, with and without
// migration 32's profiles.archived_at.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { ARCHIVE_NEEDS_MIGRATION } from "./teamArchive.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;
const route = await loadAppModule<{ PATCH: Handler }>("app/api/profiles/[id]/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const OWNER = "00000000-0000-0000-0000-00000000000c";

function patch(id: string, body: unknown): Promise<Response> {
  return route.PATCH(
    new Request(`http://time.test/api/profiles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: { id } },
  );
}
const row = (id: string) => db.rows("profiles").find((r) => r.id === id)!;

let db: FakeSupabase;

function start(withColumn: boolean) {
  const col = withColumn ? { archived_at: null } : {};
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager", ...col },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee", ...col },
      { id: OWNER, role: "manager", active: false, full_name: "Test Owner", ...col },
    ],
  });
  if (!withColumn) db.missingColumns = { profiles: ["archived_at"] };
  db.signIn(MANAGER);
}

// ---- after migration 32 -----------------------------------------------------

beforeEach(() => start(true));

test("Archive stamps archived_at with the server's time and takes them off the schedule", async () => {
  const before = Date.now();
  const res = await patch(SAM, { archived_at: true });
  assert.equal(res.status, 200);
  const stamped = Date.parse(row(SAM).archived_at as string);
  assert.ok(stamped >= before && stamped <= Date.now(), `archived_at ${row(SAM).archived_at}`);
  assert.equal(row(SAM).active, false);
});

test("Archive wins over an active: true sent alongside it", async () => {
  const res = await patch(SAM, { archived_at: true, active: true });
  assert.equal(res.status, 200);
  assert.equal(row(SAM).active, false);
});

test("Unarchive clears archived_at and leaves active false", async () => {
  await patch(SAM, { archived_at: true });
  const res = await patch(SAM, { archived_at: null });
  assert.equal(res.status, 200);
  assert.equal(row(SAM).archived_at, null);
  assert.equal(row(SAM).active, false);
});

test("On schedule sets active and nothing else", async () => {
  const res = await patch(OWNER, { active: true });
  assert.equal(res.status, 200);
  assert.equal(row(OWNER).active, true);
  assert.equal(row(OWNER).archived_at, null);
});

test("a stray archived_at value is refused and nothing is written", async () => {
  for (const bad of ["2020-01-01T00:00:00Z", false, 1]) {
    const res = await patch(SAM, { archived_at: bad, active: false });
    assert.equal(res.status, 400);
    assert.equal(row(SAM).archived_at, null);
    assert.equal(row(SAM).active, true);
  }
});

test("only a manager may archive", async () => {
  db.signIn(SAM);
  const res = await patch(SAM, { archived_at: true });
  assert.equal(res.status, 403);
  assert.equal(row(SAM).archived_at, null);
  assert.equal(row(SAM).active, true);
});

// ---- before migration 32 ----------------------------------------------------

test("before migration 32, Archive says so and does not fall back to active alone", async () => {
  start(false);
  const res = await patch(SAM, { archived_at: true });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, ARCHIVE_NEEDS_MIGRATION);
  assert.equal(row(SAM).active, true);
  assert.equal("archived_at" in row(SAM), false);
});

test("before migration 32, Unarchive says so", async () => {
  start(false);
  const res = await patch(OWNER, { archived_at: null });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, ARCHIVE_NEEDS_MIGRATION);
});

test("before migration 32, On schedule still saves", async () => {
  start(false);
  const off = await patch(SAM, { active: false });
  assert.equal(off.status, 200);
  assert.equal(row(SAM).active, false);
  const on = await patch(OWNER, { active: true });
  assert.equal(on.status, 200);
  assert.equal(row(OWNER).active, true);
});
