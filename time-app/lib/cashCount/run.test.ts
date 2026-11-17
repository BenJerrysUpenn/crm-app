// The cash count reminders end to end, the way the bj-box job runs them every
// 5 minutes (lib/cashCount/run.ts, through cli.ts). The stories, from the
// owner's rules of 2026-10-29:
//   * The opener clocks in: one reminder in #cash-count @mentioning them, and
//     no second one however many ticks follow.
//   * Just after closing: one reminder @mentioning one person: the one on the
//     clock, not the caterer still out at an event; of several on the clock,
//     the scheduled closer.
//   * Nobody posts within 30 minutes: one follow-up in the reminder's thread,
//     exactly once, to the same person. Someone posting in the channel or the
//     thread means no follow-up; a join notice or a bot does not count.
//   * Claude Code fails or writes something that fails the checks: the plain
//     message goes out instead, so the reminder is never lost.
//   * Slack refuses a post: nothing is recorded, and the next tick tries again.
//   * Staff are matched to Slack by email, else by name.
//   * A dry run posts nothing and writes nothing, and shows the messages.
//
// Stand-ins: the database (lib/testing/cashCountStore.ts, in memory); Slack's
// Web API at the HTTP boundary (the real slack.ts runs); Claude as an
// AskClaude that answers what the test says (claudeCli.test.ts drives the
// real child process).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import { memoryCashCountStore, type MemoryCashCountStore } from "../testing/cashCountStore.ts";
import type * as Run from "./run.ts";
import type * as Slack from "./slack.ts";
import type { ClaudeAnswer } from "./claudeCli.ts";

const { runCashCountReminders } = await loadAppModule<typeof Run>("lib/cashCount/run.ts");
const { slackClient } = await loadAppModule<typeof Slack>("lib/cashCount/slack.ts");

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
let clock = Date.parse(edt("08:00"));
const tick = (hhmm: string, opts: { dryRun?: boolean; noClaude?: boolean; date?: string } = {}) => {
  clock = Date.parse(edt(hhmm, opts.date));
  return runCashCountReminders({
    now: clock,
    store: db,
    slack: slackClient("xoxb-test"),
    ask: opts.noClaude ? null : askClaude,
    dryRun: opts.dryRun,
  });
};

type SlackMsg = { ts: string; user?: string; bot_id?: string; subtype?: string; text: string; thread_ts?: string };
let slack: {
  channel: SlackMsg[];
  posts: { text: string; thread_ts?: string }[];
  refusePosts: number;
  /** Posts Slack does not answer (HTTP 503): whether they went out is unknown. */
  downPosts: number;
  claude: { fail: string | null; text: string; calls: number; prompts: string[] };
  /** Slack's error for reading the rules message, or null when it reads. */
  rulesError: string | null;
};
let db: MemoryCashCountStore;
let tsCounter = 0;

function nextTs(): string {
  tsCounter += 1;
  return `${Math.floor(clock / 1000)}.${String(tsCounter).padStart(6, "0")}`;
}

async function askClaude(req: { system: string; prompt: string }): Promise<ClaudeAnswer> {
  slack.claude.calls += 1;
  slack.claude.prompts.push(req.prompt);
  return slack.claude.fail ? { ok: false, reason: slack.claude.fail } : { ok: true, text: slack.claude.text };
}

