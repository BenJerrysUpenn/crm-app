// The cash count reminders end to end, the way the 5-minute cron runs them
// (lib/cashCount/run.ts, called from app/api/cron/missed-clockins). The
// stories, from the owner's rules of 2026-10-29:
//   * The opener clocks in: one reminder in #cash-count @mentioning them, and
//     no second one however many ticks follow.
//   * Just after closing: one reminder @mentioning the person on the clock,
//     not the caterer still out at an event.
//   * Nobody posts within 30 minutes: one follow-up in the reminder's thread,
//     exactly once. Someone posting in the channel or the thread means no
//     follow-up; a join notice or a bot does not count as posting.
//   * The Claude API fails or writes something that fails the checks: the
//     plain message goes out instead, so the reminder is never lost.
//   * Slack refuses a post: nothing is recorded, and the next tick tries again.
//   * Staff are matched to Slack by email, else by name.
//
// Stand-ins: Supabase (lib/testing/fakeSupabase.ts); Slack's Web API and the
// Claude Messages API at the HTTP boundary (the real Anthropic SDK runs).
// Time: node:test's mock Date.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "../testing/fakeSupabase.ts";
import type * as Run from "./run.ts";

const { runCashCountReminders } = await loadAppModule<typeof Run>("lib/cashCount/run.ts");
const cron = await loadAppModule<{ GET: (request: Request) => Promise<Response> }>("app/api/cron/missed-clockins/route.ts");

const CHANNEL = "C0CE7KVKQQ0";
const RULES_TS = "1793315956.512979";
const RULES = "Open: count the register and the cash box bundles, post the counts here. Close: post the count, a photo of the printout and any difference, the bundles, and the drop amount.";

const OPENER = "00000000-0000-0000-0000-00000000000a";
const CLOSER = "00000000-0000-0000-0000-00000000000b";
const CATERER = "00000000-0000-0000-0000-00000000000c";
const NAMED = "00000000-0000-0000-0000-00000000000d"; // Slack has a different email for them

const SLACK_USERS = [
  { id: "U0OPENER", real_name: "Olive Opener", profile: { real_name: "Olive Opener", email: "olive@example.test" } },
  { id: "U0CLOSER", real_name: "Cass Closer", profile: { real_name: "Cass Closer", email: "cass@example.test" } },
  { id: "U0CATER", real_name: "Cat Erer", profile: { real_name: "Cat Erer", email: "cat@example.test" } },
  { id: "U0NAMED", real_name: "Nina Named", profile: { real_name: "Nina Named", email: "nina.other@example.test" } },
  { id: "U0BOT", is_bot: true, real_name: "Cash Count", profile: { real_name: "Cash Count" } },
];

const edt = (hhmm: string, date = "2026-10-29") => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
const tick = (hhmm: string) => {
  mock.timers.setTime(Date.parse(edt(hhmm)));
  return runCashCountReminders(Date.now());
};

type SlackMsg = { ts: string; user?: string; bot_id?: string; subtype?: string; text: string; thread_ts?: string };
let slack: {
  channel: SlackMsg[];
  posts: { text: string; thread_ts?: string }[];
  refusePosts: number;
  claude: { status: number; text: string; calls: number };
};
let db: FakeSupabase;
let tsCounter = 0;

function nextTs(): string {
  tsCounter += 1;
  return `${Math.floor(Date.now() / 1000)}.${String(tsCounter).padStart(6, "0")}`;
}

