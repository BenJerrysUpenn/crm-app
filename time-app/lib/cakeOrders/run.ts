// The cake order packing reminders in Slack #cake-orders-and-ideas, one pass.
// The bj-box job (scripts/cake-order-reminders.ts at the crm-app root,
// through cli.ts) runs it every 5 minutes from a systemd timer
// (Software-Factory droplet/). The orders: Olo's per-order email, read from
// the mailbox (mail.ts) and parsed (oloEmail.ts). Who and when: plan.ts. The
// words: message.ts, written by Claude Code on the owner's subscription
// (lib/cashCount/claudeCli.ts). The database: store.ts.
//
// ONCE EACH. An order is recorded in cake_order_reminders (migration 54)
// BEFORE it is posted; the unique order_key means a second tick finds it and
// posts nothing. If Slack refuses the post (it answers, not ok), the record is
// removed so the next tick tries again; if Slack does not answer at all, the
// record stays, so a post that may have gone out is never repeated. The
// follow-up is claimed with an update guarded on followup_outcome being null,
// so it is decided once. An order held because nobody is clocked in has no
// record yet: its email stays in the mailbox, and each tick looks again for
// MAIL_DAYS days.
//
// DRY RUN. Everything is read (the database, the mailbox, Slack users, the
// channel, reactions and threads) and every message that is due is written by
// Claude, but nothing is posted and nothing is written to the database. It
// also lists the emails it could not read as orders, and writes a preview of
// a post and a follow-up for whoever is on the clock now, so a dry run at any
// hour shows Claude answering.

import { nyWallClock } from "../coverage";
import { MAX_PUNCH_MIN, MIN, decidePost, followupStep, onStoreClock, packedHow, type PunchSnapshot } from "./plan";
import { writeFollowup, writePost, type Addressee, type Occasion, type Written } from "./message";
import type { AskClaude } from "../cashCount/claudeCli";
import { headerOf, type MailReader } from "./mail";
import { orderMailQuery, parseOloOrderEmail, type CakeOrder, type ParseEmail } from "./oloEmail";
import type { SlackClient, SlackUser } from "./slack";
import type { CakeOrderStore, OrderRow, Person } from "./store";

export const DEFAULT_CHANNEL = "C0B5QDB7RH8"; // #cake-orders-and-ideas
/** Order emails this many days old or newer are read on every tick. */
export const MAIL_DAYS = 2;
const KEEP_DAYS = 60;
/** The clock's link rule looks this far either side of a punch for its shift. */
const LINK_WINDOW_MIN = 4 * 60;

export type RunDeps = {
  /** The tick's instant (ms). */
  now: number;
  store: CakeOrderStore;
  slack: SlackClient;
  mail: MailReader;
  /** The address Olo sends each order to (CAKE_ORDERS_ORDER_ADDRESS). */
  orderAddress: string;
  /** Null when there is no Claude subscription token: every message is the plain one. */
  ask: AskClaude | null;
  /** The Olo email parser; the real one unless a test hands its own. */
  parse?: ParseEmail;
  channel?: string;
  dryRun?: boolean;
  random?: () => number;
};

/** A message a dry run would post (or previews). */
export type DryMessage = {
  occasion: Occasion;
  /** "due": it would be posted on this tick. "preview": written for whoever is on the clock now, nothing is due. */
  when: "due" | "preview";
  order: string;
  why: string;
  to: string[];
  source: Written["source"];
  note?: string;
  text: string;
};

export type CakeOrderResult =
  | { status: "not_migrated" }
  | {
      status: "ran";
      /** "2026-11-03 16:05", New York. */
      at: string;
      /** What the mailbox gave on this tick; null when it could not be read. */
      mail: { read: number; orders: number; notCake: number; unrecognised: number } | null;
      /** People on a store punch now; null when the punches were not loaded. */
      onClock: number | null;
      posted: { order: string; source: string; mentioned: number; note?: string }[];
      held: { order: string; why: string }[];
      followups: { order: string; outcome: string; how?: string; source?: string; note?: string }[];
      errors: string[];
      /** Dry run only: the emails not read as orders, by sender and subject. */
      unread?: { from: string; subject: string; why: string }[];
      /** Dry run only: what would be posted, and the previews. */
      messages?: DryMessage[];
    };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ms = (iso: string) => new Date(iso).getTime();

