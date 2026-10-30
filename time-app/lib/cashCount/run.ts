// The cash count reminders in Slack #cash-count, one pass. The missed-clock-in
// cron (app/api/cron/missed-clockins) calls runCashCountReminders on every
// 5-minute tick; whatever hits that cron (a systemd timer on bj-box) needs no
// change. Who and when: lib/cashCount/plan.ts. The words: lib/cashCount/message.ts.
//
// Off until SLACK_CASH_COUNT_BOT_TOKEN is set. ANTHROPIC_API_KEY unset means
// every reminder is the plain fallback message. The channel and the rules
// message default to #cash-count and the "Cash count steps" message; the env
// vars CASH_COUNT_SLACK_CHANNEL and CASH_COUNT_RULES_TS move them.
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
// The follow-up goes in the reminder's thread, @mentioning the same people.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { emailForUser } from "@/lib/notify";
import { addDays, nyWallClock, resolveOpenWindow, type ClosedDateRange, type StoreHoursException, type StoreHoursRow } from "@/lib/coverage";
import { isMissingTable } from "@/lib/storeHours";
import { loadStoreHoursSeasons, seasonHoursRows } from "@/lib/storeHoursSeasons";
import {
  MIN,
  dueReminders,
  followupStep,
  storeDay,
  type DaySnapshot,
  type PlanEntry,
  type PlanShift,
  type ReminderKind,
} from "@/lib/cashCount/plan";
import { claudeFromEnv, writeReminder, type Addressee, type ClaudeLike } from "@/lib/cashCount/message";
import { isHumanPostAfter, slackClient, type SlackClient, type SlackUser } from "@/lib/cashCount/slack";

export const DEFAULT_CHANNEL = "C0CE7KVKQQ0"; // #cash-count
export const DEFAULT_RULES_TS = "1793315956.512979"; // "Cash count steps"
const TABLE = "cash_count_reminders";
const KEEP_DAYS = 60;

type ReminderRow = {
  id: number;
  store_date: string;
  kind: ReminderKind;
  profile_ids: string[];
  slack_user_ids: string[];
  channel_id: string;
  reminder_ts: string | null;
  reminder_source: string | null;
  posted_at: string | null;
  followup_outcome: string | null;
};

export type CashCountResult =
  | { status: "off" }
  | { status: "not_migrated" }
  | {
      status: "ran";
      day: string;
      store: "open" | "closed" | "unset" | "unreadable";
      posted: { kind: ReminderKind; source: string; mentioned: number; note?: string }[];
      followups: { kind: ReminderKind; outcome: string; source?: string; note?: string }[];
      errors: string[];
    };