const realFetch = globalThis.fetch;
async function external(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assert.equal(url.origin, "https://slack.com", `unexpected request to ${url.origin}`);
  assert.equal(request.headers.get("authorization"), "Bearer xoxb-test");
  const form = new URLSearchParams(await request.text());
  const method = url.pathname.replace("/api/", "");
  if (method === "chat.postMessage") {
    assert.equal(form.get("channel"), CHANNEL);
    if (slack.downPosts > 0) {
      slack.downPosts -= 1;
      return new Response("upstream unavailable", { status: 503 });
    }
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
      if (slack.rulesError) return Response.json({ ok: false, error: slack.rulesError });
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
  if (method === "users.list") {
    // Two pages, as Slack's cursor gives a bigger workspace: Nina is on the second.
    const second = form.get("cursor") === "page2";
    const members = second ? SLACK_USERS.slice(3) : SLACK_USERS.slice(0, 3);
    return Response.json({ ok: true, members, response_metadata: { next_cursor: second ? "" : "page2" } });
  }
  throw new Error(`unexpected Slack method ${method}`);
}

function humanSays(text: string, thread_ts?: string, extra: Partial<SlackMsg> = {}) {
  slack.channel.push({ ts: nextTs(), user: "U0CLOSER", text, thread_ts, ...extra });
}

const SLOT = (id: string, full_name: string, email: string | null) => ({ id, full_name, preferred_name: null, email });

beforeEach(() => {
  clock = Date.parse(edt("08:00"));
  tsCounter = 0;
  slack = { channel: [], posts: [], refusePosts: 0, downPosts: 0, claude: { fail: null, text: "", calls: 0, prompts: [] }, rulesError: null };
  db = memoryCashCountStore({
    persons: [
      SLOT(OPENER, "Olive Opener", "olive@example.test"),
      SLOT(CLOSER, "Cass Closer", "cass@example.test"),
      SLOT(CATERER, "Cat Erer", "cat@example.test"),
      SLOT(NAMED, "Nina Named", "nina@example.test"),
    ],
    day: {
      // 11:00 to 22:00 every day.
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens: "11:00:00", closes: "22:00:00" })),
      exceptions: [],
      closed: [],
      shiftTypes: [
        { name: "PENN Opener", in_store: true },
        { name: "PENN Closer", in_store: true },
        { name: "Catering", in_store: false },
      ],
    },
    shifts: [
      { id: 1, employee_id: OPENER, starts_at: edt("10:00"), ends_at: edt("16:00"), position: "PENN Opener", deal_id: null, published: true },
      { id: 2, employee_id: CLOSER, starts_at: edt("16:00"), ends_at: edt("23:00"), position: "PENN Closer", deal_id: null, published: true },
      { id: 3, employee_id: CATERER, starts_at: edt("17:00"), ends_at: edt("23:30"), position: "Catering", deal_id: 501, published: true },
    ],
  });
  globalThis.fetch = external as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function clockIn(id: number, employee: string, hhmm: string, shiftId: number | null, outHhmm: string | null = null) {
  db.entries.push({ id, employee_id: employee, shift_id: shiftId, clock_in_at: edt(hhmm), clock_out_at: outHhmm ? edt(outHhmm) : null });
}

test("posts nothing before migration 51", async () => {
  db.migrated_ = false;
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
  assert.ok(slack.claude.prompts[0].includes(RULES), "Claude writes from the cash count steps as they read in the channel now");

  await tick("10:25");
  await tick("10:30");
  assert.equal(slack.posts.length, 1, "never posted twice");
  const [row] = db.rows;
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
  slack.channel.push({ ts: nextTs(), bot_id: "B0OTHER", user: "U0APPUSER", text: "beep" });

  await tick("10:45");
  assert.equal(slack.posts.length, 1, "not yet 30 minutes");
  slack.claude.text = "<@U0OPENER> quick nudge: the opening counts are not posted yet, could you add them here?";
  await tick("10:50");
  assert.equal(slack.posts.length, 2);
  assert.deepEqual(slack.posts[1], { text: slack.claude.text, thread_ts: reminderTs });

  await tick("10:55");
  await tick("11:20");
  assert.equal(slack.posts.length, 2, "the follow-up fires once");
  assert.equal(db.rows[0].followup_outcome, "sent");
});

