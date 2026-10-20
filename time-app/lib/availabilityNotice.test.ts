// What the schedulers are told when someone changes their availability
// (bj-finance #754). The owner's words: "for the schedulers they need emails
// for when a scheduled updates their availability."
//
// The stories:
//   * An employee changes their own availability (a day, a week, copy last
//     week, weekly blocks, removing a block). Nobody is emailed then; each
//     scheduler's bell shows it at once.
//   * At 8pm New York time, from the missed-clock-in cron, each scheduler gets
//     ONE email listing who changed their availability and which dates or
//     weekdays. No changes, no email. Once a day however many ticks.
//   * The schedulers: every owner, plus every manager on the schedule
//     (active), leaving out anyone archived or banned, as the coverage
//     reminder picks them. notif_prefs availability_change or email switched
//     off means no email.
//   * Not counted: time-off requests (their own alert), a save that changes
//     nothing, a manager removing someone else's block. A scheduler is not
//     told of their own changes.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts. Time: node:test's mock Date.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const availability = await loadAppModule<{ POST: Handler }>("app/api/availability/route.ts");
const availabilityById = await loadAppModule<{ DELETE: Handler }>("app/api/availability/[id]/route.ts");
const week = await loadAppModule<{ PUT: Handler }>("app/api/availability/week/route.ts");
const copyWeek = await loadAppModule<{ POST: Handler }>("app/api/availability/copy-week/route.ts");
const recurring = await loadAppModule<{ PUT: Handler }>("app/api/availability/recurring/route.ts");
const cron = await loadAppModule<{ GET: (request: Request) => Promise<Response> }>("app/api/cron/missed-clockins/route.ts");

const OWNER = "00000000-0000-0000-0000-0000000000a1";
const MANAGER = "00000000-0000-0000-0000-0000000000a2";
const OFF_MANAGER = "00000000-0000-0000-0000-0000000000a3"; // manager not on the schedule
const GONE_MANAGER = "00000000-0000-0000-0000-0000000000a4"; // archived
const BANNED_MANAGER = "00000000-0000-0000-0000-0000000000a5";
const SAM = "00000000-0000-0000-0000-00000000000b";
const JO = "00000000-0000-0000-0000-00000000000c";

