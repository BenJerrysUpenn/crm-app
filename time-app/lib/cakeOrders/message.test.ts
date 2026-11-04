// The words of a cake order post and its follow-up (lib/cakeOrders/message.ts):
// Claude writes the first line and the thread reply, both checked and
// replaced by a plain message whenever the AI step fails; the customer's name
// under it is copied from the email by code, never by Claude. Claude is a stand-in
// here; lib/cashCount/claudeCli.test.ts drives the real child process.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Message from "./message.ts";
import type { CakeOrder } from "./oloEmail.ts";

const m = await loadAppModule<typeof Message>("lib/cakeOrders/message.ts");
const { FALLBACK_FOLLOWUP, orderName, validateFollowup, validateLead, writeFollowup, writePost } = m;

const ANA = { token: "<@U0ANA>" };
const BEN = { token: "<@U0BEN>" };
const ORDER: CakeOrder = {
  key: "1001",
  customer: "Pat Placeholder",
  pickupAt: "2026-11-04T20:00:00.000Z",
  pickupText: "Nov 4, 3:00 PM",
  cake: ['8" round, Cookie Dough & Fudge', "Message: Happy <b>day</b>"],
};

type Asked = { system: string; prompt: string };
function claudeSaying(answer: string | { ok: false; reason: string }) {
  const seen: Asked[] = [];
  const ask = async (req: Asked) => {
    seen.push(req);
    return typeof answer === "string" ? { ok: true as const, text: answer } : answer;
  };
  return { seen, ask };
}

test("a good first line passes: each mention once, asks to pack it and react or reply", () => {
  assert.deepEqual(validateLead("<@U0ANA> and <@U0BEN>, a cake order just landed 🎂 Please pack it and react here when it's done!", [ANA, BEN]), { ok: true });
});

test("a first line is rejected for a missing or doubled mention, another mention, a link, a number, money, or not asking", () => {
  // Each case breaks one rule, and the reason names that rule (it is the note the run records).
  const why = (text: string) => {
    const v = validateLead(text, [ANA]);
    return v.ok ? "accepted" : v.reason;
  };
  assert.equal(why("A cake order! Please pack it and react when done."), "mention <@U0ANA> appears 0 times");
  assert.equal(why("<@U0ANA> <@U0ANA> please pack it and react when done."), "mention <@U0ANA> appears 2 times");
  assert.equal(why("<@U0ANA> and <@U0CY> please pack it and react when done."), "another mention");
  assert.equal(why("<@U0ANA> <!here> please pack it and react when done."), "another mention");
  assert.equal(why("<@U0ANA> @channel please pack it and react when done."), "another mention");
  assert.equal(why("<@U0ANA> pickup at 3, please pack it and react when done."), "a number");
  assert.equal(why("<@U0ANA> a $$ cake, please pack it and react when done."), "a dollar sign");
  assert.equal(why("<@U0ANA> see https://x.test and pack it, react when done."), "a link");
  assert.equal(why("<@U0ANA> a cake order came in, react when you see it."), "does not ask them to pack it");
  assert.equal(why("<@U0ANA> a cake order came in, please pack it."), "does not ask them to react or reply");
  assert.equal(why(`<@U0ANA> please pack it and react when done.${" so good".repeat(40)}`), "longer than 240 characters");
  assert.equal(why("<@U0ANA> a cake order!\nPlease pack it\nand react when done."), "more than 2 lines");
  assert.equal(why("   "), "empty");
});

test("the follow-up has no mention at all", () => {
  assert.deepEqual(validateFollowup("Quick nudge: if this cake is not packed yet, please pack it and react or reply here when it's done 📦"), { ok: true });
  assert.equal(validateFollowup("<@U0ANA> please pack it and reply here when done.").ok, false);
  assert.equal(validateFollowup("@channel please pack it and reply here when done.").ok, false);
  assert.equal(validateFollowup(FALLBACK_FOLLOWUP).ok, true, "the plain reply passes its own check");
});

const DETAILS = "*Pat Placeholder*";

test("under Claude's line is the customer's name only: no pickup time, no cake", () => {
  assert.equal(orderName(ORDER), DETAILS);
  assert.equal(orderName({ ...ORDER, customer: "  Pat <b>&\n Co  " }), "*Pat &lt;b&gt;&amp; Co*", "one line, escaped for Slack");
  assert.equal(orderName({ ...ORDER, customer: "x".repeat(100) }), `*${"x".repeat(79)}…*`, "cut at 80 characters");
  assert.equal(orderName({ ...ORDER, customer: "y".repeat(80) }), `*${"y".repeat(80)}*`, "a name of exactly 80 characters is posted whole");
  assert.equal(orderName({ ...ORDER, customer: "z".repeat(81) }), `*${"z".repeat(79)}…*`, "one character over is cut");
});

test("writePost: Claude's line, then the name; Claude never sees the order", async () => {
  const claude = claudeSaying("<@U0ANA> new cake order! Please pack it and react when it's done 📦");
  const w = await writePost({ ask: claude.ask, people: [ANA], order: ORDER, random: () => 0 });
  assert.equal(w.source, "ai");
  assert.equal(w.text, `<@U0ANA> new cake order! Please pack it and react when it's done 📦\n${DETAILS}`);
  assert.equal(claude.seen.length, 1);
  assert.ok(!claude.seen[0].prompt.includes("Pat") && !claude.seen[0].prompt.includes("Cookie"), "no order details in the prompt");
  assert.match(claude.seen[0].prompt, /Mention text: <@U0ANA>/);
});

test("writePost falls back to the plain line on any failure, with the name still there", async () => {
  const failing = claudeSaying({ ok: false, reason: "claude timed out after 45s" });
  const w = await writePost({ ask: failing.ask, people: [ANA, BEN], order: ORDER });
  assert.equal(w.source, "fallback");
  assert.equal(w.note, "claude timed out after 45s");
  assert.ok(w.text.startsWith("<@U0ANA> and <@U0BEN> a new custom cake order just came in. Please pack it"));
  assert.ok(w.text.endsWith(`when it is done.\n${DETAILS}`));

  const rejected = await writePost({ ask: claudeSaying("Pack the cake at 3pm!").ask, people: [ANA], order: ORDER });
  assert.equal(rejected.source, "fallback");
  assert.match(rejected.note!, /^AI message rejected: /);

  const none = await writePost({ ask: null, people: [ANA], order: ORDER });
  assert.deepEqual([none.source, none.note], ["fallback", "no Claude subscription token"]);
});

test("writeFollowup: Claude's reply, or the plain one", async () => {
  const ok = await writeFollowup({ ask: claudeSaying("Gentle nudge: please pack this one and reply here when done 🙏").ask });
  assert.deepEqual(ok, { text: "Gentle nudge: please pack this one and reply here when done 🙏", source: "ai" });
  const mentioned = await writeFollowup({ ask: claudeSaying("<@U0ANA> please pack it and reply here when done.").ask });
  assert.deepEqual([mentioned.text, mentioned.source, mentioned.note], [FALLBACK_FOLLOWUP, "fallback", "AI message rejected: a mention"]);
  const failed = await writeFollowup({ ask: claudeSaying({ ok: false, reason: "claude timed out after 45s" }).ask });
  assert.deepEqual(failed, { text: FALLBACK_FOLLOWUP, source: "fallback", note: "claude timed out after 45s" });
  assert.deepEqual(await writeFollowup({ ask: null }), { text: FALLBACK_FOLLOWUP, source: "fallback", note: "no Claude subscription token" });
});