test("someone posted in the channel, or replied in the thread: no follow-up", async () => {
  slack.claude.text = "Hi <@U0OPENER>, please post the register count and cash box bundles here.";
  clockIn(11, OPENER, "10:20", 1, "16:02");
  await tick("10:20");
  humanSays("Register counted, bundles counted.");
  await tick("10:50");
  assert.equal(slack.posts.length, 1);
  assert.equal(db.rows[0].followup_outcome, "not_needed");

  // The closing reminder, answered in its thread.
  clockIn(12, CLOSER, "15:58", 2);
  slack.claude.text = "<@U0CLOSER> great close! Post the count, a photo of the printout with any difference, the bundles and the drop here.";
  await tick("22:02");
  assert.equal(slack.posts.length, 2);
  const closeTs = slack.channel.find((m) => m.text === slack.claude.text)!.ts;
  humanSays("done, photo attached", closeTs);
  await tick("22:35");
  assert.equal(slack.posts.length, 2);
  assert.equal(db.rows.find((r) => r.kind === "close")!.followup_outcome, "not_needed");
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
  assert.deepEqual(db.rows[0].profile_ids, [CLOSER]);
});

test("Slack has another email for someone: they are matched by name", async () => {
  clockIn(14, NAMED, "15:58", null); // on the clock at closing with no shift
  db.shifts = db.shifts.filter((s) => s.id !== 2);
  slack.claude.text = "<@U0NAMED> store's closed! Please post the closing count, printout photo, bundles and drop here.";
  await tick("22:01");
  assert.deepEqual(db.rows[0].slack_user_ids, ["U0NAMED"]);
  assert.match(slack.posts[0].text, /<@U0NAMED>/);
});

test("someone Slack does not know by email or name is addressed by name, with no mention", async () => {
  const PAT = "00000000-0000-0000-0000-00000000000e";
  db.persons.push({ id: PAT, full_name: "Patricia Nobody", preferred_name: "Pat", email: null });
  clockIn(15, PAT, "15:58", null); // on the clock at closing; no auth email, no Slack member of that name
  slack.claude.text = "Thanks Pat! The store's closed, please post the closing counts here.";
  const res = await tick("22:01");
  assert.deepEqual(slack.posts, [{ text: "Thanks Pat! The store's closed, please post the closing counts here.", thread_ts: undefined }]);
  assert.ok(res.status === "ran");
  assert.equal(res.posted[0].mentioned, 0);
  assert.deepEqual(db.rows[0].slack_user_ids, [""]);
});

test("the cash count steps cannot be read: the plain message goes out and Claude is not asked", async () => {
  slack.rulesError = "message_not_found";
  slack.claude.text = "Morning <@U0OPENER>, please post the opening counts here.";
  clockIn(11, OPENER, "10:20", 1);
  const res = await tick("10:20");
  assert.equal(slack.claude.calls, 0);
  assert.equal(slack.posts[0].text, "<@U0OPENER> thanks for opening! Please post the opening cash counts here, as the cash count steps in this channel say.");
  assert.ok(res.status === "ran");
  assert.equal(res.posted[0].source, "fallback");
  assert.ok(res.errors.includes("rules message: message_not_found"));
});

test("Claude Code fails, or writes a dollar amount: the plain message goes out, so no reminder is lost", async () => {
  slack.claude.fail = "claude error 429: Claude AI usage limit reached";
  clockIn(11, OPENER, "10:20", 1, "16:02");
  const res = await tick("10:20");
  assert.equal(res.status === "ran" && res.posted[0]?.source, "fallback");
  assert.match(slack.posts[0].text, /^<@U0OPENER> thanks for opening! Please post the opening cash counts here/);

  slack.claude.fail = null;
  slack.claude.text = "<@U0CLOSER> remember the register stays at $300, post the count.";
  clockIn(12, CLOSER, "15:58", 2);
  await tick("22:02");
  assert.equal(slack.posts.length, 2);
  assert.match(slack.posts[1].text, /^<@U0CLOSER> the store just closed\. Please post the closing cash counts here/);
  assert.equal(db.rows.find((r) => r.kind === "close")!.reminder_source, "fallback");
});

