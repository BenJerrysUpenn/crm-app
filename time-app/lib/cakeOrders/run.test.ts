// The cake order packing reminders end to end, the way the bj-box job runs
// them every 5 minutes (lib/cakeOrders/run.ts, through cli.ts). The stories,
// from the owner's rules of 2026-11-03 (crm-app #142):
//   * A cake order email arrives while people are on store punches: one post
//     in #cake-orders-and-ideas @mentioning all of them, with the order
//     details, and no second one however many ticks follow (or however many
//     times the email is resent).
//   * It arrives overnight: held until 30 minutes after the first store
//     clock-in, then posted to everyone in.
//   * Not marked packed 60 minutes later: one reply in the post's thread,
//     with no mention, exactly once. A packed reaction, a thread reply, or a
//     channel message from someone mentioned means no reply; a cake idea from
//     someone else does not count.
//   * Claude fails: the plain message goes out instead.
//   * Slack refuses a post: nothing is recorded, the next tick tries again.
//     Slack does not answer: the record stays, so it never posts twice.
//   * The real parser on the real Olo emails: the milkshake and pint orders
//     are skipped with the order id and why, and a cake order is posted.
//   * A dry run posts nothing and writes nothing, and shows the messages.
//
// Stand-ins: the database (lib/testing/cakeOrderStore.ts, in memory); the
// mailbox as a MailReader; Slack's Web API at the HTTP boundary (the real
// slack.ts runs); Claude as an AskClaude. Most tests use a stand-in parser
// that reads a test-only JSON body, which is not Olo's format, so a test can
// state an order in one line; the real parser runs on the real Olo emails in
// fixtures/ (oloEmail.test.ts reads them field by field).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import { memoryCakeOrderStore, type MemoryCakeOrderStore } from "../testing/cakeOrderStore.ts";
import type * as Run from "./run.ts";
import type * as Slack from "./slack.ts";
import type { ClaudeAnswer } from "../cashCount/claudeCli.ts";
import type { MailMessage } from "./mail.ts";
import type { CakeOrder, ParsedEmail } from "./oloEmail.ts";

const { runCakeOrderReminders } = await loadAppModule<typeof Run>("lib/cakeOrders/run.ts");
const { slackClient } = await loadAppModule<typeof Slack>("lib/cakeOrders/slack.ts");

const CHANNEL = "C0B5QDB7RH8";
const ANA = "00000000-0000-0000-0000-00000000000a";
const BEN = "00000000-0000-0000-0000-00000000000b";
const CAT = "00000000-0000-0000-0000-00000000000c"; // on a catering shift

const SLACK_USERS: Slack.SlackUser[] = [
  { id: "U0ANA", real_name: "Ana Able", profile: { real_name: "Ana Able", email: "ana@example.test" } },
  { id: "U0BEN", real_name: "Ben Baker", profile: { real_name: "Ben Baker", email: "ben@example.test" } },
  { id: "U0CAT", real_name: "Cat Erer", profile: { real_name: "Cat Erer", email: "cat@example.test" } },
];
/** users.list's second page: people the time app knows by name only, or who left Slack. */
const SLACK_USERS_PAGE_2: Slack.SlackUser[] = [
  { id: "U0DEE", real_name: "Dee Dough", profile: { real_name: "Dee Dough", display_name: "dee" } },
  { id: "U0EVE", deleted: true, real_name: "Eve Early", profile: { real_name: "Eve Early", email: "eve@example.test" } },
  { id: "U0FAY1", real_name: "Fay Frost", profile: { real_name: "Fay Frost" } },
  { id: "U0FAY2", real_name: "Fay Frost", profile: { real_name: "Fay Frost" } },
];

const est = (hhmm: string, date = "2026-11-04") => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
let clock = Date.parse(est("08:00"));

type SlackMsg = { ts: string; user?: string; bot_id?: string; subtype?: string; text: string; thread_ts?: string };
let slack: {
  channel: SlackMsg[];
  posts: { channel: string; text: string; thread_ts?: string }[];
  reactions: Map<string, { name: string; count: number; users: string[] }[]>;
  refusePosts: number;
  downPosts: number;
  /** reactions.get answers not ok this many times. */
  refuseReads: number;
};
let claude: { fail: string | null; lead: string; followup: string; calls: number };
let db: MemoryCakeOrderStore;
let inbox: MailMessage[];
let mailDown: string | null;
let tsCounter = 0;
let uid = 100;

