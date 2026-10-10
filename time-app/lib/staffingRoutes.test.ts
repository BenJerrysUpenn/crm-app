// The Team page's staffing records, driven through the real route handlers
// (app/api/staffing/**, app/api/profiles) against a stand-in Supabase: what
// adding, offboarding and ticking off a step does to the person's login,
// profile and fob. docs/staffing.md is the spec; its hard rule is that no
// path deletes a person, so their payroll hours survive.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Ctx<P> = { params: P };
type Handler<P = Record<string, never>> = (request: Request, ctx: Ctx<P>) => Promise<Response>;

const create = await loadAppModule<{ POST: Handler }>("app/api/staffing/route.ts");
const run = await loadAppModule<{ POST: Handler<{ id: string }> }>("app/api/staffing/[id]/run/route.ts");
const record = await loadAppModule<{ PATCH: Handler<{ id: string }> }>("app/api/staffing/[id]/route.ts");
const steps = await loadAppModule<{ PATCH: Handler<{ id: string; key: string }> }>(
  "app/api/staffing/[id]/steps/[key]/route.ts",
);
const profiles = await loadAppModule<{ POST: Handler }>("app/api/profiles/route.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b"; // a shift lead with manager access
const KIT = "00000000-0000-0000-0000-00000000000c";

type Step = { key: string; mode: string; status: string; result: string | null };
type Rec = { id: number; status: string; employee_id: string | null; steps: Step[] };

let db: FakeSupabase;
let revoked: string[];

beforeEach(() => {
  delete process.env.RESEND_API_KEY; // invites go out through Supabase's own mail
  delete process.env.NEXT_PUBLIC_SITE_URL;
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager" },
      { id: SAM, role: "manager", active: true, full_name: "Sam Lee", last_day: null },
      { id: KIT, role: "employee", active: true, full_name: "Kit Doe" },
    ],
    time_entries: [{ id: 1, employee_id: SAM, clock_in_at: "2026-09-01T14:00:00Z", clock_out_at: "2026-09-01T20:00:00Z" }],
    staff_cards: [{ id: 1, card_id: "CARD-1", employee_id: SAM }],
    staff_lifecycle: [],
    staff_lifecycle_steps: [],
  });
  db.authUsers = [
    { id: MANAGER, email: "manager@example.test" },
    { id: SAM, email: "sam@example.test" },
    { id: KIT, email: "kit@example.test" },
  ];
  revoked = [];
  db.rpc = {
    revoke_user_sessions: (args) => {
      revoked.push(String(args.uid));
      return 2;
    },
  };
  db.signIn(MANAGER);
});

const post = (handler: Handler, url: string, body: unknown) =>
  handler(new Request(`http://time.test${url}`, { method: "POST", body: JSON.stringify(body) }), { params: {} });

