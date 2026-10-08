// What staff are told about their shifts, and when. Alina, 2026-10-08: a
// manager building the schedule fired one email and one text per edit; staff
// now get ONE summary a day, at 8pm New York time, and everything waits for
// it, including edits to a shift that starts within the next day.
//
// Saving a shift still puts it on the person's bell straight away (the in-app
// notification row, as before) and queues it. The missed-clock-in cron, which
// an outside scheduler hits every few minutes (ALEX-CRON-SETUP.md), sends the
// summary on its first tick at or after 20:00, once per person per day, from
// each shift as it stands then.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts. Time: node:test's mock Date.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;

const shifts = await loadAppModule<{ POST: Handler }>("app/api/shifts/route.ts");
const shiftById = await loadAppModule<{ PATCH: Handler; DELETE: Handler }>("app/api/shifts/[id]/route.ts");
const copyWeek = await loadAppModule<{ POST: Handler }>("app/api/shifts/copy-week/route.ts");
const cron = await loadAppModule<{ GET: (request: Request) => Promise<Response> }>("app/api/cron/missed-clockins/route.ts");
const { digestDayAt } = await loadAppModule<{ digestDayAt: (nowMs: number) => string | null }>("lib/shiftNotice.ts");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const JO = "00000000-0000-0000-0000-00000000000c";
const SAM_PHONE = "+12155550101";
const JO_PHONE = "+12155550102";

