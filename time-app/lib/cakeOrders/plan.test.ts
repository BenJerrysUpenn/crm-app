// Who the cake order reminders mention, when, and whether an order is packed
// (lib/cakeOrders/plan.ts). The owner's rules, 2026-11-03 (crm-app #142):
// everyone on a store punch when the email arrives; nobody in, then 30
// minutes after the first store clock-in; packed by a reaction, a thread
// reply, or the next channel message from someone mentioned; one follow-up
// 60 minutes after the post. Invented people and shifts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Plan from "./plan.ts";

const plan = await loadAppModule<typeof Plan>("lib/cakeOrders/plan.ts");
const { decidePost, followupStep, isPackedReaction, onStoreClock, packedHow } = plan;

const at = (hhmm: string, date = "2026-11-04") => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
const t = (hhmm: string, date?: string) => Date.parse(at(hhmm, date));

const IN_STORE = new Map([
  ["PENN Opener", true],
  ["Catering", false],
]);

function snap(entries: Plan.PlanEntry[], shifts: Plan.PlanShift[] = []): Plan.PunchSnapshot {
  return { shifts, entries, inStoreByName: IN_STORE };
}
const punch = (id: number, who: string, inAt: string, outAt: string | null = null, shift_id: number | null = null): Plan.PlanEntry => ({
  id,
  employee_id: who,
  shift_id,
  clock_in_at: inAt,
  clock_out_at: outAt,
});
const order = (receivedAt: string, pickupAt: string | null = null) => ({ key: "1001", receivedAt: Date.parse(receivedAt), pickupAt: pickupAt ? Date.parse(pickupAt) : null });

test("an order that arrives while people are on store punches goes to all of them at once", () => {
  const s = snap([punch(1, "ana", at("10:00")), punch(2, "ben", at("12:00")), punch(3, "cy", at("09:00"), at("11:00"))]);
  assert.deepEqual(decidePost(order(at("13:00")), s, t("13:00")), { action: "post", profileIds: ["ana", "ben"], why: "on_clock" });
});

test("a catering punch is not on a store shift; a punch with no shift is", () => {
  const shifts: Plan.PlanShift[] = [
    { id: 7, employee_id: "cat", starts_at: at("12:00"), ends_at: at("18:00"), position: "Catering", deal_id: 501, published: true },
  ];
  const s = snap([punch(1, "cat", at("12:00"), null, 7), punch(2, "fob", at("12:30"))], shifts);
  assert.deepEqual(onStoreClock(s, t("13:00")), ["fob"]);
});

test("a punch left open more than 16 hours is a forgotten clock-out, not someone on shift", () => {
  const s = snap([punch(1, "old", at("08:00", "2026-11-03"))]);
  assert.deepEqual(onStoreClock(s, t("13:00")), []);
});

test("an overnight order waits until 30 minutes after the first store clock-in, then mentions everyone in", () => {
  const night = at("23:10", "2026-11-03");
  assert.deepEqual(decidePost(order(night), snap([]), t("09:00")), { action: "hold", why: "nobody_clocked_in" });

  const s = snap([punch(1, "ana", at("10:40")), punch(2, "ben", at("10:55"))]);
  assert.deepEqual(decidePost(order(night), s, t("11:05")), { action: "hold", why: "settling_in", until: t("11:10") });
  assert.deepEqual(decidePost(order(night), s, t("11:10")), { action: "post", profileIds: ["ana", "ben"], why: "after_first_clock_in" });
});

test("a punch closed before the email arrived does not count as someone in", () => {
  const s = snap([punch(1, "ana", at("10:00"), at("12:00"))]);
  assert.deepEqual(decidePost(order(at("12:30")), s, t("12:30")), { action: "hold", why: "nobody_clocked_in" });
});

test("if everyone has clocked out again when the hold ends, the post waits for the next one in", () => {
  const s = snap([punch(1, "ana", at("10:00"), at("10:20"))]);
  assert.deepEqual(decidePost(order(at("08:00")), s, t("10:45")), { action: "hold", why: "nobody_on_clock_now" });
});

test("an order whose pickup has passed is never posted", () => {
  const s = snap([punch(1, "ana", at("10:00"))]);
  assert.deepEqual(decidePost(order(at("10:30"), at("12:00")), s, t("12:00")), { action: "skip", why: "pickup_passed" });
});

test("the follow-up waits 60 minutes, then checks, and is stale after 180", () => {
  const posted = t("12:00");
  assert.equal(followupStep(posted, t("12:59")), "wait");
  assert.equal(followupStep(posted, t("13:00")), "check");
  assert.equal(followupStep(posted, t("15:00")), "check");
  assert.equal(followupStep(posted, t("15:01")), "expired");
});

test("packed reactions, skin tones included; a heart or a cake is not packed", () => {
  for (const name of ["package", "white_check_mark", "heavy_check_mark", "+1", "+1::skin-tone-4", "ok_hand::skin-tone-2", "raised_hands"]) {
    assert.equal(isPackedReaction(name), true, name);
  }
  for (const name of ["heart", "birthday", "cake", "eyes", "thinking_face"]) assert.equal(isPackedReaction(name), false, name);
});

test("packed: a reaction, a thread reply, or the next channel message from someone mentioned", () => {
  const base = { postTs: "100.000001", mentioned: ["U0ANA", "U0BEN"], reactions: [], thread: [], channel: [], laterPostTs: [] };
  assert.equal(packedHow(base), null);
  assert.equal(packedHow({ ...base, reactions: [{ name: "eyes", count: 1 }] }), null);
  assert.equal(packedHow({ ...base, reactions: [{ name: "package", count: 1, users: ["U0CY"] }] }), "reaction");
  assert.equal(
    packedHow({ ...base, thread: [{ ts: "100.000001", bot_id: "B0" }, { ts: "100.000005", user: "U0CY", text: "got it", thread_ts: "100.000001" }] }),
    "reply",
  );
  assert.equal(packedHow({ ...base, channel: [{ ts: "100.000009", user: "U0BEN", text: "packed!" }] }), "channel_message");
});

test("a channel message from someone not mentioned, a bot, or after the next cake post does not count", () => {
  const base = { postTs: "100.000001", mentioned: ["U0ANA"], reactions: [], thread: [], laterPostTs: ["200.000001"] };
  assert.equal(packedHow({ ...base, channel: [{ ts: "100.000009", user: "U0IDEAS", text: "what about a mint cake?" }] }), null);
  assert.equal(packedHow({ ...base, channel: [{ ts: "100.000009", bot_id: "B0", user: "U0ANA", text: "beep" }] }), null);
  assert.equal(packedHow({ ...base, channel: [{ ts: "200.000009", user: "U0ANA", text: "done" }] }), null, "that one is about the next order");
  assert.equal(packedHow({ ...base, channel: [{ ts: "150.000000", user: "U0ANA", text: "done", thread_ts: "150.000000" }] }), "channel_message", "a top-level message that has a thread of its own");
});

test("the bot's own thread parent does not count as a reply", () => {
  assert.equal(packedHow({ postTs: "100.000001", mentioned: [], reactions: [], channel: [], laterPostTs: [], thread: [{ ts: "100.000001", user: "U0BOTUSER", bot_id: "B0" }] }), null);
});
