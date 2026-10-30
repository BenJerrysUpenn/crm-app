// The cash count reminders in Slack #cash-count, one pass. The bj-box job
// (scripts/cash-count-reminders.ts at the crm-app root, through cli.ts) runs
// it every 5 minutes from a systemd timer (Software-Factory droplet/). Who and
// when: plan.ts. The words: message.ts, written by Claude Code on the owner's
// subscription (claudeCli.ts). The database: store.ts.
//
// ONCE EACH. A reminder is recorded in cash_count_reminders (migration 51)
// BEFORE it is posted; the unique (store_date, kind) means a second tick finds
// it and posts nothing. If Slack refuses the post (it answers, not ok), the
// record is removed so the next tick tries again; if Slack does not answer at
// all, the record stays, so a post that may have gone out is never repeated.
// The follow-up is claimed with an update guarded on followup_outcome being
// null, so it is decided once.
//
// "SOMEBODY POSTED" for the follow-up: any message by a person (not a bot, not
// a join notice) in the channel after the reminder, or a reply in its thread.
// The follow-up goes in the reminder's thread, @mentioning the same person.
//
// DRY RUN. Everything is read (the database, the rules message, Slack users,
// the channel) and every message that is due is written by Claude, but nothing
// is posted and nothing is written to the database. It also writes a preview
// of today's opening and closing reminders for whoever the plan names right
// now, so a dry run at any hour shows Claude answering.

import { addDays, formatMinutes, nyWallClock, resolveOpenWindow } from "../coverage";
import {
  MAX_PUNCH_MIN,
  MIN,
  dueReminders,
  findCloser,
  findOpener,
  followupStep,
  storeDay,
  type DaySnapshot,
  type ReminderKind,
  type StoreDay,
} from "./plan";
import { writeReminder, type Addressee, type Occasion, type Written } from "./message";
import type { AskClaude } from "./claudeCli";
import { isHumanPostAfter, type SlackClient, type SlackUser } from "./slack";
import type { CashCountStore, Person, ReminderRow } from "./store";

export const DEFAULT_CHANNEL = "C0CE7KVKQQ0"; // #cash-count
export const DEFAULT_RULES_TS = "1793315956.512979"; // "Cash count steps"
const KEEP_DAYS = 60;

export type RunDeps = {
  /** The tick's instant (ms). */
  now: number;
  store: CashCountStore;
  slack: SlackClient;
  /** Null when there is no Claude subscription token: every message is the plain one. */
  ask: AskClaude | null;
  channel?: string;
  rulesTs?: string;
  dryRun?: boolean;
  random?: () => number;
};

/** A message a dry run would post (or previews). */
export type DryMessage = {
  kind: ReminderKind;
  occasion: Occasion;
  /** "due": it would be posted on this tick. "preview": written for whoever the plan names now, not due yet. */
  when: "due" | "preview";
  why: string;
  to: string[];
  source: Written["source"];
  note?: string;
  text: string;
};

