// The owner role through the routes a phone calls (migration 31).
//
//   * An owner, kept off the roster (active = false), passes the manager
//     gates: the Timesheets routes and the clock's geofence exemption.
//   * A manager cannot give, take away or touch the owner role through the
//     Team page's routes, and is refused before anything is written or any
//     sign-in email is sent. An owner can.
//
// These drive the real route handlers against the stand-in Supabase project
// (testing/fakeSupabase.ts). Supabase Auth's admin API (looking a login up,
// sending an invite) is the other boundary the profile routes cross; it is
// stood in for below and records every invite it is asked to send. The
// database's own guard is supabase/migration_31_verify.sql.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, SUPABASE_URL, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const timesheet = await loadAppModule<{ POST: Handler }>("app/api/time-entries/route.ts");
const timesheetEntry = await loadAppModule<{ PATCH: Handler }>("app/api/time-entries/[id]/route.ts");
const clock = await loadAppModule<{ POST: Handler }>("app/api/clock/route.ts");
const profile = await loadAppModule<{ PATCH: Handler }>("app/api/profiles/[id]/route.ts");
const invite = await loadAppModule<{ POST: Handler }>("app/api/profiles/route.ts");
const reinvite = await loadAppModule<{ POST: Handler }>("app/api/profiles/[id]/invite/route.ts");

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const OTHER_OWNER = "00000000-0000-0000-0000-0000000000a2";
const MANAGER = "00000000-0000-0000-0000-0000000000b1";
const EMPLOYEE = "00000000-0000-0000-0000-0000000000c1";
const NEWCOMER = "00000000-0000-0000-0000-0000000000d1";

const LOGINS: Record<string, string> = {
  [OWNER]: "owner-one@example.test",
  [OTHER_OWNER]: "owner-two@example.test",
  [MANAGER]: "manager@example.test",
  [EMPLOYEE]: "employee@example.test",
};

// The shop, and a spot about 1.1 km north of it.
const SHOP = { lat: 39.9522, lng: -75.1932 };
const FAR = { lat: 39.9622, lng: -75.1932 };

let db: FakeSupabase;
let invitesSent: string[];

// Supabase Auth's admin endpoints, in front of the fake project. Everything
// else goes on to the fake.
function standInForAuthAdmin() {
  const project = globalThis.fetch;
  const user = (id: string, email: string) => ({ id, email, aud: "authenticated", role: "authenticated" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === new URL(SUPABASE_URL).origin && url.pathname.startsWith("/auth/v1/")) {
      const path = url.pathname.slice("/auth/v1".length);
      if (request.method === "GET" && path === "/admin/users") {
        const users = Object.entries(LOGINS).map(([id, email]) => user(id, email));
        return Response.json({ users, aud: "authenticated" });
      }
      const one = path.match(/^\/admin\/users\/([\w-]+)$/);
      if (request.method === "GET" && one) {
        const email = LOGINS[one[1]];
        return email ? Response.json(user(one[1], email)) : Response.json({ msg: "User not found" }, { status: 404 });
      }
      if (request.method === "POST" && path === "/invite") {
        const { email } = (await request.json()) as { email: string };
        invitesSent.push(email);
        const id = Object.entries(LOGINS).find(([, e]) => e === email)?.[0] ?? NEWCOMER;
        return Response.json(user(id, email));
      }
    }
    return project(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "owner", active: false, full_name: "Owner One", phone: "555-0101" },
      { id: OTHER_OWNER, role: "owner", active: false, full_name: "Owner Two", phone: "555-0102" },
      { id: MANAGER, role: "manager", active: true, full_name: "Store Manager", phone: "555-0103" },
      { id: EMPLOYEE, role: "employee", active: true, full_name: "Scooper", phone: "555-0104" },
    ],
    locations: [
      { id: 1, name: "the shop", latitude: SHOP.lat, longitude: SHOP.lng, radius_meters: 150, is_default: true },
    ],
    clockin_reminders: [],
    clockin_reminder_acks: [],
    shifts: [],
    time_entries: [],
    app_settings: [],
  });
  invitesSent = [];
  standInForAuthAdmin();
});