test("Slack refuses the post: nothing is recorded, and the next tick posts it", async () => {
  slack.claude.text = "Morning <@U0OPENER>, please post the opening counts here.";
  slack.refusePosts = 1;
  clockIn(11, OPENER, "10:20", 1);
  const res = await tick("10:20");
  assert.equal(slack.posts.length, 0);
  assert.equal(db.rows.length, 0);
  assert.ok(res.status === "ran" && res.errors.some((e) => /not_in_channel/.test(e)));
  await tick("10:25");
  assert.equal(slack.posts.length, 1);
});

test("Slack does not answer the post: the record stays, so a reminder that may have gone out is never posted again", async () => {
  slack.claude.text = "Morning <@U0OPENER>, please post the opening counts here.";
  slack.downPosts = 1;
  clockIn(11, OPENER, "10:20", 1);
  const res = await tick("10:20");
  assert.ok(res.status === "ran" && res.errors.some((e) => /chat\.postMessage: HTTP 503/.test(e)));
  await tick("10:25");
  await tick("10:55");
  assert.equal(slack.posts.length, 0, "no second reminder, and no follow-up to one that may not exist");
  assert.equal(db.rows.length, 1);
});

test("Slack refuses the follow-up: the next tick sends it in the thread", async () => {
  slack.claude.text = "Hey <@U0OPENER>, please post the opening counts here when you can.";
  clockIn(11, OPENER, "10:20", 1);
  await tick("10:20");
  const reminderTs = slack.channel[0].ts;
  slack.refusePosts = 1;
  const res = await tick("10:50");
  assert.equal(slack.posts.length, 1);
  assert.ok(res.status === "ran" && res.errors.some((e) => /follow-up open: Slack refused \(not_in_channel\)/.test(e)));
  await tick("10:55");
  assert.equal(slack.posts.length, 2);
  assert.equal(slack.posts[1].thread_ts, reminderTs);
  assert.equal(db.rows[0].followup_outcome, "sent");
});

test("the cron was off for over two hours: the follow-up is skipped, not sent late", async () => {
  slack.claude.text = "Hey <@U0OPENER>, please post the opening counts here when you can.";
  clockIn(11, OPENER, "10:20", 1, "16:02");
  await tick("10:20");
  const res = await tick("12:25");
  assert.equal(slack.posts.length, 1);
  assert.ok(res.status === "ran");
  assert.deepEqual(res.followups, [{ kind: "open", outcome: "expired" }]);
  assert.equal(db.rows[0].followup_outcome, "expired");
});

test("the store is closed that day: no reminders", async () => {
  db.day.exceptions.push({ date: "2026-10-29", label: "Closed", is_closed: true, opens: null, closes: null });
  clockIn(11, OPENER, "10:20", 1);
  const res = await tick("10:25");
  assert.equal(res.status === "ran" && res.store, "closed");
  assert.equal(slack.posts.length, 0);
});

test("several on the clock at closing: one reminder to the scheduled closer, and the follow-up to them alone", async () => {
  clockIn(12, CLOSER, "15:58", 2);
  clockIn(14, NAMED, "18:10", null); // an unscheduled manager, in later
  slack.claude.text = "<@U0CLOSER> nice close! Please post the count, the printout photo, the bundles and the drop.";
  await tick("22:01");
  assert.equal(slack.posts.length, 1);
  assert.doesNotMatch(slack.posts[0].text, /U0NAMED/);
  assert.deepEqual(db.rows[0].profile_ids, [CLOSER]);
  slack.claude.text = "<@U0CLOSER> gentle nudge: the closing counts are not posted yet.";
  await tick("22:32");
  assert.equal(slack.posts.length, 2);
  assert.match(slack.posts[1].text, /^<@U0CLOSER> gentle nudge/);
  assert.ok(slack.claude.prompts[1].includes("Mention text: <@U0CLOSER>\n"), "the follow-up mentions only the closer");
});

test("no Claude token: every reminder is the plain message", async () => {
  clockIn(11, OPENER, "10:20", 1);
  const res = await tick("10:20", { noClaude: true });
  assert.ok(res.status === "ran");
  assert.deepEqual(res.posted, [{ kind: "open", source: "fallback", mentioned: 1, note: "no Claude subscription token" }]);
  assert.equal(slack.claude.calls, 0);
});