function nextTs(): string {
  tsCounter += 1;
  return `${Math.floor(clock / 1000)}.${String(tsCounter).padStart(6, "0")}`;
}

async function askClaude(req: { system: string; prompt: string }): Promise<ClaudeAnswer> {
  claude.calls += 1;
  if (claude.fail) return { ok: false, reason: claude.fail };
  return { ok: true, text: req.prompt.startsWith("Mention text:") ? claude.lead : claude.followup };
}

/** The test-only parser: a JSON body is a cake order, "not cake" is not one, anything else is unreadable. */
function testParser(raw: string): ParsedEmail {
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4).trim();
  if (body === "not cake") return { kind: "not_cake", order: "2001", why: "no cake on it" };
  if (body === "parser bug") throw new Error("Unexpected token in the email");
  try {
    return { kind: "cake_order", order: JSON.parse(body) as CakeOrder };
  } catch {
    return { kind: "unrecognised", why: "not a test order" };
  }
}

const ORDER: CakeOrder = { key: "1001", customer: "Pat Placeholder", pickupAt: est("17:00", "2026-11-05"), pickupText: "Thu 5pm", cake: ['8" Cookie Dough', "Message: Happy Birthday"] };

/** One of the raw Olo emails in fixtures/, arriving at hhmm. */
function oloEmailArrives(hhmm: string, fixture: string) {
  uid += 1;
  inbox.push({ uid, receivedAt: est(hhmm), raw: readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url)).toString("latin1") });
}

function emailArrives(hhmm: string, order: CakeOrder | string = ORDER, date?: string) {
  uid += 1;
  const body = typeof order === "string" ? order : JSON.stringify(order);
  inbox.push({ uid, receivedAt: est(hhmm, date), raw: `From: orders@example.test\r\nSubject: Order\r\nMessage-ID: <m${uid}@example.test>\r\n\r\n${body}\r\n` });
}

const tick = (
  hhmm: string,
  opts: { dryRun?: boolean; noClaude?: boolean; realParser?: boolean; date?: string; store?: Run.RunDeps["store"]; channel?: string } = {},
) => {
  clock = Date.parse(est(hhmm, opts.date));
  return runCakeOrderReminders({
    now: clock,
    store: opts.store ?? db,
    channel: opts.channel,
    slack: slackClient("xoxb-test"),
    mail: {
      async search(query) {
        assert.equal(query, 'to:orders@example.test subject:"Order Notification" newer_than:2d');
        if (mailDown) throw new Error(mailDown);
        return inbox.filter((m) => Date.parse(m.receivedAt) <= clock);
      },
    },
    orderAddress: "orders@example.test",
    ask: opts.noClaude ? null : askClaude,
    parse: opts.realParser ? undefined : testParser,
    dryRun: opts.dryRun,
    random: () => 0,
  });
};

const realFetch = globalThis.fetch;
async function external(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assert.equal(url.origin, "https://slack.com", `unexpected request to ${url.origin}`);
  assert.equal(request.headers.get("authorization"), "Bearer xoxb-test");
  const form = new URLSearchParams(await request.text());
  const method = url.pathname.replace("/api/", "");
  if (method === "chat.postMessage") {
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
    slack.posts.push({ channel: form.get("channel")!, text: msg.text, thread_ts: msg.thread_ts });
    return Response.json({ ok: true, ts: msg.ts });
  }
  if (method === "conversations.history") {
    const oldest = Number(form.get("oldest"));
    return Response.json({ ok: true, messages: slack.channel.filter((m) => !m.thread_ts && Number(m.ts) > oldest).reverse() });
  }
  if (method === "conversations.replies") {
    const ts = form.get("ts")!;
    return Response.json({ ok: true, messages: slack.channel.filter((m) => m.ts === ts || m.thread_ts === ts) });
  }
  if (method === "reactions.get") {
    if (slack.refuseReads > 0) {
      slack.refuseReads -= 1;
      return Response.json({ ok: false, error: "ratelimited" });
    }
    return Response.json({ ok: true, type: "message", message: { ts: form.get("timestamp"), reactions: slack.reactions.get(form.get("timestamp")!) ?? [] } });
  }
  if (method === "users.lookupByEmail") {
    const user = [...SLACK_USERS, ...SLACK_USERS_PAGE_2].find((u) => u.profile?.email === form.get("email"));
    return Response.json(user ? { ok: true, user } : { ok: false, error: "users_not_found" });
  }
  if (method === "users.list") {
    return form.get("cursor") === "page-2"
      ? Response.json({ ok: true, members: SLACK_USERS_PAGE_2, response_metadata: { next_cursor: "" } })
      : Response.json({ ok: true, members: SLACK_USERS, response_metadata: { next_cursor: "page-2" } });
  }
  throw new Error(`unexpected Slack method ${method}`);
}

