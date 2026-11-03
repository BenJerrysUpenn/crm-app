// The words of a cake order post and its follow-up (lib/cakeOrders/message.ts):
// Claude writes the first line and the thread reply, both checked and
// replaced by a plain message whenever the AI step fails; the order details
// are copied from the email by code, never by Claude. Claude is a stand-in
// here; lib/cashCount/claudeCli.test.ts drives the real child process.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Message from "./message.ts";
import type { CakeOrder } from "./oloEmail.ts";

const m = await loadAppModule<typeof Message>("lib/cakeOrders/message.ts");
const { FALLBACK_FOLLOWUP, orderDetails, validateFollowup, validateLead, writeFollowup, writePost } = m;

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

test("a good first line passes: each mention once, asks to pack and react or reply", () => {
  assert.deepEqual(validateLead("<@U0ANA> and <@U0BEN>, a cake order just landed 🎂 Please pack it and react here when it's done!", [ANA, BEN]), { ok: true });
});

test("a first line is rejected for a missing or doubled mention, another mention, a link, a number, money, or not asking", () => {
  const bad = (text: string) => validateLead(text, [ANA]).ok;
  assert.equal(bad("A cake order! Please pack it and react when done."), false, "no mention");
  assert.equal(bad("<@U0ANA> <@U0ANA> please pack it and react when done."), false, "twice");
  assert.equal(bad("<@U0ANA> and <@U0CY> please pack it and react when done."), false, "someone else");
  assert.equal(bad("<@U0ANA> <!here> please pack it and react when done."), false, "@here");
  assert.equal(bad("<@U0ANA> pickup at 3, please pack it and react when done."), false, "a time");
  assert.equal(bad("<@U0ANA> a $40 cake, please pack it and react when done."), false, "money");
  assert.equal(bad("<@U0ANA> see https://x.test and pack it, react when done."), false, "a link");
  assert.equal(bad("<@U0ANA> a cake order came in, react when you see it."), false, "does not ask to pack");
  assert.equal(bad("<@U0ANA> a cake order came in, please pack it."), false, "does not ask for a reaction or reply");
  assert.equal(bad(`<@U0ANA> please pack it and react when done.${" so good".repeat(40)}`), false, "too long");
});

test("the follow-up has no mention at all", () => {
  assert.deepEqual(validateFollowup("Quick nudge: if this cake is not packed yet, please pack it and react or reply here when it's done 📦"), { ok: true });
  assert.equal(validateFollowup("<@U0ANA> please pack it and reply here when done.").ok, false);
  assert.equal(validateFollowup("@channel please pack it and reply here when done.").ok, false);
  assert.equal(validateFollowup(FALLBACK_FOLLOWUP).ok, true, "the plain reply passes its own check");
});

test("the order details are copied from the email, escaped for Slack, pickup in New York time", () => {
  assert.equal(orderDetails(ORDER), '*Pat Placeholder*, pickup Wed Nov 4, 3:00 PM\n• 8" round, Cookie Dough &amp; Fudge\n• Message: Happy &lt;b&gt;day&lt;/b&gt;');
  assert.equal(orderDetails({ ...ORDER, pickupAt: null }).split("\n")[0], "*Pat Placeholder*, pickup Nov 4, 3:00 PM");
});

test("writePost: Claude's line, then the details; Claude never sees the order", async () => {
  const claude = claudeSaying("<@U0ANA> new cake order! Please pack it and react when it's done 📦");
  const w = await writePost({ ask: claude.ask, people: [ANA], order: ORDER, random: () => 0 });
  assert.equal(w.source, "ai");
  assert.equal(w.text, `<@U0ANA> new cake order! Please pack it and react when it's done 📦\n${orderDetails(ORDER)}`);
  assert.equal(claude.seen.length, 1);
  assert.ok(!claude.seen[0].prompt.includes("Pat") && !claude.seen[0].prompt.includes("Cookie"), "no order details in the prompt");
  assert.match(claude.seen[0].prompt, /Mention text: <@U0ANA>/);
});

test("writePost falls back to the plain line on any failure, with the details still there", async () => {
  const failing = claudeSaying({ ok: false, reason: "claude timed out after 45s" });
  const w = await writePost({ ask: failing.ask, people: [ANA, BEN], order: ORDER });
  assert.equal(w.source, "fallback");
  assert.equal(w.note, "claude timed out after 45s");
  assert.ok(w.text.startsWith("<@U0ANA> and <@U0BEN> a new cake order just came in. Please pack it"));
  assert.ok(w.text.endsWith(orderDetails(ORDER)));

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
  assert.deepEqual([mentioned.text, mentioned.source], [FALLBACK_FOLLOWUP, "fallback"]);
});