test("a dry run writes the due messages and previews, but posts nothing and writes nothing", async () => {
  clockIn(11, OPENER, "10:20", 1);
  slack.claude.text = "Morning <@U0OPENER>! Please post the register count and the cash box bundles here.";
  const res = await tick("10:22", { dryRun: true });
  assert.ok(res.status === "ran");
  assert.equal(slack.posts.length, 0, "nothing posted");
  assert.deepEqual(db.writes, [], "nothing written");
  assert.deepEqual(res.hours, { opens: "11:00", closes: "22:00" });
  assert.deepEqual(
    res.messages?.map((m) => [m.kind, m.when, m.why, m.to, m.source]),
    [
      ["open", "due", "opening_shift", ["<@U0OPENER>"], "ai"],
      // Nobody on the clock for closing yet: the scheduled closer.
      ["close", "preview", "scheduled", ["<@U0CLOSER>"], "fallback"],
    ],
  );
  assert.equal(res.messages?.[0].text, slack.claude.text);
  assert.match(res.messages?.[1].note ?? "", /AI message rejected/, "the opener's text, reused for the closer, fails the mention check");

  // A real tick afterwards still posts: the dry run claimed nothing.
  await tick("10:23");
  assert.equal(slack.posts.length, 1);

  // A follow-up that is due: shown, not claimed.
  const writes = db.writes.length;
  slack.claude.text = "<@U0OPENER> friendly nudge: the opening counts are not posted yet.";
  const later = await tick("10:55", { dryRun: true });
  assert.ok(later.status === "ran");
  assert.deepEqual(later.messages?.[0], {
    kind: "open",
    occasion: "followup",
    when: "due",
    why: "nobody posted",
    to: ["<@U0OPENER>"],
    source: "ai",
    text: "<@U0OPENER> friendly nudge: the opening counts are not posted yet.",
  });
  assert.equal(db.writes.length, writes);
  assert.equal(db.rows[0].followup_outcome, null);
  assert.equal(slack.posts.length, 1);
});

test("the database fails mid-tick: the error is reported and nothing is posted twice", async () => {
  clockIn(11, OPENER, "10:20", 1);
  db.fail.add("reminders");
  const res = await tick("10:20");
  assert.ok(res.status === "ran" && res.errors[0] === "reminders: connection lost (reminders)");
  assert.equal(slack.posts.length, 0);
  slack.claude.text = "Morning <@U0OPENER>, please post the opening counts here.";
  await tick("10:25");
  await tick("10:30");
  assert.equal(slack.posts.length, 1);
});

test("a photo of the counts (a file share) counts as someone posting: no follow-up", async () => {
  slack.claude.text = "Hi <@U0OPENER>, please post the register count and cash box bundles here.";
  clockIn(11, OPENER, "10:20", 1, "16:02");
  await tick("10:20");
  humanSays("", undefined, { subtype: "file_share" });
  await tick("10:50");
  assert.equal(slack.posts.length, 1);
  assert.equal(db.rows[0].followup_outcome, "not_needed");
});

test("a deleted Slack account is never mentioned, by email or by name: the person is addressed by name", async () => {
  const GONE = "00000000-0000-0000-0000-00000000000f";
  SLACK_USERS.push({ id: "U0GONE", deleted: true, real_name: "Gil Gone", profile: { real_name: "Gil Gone", email: "gil@example.test" } } as (typeof SLACK_USERS)[number]);
  try {
    db.persons.push({ id: GONE, full_name: "Gil Gone", preferred_name: null, email: "gil@example.test" });
    clockIn(16, GONE, "15:58", null);
    db.shifts = db.shifts.filter((s) => s.id !== 2);
    slack.claude.text = "Thanks Gil Gone! The store's closed, please post the closing counts here.";
    await tick("22:01");
    assert.deepEqual(db.rows[0].slack_user_ids, [""]);
    assert.doesNotMatch(slack.posts[0].text, /U0GONE/);
  } finally {
    SLACK_USERS.pop();
  }
});

