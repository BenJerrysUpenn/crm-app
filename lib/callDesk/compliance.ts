// The lawful-dial gate for the call desk (bj-finance #420).
//
// Pure logic — no React, no DOM, no Supabase — so the same rules run in the
// browser (to grey out a button) and in the route handler (to refuse the
// write). The server is the one that counts: a client can be stale, edited or
// simply a different tab, so nothing here is ever trusted from the wire.
//
// The rules, and where they come from (research:
// bj-finance docs/call-desk-consent-and-calling-rules.md, branch
// research/call-desk-consent; not legal advice):
//
//   * Relationship window. Nobody consented to a call, so the only permission
//     we have is the established business relationship the rules grant
//     automatically. We take the shortest applicable clock: 12 months from the
//     last paid booking and 90 days from the last inbound enquiry
//     (73 P.S. §2245; federally 18 months / 3 months, 47 C.F.R.
//     §64.1200(f)(5)). Our own outbound email creates no window — the clock
//     runs on what the customer did, never on what we sent.
//   * Internal do-not-call list. Permanent, phone-keyed, beats every window
//     (47 C.F.R. §64.1200(d)(3)).
//   * Registry scrub. A number outside its window is a cold call, which the
//     policy says needs the national and Pennsylvania registries scrubbed
//     within the last 31 days (16 C.F.R. §310.4(b)(3)(iv)). Since #424 the
//     desk marks that case rather than blocking it: `callRisk` returns
//     'outside_window', the button goes striped, and the call is recorded
//     with `outside_window: true`. Honouring the scrub rule is the caller's,
//     not the button's.
//   * Hours. 9 a.m. – 7 p.m. Eastern, Monday to Saturday, never on a US
//     federal legal holiday. That is PA Act 47 of 2026 (effective 2026-10-18),
//     adopted early because it is the tightest of PA / NJ / federal and it
//     saves changing habits in October.

import type { CallDeskRow } from "./types";

export const TZ = "America/New_York";

/** Calling window, Eastern. 9 a.m. up to (not including) 7 p.m. */
export const CALL_HOUR_START = 9;
export const CALL_HOUR_END = 19;

/** How long a registry scrub stays good for (16 C.F.R. §310.4(b)(3)(iv)). */
export const SCRUB_MAX_AGE_DAYS = 31;

/** Relationship windows, in the conservative (Pennsylvania) reading. */
export const PURCHASE_WINDOW_MONTHS = 12;
export const INQUIRY_WINDOW_DAYS = 90;

/** dnc_status values that mean "never dial this number". */
const DNC_BLOCKING = new Set(["national", "pa_list", "internal"]);

/* phone ------------------------------------------------------------------ */

/**
 * Digits-only phone key. Mirrors public.normalize_phone() in
 * supabase/crm/003_call_desk_compliance.sql exactly — the two must agree or a
 * suppressed number stops matching its own suppression row.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/* calendar --------------------------------------------------------------- */

type Parts = { ymd: string; year: number; weekday: number; hour: number };

const YMD_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The wall-clock date, weekday (0 = Sunday) and hour in a time zone. */
function partsIn(date: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) bag[p.type] = p.value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    ymd: `${bag.year}-${bag.month}-${bag.day}`,
    year: Number(bag.year),
    weekday: Math.max(0, weekdays.indexOf(bag.weekday ?? "Sun")),
    // "24" shows up for midnight in some ICU builds.
    hour: Number(bag.hour) % 24,
  };
}

/** YYYY-MM-DD for a UTC-built date, used only inside the holiday table. */
function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Nth (1-based) given weekday of a month, as a UTC date. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + (n - 1) * 7));
}

/** Last given weekday of a month, as a UTC date. */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month + 1, 0 - shift));
}

/**
 * The eleven US federal legal holidays for a year, as YYYY-MM-DD strings.
 *
 * Source: 5 U.S.C. §6103(a) for the list and the dates; the Saturday/Sunday
 * observance shift is §6103(b) and E.O. 11582 §5 (a Saturday holiday is
 * observed on the preceding Friday, a Sunday holiday on the following Monday).
 * Both the actual day and its observed day are blocked, which is stricter than
 * either alone and is the right way round for a rule we would rather over-obey
 * than argue about. Sundays are already closed, so in practice the shift that
 * matters is the Monday one.
 */