const SLOT = (id: string, full_name: string, email: string | null) => ({ id, full_name, preferred_name: null, email });

beforeEach(() => {
  clock = Date.parse(est("08:00"));
  tsCounter = 0;
  uid = 100;
  slack = { channel: [], posts: [], reactions: new Map(), refusePosts: 0, downPosts: 0, refuseReads: 0 };
  claude = { fail: null, lead: "", followup: "", calls: 0 };
  inbox = [];
  mailDown = null;
  db = memoryCakeOrderStore({
    persons: [SLOT(ANA, "Ana Able", "ana@example.test"), SLOT(BEN, "Ben Baker", "ben@example.test"), SLOT(CAT, "Cat Erer", "cat@example.test")],
    types: [
      { name: "PENN Opener", in_store: true },
      { name: "Catering", in_store: false },
    ],
    shifts: [
      { id: 1, employee_id: ANA, starts_at: est("11:00"), ends_at: est("17:00"), position: "PENN Opener", deal_id: null, published: true },
      { id: 3, employee_id: CAT, starts_at: est("11:00"), ends_at: est("18:00"), position: "Catering", deal_id: 501, published: true },
    ],
  });
  globalThis.fetch = external as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function clockIn(id: number, employee: string, hhmm: string, shiftId: number | null, outHhmm: string | null = null) {
  db.entries.push({ id, employee_id: employee, shift_id: shiftId, clock_in_at: est(hhmm), clock_out_at: outHhmm ? est(outHhmm) : null });
}
function says(user: string, text: string, thread_ts?: string) {
  slack.channel.push({ ts: nextTs(), user, text, thread_ts });
}
const ran = (r: Run.CakeOrderResult) => {
  assert.equal(r.status, "ran");
  return r as Extract<Run.CakeOrderResult, { status: "ran" }>;
};

test("posts nothing before migration 54", async () => {
  db.migrated_ = false;
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  assert.deepEqual(await tick("12:00"), { status: "not_migrated" });
  assert.equal(slack.posts.length, 0);
});

test("an order while two are on store punches: one AI post mentioning both with the order details, and never a second", async () => {
  claude.lead = "<@U0ANA> and <@U0BEN>, a cake order just came in! Please pack it and react here when it's done 📦";
  clockIn(11, ANA, "11:00", 1);
  clockIn(12, BEN, "11:30", null); // the fob: no shift linked, still a store punch
  clockIn(13, CAT, "11:00", 3); // out at a catering event
  emailArrives("12:00");

  const first = ran(await tick("12:00"));
  assert.deepEqual(first.posted, [{ order: "1001", source: "ai", mentioned: 2, note: undefined }]);
  assert.deepEqual(first.mail, { read: 1, orders: 1, notCake: 0, unrecognised: 0 });
  assert.equal(slack.posts.length, 1);
  assert.equal(
    slack.posts[0].text,
    "<@U0ANA> and <@U0BEN>, a cake order just came in! Please pack it and react here when it's done 📦\n*Pat Placeholder*, pickup Thu Nov 5, 5:00 PM\n• 8\" Cookie Dough\n• Message: Happy Birthday",
  );
  assert.equal(slack.posts[0].thread_ts, undefined);
  assert.equal(slack.posts[0].channel, CHANNEL);
  const row = db.rows[0];
  assert.deepEqual([row.order_key, row.message_id, row.profile_ids, row.slack_user_ids, row.post_source], ["1001", "<m101@example.test>", [ANA, BEN], ["U0ANA", "U0BEN"], "ai"]);

  emailArrives("12:03"); // Olo resends the same order
  for (const at of ["12:05", "12:10", "12:30"]) ran(await tick(at));
  assert.equal(slack.posts.length, 1, "one post per order");
  assert.equal(claude.calls, 1);
});

test("an overnight order is held until 30 minutes after the first store clock-in", async () => {
  claude.lead = "<@U0ANA> morning! A cake order came in overnight, please pack it and reply here when done.";
  emailArrives("23:10", ORDER, "2026-11-03");
  const night = ran(await tick("23:15", { date: "2026-11-03" }));
  assert.deepEqual(night.held, [{ order: "1001", why: "nobody_clocked_in" }]);
  assert.equal(db.rows.length, 0, "a held order has no record yet");

  clockIn(11, ANA, "10:40", 1);
  const settling = ran(await tick("10:45"));
  assert.deepEqual(settling.held, [{ order: "1001", why: "settling_in until 11:10" }]);
  assert.equal(slack.posts.length, 0);

  const due = ran(await tick("11:10"));
  assert.equal(due.posted.length, 1);
  assert.match(slack.posts[0].text, /^<@U0ANA> morning!/);
});

test("not packed after 60 minutes: one reply in the thread, no mention, exactly once", async () => {
  claude.lead = "<@U0ANA> cake order! Please pack it and react when done.";
  claude.followup = "Quick nudge: please pack this cake if it isn't yet, and react or reply here when it's done 🙏";
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  await tick("12:00");
  says("U0IDEAS", "ooh what about a mint chip cake for the holidays?"); // a cake idea from someone not mentioned

  ran(await tick("12:55"));
  assert.equal(slack.posts.length, 1, "not yet");
  const due = ran(await tick("13:00"));
  assert.deepEqual(due.followups, [{ order: "1001", outcome: "sent", source: "ai", note: undefined }]);
  assert.equal(slack.posts[1].thread_ts, db.rows[0].post_ts);
  assert.ok(!slack.posts[1].text.includes("<@"), "no second mention");
  for (const at of ["13:05", "13:30", "15:00"]) await tick(at);
  assert.equal(slack.posts.length, 2, "exactly once");
  assert.equal(db.rows[0].followup_outcome, "sent");
});

test("packed by a reaction, a thread reply, or the mentioned person's next channel message: no follow-up", async () => {
  claude.lead = "<@U0ANA> cake order! Please pack it and react when done.";
  clockIn(11, ANA, "11:00", 1);
  const o2 = { ...ORDER, key: "1002" };
  const o3 = { ...ORDER, key: "1003" };
  emailArrives("12:00");
  await tick("12:00");
  slack.reactions.set(db.rows[0].post_ts!, [{ name: "white_check_mark::skin-tone-3", count: 1, users: ["U0ANA"] }]);

  emailArrives("12:10", o2);
  await tick("12:10");
  says("U0BEN", "packed it", db.rows[1].post_ts!); // a reply in its thread, by anyone

  emailArrives("12:20", o3);
  await tick("12:20");
  says("U0ANA", "done!"); // the next channel message, from the one mentioned

  await tick("13:20");
  assert.deepEqual(
    db.rows.map((r) => [r.order_key, r.followup_outcome, r.packed_how]),
    [
      ["1001", "not_needed", "reaction"],
      ["1002", "not_needed", "reply"],
      ["1003", "not_needed", "channel_message"],
    ],
  );
  assert.equal(slack.posts.length, 3, "no follow-ups");
});

test("Claude fails: the plain post and the plain reply go out", async () => {
  claude.fail = "claude error 429: usage limit";
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  const r = ran(await tick("12:00"));
  assert.deepEqual(r.posted, [{ order: "1001", source: "fallback", mentioned: 1, note: "claude error 429: usage limit" }]);
  assert.match(slack.posts[0].text, /^<@U0ANA> a new cake order just came in\. Please pack it, then react/);
  await tick("13:00");
  assert.match(slack.posts[1].text, /^Friendly reminder: this cake order is not marked packed yet/);
  assert.equal(db.rows[0].followup_source, "fallback");
});

test("Slack refuses the post: nothing is recorded and the next tick posts it; no answer at all: never posted twice", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  slack.refusePosts = 1;
  const refused = ran(await tick("12:00", { noClaude: true }));
  assert.deepEqual(refused.errors, ["order 1001: Slack refused (not_in_channel)"]);
  assert.equal(db.rows.length, 0);
  ran(await tick("12:05", { noClaude: true }));
  assert.equal(slack.posts.length, 1);

  emailArrives("12:10", { ...ORDER, key: "1002" });
  slack.downPosts = 1;
  const down = ran(await tick("12:10", { noClaude: true }));
  assert.match(down.errors[0], /^order 1002: chat.postMessage: HTTP 503/);
  ran(await tick("12:15", { noClaude: true }));
  assert.equal(slack.posts.length, 1, "the order Slack may have posted is not posted again");
  assert.equal(db.rows.find((r) => r.order_key === "1002")!.post_ts, null);
});

test("an order whose pickup has passed, and a non-cake order, are not posted", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00", { ...ORDER, pickupAt: est("12:30") });
  emailArrives("12:01", "not cake");
  const r = ran(await tick("13:00"));
  assert.deepEqual(r.held, [{ order: "1001", why: "pickup_passed" }]);
  assert.deepEqual(r.mail, { read: 2, orders: 1, notCake: 1, unrecognised: 0 });
  assert.deepEqual(r.skipped, [{ order: "2001", why: "no cake on it" }]);
  assert.equal(slack.posts.length, 0);
});