test("two Slack members with the person's name: no guess, the person is addressed by name", async () => {
  const SAM = "00000000-0000-0000-0000-000000000010";
  SLACK_USERS.push(
    { id: "U0SAM1", real_name: "Sam Same", profile: { real_name: "Sam Same", email: "sam1@example.test" } },
    { id: "U0SAM2", real_name: "Sam Same", profile: { real_name: "Sam Same", email: "sam2@example.test" } },
  );
  try {
    db.persons.push({ id: SAM, full_name: "Sam Same", preferred_name: null, email: null });
    clockIn(17, SAM, "15:58", null);
    db.shifts = db.shifts.filter((s) => s.id !== 2);
    slack.claude.text = "Thanks Sam Same! The store's closed, please post the closing counts here.";
    const res = await tick("22:01");
    assert.ok(res.status === "ran");
    assert.equal(res.posted[0].mentioned, 0);
    assert.deepEqual(db.rows[0].slack_user_ids, [""]);
  } finally {
    SLACK_USERS.splice(-2, 2);
  }
});

test("Slack does not answer the follow-up: it is marked failed and never sent again", async () => {
  slack.claude.text = "Hey <@U0OPENER>, please post the opening counts here when you can.";
  clockIn(11, OPENER, "10:20", 1);
  await tick("10:20");
  slack.downPosts = 1;
  const res = await tick("10:50");
  assert.ok(res.status === "ran" && res.errors.some((e) => /follow-up open: chat\.postMessage: HTTP 503/.test(e)));
  await tick("10:55");
  await tick("11:00");
  assert.equal(slack.posts.length, 1, "a follow-up that may have gone out is not repeated");
  assert.equal(db.rows[0].followup_outcome, "failed");
});

test("another tick claimed the follow-up first: this one posts nothing", async () => {
  slack.claude.text = "Hey <@U0OPENER>, please post the opening counts here when you can.";
  clockIn(11, OPENER, "10:20", 1);
  await tick("10:20");
  // The database as it is when a second tick wins the claim between this tick's read and its claim.
  const claim = db.claimFollowup;
  db.claimFollowup = async (id, outcome, at) => {
    await claim(id, "sending", at);
    return claim(id, outcome, at);
  };
  await tick("10:50");
  assert.equal(slack.posts.length, 1);
});

test("a closing reminder late in the evening still gets its follow-up after midnight", async () => {
  db.day.exceptions.push({ date: "2026-10-29", label: "Late night", is_closed: false, opens: "11:00:00", closes: "23:40:00" });
  clockIn(12, CLOSER, "15:58", 2);
  slack.claude.text = "<@U0CLOSER> great close! Please post the count, the printout photo, the bundles and the drop.";
  await tick("23:41");
  assert.equal(slack.posts.length, 1);
  slack.claude.text = "<@U0CLOSER> gentle nudge: the closing counts are not posted yet.";
  await tick("00:12", { date: "2026-10-30" });
  assert.equal(slack.posts.length, 2);
  assert.equal(slack.posts[1].thread_ts, slack.channel[0].ts);
  assert.equal(db.rows[0].followup_outcome, "sent");
});

test("reminders are kept for 60 days, then deleted", async () => {
  const old = (id: number, store_date: string) => ({
    id,
    store_date,
    kind: "open" as const,
    profile_ids: [OPENER],
    slack_user_ids: ["U0OPENER"],
    channel_id: CHANNEL,
    reminder_ts: "1788000000.000001",
    reminder_source: "ai",
    posted_at: `${store_date}T14:30:00.000Z`,
    followup_outcome: "not_needed",
    followup_ts: null,
    followup_source: null,
    followup_at: null,
  });
  db.rows.push(old(901, "2026-08-29"), old(902, "2026-08-30"));
  await tick("09:00");
  assert.deepEqual(db.rows.map((r) => r.store_date), ["2026-08-30"], "60 days before 2026-10-29 is kept; the day before it is deleted");
});