const EMAIL: Record<string, string> = {
  [OWNER]: "owner@example.test",
  [MANAGER]: "manager@example.test",
  [OFF_MANAGER]: "off@example.test",
  [GONE_MANAGER]: "gone@example.test",
  [BANNED_MANAGER]: "banned@example.test",
  [SAM]: "sam@example.test",
  [JO]: "jo@example.test",
};

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function req(method: string, body?: unknown): Request {
  return new Request("http://time.test/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });
}
const noParams = { params: { id: "" } };
const id = (n: number) => ({ params: { id: String(n) } });

let db: FakeSupabase;

beforeEach(() => {
  // Thursday 2026-10-08, 10am New York.
  mock.timers.enable({ apis: ["Date"], now: Date.parse(edt("2026-10-08", "10:00")) });
  db = startFakeSupabase({
    profiles: [
      { id: OWNER, role: "owner", active: false, archived_at: null, full_name: "Test Owner", phone: "+12155550109", notif_prefs: {} },
      { id: MANAGER, role: "manager", active: true, archived_at: null, full_name: "Max Manager", phone: "+12155550108", notif_prefs: {} },
      { id: OFF_MANAGER, role: "manager", active: false, archived_at: null, full_name: "Off Roster", phone: null, notif_prefs: {} },
      { id: GONE_MANAGER, role: "manager", active: true, archived_at: "2026-09-01T00:00:00Z", full_name: "Gone Away", phone: null, notif_prefs: {} },
      { id: BANNED_MANAGER, role: "manager", active: true, archived_at: null, full_name: "Banned Person", phone: null, notif_prefs: {} },
      { id: SAM, role: "employee", active: true, archived_at: null, full_name: "Sam Lee", phone: "+12155550101", notif_prefs: {} },
      { id: JO, role: "employee", active: true, archived_at: null, full_name: "Jo Park", phone: "+12155550102", notif_prefs: {} },
    ],
    availability: [],
    annotations: [],
    notifications: [],
    shifts: [],
    time_entries: [],
    shift_notices: [],
    shift_digests: [],
    availability_notices: [],
    availability_digests: [],
  });
  db.emails = { ...EMAIL };
  delete db.emails[BANNED_MANAGER];
  db.authUsers = [{ id: BANNED_MANAGER, email: EMAIL[BANNED_MANAGER], banned_until: "2999-01-01T00:00:00Z" }];
  process.env.RESEND_API_KEY = "re_test";
  db.signIn(SAM);
});

afterEach(() => {
  mock.timers.reset();
  delete process.env.RESEND_API_KEY;
});

function as(who: string) {
  db.signIn(who);
}
async function tick(iso: string) {
  mock.timers.setTime(Date.parse(iso));
  const res = await cron.GET(new Request("http://time.test/api/cron/missed-clockins"));
  assert.equal(res.status, 200);
  return res.json();
}
async function addDay(date: string, extra: Record<string, unknown> = {}) {
  const res = await availability.POST(
    req("POST", { specific_date: date, is_available: true, preference: "preferred", start_time: "12:00:00", end_time: "17:00:00", status: "approved", ...extra }),
    noParams,
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return ((await res.json()) as { availability: { id: number } }).availability.id;
}
async function addWeekly(weekday: number, extra: Record<string, unknown> = {}) {
  const res = await availability.POST(
    req("POST", { weekday, is_available: true, preference: "unavailable", start_time: null, end_time: null, status: "approved", repeat_until: "2027-01-08", ...extra }),
    noParams,
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return ((await res.json()) as { availability: { id: number } }).availability.id;
}
const mail = (who: string) => db.outbox.filter((m) => m.to === EMAIL[who]);
const bells = () => db.rows("notifications").map((n) => [n.user_id, n.type, n.title]);

// ---- At save time --------------------------------------------------------------

test("changing your availability emails nobody: the schedulers' bells show it now, and it is queued for 8pm", async () => {
  await addDay("2026-10-13");

  assert.deepEqual(db.outbox, []);
  const rows = db.rows("notifications");
  assert.ok(rows.length > 0);
  assert.ok(rows.every((n) => n.type === "availability_change" && n.sent_email === false && n.sent_sms === false));
  assert.equal(rows[0].body, "Sam Lee changed their availability: Tue, Oct 13.");
  assert.deepEqual(db.rows("availability_notices").map((n) => [n.employee_id, n.changed_date ?? null, n.changed_weekday ?? null]), [
    [SAM, "2026-10-13", null],
  ]);
});

test("a time-off request is not an availability change: it keeps its own alert", async () => {
  const res = await availability.POST(req("POST", { start_date: "2026-10-20", end_date: "2026-10-21", is_available: false, status: "pending" }), noParams);
  assert.equal(res.status, 200);
  assert.deepEqual(db.rows("availability_notices"), []);
  assert.ok(db.rows("notifications").every((n) => n.type === "time_off_request"));
});

// ---- The 8pm email -------------------------------------------------------------

test("at 8pm each scheduler gets one email: who changed their availability, and which days", async () => {
  await addDay("2026-10-15");
  await addDay("2026-10-13");
  await addWeekly(2);
  as(JO);
  await addWeekly(0);

  const before = await tick(edt("2026-10-08", "19:59"));
  assert.deepEqual(before.availabilityDigest, []);
  assert.deepEqual(db.outbox, []);

  const out = await tick(edt("2026-10-08", "20:00"));

  const text = "Availability changes\n\nJo Park: every Sunday\nSam Lee: Tue, Oct 13 · Thu, Oct 15 · every Tuesday";
  assert.deepEqual(mail(OWNER).map((m) => [m.subject, m.text]), [["Availability changes", text]]);
  assert.deepEqual(mail(MANAGER).map((m) => [m.subject, m.text]), [["Availability changes", text]]);
  assert.deepEqual(new Set(out.availabilityDigest), new Set([OWNER, MANAGER]));
  assert.deepEqual(db.rows("availability_notices"), []);
});

test("the schedulers are the owners and the managers on the schedule; archived, banned and staff are left out", async () => {
  await addDay("2026-10-13");
  await tick(edt("2026-10-08", "20:00"));

  assert.deepEqual([...new Set(db.outbox.map((m) => m.to))].sort(), [EMAIL[MANAGER], EMAIL[OWNER]].sort());
  for (const who of [OFF_MANAGER, GONE_MANAGER, BANNED_MANAGER, SAM, JO]) assert.deepEqual(mail(who), [], who);
});

test("no changes, no email", async () => {
  const out = await tick(edt("2026-10-08", "20:00"));
  assert.deepEqual(db.outbox, []);
  assert.deepEqual(out.availabilityDigest, []);
});

test("one email a day however many ticks; a change after it waits for tomorrow's", async () => {
  await addDay("2026-10-13");
  await tick(edt("2026-10-08", "20:00"));
  await tick(edt("2026-10-08", "20:05"));
  assert.equal(mail(OWNER).length, 1);

  mock.timers.setTime(Date.parse(edt("2026-10-08", "21:00")));
  as(SAM);
  await addDay("2026-10-14");
  await tick(edt("2026-10-08", "21:05"));
  await tick(edt("2026-10-09", "19:59"));
  assert.equal(mail(OWNER).length, 1);

  await tick(edt("2026-10-09", "20:00"));
  assert.equal(mail(OWNER).length, 2);
  assert.equal(mail(OWNER)[1].text, "Availability changes\n\nSam Lee: Wed, Oct 14");
});

test("availability_change switched off, or email switched off: that scheduler gets no email", async () => {
  db.tables.profiles.find((p) => p.id === OWNER)!.notif_prefs = { availability_change: false };
  db.tables.profiles.find((p) => p.id === MANAGER)!.notif_prefs = { email: false };
  await addDay("2026-10-13");
  await tick(edt("2026-10-08", "20:00"));
  assert.deepEqual(db.outbox, []);
});

test("a scheduler is not told of their own changes; the other schedulers are", async () => {
  as(MANAGER);
  await addDay("2026-10-13");
  await tick(edt("2026-10-08", "20:00"));

  assert.deepEqual(mail(MANAGER), []);
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nMax Manager: Tue, Oct 13");
});

// ---- Every way of changing it -----------------------------------------------------

test("a week saved: only the dates whose blocks changed; the same week saved again queues nothing", async () => {
  db.tables.availability.push(
    { id: 1, employee_id: SAM, specific_date: "2026-10-12", weekday: null, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available" },
    { id: 2, employee_id: SAM, specific_date: "2026-10-13", weekday: null, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available" },
  );
  const blocks = [
    { date: "2026-10-12", start_time: "12:00:00", end_time: "17:00:00", preference: "available" },
    { date: "2026-10-13", start_time: "13:00:00", end_time: "17:00:00", preference: "available" },
    { date: "2026-10-16", start_time: "09:00:00", end_time: "12:00:00", preference: "preferred" },
  ];
  assert.equal((await week.PUT(req("PUT", { weekStart: "2026-10-11", blocks }), noParams)).status, 200);
  assert.deepEqual(db.rows("availability_notices").map((n) => n.changed_date).sort(), ["2026-10-13", "2026-10-16"]);

  assert.equal((await week.PUT(req("PUT", { weekStart: "2026-10-11", blocks }), noParams)).status, 200);
  assert.equal(db.rows("availability_notices").length, 2);

  await tick(edt("2026-10-08", "20:00"));
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nSam Lee: Tue, Oct 13 · Fri, Oct 16");
});

test("copy last week: the target dates the copy changed", async () => {
  db.tables.availability.push(
    { id: 1, employee_id: SAM, specific_date: "2026-10-05", weekday: null, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available" },
    { id: 2, employee_id: SAM, specific_date: "2026-10-12", weekday: null, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available" },
    { id: 3, employee_id: SAM, specific_date: "2026-10-07", weekday: null, start_time: "09:00:00", end_time: "12:00:00", is_available: true, status: "approved", preference: "available" },
  );
  assert.equal((await copyWeek.POST(req("POST", { weekStart: "2026-10-11" }), noParams)).status, 200);
  await tick(edt("2026-10-08", "20:00"));
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nSam Lee: Wed, Oct 14");
});

test("weekly blocks saved: the weekdays whose blocks changed", async () => {
  db.tables.availability.push(
    { id: 1, employee_id: SAM, specific_date: null, weekday: 1, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available", repeat_until: "2027-01-08" },
    { id: 2, employee_id: SAM, specific_date: null, weekday: 3, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available", repeat_until: "2027-01-08" },
  );
  const res = await recurring.PUT(
    req("PUT", {
      repeat_until: "2027-01-08",
      blocks: [
        { weekday: 1, start_time: "12:00:00", end_time: "17:00:00" },
        { weekday: 5, start_time: "12:00:00", end_time: "17:00:00" },
      ],
    }),
    noParams,
  );
  assert.equal(res.status, 200);
  await tick(edt("2026-10-08", "20:00"));
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nSam Lee: every Wednesday · every Friday");
});

test("weekly blocks saved again with the same times written without seconds queue nothing", async () => {
  // The database hands times back as "12:00:00"; a caller may send "12:00".
  db.tables.availability.push(
    { id: 1, employee_id: SAM, specific_date: null, weekday: 1, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available", repeat_until: "2027-01-08" },
  );
  const res = await recurring.PUT(
    req("PUT", { repeat_until: "2027-01-08", blocks: [{ weekday: 1, start_time: "12:00", end_time: "17:00" }] }),
    noParams,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(db.rows("availability_notices"), []);
});

test("weekly blocks saved with only the repeat-until date moved: every weekday they cover changed", async () => {
  db.tables.availability.push(
    { id: 1, employee_id: SAM, specific_date: null, weekday: 1, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available", repeat_until: "2027-01-08" },
    { id: 2, employee_id: SAM, specific_date: null, weekday: 3, start_time: "12:00:00", end_time: "17:00:00", is_available: true, status: "approved", preference: "available", repeat_until: "2027-01-08" },
  );
  const res = await recurring.PUT(
    req("PUT", {
      repeat_until: "2026-11-30",
      blocks: [
        { weekday: 1, start_time: "12:00:00", end_time: "17:00:00" },
        { weekday: 3, start_time: "12:00:00", end_time: "17:00:00" },
      ],
    }),
    noParams,
  );
  assert.equal(res.status, 200);
  await tick(edt("2026-10-08", "20:00"));
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nSam Lee: every Monday · every Wednesday");
});

test("removing one of your own blocks is a change; removing time off is not one", async () => {
  const day = await addDay("2026-10-13");
  const weekly = await addWeekly(4);
  db.tables.availability_notices = [];
  db.tables.availability.push({ id: 50, employee_id: SAM, specific_date: "2026-10-20", weekday: null, is_available: false, status: "pending", preference: "available", request_group: null });

  assert.equal((await availabilityById.DELETE(req("DELETE"), id(day))).status, 200);
  assert.equal((await availabilityById.DELETE(req("DELETE"), id(weekly))).status, 200);
  assert.equal((await availabilityById.DELETE(req("DELETE"), id(50))).status, 200);

  await tick(edt("2026-10-08", "20:00"));
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nSam Lee: Tue, Oct 13 · every Thursday");
});

test("a manager removing someone else's block does not count", async () => {
  db.tables.availability.push({ id: 1, employee_id: SAM, specific_date: "2026-10-13", weekday: null, start_time: null, end_time: null, is_available: true, status: "approved", preference: "unavailable" });
  as(MANAGER);
  assert.equal((await availabilityById.DELETE(req("DELETE"), id(1))).status, 200);
  assert.deepEqual(db.rows("availability_notices"), []);
});

// ---- When a step fails ---------------------------------------------------------

test("a change is still saved when it cannot be queued (migration 48 not applied)", async () => {
  db.missingTables = ["availability_notices"];
  await addDay("2026-10-13");
  assert.equal(db.rows("availability").length, 1);
});

test("when the email cannot be claimed, the cron still answers, says why, and the queue keeps every change", async () => {
  await addDay("2026-10-13");
  db.beforeWrite = (target) => {
    if (target === "rpc/claim_availability_digest") throw new Error("database unreachable");
  };
  const out = await tick(edt("2026-10-08", "20:00"));
  assert.match(out.availabilityDigestError, /database unreachable/);
  assert.deepEqual(db.outbox, []);
  assert.equal(db.rows("availability_notices").length, 1);

  db.beforeWrite = null;
  await tick(edt("2026-10-08", "20:05"));
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nSam Lee: Tue, Oct 13");
});

test("when the people cannot be read after the claim, nothing is sent and the changes come back in the next day's email", async () => {
  await addDay("2026-10-13");
  db.beforeWrite = (target) => {
    if (target === "rpc/claim_availability_digest") db.missingTables = ["profiles"];
  };
  const out = await tick(edt("2026-10-08", "20:00"));
  db.beforeWrite = null;
  db.missingTables = [];
  assert.match(out.availabilityDigestError, /profiles/);
  assert.deepEqual(db.outbox.filter((m) => m.subject === "Availability changes"), []);
  assert.equal(db.rows("availability_notices").length, 1);

  await tick(edt("2026-10-09", "20:00"));
  assert.equal(mail(OWNER)[0].text, "Availability changes\n\nSam Lee: Tue, Oct 13");
});