export async function runCashCountReminders(
  now: number,
  opts: { claude?: ClaudeLike | null; random?: () => number } = {},
): Promise<CashCountResult> {
  const token = process.env.SLACK_CASH_COUNT_BOT_TOKEN;
  if (!token) return { status: "off" };
  const channel = process.env.CASH_COUNT_SLACK_CHANNEL || DEFAULT_CHANNEL;
  const rulesTs = process.env.CASH_COUNT_RULES_TS || DEFAULT_RULES_TS;
  const claude = opts.claude !== undefined ? opts.claude : claudeFromEnv();
  const slack = slackClient(token);
  const supabase = createAdminClient();

  const today = nyWallClock(new Date(now).toISOString()).date;
  const recent = await supabase.from(TABLE).select("*").gte("store_date", addDays(today, -1));
  if (isMissingTable(recent.error)) return { status: "not_migrated" };

  const result: Extract<CashCountResult, { status: "ran" }> = {
    status: "ran",
    day: today,
    store: "unreadable",
    posted: [],
    followups: [],
    errors: [],
  };
  if (recent.error) {
    result.errors.push(`reminders: ${recent.error.message}`);
    return result;
  }
  const rows = (recent.data ?? []) as ReminderRow[];

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
      result.errors.push(`rules message: ${(e as Error).message}`);
    }
    return rules;
  };
  const people = new PeopleResolver(supabase, slack);

  // ---- follow-ups --------------------------------------------------------
  for (const row of rows) {
    if (row.followup_outcome || !row.reminder_ts || !row.posted_at) continue;
    const step = followupStep(new Date(row.posted_at).getTime(), now);
    if (step === "wait") continue;
    if (step === "expired") {
      await supabase.from(TABLE).update({ followup_outcome: "expired" }).eq("id", row.id).is("followup_outcome", null);
      result.followups.push({ kind: row.kind, outcome: "expired" });
      continue;
    }

    let someonePosted: boolean;
    try {
      someonePosted = await humanPostedSince(slack, row.channel_id, row.reminder_ts);
    } catch (e) {
      result.errors.push(`follow-up ${row.kind}: ${(e as Error).message}`);
      continue; // try again next tick
    }
    if (someonePosted) {
      await supabase
        .from(TABLE)
        .update({ followup_outcome: "not_needed", followup_at: new Date(now).toISOString() })
        .eq("id", row.id)
        .is("followup_outcome", null);
      result.followups.push({ kind: row.kind, outcome: "not_needed" });
      continue;
    }

    const claim = await supabase
      .from(TABLE)
      .update({ followup_outcome: "sending", followup_at: new Date(now).toISOString() })
      .eq("id", row.id)
      .is("followup_outcome", null)
      .select("id");
    if (claim.error || !claim.data?.length) continue; // another tick has it

    const addressees = await people.fromRow(row);
    const written = await writeReminder({ claude, rules: await readRules(), people: addressees, phase: row.kind, occasion: "followup", random: opts.random });
    try {
      const sent = await slack.postMessage(row.channel_id, written.text, row.reminder_ts);
      if (sent.ok) {
        await supabase
          .from(TABLE)
          .update({ followup_outcome: "sent", followup_ts: sent.value, followup_source: written.source })
          .eq("id", row.id);
        result.followups.push({ kind: row.kind, outcome: "sent", source: written.source, note: written.note });
      } else {
        // Slack said it did not post: release the claim for the next tick.
        await supabase.from(TABLE).update({ followup_outcome: null, followup_at: null }).eq("id", row.id);
        result.errors.push(`follow-up ${row.kind}: Slack refused (${sent.error})`);
      }
    } catch (e) {
      await supabase.from(TABLE).update({ followup_outcome: "failed" }).eq("id", row.id);
      result.errors.push(`follow-up ${row.kind}: ${(e as Error).message}`);
    }
  }

  // ---- today's opening and closing reminders ----------------------------------
  const sent = new Set(rows.filter((r) => r.store_date === today).map((r) => r.kind));
  if (!(sent.has("open") && sent.has("close"))) {
    const loaded = await loadDay(supabase, today, now);
    result.store = loaded.store;
    if (loaded.error) result.errors.push(loaded.error);
    for (const due of loaded.snapshot ? dueReminders(loaded.snapshot, now, sent) : []) {
      const addressees = await people.forProfiles(due.profileIds);
      const claim = await supabase
        .from(TABLE)
        .insert({
          store_date: today,
          kind: due.kind,
          profile_ids: due.profileIds,
          slack_user_ids: addressees.map((a) => a.slackId),
          channel_id: channel,
        })
        .select("id")
        .single();
      if (claim.error || !claim.data) {
        // 23505: another tick recorded it first. Anything else: try next tick.
        if (claim.error?.code !== "23505") result.errors.push(`${due.kind} reminder: ${claim.error?.message ?? "not recorded"}`);
        continue;
      }
      const id = (claim.data as { id: number }).id;
      const written = await writeReminder({ claude, rules: await readRules(), people: addressees, phase: due.kind, occasion: "reminder", random: opts.random });
      try {
        const posted = await slack.postMessage(channel, written.text);
        if (posted.ok) {
          await supabase
            .from(TABLE)
            .update({ reminder_ts: posted.value, reminder_source: written.source, posted_at: new Date(now).toISOString() })
            .eq("id", id);
          result.posted.push({ kind: due.kind, source: written.source, mentioned: addressees.filter((a) => a.slackId).length, note: written.note });
        } else {
          await supabase.from(TABLE).delete().eq("id", id); // not posted: the next tick tries again
          result.errors.push(`${due.kind} reminder: Slack refused (${posted.error})`);
        }
      } catch (e) {
        // Unknown whether it posted: keep the record so it is never posted twice.
        result.errors.push(`${due.kind} reminder: ${(e as Error).message}`);
      }
    }
  }

  await supabase.from(TABLE).delete().lt("store_date", addDays(today, -KEEP_DAYS));
  return result;
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
  supabase: SupabaseClient,
  date: string,
  now: number,
): Promise<{ store: "open" | "closed" | "unset" | "unreadable"; snapshot: DaySnapshot | null; error?: string }> {
  const [hours, exceptions, closed, seasons, types] = await Promise.all([
    supabase.from("store_hours").select("weekday, is_closed, opens, closes"),
    supabase.from("store_hours_exceptions").select("date, label, is_closed, opens, closes").eq("date", date),
    supabase.from("annotations").select("title, start_date, end_date").eq("business_closed", true).lte("start_date", date).gte("end_date", date),
    loadStoreHoursSeasons(supabase),
    supabase.from("shift_types").select("name, in_store"),
  ]);
  const failed = hours.error || exceptions.error || seasons.error || types.error;
  if (failed) return { store: "unreadable", snapshot: null, error: `store hours: ${typeof failed === "string" ? failed : failed.message}` };

  const window = resolveOpenWindow(
    date,
    [...((hours.data ?? []) as StoreHoursRow[]), ...seasonHoursRows(seasons.seasons)],
    (exceptions.data ?? []) as StoreHoursException[],
    // Not load-bearing, as in the coverage check: if this read fails, the day's hours still apply.
    closed.error ? [] : ((closed.data ?? []) as ClosedDateRange[]),
  );
  const day = storeDay(date, window);
  if (!day) return { store: window.state === "closed" ? "closed" : "unset", snapshot: null };

  const [shifts, entries] = await Promise.all([
    supabase
      .from("shifts")
      .select("id, employee_id, starts_at, ends_at, position, deal_id, published")
      .gte("starts_at", new Date(day.openAt - 20 * 60 * MIN).toISOString())
      .lte("starts_at", new Date(day.closeAt + 60 * MIN).toISOString()),
    supabase
      .from("time_entries")
      .select("id, employee_id, shift_id, clock_in_at, clock_out_at")
      .gte("clock_in_at", new Date(day.closeAt - 16 * 60 * MIN).toISOString())
      .lte("clock_in_at", new Date(Math.min(now, day.closeAt)).toISOString()),
  ]);
  if (shifts.error || entries.error) {
    return { store: "unreadable", snapshot: null, error: `shifts or punches: ${(shifts.error ?? entries.error)!.message}` };
  }
  return {
    store: "open",
    snapshot: {
      day,
      shifts: (shifts.data ?? []) as PlanShift[],
      entries: (entries.data ?? []) as PlanEntry[],
      inStoreByName: new Map(((types.data ?? []) as { name: string; in_store?: boolean | null }[]).map((t) => [t.name, t.in_store !== false])),
    },
  };
}