test("the real parser on the real Olo emails: the milkshake and pints are skipped with why, the cake order is posted once", async () => {
  claude.lead = "<@U0ANA> a cake order just came in! Please pack it and react here when it's done 📦";
  clockIn(11, ANA, "11:00", 1);
  oloEmailArrives("12:00", "olo-order-uber-milkshake.eml");
  oloEmailArrives("12:01", "olo-order-doordash-two-pints.eml");
  oloEmailArrives("12:02", "olo-order-doordash-pint.eml");
  oloEmailArrives("12:03", "olo-order-cake-DERIVED.eml"); // derived from a real email, see its X-Fixture header
  emailArrives("12:04", "Your weekly summary"); // not from Olo

  const r = ran(await tick("12:05", { realParser: true }));
  assert.deepEqual(r.mail, { read: 5, orders: 1, notCake: 4, unrecognised: 0 });
  assert.deepEqual(r.skipped, [
    { order: "47729604891115532", why: "no cake on it: 1 x Custom Milkshake (20oz) (Paid Via Uber Eats)" },
    { order: "47730533409587210", why: "no cake on it: 1 x Fresh Packed Pint (16oz), 1 x Fresh Packed Pint (16oz) (Paid by DoorDash)" },
    { order: "47730730709549057", why: "no cake on it: 1 x Fresh Packed Pint (16oz) (Paid by DoorDash)" },
  ]);
  assert.deepEqual(r.posted, [{ order: "47729604891100001", source: "ai", mentioned: 1, note: undefined }]);
  assert.equal(
    slack.posts[0].text,
    `${claude.lead}\n*Pat P. 0000C*, pickup Thu Nov 5, 3:00 PM\n• 1 x Celebration Cake: No Allergy Concerns; Medium Round 8" (Serves 8-10); Cake Batter; Standard Frosting; Happy Birthday!`,
  );
  assert.equal(db.rows[0].pickup_at, "2026-11-05T20:00:00.000Z");

  ran(await tick("12:10", { realParser: true }));
  assert.equal(slack.posts.length, 1, "the cake order is posted once");
});