export type CashCountResult =
  | { status: "not_migrated" }
  | {
      status: "ran";
      day: string;
      store: "open" | "closed" | "unset" | "unreadable";
      hours?: { opens: string; closes: string };
      posted: { kind: ReminderKind; source: string; mentioned: number; note?: string }[];
      followups: { kind: ReminderKind; outcome: string; source?: string; note?: string }[];
      errors: string[];
      /** Dry run only: what would be posted, and the previews. */
      messages?: DryMessage[];
    };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runCashCountReminders(deps: RunDeps): Promise<CashCountResult> {
  const { now, store, slack, ask } = deps;
  const channel = deps.channel || DEFAULT_CHANNEL;
  const rulesTs = deps.rulesTs || DEFAULT_RULES_TS;
  const dryRun = deps.dryRun === true;
  if (!(await store.migrated())) return { status: "not_migrated" };

  const today = nyWallClock(new Date(now).toISOString()).date;
  const nowIso = new Date(now).toISOString();
  const result: Extract<CashCountResult, { status: "ran" }> = {
    status: "ran",
    day: today,
    store: "unreadable",
    posted: [],
    followups: [],
    errors: [],
    ...(dryRun ? { messages: [] } : {}),
  };
  let rows: ReminderRow[];
  try {
    rows = await store.reminders(addDays(today, -1));
  } catch (e) {
    result.errors.push(`reminders: ${errText(e)}`);
    return result;
  }

  // The rules message, read once per tick and only when a message is written.
  let rules: string | null | undefined;
  const readRules = async (): Promise<string | null> => {
    if (rules !== undefined) return rules;
    try {
      const got = await slack.message(channel, rulesTs);
      rules = got.ok ? (got.value?.text ?? null) : null;
      if (!got.ok) result.errors.push(`rules message: ${got.error}`);
    } catch (e) {
      rules = null;
      result.errors.push(`rules message: ${errText(e)}`);
    }
    return rules;
  };
  const people = new PeopleResolver(store, slack);
  const write = async (addressees: Addressee[], phase: ReminderKind, occasion: Occasion) =>
    writeReminder({ ask, rules: await readRules(), people: addressees, phase, occasion, random: deps.random });

  // ---- follow-ups --------------------------------------------------------
  for (const row of rows) {
    if (row.followup_outcome || !row.reminder_ts || !row.posted_at) continue;
    const step = followupStep(new Date(row.posted_at).getTime(), now);
    if (step === "wait") continue;
    try {
      if (step === "expired") {
        if (!dryRun) await store.claimFollowup(row.id, "expired", null);
        result.followups.push({ kind: row.kind, outcome: "expired" });
        continue;
      }

      let someonePosted: boolean;
      try {
        someonePosted = await humanPostedSince(slack, row.channel_id, row.reminder_ts);
      } catch (e) {
        result.errors.push(`follow-up ${row.kind}: ${errText(e)}`);
        continue; // try again next tick
      }
      if (someonePosted) {
        if (!dryRun) await store.claimFollowup(row.id, "not_needed", nowIso);
        result.followups.push({ kind: row.kind, outcome: "not_needed" });
        continue;
      }

      const addressees = await people.fromRow(row);
      if (dryRun) {
        const written = await write(addressees, row.kind, "followup");
        result.messages!.push(dryMessage(row.kind, "followup", "due", "nobody posted", addressees, written));
        continue;
      }
      if (!(await store.claimFollowup(row.id, "sending", nowIso))) continue; // another tick has it
      const written = await write(addressees, row.kind, "followup");
      try {
        const sent = await slack.postMessage(row.channel_id, written.text, row.reminder_ts);
        if (sent.ok) {
          await store.settleFollowup(row.id, { followup_outcome: "sent", followup_ts: sent.value, followup_source: written.source });
          result.followups.push({ kind: row.kind, outcome: "sent", source: written.source, note: written.note });
        } else {
          // Slack said it did not post: release the claim for the next tick.
          await store.settleFollowup(row.id, { followup_outcome: null, followup_at: null });
          result.errors.push(`follow-up ${row.kind}: Slack refused (${sent.error})`);
        }
      } catch (e) {
        await store.settleFollowup(row.id, { followup_outcome: "failed" });
        result.errors.push(`follow-up ${row.kind}: ${errText(e)}`);
      }
    } catch (e) {
      result.errors.push(`follow-up ${row.kind}: ${errText(e)}`);
    }
  }

  // ---- today's opening and closing reminders ----------------------------------
  const sent = new Set(rows.filter((r) => r.store_date === today).map((r) => r.kind));
  if (!(sent.has("open") && sent.has("close")) || dryRun) {
    const loaded = await loadDay(store, today, now);
    result.store = loaded.store;
    if (loaded.day) result.hours = { opens: nyClock(loaded.day.openAt), closes: nyClock(loaded.day.closeAt) };
    if (loaded.error) result.errors.push(loaded.error);
    const due = loaded.snapshot ? dueReminders(loaded.snapshot, now, sent) : [];
    for (const reminder of due) {
      try {
        const addressees = await people.forProfiles(reminder.profileIds);
        if (dryRun) {
          const written = await write(addressees, reminder.kind, "reminder");
          result.messages!.push(dryMessage(reminder.kind, "reminder", "due", reminder.why, addressees, written));
          continue;
        }
        const id = await store.claimReminder({
          store_date: today,
          kind: reminder.kind,
          profile_ids: reminder.profileIds,
          slack_user_ids: addressees.map((a) => a.slackId),
          channel_id: channel,
        });
        if (id === null) continue; // another tick recorded it first
        const written = await write(addressees, reminder.kind, "reminder");
        try {
          const posted = await slack.postMessage(channel, written.text);
          if (posted.ok) {
            await store.markPosted(id, { reminder_ts: posted.value, reminder_source: written.source, posted_at: nowIso });
            result.posted.push({ kind: reminder.kind, source: written.source, mentioned: addressees.filter((a) => a.slackId).length, note: written.note });
          } else {
            await store.dropReminder(id); // not posted: the next tick tries again
            result.errors.push(`${reminder.kind} reminder: Slack refused (${posted.error})`);
          }
        } catch (e) {
          // Unknown whether it posted: keep the record so it is never posted twice.
          result.errors.push(`${reminder.kind} reminder: ${errText(e)}`);
        }
      } catch (e) {
        result.errors.push(`${reminder.kind} reminder: ${errText(e)}`);
      }
    }

    // A dry run previews the reminders not due yet, for whoever the plan names now.
    if (dryRun && loaded.snapshot) {
      const dueKinds = new Set(due.map((d) => d.kind));
      const previews: { kind: ReminderKind; profileId: string; why: string }[] = [];
      const opener = findOpener(loaded.snapshot, now);
      if (!dueKinds.has("open") && opener) previews.push({ kind: "open", profileId: opener.profileId, why: opener.how });
      // Before closing, who will be on the clock is not known: preview the scheduled closer.
      const closer = findCloser(now < loaded.snapshot.day.closeAt ? { ...loaded.snapshot, entries: [] } : loaded.snapshot);
      if (!dueKinds.has("close") && closer) previews.push({ kind: "close", profileId: closer.profileId, why: closer.how });
      for (const p of previews) {
        const addressees = await people.forProfiles([p.profileId]);
        const written = await write(addressees, p.kind, "reminder");
        result.messages!.push(dryMessage(p.kind, "reminder", "preview", p.why, addressees, written));
      }
    }
  }

  if (!dryRun) {
    try {
      await store.prune(addDays(today, -KEEP_DAYS));
    } catch (e) {
      result.errors.push(`prune: ${errText(e)}`);
    }
  }
  return result;
}