async function external(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === "https://api.anthropic.com") {
    slack.claude.calls += 1;
    if (slack.claude.status !== 200) {
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "nope" } }, { status: slack.claude.status });
    }
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: slack.claude.text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }
  assert.equal(url.origin, "https://slack.com", `unexpected request to ${url.origin}`);
  assert.equal(request.headers.get("authorization"), "Bearer xoxb-test");
  const form = new URLSearchParams(await request.text());
  const method = url.pathname.replace("/api/", "");
  if (method === "chat.postMessage") {
    assert.equal(form.get("channel"), CHANNEL);
    if (slack.refusePosts > 0) {
      slack.refusePosts -= 1;
      return Response.json({ ok: false, error: "not_in_channel" });
    }
    const msg: SlackMsg = { ts: nextTs(), bot_id: "B0BOT", text: form.get("text")!, thread_ts: form.get("thread_ts") ?? undefined };
    slack.channel.push(msg);
    slack.posts.push({ text: msg.text, thread_ts: msg.thread_ts });
    return Response.json({ ok: true, ts: msg.ts });
  }
  if (method === "conversations.history") {
    const latest = form.get("latest");
    if (latest) {
      return Response.json({ ok: true, messages: latest === RULES_TS ? [{ ts: RULES_TS, user: "U0ALEX", text: RULES }] : [] });
    }
    const oldest = Number(form.get("oldest"));
    return Response.json({ ok: true, messages: slack.channel.filter((m) => !m.thread_ts && Number(m.ts) > oldest).reverse() });
  }
  if (method === "conversations.replies") {
    const ts = form.get("ts")!;
    const thread = slack.channel.filter((m) => m.ts === ts || m.thread_ts === ts);
    return Response.json({ ok: true, messages: thread });
  }
  if (method === "users.lookupByEmail") {
    const user = SLACK_USERS.find((u) => u.profile.email === form.get("email"));
    return Response.json(user ? { ok: true, user } : { ok: false, error: "users_not_found" });
  }
  if (method === "users.list") return Response.json({ ok: true, members: SLACK_USERS, response_metadata: { next_cursor: "" } });
  throw new Error(`unexpected Slack method ${method}`);
}

function humanSays(text: string, thread_ts?: string, extra: Partial<SlackMsg> = {}) {
  slack.channel.push({ ts: nextTs(), user: "U0CLOSER", text, thread_ts, ...extra });
}

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(edt("08:00")) });
  tsCounter = 0;
  process.env.SLACK_CASH_COUNT_BOT_TOKEN = "xoxb-test";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  delete process.env.CASH_COUNT_SLACK_CHANNEL;
  delete process.env.CASH_COUNT_RULES_TS;
  slack = { channel: [], posts: [], refusePosts: 0, claude: { status: 200, text: "", calls: 0 } };
  db = startFakeSupabase({
    profiles: [
      { id: OPENER, role: "employee", full_name: "Olive Opener", preferred_name: null, active: true, archived_at: null },
      { id: CLOSER, role: "employee", full_name: "Cass Closer", preferred_name: null, active: true, archived_at: null },
      { id: CATERER, role: "manager", full_name: "Cat Erer", preferred_name: null, active: true, archived_at: null },
      { id: NAMED, role: "manager", full_name: "Nina Named", preferred_name: null, active: true, archived_at: null },
    ],
    // 11:00 to 22:00 every day.
    store_hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens: "11:00:00", closes: "22:00:00" })),
    store_hours_seasons: [],
    store_hours_exceptions: [],
    annotations: [],
    shift_types: [
      { name: "PENN Opener", in_store: true },
      { name: "PENN Closer", in_store: true },
      { name: "Catering", in_store: false },
    ],
    shifts: [
      { id: 1, employee_id: OPENER, starts_at: edt("10:00"), ends_at: edt("16:00"), position: "PENN Opener", deal_id: null, published: true },
      { id: 2, employee_id: CLOSER, starts_at: edt("16:00"), ends_at: edt("23:00"), position: "PENN Closer", deal_id: null, published: true },
      { id: 3, employee_id: CATERER, starts_at: edt("17:00"), ends_at: edt("23:30"), position: "Catering", deal_id: 501, published: true },
    ],
    time_entries: [],
    cash_count_reminders: [],
  });
  db.emails = { [OPENER]: "olive@example.test", [CLOSER]: "cass@example.test", [CATERER]: "cat@example.test", [NAMED]: "nina@example.test" };
  db.external = external;
});

afterEach(() => mock.timers.reset());