test("the mailbox cannot be read: the error is reported and follow-ups still go out", async () => {
  claude.lead = "<@U0ANA> cake order! Please pack it and react when done.";
  claude.followup = "Please pack this one and reply here when it's done!";
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  await tick("12:00");
  mailDown = "IMAP login failed: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)";
  const r = ran(await tick("13:00"));
  assert.equal(r.mail, null);
  assert.deepEqual(r.errors, ["mail: IMAP login failed: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)"]);
  assert.equal(r.followups[0].outcome, "sent");
});

test("a dry run posts nothing and writes nothing, and shows the due post, the unread emails and the previews", async () => {
  claude.lead = "<@U0ANA> cake order! Please pack it and react when done.";
  claude.followup = "Please pack this one and reply here when it's done!";
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  emailArrives("12:01", "Your weekly summary");
  const r = ran(await tick("12:05", { dryRun: true }));
  assert.equal(slack.posts.length, 0);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(r.unread, [{ from: "orders@example.test", subject: "Order", why: "not a test order" }]);
  assert.deepEqual(
    r.messages!.map((m) => [m.occasion, m.when, m.order, m.to]),
    [["post", "due", "1001", ["<@U0ANA>"]]],
  );

  // Nothing due: a preview of a post and a follow-up for whoever is on the clock.
  inbox = [];
  const quiet = ran(await tick("12:10", { dryRun: true }));
  assert.deepEqual(
    quiet.messages!.map((m) => [m.occasion, m.when]),
    [
      ["post", "preview"],
      ["followup", "preview"],
    ],
  );
  assert.deepEqual(db.writes, []);
});

