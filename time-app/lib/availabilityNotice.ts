// What the schedulers are told when someone changes their availability, and
// when (bj-finance #754). The owner's words: "for the schedulers they need
// emails for when a scheduled updates their availability."
//
// ONE EMAIL A DAY, AT 8PM, like the staff's shift summary (lib/shiftNotice.ts).
// A change an employee makes to their OWN availability (one day, a week, copy
// last week, weekly blocks, removing a block) is queued in
// availability_notices (migration 48), one row per date or weekday it
// touched, and puts an "Availability updated" row on each scheduler's bell
// straight away (in-app only). At 8pm New York time the missed-clock-in cron
// calls sendAvailabilityDigest: claim_availability_digest hands the day's
// queue to exactly one caller, and each scheduler gets one email listing who
// changed their availability and which dates or weekdays. No changes, no
// email. A save that changes nothing (the same blocks saved again) queues
// nothing.
//
// Not queued: time-off requests and cancelled approved time off (each has its
// own alert, as before), and a change a manager makes to someone else's rows.
// A scheduler's email leaves out their own changes.
//
// THE SCHEDULERS are chosen as the coverage reminder chooses them
// (lib/coverageReminder.ts selectRecipients, repo root): every owner, plus
// every manager on the schedule (active), leaving out anyone archived or
// banned. Then notif_prefs, as notify() applies them: availability_change
// switched off, or email switched off, means no email.
//
// Best-effort, like every notification here: a change that cannot be queued
// never fails the save that has already been made.
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyManagers, sendOnChannels, wants, type NotifPrefs } from "@/lib/notify";
import { digestDayAt } from "@/lib/shiftNotice";
import { shortDate } from "@/lib/repeatUntil";
import { isManagerRole, isOwnerRole, MANAGER_ROLES } from "@/lib/roles";

export const AVAILABILITY_TYPE = "availability_change";
export const AVAILABILITY_BELL_TITLE = "Availability updated";
export const AVAILABILITY_DIGEST_TITLE = "Availability changes";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What one save touched: dated days and weekly weekdays. */
export type AvailabilityChange = { dates: string[]; weekdays: number[] };

/** The dates and weekdays of one change, dates first in order, then weekdays Sunday on. */
export function describeChange(change: AvailabilityChange): string[] {
  const dates = [...new Set(change.dates)].sort().map(shortDate);
  const weekdays = [...new Set(change.weekdays)].sort((a, b) => a - b).map((w) => `every ${WEEKDAY_NAMES[w]}`);
  return [...dates, ...weekdays];
}

/**
 * What saving or removing one block touched: its weekday when it repeats
 * weekly, otherwise its date (none when it has neither).
 */
export function blockChange(block: { weekday?: number | string | null; specific_date?: string | null }): AvailabilityChange {
  const weekly = block.weekday !== null && block.weekday !== undefined;
  return {
    dates: !weekly && block.specific_date ? [block.specific_date] : [],
    weekdays: weekly ? [Number(block.weekday)] : [],
  };
}

/** One block as a save compares it: everything a person can change about it. */
type Block = {
  specific_date?: string | null;
  weekday?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  preference?: string | null;
  is_available?: boolean | null;
  repeat_until?: string | null;
};

function signature(blocks: Block[]): string {
  return blocks
    // "09:00" and "09:00:00" are the same time.
    .map((b) => [(b.start_time ?? "").slice(0, 5), (b.end_time ?? "").slice(0, 5), b.preference ?? "available", b.is_available === false ? 0 : 1, (b.repeat_until ?? "").slice(0, 10)].join("|"))
    .sort()
    .join(";");
}

/**
 * The keys (dates or weekdays) whose blocks differ between `before` and
 * `after`. A key present on one side only differs; one whose blocks are the
 * same in any order does not.
 */