function send(method: string, body?: unknown): Request {
  return new Request("http://time.test/api", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const noParams = { params: { id: "" } };

function roleOf(id: string) {
  return db.rows("profiles").find((p) => p.id === id)?.role;
}

// ---- an owner passes the manager gates --------------------------------------

test("an owner off the roster adds a manual punch through the Timesheets route", async () => {
  db.signIn(OWNER);

  const res = await timesheet.POST(
    send("POST", { employee_id: EMPLOYEE, clock_in_at: "2026-09-27T08:00:00Z", clock_out_at: "2026-09-27T12:00:00Z" }),
    noParams,
  );

  assert.equal(res.status, 200);
  const [punch] = db.rows("time_entries");
  assert.equal(punch.employee_id, EMPLOYEE);
  assert.equal(punch.clock_in_at, "2026-09-27T08:00:00Z");
});

test("an owner off the roster corrects a punch through the Timesheets route", async () => {
  db.tables.time_entries.push({
    id: 7,
    employee_id: EMPLOYEE,
    clock_in_at: "2026-09-28T13:00:00.000Z",
    clock_out_at: "2026-09-28T17:00:00.000Z",
    status: "closed",
  });
  db.signIn(OWNER);

  const res = await timesheetEntry.PATCH(send("PATCH", { clock_in_at: "2026-09-28T12:30:00.000Z" }), {
    params: { id: "7" },
  });

  assert.equal(res.status, 200);
  assert.equal(db.rows("time_entries")[0].clock_in_at, "2026-09-28T12:30:00.000Z");
});

test("an owner clocks in away from the shop, as a manager may", async () => {
  db.signIn(OWNER);

  const res = await clock.POST(send("POST", { action: "in", ...FAR, accuracy: 8 }), noParams);

  assert.equal(res.status, 200);
  assert.equal(db.rows("time_entries").length, 1);
});

// ---- PATCH /api/profiles/:id ------------------------------------------------

test("a manager cannot make an employee an owner", async () => {
  db.signIn(MANAGER);

  const res = await profile.PATCH(send("PATCH", { role: "owner" }), { params: { id: EMPLOYEE } });

  assert.equal(res.status, 403);
  assert.equal(roleOf(EMPLOYEE), "employee");
});

test("a manager cannot make themself an owner", async () => {
  db.signIn(MANAGER);

  const res = await profile.PATCH(send("PATCH", { role: "owner" }), { params: { id: MANAGER } });

  assert.equal(res.status, 403);
  assert.equal(roleOf(MANAGER), "manager");
});

test("a manager cannot demote an owner", async () => {
  db.signIn(MANAGER);

  const res = await profile.PATCH(send("PATCH", { role: "manager" }), { params: { id: OWNER } });

  assert.equal(res.status, 403);
  assert.equal(roleOf(OWNER), "owner");
});

test("a manager cannot edit an owner's phone", async () => {
  db.signIn(MANAGER);

  const res = await profile.PATCH(send("PATCH", { phone: "555-0199" }), { params: { id: OWNER } });

  assert.equal(res.status, 403);
  assert.equal(db.rows("profiles").find((p) => p.id === OWNER)?.phone, "555-0101");
});

test("a manager can still make an employee a manager", async () => {
  db.signIn(MANAGER);

  const res = await profile.PATCH(send("PATCH", { role: "manager" }), { params: { id: EMPLOYEE } });

  assert.equal(res.status, 200);
  assert.equal(roleOf(EMPLOYEE), "manager");
});

test("an owner can make a manager an owner", async () => {
  db.signIn(OWNER);

  const res = await profile.PATCH(send("PATCH", { role: "owner" }), { params: { id: MANAGER } });

  assert.equal(res.status, 200);
  assert.equal(roleOf(MANAGER), "owner");
});

// ---- POST /api/profiles (invite) --------------------------------------------

test("a manager cannot invite someone as an owner, and no invite is sent", async () => {
  db.signIn(MANAGER);

  const res = await invite.POST(
    send("POST", { email: "new-person@example.test", full_name: "New Person", role: "owner" }),
    noParams,
  );

  assert.equal(res.status, 403);
  assert.deepEqual(invitesSent, []);
});

test("a manager re-inviting an owner's email is refused, and the owner stays an owner", async () => {
  db.signIn(MANAGER);

  const res = await invite.POST(
    send("POST", { email: "Owner-One@example.test", full_name: "Owner One", role: "employee" }),
    noParams,
  );

  assert.equal(res.status, 403);
  assert.deepEqual(invitesSent, []);
  assert.equal(roleOf(OWNER), "owner");
});

test("an owner can invite someone as an owner", async () => {
  db.signIn(OWNER);

  const res = await invite.POST(
    send("POST", { email: "new-owner@example.test", full_name: "New Owner", role: "owner" }),
    noParams,
  );

  assert.equal(res.status, 200);
  assert.deepEqual(invitesSent, ["new-owner@example.test"]);
});

// ---- POST /api/profiles/:id/invite (re-send a sign-in link) -----------------

test("a manager cannot re-send an owner's sign-in link", async () => {
  db.signIn(MANAGER);

  const res = await reinvite.POST(send("POST"), { params: { id: OWNER } });

  assert.equal(res.status, 403);
  assert.deepEqual(invitesSent, []);
});

test("an owner can re-send the other owner's sign-in link", async () => {
  db.signIn(OWNER);

  const res = await reinvite.POST(send("POST"), { params: { id: OTHER_OWNER } });

  assert.equal(res.status, 200);
  assert.deepEqual(invitesSent, ["owner-two@example.test"]);
});