test("a post more than 3 hours old with no follow-up yet (the box was off) gets none, and is settled as expired", async () => {
  claude.lead = "<@U0ANA> cake order! Please pack it and react when done.";
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  await tick("12:00");
  const late = ran(await tick("15:05"));
  assert.deepEqual(late.followups, [{ order: "1001", outcome: "expired" }]);
  assert.equal(db.rows[0].followup_outcome, "expired");
  await tick("15:10");
  assert.equal(slack.posts.length, 1, "no reply, then or later");
});

test("Slack cannot say whether it was packed: no reply on that tick, the error is reported, and the next tick checks again", async () => {
  claude.lead = "<@U0ANA> cake order! Please pack it and react when done.";
  claude.followup = "Please pack this one and reply here when it's done!";
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  await tick("12:00");
  slack.refuseReads = 1;
  const blind = ran(await tick("13:00"));
  assert.deepEqual(blind.errors, ["follow-up 1001: reactions: ratelimited"]);
  assert.deepEqual(blind.followups, []);
  assert.equal(slack.posts.length, 1);
  const next = ran(await tick("13:05"));
  assert.equal(next.followups[0].outcome, "sent");
  assert.equal(slack.posts.length, 2);
});

test("Slack refuses the follow-up: the next tick sends it", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  await tick("12:00", { noClaude: true });
  slack.refusePosts = 1;
  const refused = ran(await tick("13:00", { noClaude: true }));
  assert.deepEqual(refused.errors, ["follow-up 1001: Slack refused (not_in_channel)"]);
  assert.equal(db.rows[0].followup_outcome, null);
  const retried = ran(await tick("13:05", { noClaude: true }));
  assert.deepEqual(retried.followups, [{ order: "1001", outcome: "sent", source: "fallback", note: "no Claude subscription token" }]);
  assert.equal(slack.posts[1].thread_ts, db.rows[0].post_ts);
});

test("Slack does not answer the follow-up: it may have gone out, so it is never sent again", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  await tick("12:00", { noClaude: true });
  slack.downPosts = 1;
  const down = ran(await tick("13:00", { noClaude: true }));
  assert.match(down.errors[0], /^follow-up 1001: chat\.postMessage: HTTP 503/);
  assert.equal(db.rows[0].followup_outcome, "failed");
  for (const at of ["13:05", "13:30"]) ran(await tick(at, { noClaude: true }));
  assert.equal(slack.posts.length, 1);
});

test("two ticks at once: the one that loses the order or the follow-up to the other posts nothing", async () => {
  claude.lead = "<@U0ANA> cake order! Please pack it and react when done.";
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  // The other tick records the order between this tick's read and its claim.
  const orderRace = { ...db, claimOrder: async (row: Parameters<typeof db.claimOrder>[0]) => (await db.claimOrder(row), db.claimOrder(row)) };
  const lost = ran(await tick("12:00", { store: orderRace }));
  assert.deepEqual([lost.posted, lost.errors, slack.posts.length, claude.calls], [[], [], 0, 0]);

  db.rows = [];
  await tick("12:05");
  assert.equal(slack.posts.length, 1);
  // The other tick claims the follow-up first.
  const followupRace = {
    ...db,
    claimFollowup: async (...args: Parameters<typeof db.claimFollowup>) => (await db.claimFollowup(args[0], "sending", args[2]), db.claimFollowup(...args)),
  };
  const second = ran(await tick("13:05", { store: followupRace }));
  assert.deepEqual([second.followups, second.errors, slack.posts.length], [[], [], 1]);
});