export function changedKeys<K extends string | number>(before: Block[], after: Block[], keyOf: (b: Block) => K | null | undefined): K[] {
  const group = (rows: Block[]) => {
    const m = new Map<K, Block[]>();
    for (const r of rows) {
      const k = keyOf(r);
      if (k === null || k === undefined) continue;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const a = group(before);
  const b = group(after);
  const keys = new Set<K>([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => signature(a.get(k) ?? []) !== signature(b.get(k) ?? []));
}

/**
 * Queue a change `employeeId` made to their own availability for the 8pm
 * email, and put it on the schedulers' bells now. Nothing when the change
 * touched no date or weekday.
 */
export async function queueAvailabilityChange(
  employee: { id: string; full_name: string | null },
  change: AvailabilityChange,
): Promise<void> {
  const rows = [
    ...[...new Set(change.dates)].map((d) => ({ employee_id: employee.id, changed_date: d })),
    ...[...new Set(change.weekdays)].map((w) => ({ employee_id: employee.id, changed_weekday: w })),
  ];
  if (!rows.length) return;
  const { error } = await createAdminClient().from("availability_notices").insert(rows);
  if (error) console.error(`availability of ${employee.id}: could not queue the change: ${error.message}`);
  await notifyManagers({
    type: AVAILABILITY_TYPE,
    title: AVAILABILITY_BELL_TITLE,
    body: `${employee.full_name ?? "An employee"} changed their availability: ${describeChange(change).join(", ")}.`,
    inAppOnly: true,
  }).catch(() => {});
}

type Claimed = { id?: number; employee_id: string; changed_date: string | null; changed_weekday: number | null };

type Person = {
  id: string;
  role: string | null;
  active: boolean | null;
  archived_at?: string | null;
  full_name: string | null;
  notif_prefs: NotifPrefs | null;
};

/** Is this person a scheduler: an owner, or a manager on the schedule, not archived? */
function schedulerByProfile(p: Person): boolean {
  if (p.archived_at) return false;
  return isOwnerRole(p.role) || (isManagerRole(p.role) && p.active === true);
}

/**
 * The email's lines for one scheduler: one per person who changed their
 * availability, by name, with the dates and weekdays they changed. The
 * scheduler's own changes are left out.
 */
export function availabilityDigestLines(claimed: Claimed[], names: Map<string, string | null>, schedulerId: string): string[] {
  const byPerson = new Map<string, AvailabilityChange>();
  for (const c of claimed) {
    if (c.employee_id === schedulerId) continue;
    const change = byPerson.get(c.employee_id) ?? { dates: [], weekdays: [] };
    if (c.changed_date) change.dates.push(c.changed_date.slice(0, 10));
    else if (c.changed_weekday !== null && c.changed_weekday !== undefined) change.weekdays.push(Number(c.changed_weekday));
    byPerson.set(c.employee_id, change);
  }
  return [...byPerson]
    .map(([id, change]) => ({ name: names.get(id)?.trim() || "Someone with no name on file", parts: describeChange(change) }))
    .filter((x) => x.parts.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((x) => `${x.name}: ${x.parts.join(" · ")}`);
}

// Sends the day's availability email if it is 8pm or later in New York. Safe
// on every cron tick: claim_availability_digest (migration 48) hands the
// queue out once per day. Returns which schedulers were emailed.
export async function sendAvailabilityDigest(now: number = Date.now()): Promise<{ told: string[]; error: string | null }> {
  const day = digestDayAt(now);
  if (!day) return { told: [], error: null };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("claim_availability_digest", { p_day: day });
  if (error) return { told: [], error: error.message };
  const claimed = ((data ?? []) as Claimed[]).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  if (!claimed.length) return { told: [], error: null };

  const changers = [...new Set(claimed.map((c) => c.employee_id))];
  const [changersRead, schedulersRead] = await Promise.all([
    supabase.from("profiles").select("id, full_name").in("id", changers),
    supabase.from("profiles").select("*").in("role", MANAGER_ROLES),
  ]);
  if (changersRead.error || schedulersRead.error) {
    // Today's email is claimed, so put the changes back for tomorrow's rather
    // than lose them.
    await supabase.from("availability_notices").insert(
      claimed.map(({ employee_id, changed_date, changed_weekday }) =>
        changed_date ? { employee_id, changed_date } : { employee_id, changed_weekday },
      ),
    );
    return { told: [], error: (changersRead.error ?? schedulersRead.error)!.message };
  }

  const names = new Map(((changersRead.data ?? []) as { id: string; full_name: string | null }[]).map((p) => [p.id, p.full_name]));
  const schedulers = ((schedulersRead.data ?? []) as Person[]).filter(schedulerByProfile);

  const told: string[] = [];
  for (const s of schedulers) {
    const prefs = s.notif_prefs ?? {};
    if (!wants(prefs, AVAILABILITY_TYPE) || !wants(prefs, "email")) continue;
    const lines = availabilityDigestLines(claimed, names, s.id);
    if (!lines.length) continue;
    const account = await schedulerAccount(s.id);
    if (!account || account.banned) continue;
    const { sent_email } = await sendOnChannels({
      prefs,
      title: AVAILABILITY_DIGEST_TITLE,
      body: lines.join("\n"),
      email: account.email,
      phone: null,
    }).catch(() => ({ sent_email: false }));
    if (sent_email) told.push(s.id);
  }
  return { told, error: null };
}

// The scheduler's login: their email, and whether the account is banned (any
// banned_until set, as the coverage reminder reads it). Null when it cannot be
// read; that scheduler is skipped.
async function schedulerAccount(userId: string): Promise<{ email: string; banned: boolean } | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const { data } = await createAdminClient().auth.admin.getUserById(userId);
    const email = data.user?.email?.trim();
    if (!email) return null;
    return { email, banned: Boolean((data.user as { banned_until?: string | null } | null)?.banned_until) };
  } catch {
    return null;
  }
}
