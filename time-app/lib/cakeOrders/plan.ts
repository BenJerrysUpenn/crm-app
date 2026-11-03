// Who the cake order packing reminders in Slack #cake-orders-and-ideas go to,
// and when, and whether an order has been marked packed. Pure: the cron
// (lib/cakeOrders/run.ts) loads the punches and the Slack thread and asks
// these functions; nothing here reads a clock, the database, the mailbox or
// Slack.
//
// The owner's rules (2026-11-03, crm-app #142):
//   * POST. When an Olo cake order email arrives, @mention everyone clocked
//     in on a store shift, with the customer, pickup time and what the cake
//     is, asking them to pack it and react or reply when done.
//   * NOBODY CLOCKED IN. If nobody is on a store punch when the email
//     arrives (orders come in overnight), hold the post until 30 minutes after
//     the first store clock-in, because opening has a lot of tasks. At that
//     point everyone on a store punch is mentioned; if they have all clocked
//     out again, the post waits for the next one on the clock.
//   * PACKED. A positive reaction on the post, a reply in its thread, or the
//     next channel message from someone the post mentioned. The channel also
//     carries cake ideas, so a message from someone not mentioned does not
//     count, and neither does one after the next cake order post (that one is
//     about the next order).
//   * FOLLOW-UP. Not packed 60 minutes after the post: reply once in the
//     post's thread. No second @mention: the people mentioned follow the
//     thread. Managers are not alerted.
//
// "On a store punch" is cash count's word for it (lib/cashCount/plan.ts): a
// time_entries row with no clock-out (or a clock-out after the instant asked
// about) whose shift, by its link or the clock's own link rule
// (shiftForEntry), is a store shift (isStoreShift), or that has no shift at
// all. A punch open longer than 16 hours is a forgotten clock-out, not
// someone on shift.

import { MAX_PUNCH_MIN, MIN, isStoreShift, shiftForEntry, type PlanEntry, type PlanShift } from "../cashCount/plan";
import type { SlackMessage } from "../cashCount/slack";

export { MAX_PUNCH_MIN, MIN };
/** The post waits this long after the first store clock-in when nobody was in as the email arrived. */
export const HOLD_AFTER_CLOCK_IN_MIN = 30;
/** The follow-up is due this long after the post. */
export const FOLLOWUP_AFTER_MIN = 60;
/** Later than this after the post, the follow-up is skipped: the machine running the cron was off. */
export const FOLLOWUP_STALE_MIN = 180;

export type { PlanEntry, PlanShift };

/** The punches and shifts around the orders being planned, as the cron loads them. */
export type PunchSnapshot = {
  shifts: PlanShift[];
  entries: PlanEntry[];
  /** shift_types.in_store by name. */
  inStoreByName: Map<string, boolean>;
};

const ms = (iso: string) => new Date(iso).getTime();

/** True when `entry` is a store punch: its shift is a store shift, or it has none. */
export function isStorePunch(entry: PlanEntry, snap: PunchSnapshot): boolean {
  const shift = shiftForEntry(entry, snap.shifts);
  return !shift || isStoreShift(shift, snap.inStoreByName);
}

/** Store punches open at `at`, earliest clock-in first. */
function openStorePunches(snap: PunchSnapshot, at: number): PlanEntry[] {
  return snap.entries
    .filter((e) => {
      const inAt = ms(e.clock_in_at);
      if (inAt > at || inAt < at - MAX_PUNCH_MIN * MIN) return false;
      if (e.clock_out_at && ms(e.clock_out_at) <= at) return false;
      return isStorePunch(e, snap);
    })
    .sort((a, b) => ms(a.clock_in_at) - ms(b.clock_in_at) || a.id - b.id);
}

/** Everyone on a store punch at `at` (profile ids, earliest clock-in first, each once). */
export function onStoreClock(snap: PunchSnapshot, at: number): string[] {
  return [...new Set(openStorePunches(snap, at).map((e) => e.employee_id))];
}

/** The first store clock-in at or after `from` and no later than `until`, or null. */
export function firstStoreClockIn(snap: PunchSnapshot, from: number, until: number): number | null {
  let first: number | null = null;
  for (const e of snap.entries) {
    const inAt = ms(e.clock_in_at);
    if (inAt < from || inAt > until || !isStorePunch(e, snap)) continue;
    if (first === null || inAt < first) first = inAt;
  }
  return first;
}

// ---- when an order is posted ---------------------------------------------------

/** What the plan needs to know about an order: when its email arrived and when it is picked up. */
export type PlannedOrder = { receivedAt: number; pickupAt: number | null };