function clockIn(id: number, employee: string, hhmm: string, shiftId: number | null, outHhmm: string | null = null) {
  db.tables.time_entries.push({ id, employee_id: employee, shift_id: shiftId, clock_in_at: edt(hhmm), clock_out_at: outHhmm && edt(outHhmm), status: outHhmm ? "closed" : "open" });
}

test("off until the Slack token is set; posts nothing before the migration", async () => {
  delete process.env.SLACK_CASH_COUNT_BOT_TOKEN;
  assert.deepEqual(await tick("10:30"), { status: "off" });
  process.env.SLACK_CASH_COUNT_BOT_TOKEN = "xoxb-test";
  db.missingTables = ["cash_count_reminders"];
  clockIn(11, OPENER, "10:20", 1);
  assert.deepEqual(await tick("10:30"), { status: "not_migrated" });
  assert.equal(slack.posts.length, 0);
});

test("the opener clocks in: one AI-written reminder mentioning them, and no second one on later ticks", async () => {
  slack.claude.text = "Morning <@U0OPENER>! Thanks for opening, please post the register count and the cash box bundles here.";
  assert.equal((await tick("10:15")).status, "ran");
  assert.equal(slack.posts.length, 0, "nobody has clocked in yet");

  clockIn(11, OPENER, "10:20", 1);
  const first = await tick("10:20");
  assert.equal(first.status === "ran" && first.posted[0]?.source, "ai");
  assert.deepEqual(slack.posts, [{ text: slack.claude.text, thread_ts: undefined }]);

  await tick("10:25");
  await tick("10:30");
  assert.equal(slack.posts.length, 1, "never posted twice");
  const [row] = db.rows("cash_count_reminders");
  assert.equal(row.kind, "open");
  assert.equal(row.store_date, "2026-10-29");
  assert.deepEqual(row.profile_ids, [OPENER]);
  assert.deepEqual(row.slack_user_ids, ["U0OPENER"]);
  assert.equal(row.reminder_source, "ai");
});

test("nobody posts within 30 minutes: one follow-up in the thread, exactly once", async () => {
  slack.claude.text = "Hey <@U0OPENER>, please post the opening counts here when you can.";
  clockIn(11, OPENER, "10:20", 1);
  await tick("10:20");
  const reminderTs = slack.channel[0].ts;
  // A join notice and a bot do not count as someone posting.
  humanSays("<@U0NEW> has joined the channel", undefined, { subtype: "channel_join" });
  slack.channel.push({ ts: nextTs(), bot_id: "B0OTHER", text: "beep" });

  await tick("10:45");
  assert.equal(slack.posts.length, 1, "not yet 30 minutes");
  slack.claude.text = "<@U0OPENER> quick nudge: the opening counts are not posted yet, could you add them here?";
  await tick("10:50");
  assert.equal(slack.posts.length, 2);
  assert.deepEqual(slack.posts[1], { text: slack.claude.text, thread_ts: reminderTs });

  await tick("10:55");
  await tick("11:20");
  assert.equal(slack.posts.length, 2, "the follow-up fires once");
  assert.equal(db.rows("cash_count_reminders")[0].followup_outcome, "sent");
});

test("someone posted in the channel, or replied in the thread: no follow-up", async () => {
  slack.claude.text = "Hi <@U0OPENER>, please post the register count and cash box bundles here.";
  clockIn(11, OPENER, "10:20", 1, "16:02");
  await tick("10:20");
  humanSays("Register counted, bundles counted.");
  await tick("10:50");
  assert.equal(slack.posts.length, 1);
  assert.equal(db.rows("cash_count_reminders")[0].followup_outcome, "not_needed");

  // The closing reminder, answered in its thread.
  clockIn(12, CLOSER, "15:58", 2);
  slack.claude.text = "<@U0CLOSER> great close! Post the count, a photo of the printout with any difference, the bundles and the drop here.";
  await tick("22:02");
  assert.equal(slack.posts.length, 2);
  const closeTs = slack.channel.find((m) => m.text === slack.claude.text)!.ts;
  humanSays("done, photo attached", closeTs);
  await tick("22:35");
  assert.equal(slack.posts.length, 2);
  assert.equal(db.rows("cash_count_reminders").find((r) => r.kind === "close")!.followup_outcome, "not_needed");
});

