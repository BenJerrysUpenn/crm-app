// PATCH /api/account (the /account page's own save), driven through the real
// route handler: the signed-in person edits only their own name and phone, and
// the name rule (validateFullName) is enforced on the server, not just in the
// browser (bj-finance #468).
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request) => Promise<Response>;
const route = await loadAppModule<{ PATCH: Handler }>("app/api/account/route.ts");

const SAM = "00000000-0000-0000-0000-00000000000b";
const PAT = "00000000-0000-0000-0000-00000000000d";

function patch(body: unknown): Promise<Response> {
  return route.PATCH(
    new Request("http://time.test/api/account", { method: "PATCH", body: JSON.stringify(body) }),
  );
}
const row = (id: string) => db.rows("profiles").find((r) => r.id === id)!;

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee", phone: null },
      { id: PAT, role: "employee", active: true, full_name: "Pat Diaz", phone: "555-0001" },
    ],
  });
  db.signIn(SAM);
});

test("the signed-in person renames themselves, trimmed", async () => {
  const res = await patch({ full_name: "  Samantha Lee  ", phone: null });
  assert.equal(res.status, 200);
  assert.equal(row(SAM).full_name, "Samantha Lee");
});

test("a self-edit can't store an email as the name, and nothing is written", async () => {
  const res = await patch({ full_name: "sam@example.com", phone: "555-0100" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Enter the person's name, not their email address.");
  assert.equal(row(SAM).full_name, "Sam Lee");
  assert.equal(row(SAM).phone, null);
});

test("a self-edit can't clear the name, and nothing is written", async () => {
  for (const blank of ["", "   ", null]) {
    const res = await patch({ full_name: blank });
    assert.equal(res.status, 400, `full_name ${JSON.stringify(blank)}`);
    assert.equal((await res.json()).error, "Full name is required.");
    assert.equal(row(SAM).full_name, "Sam Lee");
  }
});

test("phone is saved trimmed, and a blank becomes null", async () => {
  await patch({ full_name: "Sam Lee", phone: "  555-0123  " });
  assert.equal(row(SAM).phone, "555-0123");
  await patch({ full_name: "Sam Lee", phone: "   " });
  assert.equal(row(SAM).phone, null);
});

test("a body id is ignored; only the caller's own row is written", async () => {
  const res = await patch({ id: PAT, full_name: "Renamed" });
  assert.equal(res.status, 200);
  assert.equal(row(SAM).full_name, "Renamed");
  assert.equal(row(PAT).full_name, "Pat Diaz");
});

test("a signed-out caller is refused and nothing is written", async () => {
  db = startFakeSupabase({
    profiles: [{ id: SAM, role: "employee", active: true, full_name: "Sam Lee", phone: null }],
  });
  // no signIn
  const res = await patch({ full_name: "Whoever" });
  assert.equal(res.status, 401);
  assert.equal(row(SAM).full_name, "Sam Lee");
});