async function submit(body: Record<string, unknown>): Promise<{ status: number; json: { record?: Rec; ran?: boolean; error?: string } }> {
  const res = await post(create.POST, "/api/staffing", body);
  return { status: res.status, json: await res.json() };
}
async function runRecord(id: number) {
  const res = await run.POST(new Request(`http://time.test/api/staffing/${id}/run`, { method: "POST" }), {
    params: { id: String(id) },
  });
  return { status: res.status, json: (await res.json()) as { record?: Rec; error?: string } };
}
async function tick(id: number, key: string, body: Record<string, unknown> = {}) {
  const res = await steps.PATCH(
    new Request(`http://time.test/api/staffing/${id}/steps/${key}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: { id: String(id), key } },
  );
  return { status: res.status, json: (await res.json()) as { record?: Rec; error?: string } };
}

const profile = (id: string) => db.rows("profiles").find((r) => r.id === id)!;
const authUser = (id: string) => db.authUsers.find((u) => u.id === id)!;
const step = (rec: Rec, key: string) => rec.steps.find((s) => s.key === key)!;
const offboardSam = (extra: Record<string, unknown> = {}) =>
  submit({ kind: "offboarding", employee_id: SAM, last_day: "2026-09-15", reason: "Quit", ...extra });

// ---- offboarding -------------------------------------------------------------

test("offboarding on or after the last day bans the login, signs them out, drops manager access, marks them inactive and frees the fob", async () => {
  const { status, json } = await offboardSam({ systems: ["fob", "slack"] });
  assert.equal(status, 200);
  assert.equal(json.ran, true);
  assert.equal(authUser(SAM).ban_duration, "876000h");
  assert.deepEqual(revoked, [SAM]);
  assert.equal(profile(SAM).role, "employee");
  assert.equal(profile(SAM).active, false);
  assert.equal(profile(SAM).last_day, "2026-09-15");
  assert.deepEqual(db.rows("staff_cards"), []);
  const rec = json.record!;
  assert.equal(step(rec, "fob_unassign").result, "Unassigned fob CARD-1");
  assert.equal(step(rec, "slack_deactivate").status, "pending"); // left for the worker
  assert.equal(rec.status, "open");
});

test("offboarding deletes nobody: the profile, the auth user and their hours all remain", async () => {
  await offboardSam();
  assert.ok(db.rows("profiles").some((r) => r.id === SAM));
  assert.ok(db.authUsers.some((u) => u.id === SAM));
  assert.equal(db.rows("time_entries").filter((r) => r.employee_id === SAM).length, 1);
});

test("a last day still ahead queues the record and changes nothing until Run", async () => {
  const { json } = await offboardSam({ last_day: "2999-12-31" });
  assert.equal(json.ran, false);
  assert.equal(authUser(SAM).ban_duration, undefined);
  assert.equal(profile(SAM).active, true);
  assert.ok(json.record!.steps.every((s) => s.status === "pending"));

  const ran = await runRecord(json.record!.id);
  assert.equal(ran.status, 200);
  assert.equal(authUser(SAM).ban_duration, "876000h");
  assert.equal(profile(SAM).active, false);
});

test("Remove access now runs before a future last day", async () => {
  const { json } = await offboardSam({ last_day: "2999-12-31", run_now: true });
  assert.equal(json.ran, true);
  assert.equal(authUser(SAM).ban_duration, "876000h");
  assert.equal(profile(SAM).active, false);
});

// "Is the last day past?" is asked of the shop's calendar (America/New_York),
// not of UTC: at 23:00 on 15 September in Philadelphia it is already the 16th in UTC.
async function offboardSamAt(now: string, last_day: string) {
  mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  try {
    return await offboardSam({ last_day });
  } finally {
    mock.timers.reset();
  }
}

test("offboarding whose last day is today in Philadelphia removes access straight away", async () => {
  const { json } = await offboardSamAt("2026-09-15T15:00:00Z", "2026-09-15");
  assert.equal(json.ran, true);
  assert.equal(authUser(SAM).ban_duration, "876000h");
  assert.equal(profile(SAM).active, false);
});

test("a last day that is tomorrow in Philadelphia waits, even once it is tomorrow in UTC", async () => {
  const { json } = await offboardSamAt("2026-09-16T03:00:00Z", "2026-09-16");
  assert.equal(json.ran, false);
  assert.equal(authUser(SAM).ban_duration, undefined);
  assert.equal(profile(SAM).active, true);
});

test("offboarding someone with no fob says so and still completes the access removal", async () => {
  const { json } = await submit({ kind: "offboarding", employee_id: KIT, last_day: "2026-09-15", reason: "Quit", systems: ["fob"] });
  const rec = json.record!;
  assert.equal(step(rec, "fob_unassign").status, "done");
  assert.equal(step(rec, "fob_unassign").result, "No fob was assigned");
  assert.equal(profile(KIT).active, false);
  assert.deepEqual(
    db.rows("staff_cards").map((c) => [c.card_id, c.employee_id]),
    [["CARD-1", SAM]],
  );
});

test("the access-removal chain stops at the first failure, and Run retries from there", async () => {
  db.rpc = {}; // migration 23's revoke_user_sessions not applied yet
  const { json } = await offboardSam();
  const rec = json.record!;
  assert.equal(step(rec, "auth_ban").status, "done");
  assert.equal(step(rec, "sessions_revoke").status, "failed");
  assert.match(step(rec, "sessions_revoke").result ?? "", /^revoke_user_sessions: /);
  assert.equal(step(rec, "role_employee").status, "pending");
  assert.equal(step(rec, "mark_inactive").status, "pending");
  assert.equal(profile(SAM).role, "manager");
  assert.equal(profile(SAM).active, true);

  db.rpc = { revoke_user_sessions: (args) => (revoked.push(String(args.uid)), 1) };
  const retried = (await runRecord(rec.id)).json.record!;
  assert.equal(step(retried, "sessions_revoke").status, "done");
  assert.equal(step(retried, "sessions_revoke").result, "1 session(s) removed");
  assert.equal(profile(SAM).active, false);
});

test("a login ban the auth service refuses stops the chain: nothing else changes until Run", async () => {
  // A profile whose auth account the service cannot find: the ban fails.
  const GONE = "00000000-0000-0000-0000-00000000000d";
  db.rows("profiles").push({ id: GONE, role: "manager", active: true, full_name: "Lee Gone" });
  const { json } = await submit({ kind: "offboarding", employee_id: GONE, last_day: "2026-09-15", reason: "Quit" });
  const rec = json.record!;
  assert.equal(step(rec, "auth_ban").status, "failed");
  assert.match(step(rec, "auth_ban").result ?? "", /not found/i);
  assert.equal(step(rec, "sessions_revoke").status, "pending");
  assert.equal(step(rec, "mark_inactive").status, "pending");
  assert.deepEqual(revoked, []);
  assert.equal(profile(GONE).role, "manager");
  assert.equal(profile(GONE).active, true);

  db.authUsers.push({ id: GONE, email: "lee@example.test" });
  const retried = (await runRecord(rec.id)).json.record!;
  assert.equal(step(retried, "auth_ban").status, "done");
  assert.equal(authUser(GONE).ban_duration, "876000h");
  assert.equal(profile(GONE).active, false);
});

test("a manager cannot offboard themself", async () => {
  const { status, json } = await submit({ kind: "offboarding", employee_id: MANAGER, last_day: "2026-09-15", reason: "Quit" });
  assert.equal(status, 400);
  assert.equal(json.error, "You cannot offboard yourself");
  assert.deepEqual(db.rows("staff_lifecycle"), []);
  assert.equal(authUser(MANAGER).ban_duration, undefined);
});

test("offboarding someone with no profile is refused before anything is written", async () => {
  const { status, json } = await submit({
    kind: "offboarding",
    employee_id: "00000000-0000-0000-0000-0000000000ff",
    last_day: "2026-09-15",
    reason: "Quit",
  });
  assert.equal(status, 400);
  assert.equal(json.error, "No such team member.");
  assert.deepEqual(db.rows("staff_lifecycle"), []);
});

test("only a manager may submit a staffing form or run one", async () => {
  const { json } = await offboardSam({ last_day: "2999-12-31" });
  db.signIn(KIT);
  assert.equal((await submit({ kind: "offboarding", employee_id: SAM, last_day: "2026-09-15", reason: "Quit" })).status, 403);
  assert.equal((await runRecord(json.record!.id)).status, 403);
  assert.equal((await tick(json.record!.id, "final_pay")).status, 403);
  assert.equal(profile(SAM).active, true);
});

test("an unknown form kind is refused", async () => {
  const { status, json } = await submit({ kind: "promote" });
  assert.equal(status, 400);
  assert.equal(json.error, "Unknown form kind");
});

test("a cancelled record does not run", async () => {
  const { json } = await offboardSam({ last_day: "2999-12-31" });
  const id = json.record!.id;
  const res = await record.PATCH(
    new Request(`http://time.test/api/staffing/${id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }),
    { params: { id: String(id) } },
  );
  assert.equal(((await res.json()) as { record: Rec }).record.status, "cancelled");
  await runRecord(id);
  assert.equal(authUser(SAM).ban_duration, undefined);
  assert.equal(profile(SAM).active, true);
});