export async function runCakeOrderReminders(deps: RunDeps): Promise<CakeOrderResult> {
  const { now, store, slack, ask } = deps;
  const channel = deps.channel || DEFAULT_CHANNEL;
  const parse = deps.parse ?? parseOloOrderEmail;
  const dryRun = deps.dryRun === true;
  if (!(await store.migrated())) return { status: "not_migrated" };

  const nowIso = new Date(now).toISOString();
  const wall = nyWallClock(nowIso);
  const result: Extract<CakeOrderResult, { status: "ran" }> = {
    status: "ran",
    at: `${wall.date} ${clock(wall.minutes)}`,
    mail: null,
    onClock: null,
    posted: [],
    held: [],
    followups: [],
    errors: [],
    ...(dryRun ? { unread: [], messages: [] } : {}),
  };
  let rows: OrderRow[];
  try {
    rows = await store.orders(new Date(now - (MAIL_DAYS + 1) * 24 * 60 * MIN).toISOString());
  } catch (e) {
    result.errors.push(`orders: ${errText(e)}`);
    return result;
  }
  const people = new PeopleResolver(store, slack);
  const postTimes = rows.map((r) => r.post_ts).filter((ts): ts is string => !!ts);

  // ---- follow-ups --------------------------------------------------------
  for (const row of rows) {
    if (row.followup_outcome || !row.post_ts || !row.posted_at) continue;
    const step = followupStep(ms(row.posted_at), now);
    if (step === "wait") continue;
    try {
      if (step === "expired") {
        if (!dryRun) await store.claimFollowup(row.id, "expired", null);
        result.followups.push({ order: row.order_key, outcome: "expired" });
        continue;
      }

      let how;
      try {
        how = await packedSince(slack, row, postTimes);
      } catch (e) {
        result.errors.push(`follow-up ${row.order_key}: ${errText(e)}`);
        continue; // try again next tick
      }
      if (how) {
        if (!dryRun) await store.claimFollowup(row.id, "not_needed", nowIso, how);
        result.followups.push({ order: row.order_key, outcome: "not_needed", how });
        continue;
      }

      if (dryRun) {
        const written = await writeFollowup({ ask, random: deps.random });
        result.messages!.push(dryMessage("followup", "due", row.order_key, "not marked packed", [], written));
        continue;
      }
      if (!(await store.claimFollowup(row.id, "sending", nowIso))) continue; // another tick has it
      const written = await writeFollowup({ ask, random: deps.random });
      try {
        const sent = await slack.postMessage(row.channel_id, written.text, row.post_ts);
        if (sent.ok) {
          await store.settleFollowup(row.id, { followup_outcome: "sent", followup_ts: sent.value, followup_source: written.source });
          result.followups.push({ order: row.order_key, outcome: "sent", source: written.source, note: written.note });
        } else {
          // Slack said it did not post: release the claim for the next tick.
          await store.settleFollowup(row.id, { followup_outcome: null, followup_at: null });
          result.errors.push(`follow-up ${row.order_key}: Slack refused (${sent.error})`);
        }
      } catch (e) {
        await store.settleFollowup(row.id, { followup_outcome: "failed" });
        result.errors.push(`follow-up ${row.order_key}: ${errText(e)}`);
      }
    } catch (e) {
      result.errors.push(`follow-up ${row.order_key}: ${errText(e)}`);
    }
  }

  // ---- new orders from the mailbox ---------------------------------------------
  const recorded = new Set(rows.map((r) => r.order_key));
  const fresh: { order: CakeOrder; messageId: string; receivedAt: number }[] = [];
  try {
    const mail = await deps.mail.search(orderMailQuery(deps.orderAddress, MAIL_DAYS));
    const seen = new Set<string>();
    const counts = { read: mail.length, orders: 0, notCake: 0, unrecognised: 0 };
    for (const m of mail) {
      let parsed;
      try {
        parsed = parse(m.raw);
      } catch (e) {
        parsed = { kind: "unrecognised" as const, why: `the parser failed: ${errText(e)}` };
      }
      if (parsed.kind === "not_cake") {
        counts.notCake += 1;
        continue;
      }
      if (parsed.kind === "unrecognised") {
        counts.unrecognised += 1;
        result.unread?.push({ from: headerOf(m.raw, "From"), subject: headerOf(m.raw, "Subject"), why: parsed.why });
        continue;
      }
      counts.orders += 1;
      const key = parsed.order.key;
      if (recorded.has(key) || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ order: parsed.order, messageId: headerOf(m.raw, "Message-ID") || `<imap-uid-${m.uid}>`, receivedAt: ms(m.receivedAt) });
    }
    result.mail = counts;
  } catch (e) {
    result.errors.push(`mail: ${errText(e)}`);
  }

  // ---- who is on the clock, and the posts that are due ---------------------------
  let snap: PunchSnapshot | null = null;
  if (fresh.length || dryRun) {
    const earliest = Math.min(now, ...fresh.map((f) => f.receivedAt));
    try {
      snap = await loadPunches(store, earliest, now);
      result.onClock = onStoreClock(snap, now).length;
    } catch (e) {
      result.errors.push(`shifts or punches: ${errText(e)}`);
    }
  }
  let duePosts = 0;
  if (snap) {
    for (const f of fresh) {
      const key = f.order.key;
      const decision = decidePost({ key, receivedAt: f.receivedAt, pickupAt: f.order.pickupAt ? ms(f.order.pickupAt) : null }, snap, now);
      if (decision.action !== "post") {
        const until = decision.action === "hold" && decision.until ? ` until ${clock(nyWallClock(new Date(decision.until).toISOString()).minutes)}` : "";
        result.held.push({ order: key, why: `${decision.why}${until}` });
        continue;
      }
      duePosts += 1;
      try {
        const addressees = await people.forProfiles(decision.profileIds);
        if (dryRun) {
          const written = await writePost({ ask, people: addressees, order: f.order, random: deps.random });
          result.messages!.push(dryMessage("post", "due", key, decision.why, addressees, written));
          continue;
        }
        const id = await store.claimOrder({
          order_key: key,
          message_id: f.messageId,
          received_at: new Date(f.receivedAt).toISOString(),
          pickup_at: f.order.pickupAt,
          profile_ids: decision.profileIds,
          slack_user_ids: addressees.map((a) => a.slackId),
          channel_id: channel,
        });
        if (id === null) continue; // another tick recorded it first
        const written = await writePost({ ask, people: addressees, order: f.order, random: deps.random });
        try {
          const posted = await slack.postMessage(channel, written.text);
          if (posted.ok) {
            await store.markPosted(id, { post_ts: posted.value, post_source: written.source, posted_at: nowIso });
            result.posted.push({ order: key, source: written.source, mentioned: addressees.filter((a) => a.slackId).length, note: written.note });
          } else {
            await store.dropOrder(id); // not posted: the next tick tries again
            result.errors.push(`order ${key}: Slack refused (${posted.error})`);
          }
        } catch (e) {
          // Unknown whether it posted: keep the record so it is never posted twice.
          result.errors.push(`order ${key}: ${errText(e)}`);
        }
      } catch (e) {
        result.errors.push(`order ${key}: ${errText(e)}`);
      }
    }

    // A dry run with nothing due previews a post and a follow-up for whoever is on the clock now.
    const onClock = onStoreClock(snap, now);
    if (dryRun && duePosts === 0 && onClock.length) {
      const addressees = await people.forProfiles(onClock);
      const sample: CakeOrder = { key: "preview", customer: "(customer)", pickupAt: null, pickupText: "(pickup time)", cake: ["(the cake, from the email)"] };
      result.messages!.push(dryMessage("post", "preview", "preview", "on the clock now", addressees, await writePost({ ask, people: addressees, order: sample, random: deps.random })));
      result.messages!.push(dryMessage("followup", "preview", "preview", "an hour later, not packed", [], await writeFollowup({ ask, random: deps.random })));
    }
  }

  if (!dryRun) {
    try {
      await store.prune(new Date(now - KEEP_DAYS * 24 * 60 * MIN).toISOString());
    } catch (e) {
      result.errors.push(`prune: ${errText(e)}`);
    }
  }
  return result;
}