export function federalHolidays(year: number): Set<string> {
  const out = new Set<string>();

  const fixed = (month: number, day: number) => {
    const actual = new Date(Date.UTC(year, month, day));
    out.add(ymdUtc(actual));
    const dow = actual.getUTCDay();
    if (dow === 6) out.add(ymdUtc(new Date(Date.UTC(year, month, day - 1))));
    if (dow === 0) out.add(ymdUtc(new Date(Date.UTC(year, month, day + 1))));
  };

  fixed(0, 1); // New Year's Day
  out.add(ymdUtc(nthWeekday(year, 0, 1, 3))); // MLK Jr Day — 3rd Monday, Jan
  out.add(ymdUtc(nthWeekday(year, 1, 1, 3))); // Washington's Birthday — 3rd Mon, Feb
  out.add(ymdUtc(lastWeekday(year, 4, 1))); // Memorial Day — last Monday, May
  fixed(5, 19); // Juneteenth
  fixed(6, 4); // Independence Day
  out.add(ymdUtc(nthWeekday(year, 8, 1, 1))); // Labor Day — 1st Monday, Sep
  out.add(ymdUtc(nthWeekday(year, 9, 1, 2))); // Columbus Day — 2nd Monday, Oct
  fixed(10, 11); // Veterans Day
  out.add(ymdUtc(nthWeekday(year, 10, 4, 4))); // Thanksgiving — 4th Thursday, Nov
  fixed(11, 25); // Christmas Day

  return out;
}

/** True when that Eastern calendar day is a federal legal holiday. */
export function isFederalHoliday(ymd: string): boolean {
  const year = Number(ymd.slice(0, 4));
  if (!Number.isFinite(year)) return false;
  return federalHolidays(year).has(ymd);
}

/**
 * May a call be placed right now? 9 a.m. – 7 p.m., Monday to Saturday, not on
 * a federal legal holiday, in the given zone (Eastern, where the shop is).
 */
export function isWithinCallingHours(
  now: Date = new Date(),
  tz: string = TZ,
): boolean {
  const p = partsIn(now, tz);
  if (p.weekday === 0) return false; // no Sundays
  if (p.hour < CALL_HOUR_START || p.hour >= CALL_HOUR_END) return false;
  return !isFederalHoliday(p.ymd);
}

/** Human sentence for the hours rule, used in hints and the policy page. */
export const CALLING_HOURS_LABEL = "9 a.m.–7 p.m. Eastern, Mon–Sat, no federal holidays";

/* the gate --------------------------------------------------------------- */

export type BlockReason =
  | "phone_suppressed"
  | "dnc"
  | "lost"
  | "hours"
  | "pending_outcome";

/**
 * A call that is permitted but is not a warm one. Alina's ruling on first
 * live use, 2026-09-10: "we still need to be able to make the risky calls,
 * but I'd like them striped green and gray rather than full green."
 *
 * So the out-of-window case stopped being a block and became a *risk*: the
 * button stays live, wears diagonal green-and-grey stripes instead of solid
 * green, and the event we write records `outside_window: true` so the log
 * says the cold call was made knowingly. The lawful obligation is unchanged —
 * the policy still requires a national and Pennsylvania registry scrub before
 * dialling a registry-listed residential number — but honouring it is the
 * caller's job now, not the button's.
 */
export type CallRisk = "outside_window";

/** Days between two YYYY-MM-DD-ish instants, positive when `later` is later. */
function daysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

/**
 * A registry scrub that says "not listed" and is still fresh. This is the only
 * thing that lets an out-of-window number be dialled: a cold call is lawful
 * once the number has been checked against the registries inside 31 days.
 * Note that "clear" only means the last import did not list it — the policy
 * (docs/call-desk-do-not-call-policy.md) requires BOTH the national and the
 * Pennsylvania lists to have been imported before this is worth anything.
 */
export function hasFreshScrub(
  row: Pick<CallDeskRow, "dnc_status" | "dnc_checked_at">,
  now: Date = new Date(),
): boolean {
  if (row.dnc_status !== "clear") return false;
  if (!row.dnc_checked_at) return false;
  const checked = new Date(row.dnc_checked_at);
  if (Number.isNaN(checked.getTime())) return false;
  const age = daysBetween(checked, now);
  return age >= 0 && age <= SCRUB_MAX_AGE_DAYS;
}

/**
 * Why this row may not be dialled, or null when it may.
 *
 * Only the phone is ever blocked. The row itself always stays on the desk and
 * fully workable — Alina's ruling, 2026-09-10: "this isn't only the call desk
 * but the outreach desk, so just gray out the call button". Note, Generate
 * deal and the details are untouched by everything here.
 *
 * Order matters: the reason shown is the one that would take the most work to
 * clear, so the caller is never told "come back at nine" about a number he can
 * never dial. Legal blocks first; then "lost", which is a deliberate human
 * decision and carries its own Reopen button; then the hours; then the open
 * call.
 *
 * Being outside the relationship window is NOT here (bj-finance #424). That
 * is a risk, not a block — see `callRisk`.
 */