test("just after closing: the person on the clock is mentioned, not the caterer still at an event", async () => {
  clockIn(12, CLOSER, "15:58", 2);
  clockIn(13, CATERER, "17:05", 3);
  slack.claude.text = "Nice work today <@U0CLOSER>! Please post the count, the printout photo and any difference, the bundles and the drop.";
  await tick("21:55");
  assert.equal(slack.posts.length, 0, "not closed yet");
  await tick("22:00");
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0].text, /<@U0CLOSER>/);
  assert.doesNotMatch(slack.posts[0].text, /U0CATER/);
  assert.deepEqual(db.rows("cash_count_reminders")[0].profile_ids, [CLOSER]);
});

test("Slack has another email for someone: they are matched by name", async () => {
  clockIn(14, NAMED, "15:58", null); // on the clock at closing with no shift
  db.tables.shifts = db.tables.shifts.filter((s) => s.id !== 2);
  slack.claude.text = "<@U0NAMED> store's closed! Please post the closing count, printout photo, bundles and drop here.";
  await tick("22:01");
  assert.deepEqual(db.rows("cash_count_reminders")[0].slack_user_ids, ["U0NAMED"]);
  assert.match(slack.posts[0].text, /<@U0NAMED>/);
});

test("the Claude API fails, or writes a dollar amount: the plain message goes out, so no reminder is lost", async () => {
  slack.claude.status = 400;
  clockIn(11, OPENER, "10:20", 1, "16:02");
  const res = await tick("10:20");
  assert.equal(res.status === "ran" && res.posted[0]?.source, "fallback");
  assert.match(slack.posts[0].text, /^<@U0OPENER> thanks for opening! Please post the opening cash counts here/);

  slack.claude.status = 200;
  slack.claude.text = "<@U0CLOSER> remember the register stays at $300, post the count.";
  clockIn(12, CLOSER, "15:58", 2);
  await tick("22:02");
  assert.equal(slack.posts.length, 2);
  assert.match(slack.posts[1].text, /^<@U0CLOSER> the store just closed\. Please post the closing cash counts here/);
  assert.equal(db.rows("cash_count_reminders").find((r) => r.kind === "close")!.reminder_source, "fallback");
});

test("Slack refuses the post: nothing is recorded, and the next tick posts it", async () => {
  slack.claude.text = "Morning <@U0OPENER>, please post the opening counts here.";
  slack.refusePosts = 1;
  clockIn(11, OPENER, "10:20", 1);
  const res = await tick("10:20");
  assert.equal(slack.posts.length, 0);
  assert.equal(db.rows("cash_count_reminders").length, 0);
  assert.ok(res.status === "ran" && res.errors.some((e) => /not_in_channel/.test(e)));
  await tick("10:25");
  assert.equal(slack.posts.length, 1);
});

test("the store is closed that day: no reminders", async () => {
  db.tables.store_hours_exceptions.push({ date: "2026-10-29", label: "Closed", is_closed: true, opens: null, closes: null });
  clockIn(11, OPENER, "10:20", 1);
  const res = await tick("10:25");
  assert.equal(res.status === "ran" && res.store, "closed");
  assert.equal(slack.posts.length, 0);
});

test("the 5-minute cron runs the reminders and reports them", async () => {
  slack.claude.text = "Hi <@U0OPENER>, please post the register count and cash box bundles here.";
  clockIn(11, OPENER, "10:20", 1);
  mock.timers.setTime(Date.parse(edt("10:22")));
  const res = await cron.GET(new Request("http://time.test/api/cron/missed-clockins"));
  const body = (await res.json()) as { cashCount: Run.CashCountResult };
  assert.equal(body.cashCount.status, "ran");
  assert.equal(slack.posts.length, 1);
});