// ---- staff to Slack users ------------------------------------------------------

type Resolved = Addressee & { slackId: string };

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKD").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Matches staff to Slack users: by the email they sign in to the time app
 * with (users.lookupByEmail), else by name when exactly one Slack member has
 * that full name or display name. Someone who matches neither is addressed by
 * name, without a mention.
 */
class PeopleResolver {
  private directory: SlackUser[] | null | undefined;
  private supabase: SupabaseClient;
  private slack: SlackClient;
  constructor(supabase: SupabaseClient, slack: SlackClient) {
    this.supabase = supabase;
    this.slack = slack;
  }

  private async names(ids: string[]): Promise<Map<string, { full_name: string | null; preferred_name: string | null }>> {
    const { data } = await this.supabase.from("profiles").select("id, full_name, preferred_name").in("id", ids);
    return new Map(((data ?? []) as { id: string; full_name: string | null; preferred_name: string | null }[]).map((p) => [p.id, p]));
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
      const shown = p?.preferred_name?.trim() || p?.full_name?.trim() || "Team";
      let slackId = "";
      const email = await emailForUser(id);
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
      out.push({ slackId, token: slackId ? `<@${slackId}>` : shown });
    }
    return out;
  }

  async fromRow(row: ReminderRow): Promise<Resolved[]> {
    const names = await this.names(row.profile_ids);
    return row.profile_ids.map((id, i) => {
      const slackId = row.slack_user_ids[i] ?? "";
      const p = names.get(id);
      return { slackId, token: slackId ? `<@${slackId}>` : p?.preferred_name?.trim() || p?.full_name?.trim() || "Team" };
    });
  }
}