function dryMessage(kind: ReminderKind, occasion: Occasion, when: DryMessage["when"], why: string, to: Addressee[], w: Written): DryMessage {
  return { kind, occasion, when, why, to: to.map((a) => a.token), source: w.source, ...(w.note ? { note: w.note } : {}), text: w.text };
}

/** "11:00" New York time for an instant. */
function nyClock(at: number): string {
  return formatMinutes(nyWallClock(new Date(at).toISOString()).minutes);
}

/** True when a person posted in the channel after `ts`, or replied in its thread. Throws when Slack cannot be read. */
async function humanPostedSince(slack: SlackClient, channel: string, ts: string): Promise<boolean> {
  const history = await slack.history(channel, ts);
  if (!history.ok) throw new Error(`channel history: ${history.error}`);
  if (history.value.some((m) => isHumanPostAfter(m, ts))) return true;
  const thread = await slack.replies(channel, ts);
  if (!thread.ok) throw new Error(`thread replies: ${thread.error}`);
  return thread.value.some((m) => m.ts !== ts && isHumanPostAfter(m, ts));
}

// ---- the store day --------------------------------------------------------------

async function loadDay(
  store: CashCountStore,
  date: string,
  now: number,
): Promise<{ store: "open" | "closed" | "unset" | "unreadable"; day?: StoreDay; snapshot: DaySnapshot | null; error?: string }> {
  let rows;
  try {
    rows = await store.dayRows(date);
  } catch (e) {
    return { store: "unreadable", snapshot: null, error: `store hours: ${errText(e)}` };
  }
  const window = resolveOpenWindow(date, rows.hours, rows.exceptions, rows.closed);
  const day = storeDay(date, window);
  if (!day) return { store: window.state === "closed" ? "closed" : "unset", snapshot: null };

  try {
    const { shifts, entries } = await store.punches({
      shiftsFrom: new Date(day.openAt - 20 * 60 * MIN).toISOString(),
      shiftsTo: new Date(day.closeAt + 60 * MIN).toISOString(),
      entriesFrom: new Date(day.closeAt - MAX_PUNCH_MIN * MIN).toISOString(),
      entriesTo: new Date(Math.min(now, day.closeAt)).toISOString(),
    });
    return {
      store: "open",
      day,
      snapshot: { day, shifts, entries, inStoreByName: new Map(rows.shiftTypes.map((t) => [t.name, t.in_store !== false])) },
    };
  } catch (e) {
    return { store: "unreadable", day, snapshot: null, error: `shifts or punches: ${errText(e)}` };
  }
}

// ---- staff to Slack users ------------------------------------------------------

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
  private store: CashCountStore;
  private slack: SlackClient;
  constructor(store: CashCountStore, slack: SlackClient) {
    this.store = store;
    this.slack = slack;
  }

  /** Names and sign-in emails. A failed read leaves everyone unnamed rather than holding up the reminder. */
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

  async fromRow(row: ReminderRow): Promise<Resolved[]> {
    const names = await this.names(row.profile_ids);
    return row.profile_ids.map((id, i) => {
      const slackId = row.slack_user_ids[i] ?? "";
      return { slackId, token: slackId ? `<@${slackId}>` : shownName(names.get(id)) };
    });
  }
}