// Eastern Daylight Time (until Sunday 2026-11-01) and Eastern Standard Time.
function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
function est(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-05:00`).toISOString();
}
function req(method: string, body?: unknown): Request {
  return new Request("http://time.test/api", { method, body: body === undefined ? undefined : JSON.stringify(body) });
}
const noParams = { params: { id: "" } };
const id = (n: number) => ({ params: { id: String(n) } });

type Sent = { channel: "email" | "sms"; to: string; text: string };
let db: FakeSupabase;
let sent: Sent[];

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(edt("2026-10-08", "10:00")) });
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Owner", phone: null, notif_prefs: {} },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee", phone: SAM_PHONE, notif_prefs: {} },
      { id: JO, role: "employee", active: true, full_name: "Jo Park", phone: JO_PHONE, notif_prefs: {} },
    ],
    shifts: [],
    availability: [],
    notifications: [],
    time_entries: [],
    shift_notices: [],
    shift_digests: [],
  });
  db.emails = { [SAM]: "sam@example.test", [JO]: "jo@example.test" };
  process.env.RESEND_API_KEY = "re_test";
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "twilio_test";
  process.env.TWILIO_FROM_NUMBER = "+12155550100";
  sent = [];
  db.external = async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "api.resend.com") {
      const body = JSON.parse(await request.text()) as { to: string; text: string };
      sent.push({ channel: "email", to: body.to, text: body.text });
    } else if (url.hostname === "api.twilio.com") {
      const body = new URLSearchParams(await request.text());
      sent.push({ channel: "sms", to: body.get("To")!, text: body.get("Body")! });
    } else {
      throw new Error(`unexpected request to ${url.origin}`);
    }
    return new Response("{}", { status: 200 });
  };
  db.signIn(MANAGER);
});

afterEach(() => {
  mock.timers.reset();
  delete process.env.RESEND_API_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
});

// Moves the clock. The manager signs in again so their session is fresh.
function at(iso: string) {
  mock.timers.setTime(Date.parse(iso));
  db.signIn(MANAGER);
}
async function tick(iso: string) {
  mock.timers.setTime(Date.parse(iso));
  const res = await cron.GET(new Request("http://time.test/api/cron/missed-clockins"));
  assert.equal(res.status, 200);
  return res.json();
}
async function create(employee: string | null, date: string, from: string, to: string, position: string | null = null) {
  const res = await shifts.POST(
    req("POST", { employee_id: employee, starts_at: edt(date, from), ends_at: edt(date, to), position, confirmAvailability: true }),
    noParams,
  );
  assert.equal(res.status, 200);
  return ((await res.json()) as { shift: { id: number } }).shift.id;
}
async function edit(shiftId: number, body: Record<string, unknown>) {
  const res = await shiftById.PATCH(req("PATCH", { confirmAvailability: true, ...body }), id(shiftId));
  assert.equal(res.status, 200);
}
const to = (who: string) => sent.filter((s) => s.to === who);
const notified = () => db.rows("notifications").map((n) => [n.user_id, n.type]);

test("saving a shift emails and texts nobody: it is queued for 8pm, and the bell shows it now", async () => {
  const shiftId = await create(SAM, "2026-10-13", "12:00", "17:00", "PENN Opener");
  await edit(shiftId, { notes: "bring keys" });

  assert.deepEqual(sent, []);
  assert.deepEqual(notified(), [
    [SAM, "shift_published"],
    [SAM, "schedule_change"],
  ]);
  assert.ok(db.rows("notifications").every((n) => n.sent_email === false && n.sent_sms === false));
  assert.deepEqual(
    db.rows("shift_notices").map((n) => [n.shift_id, n.employee_id, n.notice]),
    [
      [shiftId, SAM, "posted"],
      [shiftId, SAM, "changed"],
    ],
  );
});

test("an edit to a shift starting within the next day waits for 8pm too", async () => {
  db.tables.shifts.push({ id: 1, employee_id: SAM, starts_at: edt("2026-10-08", "17:00"), ends_at: edt("2026-10-08", "22:00"), position: null, published: true });
  at(edt("2026-10-08", "16:00"));
  await edit(1, { ends_at: edt("2026-10-08", "21:00") });
  assert.deepEqual(sent, []);
  assert.equal(db.rows("shift_notices").length, 1);
});

test("nothing goes out before 8pm New York time", async () => {
  await create(SAM, "2026-10-13", "12:00", "17:00");
  await tick(edt("2026-10-08", "19:59"));
  assert.deepEqual(sent, []);
  assert.equal(db.rows("shift_notices").length, 1);
  assert.deepEqual(db.rows("shift_digests"), []);
});

test("five saves of one shift are one line with the final times, by email and text, at 8pm", async () => {
  const shiftId = await create(SAM, "2026-10-13", "12:00", "17:00", "PENN Opener");
  await edit(shiftId, { starts_at: edt("2026-10-13", "11:00") });
  await edit(shiftId, { ends_at: edt("2026-10-13", "16:00") });
  await edit(shiftId, { starts_at: edt("2026-10-13", "13:00"), ends_at: edt("2026-10-13", "18:00") });
  await edit(shiftId, { position: "PENN Closer" });

  const out = await tick(edt("2026-10-08", "20:00"));

  assert.deepEqual(sent.map((s) => [s.channel, s.to]), [
    ["email", "sam@example.test"],
    ["sms", SAM_PHONE],
  ]);
  const text = sent[0].text;
  assert.equal(sent[1].text, text);
  assert.equal(text, "Your shift updates\n\nNew: Tue, Oct 13 · 1:00 PM–6:00 PM · PENN Closer");
  assert.deepEqual(out.shiftDigests, [SAM]);
  assert.deepEqual(db.rows("shift_notices"), []);
  // The summary is not a sixth bell row: the bell already had each save.
  assert.equal(db.rows("notifications").length, 5);
});

test("a shift they already had reads as changed; new and changed are listed in start order", async () => {
  db.tables.shifts.push({ id: 1, employee_id: SAM, starts_at: edt("2026-10-15", "12:00"), ends_at: edt("2026-10-15", "17:00"), position: null, published: true });
  await edit(1, { ends_at: edt("2026-10-15", "18:00") });
  await create(SAM, "2026-10-14", "17:00", "22:00");

  await tick(edt("2026-10-08", "20:00"));

  assert.equal(
    to("sam@example.test")[0].text,
    "Your shift updates\n\nNew: Wed, Oct 14 · 5:00 PM–10:00 PM\nChanged: Thu, Oct 15 · 12:00 PM–6:00 PM",
  );
});

test("a shift deleted before 8pm is left out, and nobody is sent an empty summary", async () => {
  await create(SAM, "2026-10-13", "12:00", "17:00");
  const gone = await create(SAM, "2026-10-14", "12:00", "17:00");
  const alsoGone = await create(JO, "2026-10-14", "17:00", "22:00");
  assert.equal((await shiftById.DELETE(req("DELETE"), id(gone))).status, 200);
  assert.equal((await shiftById.DELETE(req("DELETE"), id(alsoGone))).status, 200);

  await tick(edt("2026-10-08", "20:00"));

  assert.equal(to("sam@example.test").length, 1);
  assert.equal(to("sam@example.test")[0].text, "Your shift updates\n\nNew: Tue, Oct 13 · 12:00 PM–5:00 PM");
  assert.deepEqual(to("jo@example.test"), []);
  assert.deepEqual(to(JO_PHONE), []);
});

test("a shift moved to someone else is left out of the first person's summary and is new in theirs", async () => {
  const shiftId = await create(SAM, "2026-10-13", "12:00", "17:00");
  await edit(shiftId, { employee_id: JO });

  await tick(edt("2026-10-08", "20:00"));

  assert.deepEqual(to("sam@example.test"), []);
  assert.deepEqual(to(SAM_PHONE), []);
  assert.equal(to("jo@example.test")[0].text, "Your shift updates\n\nNew: Tue, Oct 13 · 12:00 PM–5:00 PM");
});

test("a shift moved away and back again is still theirs", async () => {
  const shiftId = await create(SAM, "2026-10-13", "12:00", "17:00");
  await edit(shiftId, { employee_id: JO });
  await edit(shiftId, { employee_id: SAM });

  await tick(edt("2026-10-08", "20:00"));

  assert.equal(to("sam@example.test")[0].text, "Your shift updates\n\nNew: Tue, Oct 13 · 12:00 PM–5:00 PM");
  assert.deepEqual(to("jo@example.test"), []);
});

test("schedule_change switched off: changed shifts are left out, new ones still come", async () => {
  db.tables.profiles.find((p) => p.id === SAM)!.notif_prefs = { schedule_change: false };
  db.tables.shifts.push({ id: 1, employee_id: SAM, starts_at: edt("2026-10-15", "12:00"), ends_at: edt("2026-10-15", "17:00"), position: null, published: true });
  await edit(1, { ends_at: edt("2026-10-15", "18:00") });
  await create(SAM, "2026-10-14", "17:00", "22:00");

  await tick(edt("2026-10-08", "20:00"));

  assert.equal(to("sam@example.test")[0].text, "Your shift updates\n\nNew: Wed, Oct 14 · 5:00 PM–10:00 PM");
});

test("shift_published switched off: new shifts are left out, so a summary of only new shifts is not sent", async () => {
  db.tables.profiles.find((p) => p.id === SAM)!.notif_prefs = { shift_published: false };
  await create(SAM, "2026-10-14", "17:00", "22:00");

  await tick(edt("2026-10-08", "20:00"));

  assert.deepEqual(sent, []);
});

test("email switched off: the summary goes by text only; text switched off: by email only", async () => {
  db.tables.profiles.find((p) => p.id === SAM)!.notif_prefs = { email: false };
  db.tables.profiles.find((p) => p.id === JO)!.notif_prefs = { sms: false };
  await create(SAM, "2026-10-13", "12:00", "17:00");
  await create(JO, "2026-10-13", "17:00", "22:00");

  await tick(edt("2026-10-08", "20:00"));

  assert.deepEqual(sent.map((s) => [s.channel, s.to]).sort(), [
    ["email", "jo@example.test"],
    ["sms", SAM_PHONE],
  ]);
});

test("one summary a day however many ticks; a save after it waits for tomorrow's", async () => {
  await create(SAM, "2026-10-13", "12:00", "17:00");
  await tick(edt("2026-10-08", "20:00"));
  await tick(edt("2026-10-08", "20:05"));
  assert.equal(to("sam@example.test").length, 1);

  at(edt("2026-10-08", "20:20"));
  await create(SAM, "2026-10-14", "12:00", "17:00");
  await tick(edt("2026-10-08", "20:25"));
  await tick(edt("2026-10-08", "23:55"));
  await tick(edt("2026-10-09", "00:05"));
  await tick(edt("2026-10-09", "19:59"));
  assert.equal(to("sam@example.test").length, 1);

  await tick(edt("2026-10-09", "20:00"));
  assert.equal(to("sam@example.test").length, 2);
  assert.equal(to("sam@example.test")[1].text, "Your shift updates\n\nNew: Wed, Oct 14 · 12:00 PM–5:00 PM");
  assert.deepEqual(
    db.rows("shift_digests").map((d) => [d.employee_id, d.digest_day]),
    [
      [SAM, "2026-10-08"],
      [SAM, "2026-10-09"],
    ],
  );
});

test("two ticks at once send one summary", async () => {
  await create(SAM, "2026-10-13", "12:00", "17:00");
  mock.timers.setTime(Date.parse(edt("2026-10-08", "20:00")));
  const [a, b] = await Promise.all([
    cron.GET(new Request("http://time.test/api/cron/missed-clockins")),
    cron.GET(new Request("http://time.test/api/cron/missed-clockins")),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(to("sam@example.test").length, 1);
  assert.equal(to(SAM_PHONE).length, 1);
});

test("copy last week queues each copy for its person's summary", async () => {
  db.tables.shifts.push(
    { id: 1, employee_id: SAM, location_id: null, starts_at: edt("2026-09-29", "12:00"), ends_at: edt("2026-09-29", "17:00"), position: null, notes: null, published: true },
    { id: 2, employee_id: null, location_id: null, starts_at: edt("2026-09-29", "17:00"), ends_at: edt("2026-09-29", "22:00"), position: null, notes: null, published: true },
  );
  const res = await copyWeek.POST(req("POST", { weekStart: "2026-10-04" }), noParams);
  assert.equal(res.status, 200);
  assert.deepEqual(sent, []);
  assert.deepEqual(db.rows("shift_notices").map((n) => [n.shift_id, n.employee_id, n.notice]), [[3, SAM, "posted"]]);

  await tick(edt("2026-10-08", "20:00"));
  assert.equal(to("sam@example.test")[0].text, "Your shift updates\n\nNew: Tue, Oct 6 · 12:00 PM–5:00 PM");
});

test("8pm is New York's 8pm on both sides of a clock change", () => {
  // Summer (EDT, UTC-4): 20:00 is 00:00 UTC the next day.
  assert.equal(digestDayAt(Date.parse("2026-10-08T23:59:00Z")), null);
  assert.equal(digestDayAt(Date.parse("2026-10-09T00:00:00Z")), "2026-10-08");
  assert.equal(digestDayAt(Date.parse("2026-10-09T03:59:00Z")), "2026-10-08");
  // Midnight in New York starts a new day that is not yet due.
  assert.equal(digestDayAt(Date.parse("2026-10-09T04:00:00Z")), null);
  // Clocks go back 2026-11-01 (EST, UTC-5): 20:00 is 01:00 UTC the next day.
  assert.equal(digestDayAt(Date.parse("2026-11-01T00:00:00Z")), "2026-10-31");
  assert.equal(digestDayAt(Date.parse("2026-11-02T00:30:00Z")), null);
  assert.equal(digestDayAt(Date.parse("2026-11-02T01:00:00Z")), "2026-11-01");
  // Clocks go forward 2026-03-08: the evening before is EST, that evening EDT.
  assert.equal(digestDayAt(Date.parse("2026-03-08T00:59:00Z")), null);
  assert.equal(digestDayAt(Date.parse("2026-03-08T01:00:00Z")), "2026-03-07");
  assert.equal(digestDayAt(Date.parse("2026-03-08T23:59:00Z")), null);
  assert.equal(digestDayAt(Date.parse("2026-03-09T00:00:00Z")), "2026-03-08");
});

test("the night the clocks go back, the summary waits for 8pm EST, not 8pm EDT", async () => {
  at(est("2026-11-01", "10:00"));
  await create(SAM, "2026-11-03", "12:00", "17:00");
  // 00:30 UTC is 8:30pm by summer time but 7:30pm on the clock that night.
  await tick("2026-11-02T00:30:00Z");
  assert.deepEqual(sent, []);
  await tick(est("2026-11-01", "20:00"));
  assert.equal(to("sam@example.test").length, 1);
  assert.deepEqual(db.rows("shift_digests").map((d) => d.digest_day), ["2026-11-01"]);
});

// ---- When a step fails ---------------------------------------------------------

test("a shift is still saved, and on the bell, when its notice cannot be queued", async () => {
  // Migration 38 not applied yet: the queue table is not there.
  db.missingTables = ["shift_notices"];
  const shiftId = await create(SAM, "2026-10-13", "12:00", "17:00");

  assert.deepEqual(db.rows("shifts").map((s) => [s.id, s.employee_id]), [[shiftId, SAM]]);
  assert.deepEqual(notified(), [[SAM, "shift_published"]]);
  assert.deepEqual(sent, []);
});

test("when the summaries cannot be claimed, the cron still answers, says why, and the queue keeps every notice", async () => {
  await create(SAM, "2026-10-13", "12:00", "17:00");
  db.beforeWrite = (target) => {
    if (target === "rpc/claim_shift_digests") throw new Error("database unreachable");
  };

  const out = await tick(edt("2026-10-08", "20:00"));

  assert.deepEqual(out.shiftDigests, []);
  assert.match(out.shiftDigestError, /database unreachable/);
  assert.deepEqual(sent, []);
  assert.deepEqual(db.rows("shift_notices").map((n) => [n.employee_id, n.notice]), [[SAM, "posted"]]);

  // The next tick that can claim sends the summary that same evening.
  db.beforeWrite = null;
  await tick(edt("2026-10-08", "20:05"));
  assert.equal(to("sam@example.test")[0].text, "Your shift updates\n\nNew: Tue, Oct 13 · 12:00 PM–5:00 PM");
});

test("when the shifts cannot be read after the claim, nothing is sent and the notices come back in the next day's summary", async () => {
  const shiftId = await create(SAM, "2026-10-13", "12:00", "17:00");
  // The claim goes through; the read of the shifts it names fails.
  db.beforeWrite = (target) => {
    if (target === "rpc/claim_shift_digests") db.missingTables = ["shifts"];
  };

  const out = await tick(edt("2026-10-08", "20:00"));
  db.beforeWrite = null;
  db.missingTables = [];

  assert.deepEqual(out.shiftDigests, []);
  assert.match(out.shiftDigestError, /shifts/);
  assert.deepEqual(sent, []);
  assert.deepEqual(db.rows("shift_notices").map((n) => [n.shift_id, n.employee_id, n.notice]), [[shiftId, SAM, "posted"]]);

  // Today's summary was claimed, so the notices wait for tomorrow's.
  await tick(edt("2026-10-08", "20:05"));
  assert.deepEqual(sent, []);
  await tick(edt("2026-10-09", "20:00"));
  assert.equal(to("sam@example.test").length, 1);
  assert.equal(to("sam@example.test")[0].text, "Your shift updates\n\nNew: Tue, Oct 13 · 12:00 PM–5:00 PM");
});