function dryMessage(occasion: Occasion, when: DryMessage["when"], order: string, why: string, to: (Addressee & { token: string })[], w: Written): DryMessage {
  return { occasion, when, order, why, to: to.map((a) => a.token), source: w.source, ...(w.note ? { note: w.note } : {}), text: w.text };
}

/** "16:05" from minutes past midnight. */
function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** How the post was marked packed, or null. Throws when Slack cannot be read. */
async function packedSince(slack: SlackClient, row: OrderRow, postTimes: string[]) {
  const ts = row.post_ts!;
  const reactions = await slack.reactions(row.channel_id, ts);
  if (!reactions.ok) throw new Error(`reactions: ${reactions.error}`);
  const thread = await slack.replies(row.channel_id, ts);
  if (!thread.ok) throw new Error(`thread replies: ${thread.error}`);
  const history = await slack.history(row.channel_id, ts);
  if (!history.ok) throw new Error(`channel history: ${history.error}`);
  return packedHow({
    postTs: ts,
    mentioned: row.slack_user_ids,
    reactions: reactions.value,
    thread: thread.value,
    channel: history.value,
    laterPostTs: postTimes,
  });
}

/** The punches that can be open between the earliest order's arrival and now, and the shifts they link to. */
async function loadPunches(store: CakeOrderStore, earliest: number, now: number): Promise<PunchSnapshot> {
  const entriesFrom = earliest - MAX_PUNCH_MIN * MIN;
  const [{ shifts, entries }, types] = await Promise.all([
    store.punches({
      shiftsFrom: new Date(entriesFrom - LINK_WINDOW_MIN * MIN).toISOString(),
      shiftsTo: new Date(now + LINK_WINDOW_MIN * MIN).toISOString(),
      entriesFrom: new Date(entriesFrom).toISOString(),
      entriesTo: new Date(now).toISOString(),
    }),
    store.shiftTypes(),
  ]);
  return { shifts, entries, inStoreByName: new Map(types.map((t) => [t.name, t.in_store !== false])) };
}