test("the same order in two emails on one tick is posted once, and a dry run shows it once", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  emailArrives("12:01");
  const dry = ran(await tick("12:05", { dryRun: true, noClaude: true }));
  assert.deepEqual(dry.messages!.map((m) => [m.occasion, m.when, m.order]), [["post", "due", "1001"]]);
  const r = ran(await tick("12:05", { noClaude: true }));
  assert.deepEqual(r.mail, { read: 2, orders: 2, notCake: 0, unrecognised: 0 });
  assert.equal(r.posted.length, 1);
  assert.equal(slack.posts.length, 1);
});

test("a parser that throws on one email counts it as unreadable and the run goes on", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00", "parser bug");
  emailArrives("12:01");
  const r = ran(await tick("12:05", { noClaude: true }));
  assert.deepEqual(r.mail, { read: 2, orders: 1, notCake: 0, unrecognised: 1 });
  assert.deepEqual(r.errors, []);
  assert.equal(slack.posts.length, 1);
  const dry = ran(await tick("12:10", { dryRun: true, noClaude: true }));
  assert.deepEqual(dry.unread, [{ from: "orders@example.test", subject: "Order", why: "the parser failed: Unexpected token in the email" }]);
});

test("the punches cannot be read: the error is reported, nothing is recorded, and the next tick posts", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  db.fail.add("punches");
  const r = ran(await tick("12:00", { noClaude: true }));
  assert.deepEqual(r.errors, ["shifts or punches: connection lost (punches)"]);
  assert.equal(r.onClock, null);
  assert.equal(db.rows.length, 0);
  ran(await tick("12:05", { noClaude: true }));
  assert.equal(slack.posts.length, 1);
});

test("orders received more than 60 days ago are pruned on a run, never on a dry run, and a failed prune is reported", async () => {
  const old = (key: string, daysAgo: number) =>
    db.claimOrder({
      order_key: key,
      message_id: `<${key}@example.test>`,
      received_at: new Date(Date.parse(est("12:00")) - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
      pickup_at: null,
      profile_ids: [ANA],
      slack_user_ids: ["U0ANA"],
      channel_id: CHANNEL,
    });
  await old("old", 61);
  await old("recent", 59);
  db.writes = [];
  ran(await tick("12:00", { dryRun: true }));
  assert.deepEqual(db.writes, []);
  assert.equal(db.rows.length, 2);

  ran(await tick("12:00"));
  assert.deepEqual(db.rows.map((r) => r.order_key), ["recent"]);

  db.fail.add("prune");
  const failed = ran(await tick("12:05"));
  assert.deepEqual(failed.errors, ["prune: connection lost (prune)"]);
});

test("staff are matched to Slack by sign-in email, else by a unique name; anyone unmatched is named, not mentioned", async () => {
  const DEE = "00000000-0000-0000-0000-00000000000d"; // no sign-in email; one Slack member has her name
  const EVE = "00000000-0000-0000-0000-00000000000e"; // her Slack account was deactivated
  const FAY = "00000000-0000-0000-0000-00000000000f"; // two Slack members share her name
  db.persons.push(
    { id: DEE, full_name: "Dee Dough", preferred_name: null, email: null },
    { id: EVE, full_name: "Eve Early", preferred_name: "Evie", email: "eve@example.test" },
    { id: FAY, full_name: "Fay Frost", preferred_name: null, email: null },
  );
  clockIn(11, ANA, "11:00", 1);
  clockIn(12, DEE, "11:01", null);
  clockIn(13, EVE, "11:02", null);
  clockIn(14, FAY, "11:03", null);
  emailArrives("12:00");
  const r = ran(await tick("12:00", { noClaude: true }));
  assert.equal(r.posted[0].mentioned, 2);
  assert.ok(slack.posts[0].text.startsWith("<@U0ANA>, <@U0DEE>, Evie and Fay Frost a new cake order just came in."), slack.posts[0].text);
  assert.deepEqual(db.rows[0].slack_user_ids, ["U0ANA", "U0DEE", "", ""]);
});

test("the channel can be moved: the post and its follow-up go there", async () => {
  clockIn(11, ANA, "11:00", 1);
  emailArrives("12:00");
  await tick("12:00", { noClaude: true, channel: "C0MOVED" });
  await tick("13:00", { noClaude: true, channel: "C0MOVED" });
  assert.deepEqual(
    slack.posts.map((p) => [p.channel, p.thread_ts ? "thread" : "top"]),
    [
      ["C0MOVED", "top"],
      ["C0MOVED", "thread"],
    ],
  );
});