export function callBlockReason(
  row: CallDeskRow,
  now: Date = new Date(),
): BlockReason | null {
  if (row.phone_suppressed) return "phone_suppressed";
  if (row.dnc_status && DNC_BLOCKING.has(row.dnc_status)) return "dnc";
  if (row.status === "called_lost") return "lost";
  if (!isWithinCallingHours(now)) return "hours";
  if (row.pending_disposition_event_id) return "pending_outcome";
  return null;
}

/**
 * Why this row may be dialled but should be dialled knowingly, or null when
 * the call is an ordinary warm one (bj-finance #424).
 *
 * `outside_window` is the old `expired` block, demoted. The relationship
 * window has run out and no registry scrub inside 31 days stands in its
 * place, so the call is a cold call. It is still placed — the button is
 * striped rather than dead — and the `called` event records it as such.
 */
export function callRisk(
  row: CallDeskRow,
  now: Date = new Date(),
): CallRisk | null {
  if (!row.ebr_active && !hasFreshScrub(row, now)) return "outside_window";
  return null;
}

/**
 * The disabled button's own label. Two or three words, because the label is
 * now the only place the reason is said — bj-finance #424 deleted the hint
 * line that used to sit under the button grid.
 */
export const BLOCK_LABEL: Record<BlockReason, string> = {
  phone_suppressed: "Number suppressed",
  dnc: "On DNC list",
  lost: "Lost",
  hours: "After hours",
  pending_outcome: "Log outcome first",
};

/** One short line for a disabled Call now button, now its tooltip. */
export const BLOCK_HINT: Record<BlockReason, string> = {
  phone_suppressed: "On the do-not-call list",
  dnc: "On the do-not-call list",
  lost: "Marked lost, reopen to call",
  hours: "Outside calling hours (9–7, Mon–Sat)",
  pending_outcome: "Log the outcome of the last call first",
};

/** The striped button's tooltip — one sentence, and the honest word for it. */
export const RISK_HINT: Record<CallRisk, string> = {
  outside_window:
    "Outside the relationship window, not yet scrubbed against the registries. Calling is allowed but is a cold call.",
};

/** The longer version, for the row's expanded details and the API response. */
export const BLOCK_EXPLANATION: Record<BlockReason, string> = {
  phone_suppressed:
    "This number is on our internal do-not-call list. That never expires and it beats every relationship window.",
  dnc: "This number is on a do-not-call registry or on our own internal list. Do not dial it.",
  lost:
    "This prospect was marked \u201cNot now / lost\u201d on a call. They are still on the email list; reopen them to put the number back in play.",
  hours:
    "Calls are only placed between 9 a.m. and 7 p.m. Eastern, Monday to Saturday, and never on a federal legal holiday.",
  pending_outcome:
    "The last call to this prospect has no outcome recorded. Log it before dialling again.",
};

/* the opening script ----------------------------------------------------- */

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** "September 9, 2026" from a YYYY-MM-DD date or an ISO timestamp. */
function longDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return DATE_FMT.format(d);
}

/**
 * The caller's first name for the script. Joey signs in with a Gmail address,
 * so an email is the usual input: take the local part, cut it at the first
 * separator and capitalise. He says his own name out loud regardless — this is
 * a prompt, not a transcript.
 */
export function callerFirstName(callerName: string | null | undefined): string {
  const raw = (callerName ?? "").trim();
  if (!raw) return "…";
  const local = raw.includes("@") ? raw.split("@")[0] : raw;
  const first = local.split(/[.\s_+-]/).filter(Boolean)[0] ?? local;
  const clean = first.replace(/\d+/g, "");
  if (!clean) return "…";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * The one line Joey reads before any pitch: his name, the business, and why he
 * is calling — 47 C.F.R. §64.1200(d)(4), 16 C.F.R. §310.4(d), 73 P.S.
 * §2245(a)(5). The closing clause says how we got the number, which is the
 * honest answer to the question that follows it, and it comes from the same
 * column the window was computed from so the two can never disagree.
 */
export function openingScript(
  row: Pick<CallDeskRow, "ebr_basis" | "last_paid_event_date" | "last_inquiry_at">,
  callerName: string | null | undefined,
): string {
  const opener = `Hi, this is ${callerFirstName(callerName)} from Ben & Jerry's Philadelphia, calling about ice cream catering.`;

  if (row.ebr_basis === "purchase") {
    const when = longDate(row.last_paid_event_date);
    if (when) return `${opener} You booked with us on ${when}.`;
  }
  if (row.ebr_basis === "inquiry") {
    const when = longDate(row.last_inquiry_at);
    if (when) return `${opener} You enquired with us on ${when}.`;
  }
  return `${opener} You have been in touch with us before.`;
}

/** The callback number the rules require us to give on request. */
export const CALLBACK_NUMBER = "609-369-6808";