export type PostDecision =
  | { action: "post"; profileIds: string[]; why: "on_clock" | "after_first_clock_in" }
  | { action: "hold"; why: "nobody_clocked_in" | "settling_in" | "nobody_on_clock_now"; until?: number }
  | { action: "skip"; why: "pickup_passed" };

/** Whether to post `order` at `now`: see POST and NOBODY CLOCKED IN above. */
export function decidePost(order: PlannedOrder, snap: PunchSnapshot, now: number): PostDecision {
  if (order.pickupAt !== null && order.pickupAt <= now) return { action: "skip", why: "pickup_passed" };
  const inAtArrival = onStoreClock(snap, order.receivedAt);
  let why: "on_clock" | "after_first_clock_in" = "on_clock";
  if (inAtArrival.length === 0) {
    const first = firstStoreClockIn(snap, order.receivedAt, now);
    if (first === null) return { action: "hold", why: "nobody_clocked_in" };
    const dueAt = first + HOLD_AFTER_CLOCK_IN_MIN * MIN;
    if (now < dueAt) return { action: "hold", why: "settling_in", until: dueAt };
    why = "after_first_clock_in";
  }
  const profileIds = onStoreClock(snap, now);
  if (profileIds.length === 0) return { action: "hold", why: "nobody_on_clock_now" };
  return { action: "post", profileIds, why };
}

// ---- the follow-up ----------------------------------------------------------------

export type FollowupStep = "wait" | "check" | "expired";

/** What to do about a post's follow-up at `now`. "check" means: see whether it is packed, and reply if not. */
export function followupStep(postedAt: number, now: number): FollowupStep {
  const age = now - postedAt;
  if (age < FOLLOWUP_AFTER_MIN * MIN) return "wait";
  if (age > FOLLOWUP_STALE_MIN * MIN) return "expired";
  return "check";
}

// ---- packed ------------------------------------------------------------------------

// Reactions that say "done". Slack names them without colons, and a skin tone
// comes as a suffix ("+1::skin-tone-3"). 🎂 and ❤️ are left out: on a cake
// post they mean "nice", not "packed".
const PACKED_REACTIONS = new Set([
  "package", // 📦
  "white_check_mark", // ✅
  "heavy_check_mark", // ✔️
  "ballot_box_with_check", // ☑️
  "+1", // 👍
  "thumbsup",
  "ok_hand", // 👌
  "raised_hands", // 🙌
  "clap", // 👏
  "muscle", // 💪
  "100", // 💯
  "tada", // 🎉
  "ok", // 🆗
  "done",
  "check",
]);

/** True when a reaction name (skin tone or not) says the order is packed. */
export function isPackedReaction(name: string): boolean {
  return PACKED_REACTIONS.has(name.split("::")[0]);
}

export type SlackReaction = { name: string; count?: number; users?: string[] };

// Message subtypes that are a person posting (as cash count's isHumanPostAfter).
const PERSON_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);
const isPerson = (m: SlackMessage) => !!m.user && !m.bot_id && PERSON_SUBTYPES.has(m.subtype);

export type PackedHow = "reaction" | "reply" | "channel_message";

/**
 * How the post at `postTs` was marked packed, or null when it was not: a
 * packed reaction on it; a reply by a person in its thread; or a top-level
 * message by someone it mentioned, after it and before the next cake order
 * post (`laterPostTs`, the ts of every cake order post after it).
 */
export function packedHow(args: {
  postTs: string;
  mentioned: string[];
  reactions: SlackReaction[];
  thread: SlackMessage[];
  channel: SlackMessage[];
  laterPostTs: string[];
}): PackedHow | null {
  const { postTs } = args;
  if (args.reactions.some((r) => isPackedReaction(r.name) && (r.count ?? r.users?.length ?? 1) > 0)) return "reaction";
  if (args.thread.some((m) => m.ts !== postTs && isPerson(m) && Number(m.ts) > Number(postTs))) return "reply";
  const mentioned = new Set(args.mentioned.filter(Boolean));
  const nextPost = args.laterPostTs.map(Number).filter((t) => t > Number(postTs)).sort((a, b) => a - b)[0] ?? Infinity;
  const said = args.channel.some(
    // Top level: no thread, or the parent of one (its thread_ts is its own ts).
    (m) => (!m.thread_ts || m.thread_ts === m.ts) && isPerson(m) && mentioned.has(m.user!) && Number(m.ts) > Number(postTs) && Number(m.ts) < nextPost,
  );
  return said ? "channel_message" : null;
}