const setStatus = async (id: number, status: unknown) => {
  const res = await record.PATCH(
    new Request(`http://time.test/api/staffing/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    { params: { id: String(id) } },
  );
  return { status: res.status, json: (await res.json()) as { record?: Rec; error?: string } };
};

test("a cancelled record reopened runs again; 'done' cannot be set by hand", async () => {
  const { json } = await offboardSam({ last_day: "2999-12-31" });
  const id = json.record!.id;
  await setStatus(id, "cancelled");

  const done = await setStatus(id, "done");
  assert.equal(done.status, 400);
  assert.equal(done.json.error, "status must be open or cancelled");

  assert.equal((await setStatus(id, "open")).json.record!.status, "open");
  await runRecord(id);
  assert.equal(authUser(SAM).ban_duration, "876000h");
  assert.equal(profile(SAM).active, false);
});

test("reopening a step on a cancelled record leaves the record cancelled", async () => {
  const { json } = await offboardSam({ last_day: "2999-12-31" });
  const id = json.record!.id;
  await setStatus(id, "cancelled");
  const reopened = await tick(id, "final_pay", { reopen: true });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.record!.status, "cancelled");
  await runRecord(id);
  assert.equal(profile(SAM).active, true);
});

// ---- adding an employee ----------------------------------------------------------

test("Add employee creates the login, writes the profile from the form and assigns the typed fob", async () => {
  const { status, json } = await submit({
    kind: "onboarding",
    legal_name: "Robin Test",
    preferred_name: "Rob",
    email: "Robin@Example.test",
    phone: "555-0100",
    pay_rate: 16,
    start_date: "2026-10-01",
    fob_card_id: "CARD-9",
    systems: ["fob", "slack"],
  });
  assert.equal(status, 200);
  const user = db.authUsers.find((u) => u.email === "robin@example.test");
  assert.ok(user, "auth user created");
  const rec = json.record!;
  assert.equal(rec.employee_id, user.id);
  assert.deepEqual(
    rec.steps.map((s) => [s.key, s.status]),
    [
      ["withers_time_invite", "done"],
      ["fob_assign", "done"],
      ["slack_invite", "pending"],
    ],
  );
  const p = profile(user.id as string);
  assert.equal(p.full_name, "Robin Test");
  assert.equal(p.preferred_name, "Rob");
  assert.equal(p.start_date, "2026-10-01");
  assert.equal(p.hourly_rate, 16);
  assert.equal(p.phone, "555-0100");
  assert.equal(p.role, "employee");
  assert.equal(p.active, true);
  assert.ok(db.rows("staff_cards").some((c) => c.card_id === "CARD-9" && c.employee_id === user.id));
});

test("a fob already on someone else is not taken from them", async () => {
  const { json } = await submit({
    kind: "onboarding",
    legal_name: "Robin Test",
    email: "robin@example.test",
    fob_card_id: "CARD-1",
    systems: ["fob"],
  });
  const fob = step(json.record!, "fob_assign");
  assert.equal(fob.status, "failed");
  assert.equal(fob.result, "Card CARD-1 is already assigned to someone else");
  assert.deepEqual(
    db.rows("staff_cards").map((c) => [c.card_id, c.employee_id]),
    [["CARD-1", SAM]],
  );
});

test("an invite the login service refuses fails the first step and leaves the record without a person", async () => {
  const { json } = await submit({ kind: "onboarding", legal_name: "Sam Again", email: "sam@example.test", systems: [] });
  const rec = json.record!;
  assert.equal(step(rec, "withers_time_invite").status, "failed");
  assert.match(step(rec, "withers_time_invite").result ?? "", /already been registered/);
  assert.equal(rec.employee_id, null);
  assert.equal(rec.status, "open");
});

test("a re-invite of someone with no login is refused", async () => {
  const { status, json } = await submit({ kind: "reinvite", employee_id: "00000000-0000-0000-0000-0000000000ff" });
  assert.equal(status, 400);
  assert.equal(json.error, "No such team member");
  assert.deepEqual(db.rows("staff_lifecycle"), []);
});

// Re-invite (docs/staffing.md, "Re-invite" and the email-sender paragraph): the
// sign-in link goes to an existing account, which only the Resend path can reach.
const reinviteKit = () => submit({ kind: "reinvite", employee_id: KIT, legal_name: "Kit Doe" });

test("a re-invite with Resend set emails the existing person a magic link and reactivates their profile", async () => {
  process.env.RESEND_API_KEY = "test-resend-key";
  profile(KIT).active = false;
  const { status, json } = await reinviteKit();
  assert.equal(status, 200);
  const rec = json.record!;
  assert.equal(step(rec, "withers_time_invite").status, "done");
  assert.equal(step(rec, "withers_time_invite").result, `Invited kit@example.test (delivery: email); profile ${KIT}`);
  assert.equal(rec.employee_id, KIT);
  assert.equal(profile(KIT).active, true);
  assert.equal(db.authUsers.length, 3); // no second account
  assert.equal(db.outbox.length, 1);
  assert.equal(db.outbox[0].to, "kit@example.test");
  assert.match(db.outbox[0].text, /\/auth\/confirm\?token_hash=hashed-magiclink-0{8}-0{4}-0{4}-0{4}-0{11}c&type=magiclink/);
});

test("a re-invite without Resend is refused for an existing account and leaves the profile inactive", async () => {
  profile(KIT).active = false;
  const { status, json } = await reinviteKit();
  assert.equal(status, 200);
  const inv = step(json.record!, "withers_time_invite");
  assert.equal(inv.status, "failed");
  assert.match(inv.result ?? "", /already been registered/);
  assert.equal(profile(KIT).active, false);
  assert.deepEqual(db.outbox, []);
});

test("a re-invite Resend refuses fails the step and leaves the profile inactive", async () => {
  process.env.RESEND_API_KEY = "test-resend-key";
  db.resendStatus = 422;
  profile(KIT).active = false;
  const { json } = await reinviteKit();
  const inv = step(json.record!, "withers_time_invite");
  assert.equal(inv.status, "failed");
  assert.equal(inv.result, "Invite email could not be sent (Resend rejected it).");
  assert.equal(profile(KIT).active, false);
});

// ---- steps done by hand -------------------------------------------------------------

async function addRobin(systems: string[]) {
  const { json } = await submit({ kind: "onboarding", legal_name: "Robin Test", email: "robin@example.test", systems });
  return json.record!;
}

test("QuickBooks and Workforce done by hand write the eeid and has_workforce, and the record closes when nothing is left", async () => {
  const rec = await addRobin(["qbo"]);
  const who = rec.employee_id!;

  const a = await tick(rec.id, "qbo_create_employee", { qbo_employee_id: " 77 " });
  assert.equal(a.status, 200);
  assert.equal(profile(who).qbo_employee_id, "77");
  assert.equal(step(a.json.record!, "qbo_create_employee").result, "eeid 77");

  await tick(rec.id, "qbo_invite_workforce", { skipped: true, note: "sent from QBO directly" });
  const b = await tick(rec.id, "workforce_completed");
  assert.equal(profile(who).has_workforce, true);
  assert.equal(step(b.json.record!, "qbo_invite_workforce").status, "skipped");
  assert.equal(b.json.record!.status, "done");

  const reopened = await tick(rec.id, "workforce_completed", { reopen: true });
  assert.equal(step(reopened.json.record!, "workforce_completed").status, "pending");
  assert.equal(reopened.json.record!.status, "open");
});

test("a skipped step applies no side effect", async () => {
  const rec = await addRobin(["qbo"]);
  await tick(rec.id, "qbo_create_employee", { skipped: true, qbo_employee_id: "77" });
  await tick(rec.id, "workforce_completed", { skipped: true });
  assert.equal(profile(rec.employee_id!).qbo_employee_id, undefined);
  assert.equal(profile(rec.employee_id!).has_workforce, undefined);
});

test("a fob tapped later is linked when its id is typed into the step", async () => {
  const rec = await addRobin(["fob"]);
  const empty = await tick(rec.id, "fob_assign", { fob_card_id: "  " });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, "Enter the fob card id first");

  const done = await tick(rec.id, "fob_assign", { fob_card_id: "CARD-7", note: "blue fob" });
  assert.equal(done.status, 200);
  assert.equal(step(done.json.record!, "fob_assign").result, "Card CARD-7 assigned. blue fob");
  assert.ok(db.rows("staff_cards").some((c) => c.card_id === "CARD-7" && c.employee_id === rec.employee_id));
  assert.equal(done.json.record!.status, "done");
});

test("an automatic step cannot be ticked or reopened by hand; an unknown record is 404", async () => {
  const rec = await addRobin([]);
  const ticked = await tick(rec.id, "withers_time_invite");
  assert.equal(ticked.status, 400);
  assert.equal(ticked.json.error, "That step runs automatically; use Run");
  const reopened = await tick(rec.id, "withers_time_invite", { reopen: true });
  assert.equal(reopened.status, 400);
  assert.equal(reopened.json.error, "Automatic steps are re-run, not reopened");
  assert.equal((await tick(999, "final_pay")).status, 404);
  assert.equal((await runRecord(999)).status, 404);
});

// ---- the Team page's list of records ------------------------------------------------

test("the Team page lists records newest first, each with its own steps in checklist order", async () => {
  const { listLifecycles } = await loadAppModule<{
    listLifecycles: (c: unknown, o?: { limit?: number }) => Promise<Rec[]>;
  }>("lib/staffing/execute.ts");
  const { createClient } = await loadAppModule<{ createClient: () => unknown }>("lib/supabase/server.ts");
  const older = (await offboardSam({ last_day: "2999-12-31" })).json.record!;
  const newer = await addRobin([]);
  db.rows("staff_lifecycle").find((r) => r.id === older.id)!.created_at = "2026-09-01T12:00:00Z";
  db.rows("staff_lifecycle").find((r) => r.id === newer.id)!.created_at = "2026-09-02T12:00:00Z";

  const listed = await listLifecycles(createClient());
  assert.deepEqual(
    listed.map((r) => r.id),
    [newer.id, older.id],
  );
  assert.deepEqual(listed[0].steps.map((s) => s.key), ["withers_time_invite"]);
  assert.deepEqual(
    listed[1].steps.map((s) => s.key).slice(0, 4),
    ["auth_ban", "sessions_revoke", "role_employee", "mark_inactive"],
  );
  assert.deepEqual((await listLifecycles(createClient(), { limit: 1 })).map((r) => r.id), [newer.id]);
});

// ---- POST /api/profiles, which shares lib/team.ts with the invite step ----------------

test("POST /api/profiles still invites and writes the profile", async () => {
  const res = await post(profiles.POST, "/api/profiles", {
    email: " Jo@Example.test ",
    full_name: "Jo Test",
    role: "manager",
    hourly_rate: 18,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user_id: string; email: string; delivery: string };
  assert.equal(body.email, "jo@example.test");
  assert.equal(body.delivery, "supabase");
  const p = profile(body.user_id);
  assert.equal(p.full_name, "Jo Test");
  assert.equal(p.role, "manager");
  assert.equal(p.hourly_rate, 18);
  assert.equal(p.active, true);
});

test("POST /api/profiles refuses an email in the name box before inviting anyone", async () => {
  const res = await post(profiles.POST, "/api/profiles", { email: "jo@example.test", full_name: "jo@example.test" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "Full name required (not an email)");
  assert.equal(db.authUsers.some((u) => u.email === "jo@example.test"), false);
});

test("POST /api/profiles refuses an address with no @ before inviting anyone", async () => {
  const res = await post(profiles.POST, "/api/profiles", { email: "jo", full_name: "Jo Test" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "Valid email required");
  assert.deepEqual(db.authUsers.map((u) => u.email), ["manager@example.test", "sam@example.test", "kit@example.test"]);
});