// ---- staff to Slack users ------------------------------------------------------
// As the cash count reminders match them (lib/cashCount/run.ts PeopleResolver).

type Resolved = Addressee & { slackId: string };

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKD").replace(/\s+/g, " ").trim().toLowerCase();

/** How someone is named when they are not matched to a Slack user. */
const shownName = (p: Person | undefined) => p?.preferred_name?.trim() || p?.full_name?.trim() || "Team";

/**
 * Matches staff to Slack users: by the email they sign in to the time app
 * with (users.lookupByEmail), else by name when exactly one Slack member has
 * that full name or display name. Someone who matches neither is addressed by
 * name, without a mention.
 */
class PeopleResolver {
  private directory: SlackUser[] | null | undefined;
  private store: CakeOrderStore;
  private slack: SlackClient;
  constructor(store: CakeOrderStore, slack: SlackClient) {
    this.store = store;
    this.slack = slack;
  }

  /** Names and sign-in emails. A failed read leaves everyone unnamed rather than holding up the post. */
  private async names(ids: string[]): Promise<Map<string, Person>> {
    try {
      return new Map((await this.store.people(ids)).map((p) => [p.id, p]));
    } catch {
      return new Map();
    }
  }

  private async users(): Promise<SlackUser[]> {
    if (this.directory !== undefined) return this.directory ?? [];
    try {
      const got = await this.slack.users();
      this.directory = got.ok ? got.value : null;
    } catch {
      this.directory = null;
    }
    return this.directory ?? [];
  }

  async forProfiles(ids: string[]): Promise<Resolved[]> {
    const names = await this.names(ids);
    const out: Resolved[] = [];
    for (const id of ids) {
      const p = names.get(id);
      let slackId = "";
      const email = p?.email;
      if (email) {
        try {
          const got = await this.slack.userByEmail(email);
          if (got.ok && !got.value.deleted) slackId = got.value.id;
        } catch {
          /* fall through to the name match */
        }
      }
      if (!slackId) {
        const wanted = [norm(p?.full_name), norm(p?.preferred_name)].filter(Boolean);
        const hits = (await this.users()).filter(
          (u) =>
            !u.deleted &&
            !u.is_bot &&
            [u.real_name, u.profile?.real_name, u.profile?.display_name].some((n) => n && wanted.includes(norm(n))),
        );
        if (hits.length === 1) slackId = hits[0].id;
      }
      out.push({ slackId, token: slackId ? `<@${slackId}>` : shownName(p) });
    }
    return out;
  }
}
