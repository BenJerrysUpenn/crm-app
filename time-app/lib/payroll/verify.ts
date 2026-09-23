// Verify timesheets — the button bj-finance #519 asks for.
//
// Payroll spec §1: "All AUTO. Output is a list of findings; the button turns
// green only when every finding is either auto-resolved by rule or has a
// recorded ruling." This module is that rulebook, and nothing else: no
// database, no React, no next, and emphatically no model. Alina's design
// constraint of 2026-09-21 is that there are no AI agents anywhere in the
// payroll process — every judgement below is either a rule written here or a
// screen that asks the person, with both options costed.
//
// The caller hands in plain rows and gets back typed findings carrying their
// own evidence (punch ids, shift ids, intervals). That keeps the whole rulebook
// runnable under `node --test` with fixtures, which is the only way the spec's
// rule text can be an acceptance criterion: every test below names the rule
// number it is holding the code to.
//
// THREE STATUSES, and the difference matters:
//
//   auto_resolved — a rule decided it. The finding is still reported, because
//                   the person signing off is entitled to see what the rule
//                   did, but it does not hold the button.
//   needs_ruling  — code cannot decide (§1.4 with no shift, §1.5, §1.9, §3.5,
//                   §3.7). The screen shows the options and records the
//                   choice. §1.9, §3.5 and §3.7 are PER-CASE CHOICES WITH A
//                   PRESELECTED DEFAULT (Alina, 2026-09-22, #519): skip,
//                   Sophia, Sophia. A default satisfies the button on its own;
//                   a manager changes it only when the case needs it. §1.4 and
//                   §1.5 have no default and still need an answer.
//   needs_fix     — the data is wrong and no ruling can make it right: an open
//                   punch has no end (§1.1), two overlapping punches double-pay
//                   (§1.7), and with no audit table nothing here is defensible
//                   at all (§1.13). These clear by fixing the data and running
//                   Verify again.
//
// Times. Punches are instants; opening hours are wall clock. Everything that
// compares the two goes through lib/coverage.ts, which owns that conversion and
// its DST behaviour — see its header. Durations are real elapsed time, because
// hours worked are hours worked whatever the clocks did.

import {
  formatClock,
  formatDayLabel,
  formatMinutes,
  mergeIntervals,
  nyWallClock,
  resolveOpenWindow,
  uncovered,
  type ClosedDateRange,
  type StoreHoursException,
  type StoreHoursRow,
} from "../coverage.ts";
import { LONG_SHIFT_HOURS } from "../shiftChecks.ts";
import { inWindow, windowDates, type PayWindow } from "./window.ts";

// ---------------------------------------------------------------------------
// Thresholds. Every one of these is a number the spec names; they are constants
// so a test can cite the rule and the code can be read against it.
// ---------------------------------------------------------------------------

/** §1.3 — a clock-out this close to the next clock-in is the app auto-closing. */
export const AUTO_CLOSE_SECONDS = 5;
/** §1.5 — a punch under this share of its scheduled shift is a short punch. */
export const SHORT_PUNCH_FRACTION = 0.25;
/** §1.6 — under five minutes, with nothing scheduled, is somebody testing. */
export const TEST_PUNCH_MINUTES = 5;
/** §1.8 — an unstaffed stretch of trading time worth reporting. */
export const COVERAGE_GAP_MINUTES = 15;
/** §1.9 — the store closing this long after the last punch out. */
export const CLOSING_GAP_HOURS = 2;
/** §1.10 — how far outside a shift's hours a cover punch may still bracket it. */
export const COVER_GRACE_MINUTES = 30;
/**
 * §2.4 — "closer must clock out ≥ 22:00 else route to 1.9". The payroll sheet
 * (bj-finance modules/payroll_sheet.py) routes on this, so 1.9 asks about the
 * same nights: a last in-store clock-out before 22:00 qualifies even when it is
 * within 2h of close.
 */
export const SOLO_CLOSE_EARLIEST_OUT_MINUTES = 22 * 60;
/** §3.7 — the bake shift, and the norm: at least 2 a week, 4 a period. */
export const PASTRY_POSITION = "Pastry Opener";
export const BAKE_SHIFT_NORM_PER_PERIOD = 4;
/** §3.5 — the shift type that makes somebody an event's crew. */
export const CATERING_POSITION = "Catering";
/** §3.5 — deals that are real events (lib/cateringShifts.ts BOOKED_STAGES + done). */
export const EVENT_DEAL_STAGES = ["Booked Unpaid", "Booked Paid", "Event Complete"] as const;
/**
 * §3.5 / §3.7 — who a crewless catering tip or a stranded Olo tip goes to when
 * no manager picks anybody else (Alina, 2026-09-22). Matched to a profile by
 * name words, in any order, because the default has to name a person before
 * anybody has picked one; the pick itself is stored by profile id.
 */
export const DEFAULT_TIP_PAYEE_NAME = "Sophia Malmgren";

// ---------------------------------------------------------------------------
// Input rows. Deliberately the shapes the database returns, minus the columns
// no check reads, so the route can pass query results straight through.
// ---------------------------------------------------------------------------

export type ProfileRow = {
  id: string;
  full_name: string | null;
  active: boolean;
  role?: string | null;
  qbo_employee_id?: string | null;
};

export type PunchRow = {
  id: number;
  employee_id: string;
  shift_id: number | null;
  clock_in_at: string;
  clock_out_at: string | null;
};

export type ShiftRow = {
  id: number;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string | null;
  deal_id?: number | null;
};

export type ShiftTypeRow = { name: string; in_store?: boolean | null };

/** Just enough of a CRM deal for §1.12 and §3.5. */
export type DealRow = {
  id: number;
  event_date: string | null;
  staff_count: number | null;
  company?: string | null;
  stage?: string | null;
};

/** One row of public.row_audit (migration 25), as §1.13 reads it. */
export type AuditRow = {
  id: number;
  table_name: string;
  row_id: number | null;
  op: string;
  at: string;
  actor_uid: string | null;
  actor_role: string | null;
  db_role: string;
  before_image: Record<string, unknown> | null;
};

/** A choice already recorded for a ruling-class finding. */
export type RulingRow = {
  check_id: string;
  finding_key: string;
  choice: string;
  /** The profile the choice pays, for the choices that pay somebody. */
  payee_id?: string | null;
  note?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
};

/** The one approval a pay run gets (migration 27, payroll_run_approvals). */
export type ApprovalRow = {
  approved_by: string | null;
  approved_at: string;
};

export type VerifyInput = {
  window: PayWindow;
  /** Today, YYYY-MM-DD in New York. Used only by §0.1 to refuse a future window. */
  today?: string;
  punches: PunchRow[];
  shifts: ShiftRow[];
  shiftTypes: ShiftTypeRow[];
  storeHours: StoreHoursRow[];
  storeHoursExceptions?: StoreHoursException[];
  closedRanges?: ClosedDateRange[];
  profiles: ProfileRow[];
  deals?: DealRow[];
  /**
   * DELETE rows from the audit log. `null` means the audit table is not there
   * — migration 25 has not been applied — which is NOT the same as "nothing was
   * deleted" and must never read as a pass (§1.13).
   */
  auditDeletes?: AuditRow[] | null;
  /** The newest store_hours.updated_at, for §0.6. */
  storeHoursUpdatedAt?: string | null;
  rulings?: RulingRow[];
  /** §3.5 — event deals whose event_date falls in the window. */
  windowDeals?: DealRow[];
  approval?: ApprovalRow | null;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type FindingStatus = "auto_resolved" | "needs_ruling" | "needs_fix";
export type Severity = "info" | "warn" | "error";

/** One pre-costed side of a ruling. The person picks; nothing here guesses. */
export type RulingOption = {
  choice: string;
  label: string;
  /** What choosing this is worth, in the unit the choice is about. */
  effect: string;
};

export type Evidence = {
  employee_id?: string;
  employee_name?: string;
  date?: string;
  punch_ids?: number[];
  shift_ids?: number[];
  deal_id?: number;
  /** A wall-clock interval on `date`, as "HH:MM". */
  interval?: { from: string; to: string };
  hours?: number;
  minutes?: number;
  /** Anything else worth showing, already rendered for a human. */
  notes?: string[];
};

export type Finding = {
  check: string; // "1.5"
  title: string; // "Short punch on a scheduled shift"
  /** The spec's rule text, verbatim. The acceptance criterion, carried to the UI. */
  rule: string;
  /** Stable across runs of the same window: what a recorded ruling is keyed on. */
  key: string;
  status: FindingStatus;
  severity: Severity;
  summary: string;
  evidence: Evidence;
  /** What the rule did, for auto_resolved findings. */
  resolution?: string;
  options?: RulingOption[];
  /** §1.9, §3.5 and §3.7 have defaults; §1.4 and §1.5 deliberately have none. */
  defaultChoice?: string;
  ruling?: RulingRow | null;
  /** Who a paying choice may name. Managers for §1.9, active staff for §3.5/3.7. */
  candidates?: Person[];
  /** The person the default pays, when the default pays somebody (§3.5/3.7). */
  defaultPayee?: Person | null;
  /** §1.9 — who was scheduled to close that night, if anybody. */
  scheduledCloser?: Person | null;
  /** What stands: the recorded choice, else the default. Choice checks only. */
  effective?: EffectiveChoice | null;
  /** Things the approver must see about this case. They never block. */
  flags?: string[];
};

export type Person = { id: string; name: string };

export type EffectiveChoice = {
  choice: string;
  payee: Person | null;
  source: "recorded" | "default";
};

export type ApprovalState = "approved" | "stale" | "not_approved";

export type CheckGroup = {
  check: string;
  title: string;
  rule: string;
  findings: Finding[];
};

export type VerifyResult = {
  window: PayWindow;
  findings: Finding[];
  groups: CheckGroup[];
  counts: {
    total: number;
    autoResolved: number;
    needsRuling: number;
    ruled: number;
    /** Choice-with-default cases standing on their default. */
    defaulted: number;
    needsFix: number;
  };
  /** Nothing to fix, and every case answered by a recording or a default. */
  ready: boolean;
  approval: ApprovalRow | null;
  /** Approved before a choice last changed is STALE: approve again. */
  approvalState: ApprovalState;
  /** Every flag on every finding, for the approve panel. */
  flags: { key: string; message: string }[];
};

// The rule text, verbatim from docs/specs/payroll-pipeline.md §0 and §1. Kept
// in one place so the finding, the UI and the tests all quote the same words.
const RULES: Record<string, { title: string; rule: string }> = {
  "0.1": {
    title: "Pay window",
    rule: "period = the 14 days ending the most recent Sunday; pay date = end + 3 (Wed). Never read upcoming_pay_periods[].pay_date (misaligned).",
  },
  "0.6": {
    title: "store_hours age",
    rule: "warn if store_hours was last edited inside the window (coverage report would judge data with a younger baseline)",
  },
  "1.1": { title: "Open punch", rule: "clock_out IS NULL inside window" },
  "1.2": { title: "Long punch", rule: "duration > 15h" },
  "1.3": {
    title: "Auto-close signature",
    rule: "recorded clock_out == same person's next clock_in within 5s → missed clock-out",
  },
  "1.4": {
    title: "Truncation",
    rule: "1.2/1.3 with a scheduled shift → use scheduled end, note it. With NO scheduled shift → RULING (real hours / void).",
  },
  "1.5": {
    title: "Short punch on a scheduled shift",
    rule: "punch < 25% of scheduled length → RULING: as punched / scheduled length. Existing rules only shorten runaways; this one is about extending.",
  },
  "1.6": { title: "Test punch", rule: "< 5 min AND no scheduled shift → 0h, listed" },
  "1.7": { title: "Overlaps", rule: "same person, overlapping intervals" },
  "1.8": {
    title: "Mid-day coverage gap",
    rule: "for each day, intervals inside store_hours where no in-store punch is active, ≥15 min",
  },
  "1.9": {
    title: "No closing punch",
    rule: "last in-store clock-out > 2h before store close, or before 22:00 (2.4) → a dropdown on the schedule: pay scheduled closer / pay unpunched manager / skip payment. Default = skip (ruled 2026-09-22). Flag a night where the manager paid is the one who changed the dropdown.",
  },
  "1.10": {
    title: "Cover punches",
    rule: "blank shift_id: first join shifts by person+date; if none, join an unworked shift that day whose hours bracket the punch and show the swap",
  },
  "1.11": {
    title: "Catering shift without deal_id",
    rule: "flag at scheduling time, not payroll time",
  },
  "1.12": {
    title: "Catering event under-punched",
    rule: "deals.staff_count vs punched Catering shifts",
  },
  "1.13": {
    title: "Deleted rows",
    rule: "no audit table exists; ids 1270–1274 and ≥3 shifts vanished inside the window. Precondition for trusting anything above: add time_entries/shifts audit triggers (who, when, before-image).",
  },
  "1.14": { title: "Name hygiene", rule: "profiles.full_name containing '@' (invite-flow bug)" },
  "3.5": {
    title: "Crewless catering event",
    rule: "deal shift unassigned + nobody punched → a staff picker on the event, default Sophia (ruled 2026-09-22). Flag a crewless tip paid to the person who approves the run. Upstream: the event needs its Catering shift added.",
  },
  "3.7": {
    title: "No bake shift worked",
    rule: "a window with zero Pastry Opener shifts is a schedule anomaly (norm ≥ 2/week, ≥ 4/period); any stranded Olo tips go to a staff picker, default Sophia, flagged when paid to the approver (ruled 2026-09-22).",
  },
};

const CHECK_ORDER = [
  "0.1", "0.6", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "1.10", "1.11", "1.12", "1.13", "1.14",
  "3.5", "3.7",
];

/** The ruling-class checks. A finding outside this set can never need a ruling. */
export const RULING_CHECKS = ["1.4", "1.5", "1.9", "3.5", "3.7"] as const;

/**
 * Every choice each ruling-class check may be answered with.
 *
 * The options themselves are built per finding, because their EFFECT is per
 * finding ("Pay 2.19h" / "Pay 7h"), but the vocabulary is fixed and the API
 * validates against it rather than against anything the browser sent. A test
 * asserts that no finding ever offers a choice this map does not list, so the
 * two cannot drift apart.
 */
export const RULING_CHOICES: Record<string, readonly string[]> = {
  "1.4": ["real_hours", "void"],
  "1.5": ["as_punched", "scheduled"],
  "1.9": ["skip", "scheduled_closer", "unpunched_manager"],
  "3.5": ["staff"],
  "3.7": ["staff"],
};

/**
 * The choices that pay a named person, and so must carry a payee. Everything
 * else (skip, and every §1.4/§1.5 answer) must not. The route and the payroll
 * sheet read the same rule: a paying choice with nobody to pay is refused here
 * and reported as an open item there.
 */
export const PAYING_CHOICES: ReadonlySet<string> = new Set([
  "1.9:scheduled_closer",
  "1.9:unpunched_manager",
  "3.5:staff",
  "3.7:staff",
]);

export function choicePays(check: string, choice: string): boolean {
  return PAYING_CHOICES.has(`${check}:${choice}`);
}

/** "Sophia Malmgren" and "Malmgren, Sophia" are the same words. */
export function sameNameWords(a: string | null | undefined, b: string | null | undefined): boolean {
  const words = (s: string | null | undefined) =>
    (s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .sort()
      .join(" ");
  const left = words(a);
  return left !== "" && left === words(b);
}

// ---------------------------------------------------------------------------
// The enriched punch every check reads
// ---------------------------------------------------------------------------

export type ShiftMatch = "explicit" | "person_date" | "cover" | "none";

export type PunchView = {
  row: PunchRow;
  employeeId: string;
  name: string;
  /** New York calendar date of the clock-in. The day a punch belongs to. */
  date: string;
  startMs: number;
  /** null while the punch is open. */
  endMs: number | null;
  /** Real elapsed hours, or null while open. */
  hours: number | null;
  shift: ShiftRow | null;
  match: ShiftMatch;
  /** For a cover: whose shift it was. */
  coverFor: string | null;
  /** Does this punch put somebody behind the counter? */
  inStore: boolean;
};

const MS_HOUR = 3_600_000;

function nameOf(profiles: Map<string, ProfileRow>, id: string): string {
  return profiles.get(id)?.full_name?.trim() || "Unknown person";
}

/** Is this position an in-store type? Unknown or blank counts as in-store. */
function positionIsInStore(position: string | null | undefined, byName: Map<string, boolean>): boolean {
  const key = position?.trim();
  if (!key) return true;
  const known = byName.get(key);
  return known === undefined ? true : known;
}

/**
 * Attach each punch to the shift it was worked against (§1.10), and work out
 * whether it counts as in-store.
 *
 * The ladder is the spec's: an explicit shift_id, then this person's own shift
 * that day, then somebody else's unworked shift that brackets the punch — the
 * cover swap. Nine of nine blank punches in the 2026-09-23 window were covers,
 * and joining on person+date alone found none of them.
 */
export function buildPunchViews(input: {
  punches: PunchRow[];
  shifts: ShiftRow[];
  shiftTypes: ShiftTypeRow[];
  profiles: ProfileRow[];
}): PunchView[] {
  const profiles = new Map(input.profiles.map((p) => [p.id, p]));
  const inStoreByName = new Map(input.shiftTypes.map((t) => [t.name, t.in_store ?? true]));

  const shiftDate = new Map<number, string>();
  for (const shift of input.shifts) shiftDate.set(shift.id, nyWallClock(shift.starts_at).date);

  const shiftById = new Map(input.shifts.map((s) => [s.id, s]));

  // Which employees punched on which dates — used to tell a shift somebody
  // worked from one nobody did.
  const punchedDates = new Set<string>();
  for (const punch of input.punches) {
    punchedDates.add(`${punch.employee_id}|${nyWallClock(punch.clock_in_at).date}`);
  }

  const views: PunchView[] = [];
  for (const row of input.punches) {
    const startMs = new Date(row.clock_in_at).getTime();
    const endMs = row.clock_out_at ? new Date(row.clock_out_at).getTime() : null;
    const date = nyWallClock(row.clock_in_at).date;

    let shift: ShiftRow | null = null;
    let match: ShiftMatch = "none";
    let coverFor: string | null = null;

    if (row.shift_id !== null && shiftById.has(row.shift_id)) {
      shift = shiftById.get(row.shift_id)!;
      match = "explicit";
    } else {
      // Their own shift that day. If they have two, take the one the punch
      // overlaps most — a swing and a close on one day are both theirs.
      const own = input.shifts.filter((s) => s.employee_id === row.employee_id && shiftDate.get(s.id) === date);
      const bestOwn = pickBestOverlap(own, startMs, endMs);
      if (bestOwn) {
        shift = bestOwn;
        match = "person_date";
      } else if (endMs !== null) {
        // A cover: somebody else's shift that day, which that person did not
        // punch for, and whose hours bracket this punch.
        const grace = COVER_GRACE_MINUTES * 60_000;
        const candidates = input.shifts.filter((s) => {
          if (shiftDate.get(s.id) !== date) return false;
          if (!s.employee_id || s.employee_id === row.employee_id) return false;
          if (punchedDates.has(`${s.employee_id}|${date}`)) return false;
          const from = new Date(s.starts_at).getTime();
          const to = new Date(s.ends_at).getTime();
          return startMs >= from - grace && endMs <= to + grace;
        });
        const bestCover = pickBestOverlap(candidates, startMs, endMs);
        if (bestCover) {
          shift = bestCover;
          match = "cover";
          coverFor = bestCover.employee_id ? nameOf(profiles, bestCover.employee_id) : null;
        }
      }
    }

    views.push({
      row,
      employeeId: row.employee_id,
      name: nameOf(profiles, row.employee_id),
      date,
      startMs,
      endMs,
      hours: endMs === null ? null : Math.max(0, (endMs - startMs) / MS_HOUR),
      shift,
      match,
      coverFor,
      inStore: positionIsInStore(shift?.position ?? null, inStoreByName),
    });
  }

  return views.sort((a, b) => a.startMs - b.startMs || a.row.id - b.row.id);
}

/** The candidate a punch overlaps most, or null when none overlaps at all. */
function pickBestOverlap(candidates: ShiftRow[], startMs: number, endMs: number | null): ShiftRow | null {
  let best: ShiftRow | null = null;
  let bestOverlap = -1;
  for (const shift of candidates) {
    const from = new Date(shift.starts_at).getTime();
    const to = new Date(shift.ends_at).getTime();
    // An open punch has no end to overlap with; treat it as an instant so a
    // person who clocked in for their shift and never out is still matched.
    const punchEnd = endMs ?? startMs;
    const overlap = Math.min(to, punchEnd) - Math.max(from, startMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = shift;
    }
  }
  return bestOverlap >= 0 ? best : null;
}

function scheduledHours(shift: ShiftRow): number {
  return Math.max(0, (new Date(shift.ends_at).getTime() - new Date(shift.starts_at).getTime()) / MS_HOUR);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "2h 05m", or "2m 11s" when that is what the number deserves. */
export function describeDuration(hours: number): string {
  const totalSeconds = Math.round(hours * 3600);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}

function finding(check: string, rest: Omit<Finding, "check" | "title" | "rule">): Finding {
  const meta = RULES[check];
  return { check, title: meta.title, rule: meta.rule, ...rest };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * §0.1 and §0.6 — the preconditions this app can answer from its own data.
 *
 * The other four (§0.2–§0.5: Square coverage, Square session, QBO session, Olo
 * workbook) are about systems outside this app and belong with the hours-and-
 * tips module (build item 9.4). They are deliberately absent rather than
 * stubbed: a precondition that always passes is worse than one that is missing.
 */
function checkPreconditions(input: VerifyInput): Finding[] {
  const { window } = input;
  const out: Finding[] = [];

  const summary = `Pay window ${window.start} → ${window.end}, pay date ${window.payDate}.`;
  if (input.today && window.end > input.today) {
    out.push(
      finding("0.1", {
        key: `0.1:${window.end}`,
        status: "needs_fix",
        severity: "error",
        summary: `${summary} That period has not finished yet (today is ${input.today}).`,
        evidence: { date: window.end },
      }),
    );
  } else {
    out.push(
      finding("0.1", {
        key: `0.1:${window.end}`,
        status: "auto_resolved",
        severity: "info",
        summary,
        resolution: "14 days ending the most recent Sunday; pay date = end + 3. Computed here, never read from QBO.",
        evidence: { date: window.end },
      }),
    );
  }

  const edited = input.storeHoursUpdatedAt ? nyWallClock(input.storeHoursUpdatedAt).date : null;
  if (edited && inWindow(edited, window)) {
    out.push(
      finding("0.6", {
        key: `0.6:${window.end}`,
        status: "auto_resolved",
        severity: "warn",
        summary: `Store hours were last edited ${formatDayLabel(edited)}, inside this window.`,
        resolution:
          "The mid-day gap check (1.8) is judging this window against hours that are younger than it. Read its findings with that in mind.",
        evidence: { date: edited },
      }),
    );
  }

  return out;
}

/** §1.1 — clock_out IS NULL inside window. */
function checkOpenPunches(views: PunchView[], window: PayWindow): Finding[] {
  return views
    .filter((v) => v.endMs === null && inWindow(v.date, window))
    .map((v) =>
      finding("1.1", {
        key: `1.1:punch:${v.row.id}`,
        status: "needs_fix",
        severity: "error",
        summary: `${v.name} is still clocked in from ${formatDayLabel(v.date)} ${formatClock(formatMinutes(nyWallClock(v.row.clock_in_at).minutes))}.`,
        evidence: { employee_id: v.employeeId, employee_name: v.name, date: v.date, punch_ids: [v.row.id] },
      }),
    );
}

/** §1.2 — duration > 15h. Detection only; §1.4 decides what to do about it. */
function checkLongPunches(views: PunchView[], window: PayWindow): PunchView[] {
  return views.filter((v) => inWindow(v.date, window) && v.hours !== null && v.hours > LONG_SHIFT_HOURS);
}

/**
 * §1.3 — recorded clock_out == same person's next clock_in within 5s.
 *
 * This is the app's own signature, not a coincidence: when somebody clocks in
 * while still on the clock, the previous punch is closed at that instant. The
 * punch therefore ends where the person's attention moved on, not where their
 * shift did, and §1.4 decides what its real end was.
 */
function checkAutoClosed(views: PunchView[], window: PayWindow): PunchView[] {
  const byEmployee = new Map<string, PunchView[]>();
  for (const v of views) {
    const list = byEmployee.get(v.employeeId);
    if (list) list.push(v);
    else byEmployee.set(v.employeeId, [v]);
  }

  const flagged: PunchView[] = [];
  const tolerance = AUTO_CLOSE_SECONDS * 1000;
  for (const list of byEmployee.values()) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      if (current.endMs === null) continue;
      if (!inWindow(current.date, window)) continue;
      if (Math.abs(next.startMs - current.endMs) <= tolerance) flagged.push(current);
    }
  }
  return flagged;
}

/**
 * §1.4 — truncation. A rule, not a ruling, WHEN there is a scheduled shift:
 * the punch is cut back to the shift's end and the change is noted. With no
 * shift to cut back to there is nothing to compute from, so the screen asks:
 * the hours as punched, or void.
 */
function checkTruncation(runaways: PunchView[], reasons: Map<number, string[]>): Finding[] {
  const seen = new Set<number>();
  const out: Finding[] = [];
  for (const v of runaways) {
    if (seen.has(v.row.id)) continue;
    seen.add(v.row.id);
    const why = (reasons.get(v.row.id) ?? []).join(" and ");
    const punched = v.hours ?? 0;

    if (v.shift) {
      const end = nyWallClock(v.shift.ends_at);
      const truncated = Math.max(0, (new Date(v.shift.ends_at).getTime() - v.startMs) / MS_HOUR);
      out.push(
        finding("1.4", {
          key: `1.4:punch:${v.row.id}`,
          status: "auto_resolved",
          severity: "warn",
          summary: `${v.name} ${formatDayLabel(v.date)}: ${describeDuration(punched)} punched (${why}), against a shift ending ${formatClock(formatMinutes(end.minutes))}.`,
          resolution: `Truncated to the scheduled end: ${round2(truncated)}h instead of ${round2(punched)}h.`,
          evidence: {
            employee_id: v.employeeId,
            employee_name: v.name,
            date: v.date,
            punch_ids: [v.row.id],
            shift_ids: [v.shift.id],
            hours: round2(truncated),
          },
        }),
      );
    } else {
      out.push(
        finding("1.4", {
          key: `1.4:punch:${v.row.id}`,
          status: "needs_ruling",
          severity: "error",
          summary: `${v.name} ${formatDayLabel(v.date)}: ${describeDuration(punched)} punched (${why}), with no scheduled shift to cut it back to.`,
          options: [
            { choice: "real_hours", label: "Real hours", effect: `Pay ${round2(punched)}h as punched.` },
            { choice: "void", label: "Void", effect: "Pay 0h for this punch." },
          ],
          evidence: {
            employee_id: v.employeeId,
            employee_name: v.name,
            date: v.date,
            punch_ids: [v.row.id],
            hours: round2(punched),
          },
        }),
      );
    }
  }
  return out;
}

/**
 * §1.5 — short punch on a scheduled shift.
 *
 * New in this spec, and the only check that can make somebody's day longer:
 * every other rule here shortens a runaway. Carli's 09-18 punch was 2m 11s
 * against a 7h shift because Sophia closed for her; the ruling that run was "as
 * punched". There is deliberately no default — the two answers differ by nearly
 * a full shift's pay and the run that needs it will have a reason either way.
 */
function checkShortPunches(views: PunchView[], window: PayWindow, runawayIds: Set<number>): Finding[] {
  const out: Finding[] = [];
  for (const v of views) {
    if (!inWindow(v.date, window)) continue;
    if (v.hours === null || !v.shift) continue;
    if (runawayIds.has(v.row.id)) continue; // a long punch is not also a short one
    const scheduled = scheduledHours(v.shift);
    if (scheduled <= 0) continue;
    if (v.hours >= scheduled * SHORT_PUNCH_FRACTION) continue;

    out.push(
      finding("1.5", {
        key: `1.5:punch:${v.row.id}`,
        status: "needs_ruling",
        severity: "warn",
        summary: `${v.name} ${formatDayLabel(v.date)}: punched ${describeDuration(v.hours)} against a ${round2(scheduled)}h scheduled shift.`,
        options: [
          { choice: "as_punched", label: "As punched", effect: `Pay ${round2(v.hours)}h.` },
          { choice: "scheduled", label: "Scheduled length", effect: `Pay ${round2(scheduled)}h.` },
        ],
        evidence: {
          employee_id: v.employeeId,
          employee_name: v.name,
          date: v.date,
          punch_ids: [v.row.id],
          shift_ids: [v.shift.id],
          hours: round2(v.hours),
        },
      }),
    );
  }
  return out;
}

/** §1.6 — under five minutes with nothing scheduled. Zero hours, and listed. */
function checkTestPunches(views: PunchView[], window: PayWindow): Finding[] {
  const out: Finding[] = [];
  for (const v of views) {
    if (!inWindow(v.date, window)) continue;
    if (v.hours === null || v.shift) continue;
    if (v.hours * 60 >= TEST_PUNCH_MINUTES) continue;
    out.push(
      finding("1.6", {
        key: `1.6:punch:${v.row.id}`,
        status: "auto_resolved",
        severity: "info",
        summary: `${v.name} ${formatDayLabel(v.date)}: ${describeDuration(v.hours)} with nothing scheduled.`,
        resolution: "0 hours. Listed so it is visible, not silently dropped.",
        evidence: { employee_id: v.employeeId, employee_name: v.name, date: v.date, punch_ids: [v.row.id], hours: 0 },
      }),
    );
  }
  return out;
}

/** §1.7 — same person, overlapping intervals. Two punches, one body: double pay. */
function checkOverlaps(views: PunchView[], window: PayWindow): Finding[] {
  const byEmployee = new Map<string, PunchView[]>();
  for (const v of views) {
    if (v.endMs === null) continue; // an open punch is §1.1's problem
    const list = byEmployee.get(v.employeeId);
    if (list) list.push(v);
    else byEmployee.set(v.employeeId, [v]);
  }

  const out: Finding[] = [];
  for (const list of byEmployee.values()) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.startMs >= a.endMs!) break; // sorted: nothing later overlaps either
        if (!inWindow(a.date, window) && !inWindow(b.date, window)) continue;
        const overlapMs = Math.min(a.endMs!, b.endMs!) - b.startMs;
        out.push(
          finding("1.7", {
            key: `1.7:punches:${a.row.id}-${b.row.id}`,
            status: "needs_fix",
            severity: "error",
            summary: `${a.name} ${formatDayLabel(a.date)}: punches ${a.row.id} and ${b.row.id} overlap by ${describeDuration(overlapMs / MS_HOUR)}.`,
            evidence: {
              employee_id: a.employeeId,
              employee_name: a.name,
              date: a.date,
              punch_ids: [a.row.id, b.row.id],
              minutes: Math.round(overlapMs / 60000),
            },
          }),
        );
      }
    }
  }
  return out;
}

/**
 * §1.8 — mid-day coverage gap. New in #519.
 *
 * The same question lib/coverage.ts asks of the published SCHEDULE, asked of
 * what actually happened: for each day, the stretches inside opening hours with
 * no in-store punch running. Four evenings in the 2026-09-23 window had about
 * five hours between them, which is how §1.9 came to exist.
 *
 * Open punches cover nothing. A punch with no end cannot say when its cover
 * stopped, and assuming it ran to closing would paper over exactly the hole
 * this looks for; §1.1 reports it separately so it gets fixed.
 *
 * A day whose hours nobody has set is reported, never judged — the same
 * distinction lib/coverage.ts draws between "closed" and "not set".
 */
function checkCoverageGaps(views: PunchView[], input: VerifyInput): Finding[] {
  const { window } = input;
  const exceptions = input.storeHoursExceptions ?? [];
  const closedRanges = input.closedRanges ?? [];

  const byDate = new Map<string, { from: number; to: number }[]>();
  for (const v of views) {
    if (!v.inStore || v.endMs === null) continue;
    const start = nyWallClock(v.row.clock_in_at);
    const end = nyWallClock(v.row.clock_out_at!);
    // A punch spanning midnight covers the tail of one day and the head of the
    // next, in wall clock — the unit opening hours are written in.
    if (end.date === start.date) {
      if (end.minutes > start.minutes) push(byDate, start.date, start.minutes, end.minutes);
    } else if (end.date > start.date) {
      push(byDate, start.date, start.minutes, 1440);
      if (end.minutes > 0) push(byDate, end.date, 0, end.minutes);
    }
  }

  const out: Finding[] = [];
  const unset: string[] = [];
  for (const date of windowDates(window)) {
    const open = resolveOpenWindow(date, input.storeHours, exceptions, closedRanges);
    if (open.state === "unset") {
      unset.push(date);
      continue;
    }
    if (open.state === "closed") continue;
    const merged = mergeIntervals(byDate.get(date) ?? []);
    for (const gap of uncovered(open.opens, open.closes, merged)) {
      const minutes = gap.to - gap.from;
      if (minutes < COVERAGE_GAP_MINUTES) continue;
      const from = formatMinutes(gap.from);
      const to = formatMinutes(gap.to);
      out.push(
        finding("1.8", {
          key: `1.8:${date}:${from}-${to}`,
          status: "auto_resolved",
          severity: "warn",
          summary: `${formatDayLabel(date)}: nobody clocked in ${formatClock(from)} to ${formatClock(to)} (${describeDuration(minutes / 60)}), inside opening hours.`,
          resolution:
            "Reported. If it is the end of the evening, the closing question is 1.9; otherwise it is a punch somebody owes.",
          evidence: { date, interval: { from, to }, minutes },
        }),
      );
    }
  }

  if (unset.length > 0) {
    out.push(
      finding("1.8", {
        key: `1.8:hours-not-set:${window.end}`,
        status: "auto_resolved",
        severity: "info",
        summary: `${unset.length} day${unset.length === 1 ? "" : "s"} in this window have no store hours set, so coverage was not judged on them.`,
        resolution: "Set the hours on the Team page. Hours not set is deliberately different from closed.",
        evidence: { notes: unset.map((d) => formatDayLabel(d)) },
      }),
    );
  }

  return out;
}

function push(map: Map<string, { from: number; to: number }[]>, date: string, from: number, to: number) {
  const list = map.get(date);
  if (list) list.push({ from, to });
  else map.set(date, [{ from, to }]);
}

/**
 * §1.9 — no closing punch.
 *
 * Three nights in the 2026-09-23 window ended more than two hours before the
 * door did, and the run had to ask Sophia what happened. Alina ruled on
 * 2026-09-22 (#519) that this is a per-night choice on the SCHEDULE view, with
 * three options — pay the scheduled closer, pay a manager who closed without
 * punching, or skip — and that the default is SKIP: no bonus unless a manager
 * says otherwise.
 *
 * A night qualifies when the last in-store clock-out is more than 2h before
 * close OR before 22:00, because the payroll sheet routes every close before
 * 22:00 here (§2.4) and the two must ask about the same nights.
 *
 * Only days with at least one in-store punch are asked about: with nobody in at
 * all there is no evening to ask about, and §1.8 has already reported the whole
 * day as uncovered.
 */
function checkClosingPunch(views: PunchView[], input: VerifyInput, profiles: Map<string, ProfileRow>): Finding[] {
  const { window } = input;
  const exceptions = input.storeHoursExceptions ?? [];
  const closedRanges = input.closedRanges ?? [];

  const lastOutByDate = new Map<string, PunchView>();
  for (const v of views) {
    if (!v.inStore || v.endMs === null) continue;
    // A punch belongs to the day it STARTED on, even when it ends after
    // midnight: the person who clocked out at 00:20 closed Saturday night, not
    // Sunday morning.
    const date = v.date;
    const current = lastOutByDate.get(date);
    if (!current || v.endMs > current.endMs!) lastOutByDate.set(date, v);
  }

  const managers = input.profiles
    .filter((p) => p.active && p.role === "manager")
    .map((p) => ({ id: p.id, name: nameOf(profiles, p.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const inStoreByName = new Map(input.shiftTypes.map((t) => [t.name, t.in_store ?? true]));

  const out: Finding[] = [];
  for (const date of windowDates(window)) {
    const open = resolveOpenWindow(date, input.storeHours, exceptions, closedRanges);
    if (open.state !== "open") continue;
    const last = lastOutByDate.get(date);
    if (!last) continue;

    const outAt = nyWallClock(last.row.clock_out_at!);
    // Minutes past the day's own midnight; a 00:30 clock-out on the next
    // calendar day is 1470, not 30, so closing at 22:00 is correctly "after".
    const outMinutes = outAt.date === date ? outAt.minutes : outAt.minutes + 1440;
    const gapMinutes = open.closes - outMinutes;
    if (gapMinutes <= CLOSING_GAP_HOURS * 60 && outMinutes >= SOLO_CLOSE_EARLIEST_OUT_MINUTES) continue;

    const closer = scheduledCloser(input.shifts, date, inStoreByName);
    const closerPerson = closer?.employee_id ? { id: closer.employee_id, name: nameOf(profiles, closer.employee_id) } : null;

    out.push(
      finding("1.9", {
        key: `1.9:${date}`,
        status: "needs_ruling",
        severity: "warn",
        summary: `${formatDayLabel(date)}: last in-store clock-out was ${last.name} at ${formatClock(formatMinutes(outAt.minutes))}, ${describeDuration(Math.max(0, gapMinutes) / 60)} before the ${formatClock(formatMinutes(open.closes))} close.`,
        defaultChoice: "skip",
        options: [
          { choice: "skip", label: "Skip payment (default)", effect: "No solo-close bonus for this night." },
          {
            choice: "scheduled_closer",
            label: "Pay scheduled closer",
            effect: closerPerson
              ? `${closerPerson.name} was scheduled to close and is paid the $30 solo-close bonus.`
              : "Nobody was scheduled to close this night, so there is nobody to pay.",
          },
          {
            choice: "unpunched_manager",
            label: "Pay unpunched manager",
            effect: "A manager closed without punching and is paid the $30 solo-close bonus. Pick which one.",
          },
        ],
        candidates: managers,
        scheduledCloser: closerPerson,
        evidence: {
          date,
          employee_id: last.employeeId,
          employee_name: last.name,
          punch_ids: [last.row.id],
          shift_ids: closer ? [closer.id] : undefined,
          minutes: gapMinutes,
        },
      }),
    );
  }
  return out;
}

/** The in-store shift that ends last on a date, with somebody on it. */
function scheduledCloser(shifts: ShiftRow[], date: string, inStoreByName: Map<string, boolean>): ShiftRow | null {
  let best: ShiftRow | null = null;
  for (const s of shifts) {
    if (!s.employee_id) continue;
    if (nyWallClock(s.starts_at).date !== date) continue;
    if (!positionIsInStore(s.position, inStoreByName)) continue;
    if (!best || new Date(s.ends_at).getTime() > new Date(best.ends_at).getTime()) best = s;
  }
  return best;
}

/** Active people, by name, for a staff picker. */
function staffCandidates(input: VerifyInput, profiles: Map<string, ProfileRow>): Person[] {
  return input.profiles
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, name: nameOf(profiles, p.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The profile the §3.5/§3.7 default names, or null if nobody on file matches. */
function defaultTipPayee(input: VerifyInput, profiles: Map<string, ProfileRow>): Person | null {
  const p = input.profiles.find((row) => row.active && sameNameWords(row.full_name, DEFAULT_TIP_PAYEE_NAME));
  return p ? { id: p.id, name: nameOf(profiles, p.id) } : null;
}

/**
 * §3.5 — a catering event nobody is on.
 *
 * A booked event in the window with no Catering shift that has a person on it,
 * either linked to the deal or on the event's date. Any catering tip on it
 * would otherwise go to nobody, so the event gets a staff picker, default
 * Sophia (ruled 2026-09-22). The same finding is the upstream warning: the
 * event should have its shift added so the next run pays it the normal way.
 *
 * This app cannot see the tip itself (it arrives on a Square invoice), so it
 * asks about every crewless event; the payroll sheet applies the pick only to
 * an event that actually carries a tip.
 */
function checkCrewlessEvents(input: VerifyInput, profiles: Map<string, ProfileRow>): Finding[] {
  const { window } = input;
  const out: Finding[] = [];
  const candidates = staffCandidates(input, profiles);
  const defaultPayee = defaultTipPayee(input, profiles);
  for (const deal of input.windowDeals ?? []) {
    const date = deal.event_date?.slice(0, 10) ?? "";
    if (!inWindow(date, window)) continue;
    if (deal.stage && !(EVENT_DEAL_STAGES as readonly string[]).includes(deal.stage)) continue;
    const crewed = input.shifts.some(
      (s) =>
        s.position === CATERING_POSITION &&
        !!s.employee_id &&
        (s.deal_id === deal.id || nyWallClock(s.starts_at).date === date),
    );
    if (crewed) continue;
    const label = deal.company?.trim() || `deal ${deal.id}`;
    out.push(
      finding("3.5", {
        key: `3.5:deal:${deal.id}`,
        status: "needs_ruling",
        severity: "warn",
        summary: `${formatDayLabel(date)} ${label}: no crew on the schedule. Add the event's Catering shift so it is paid the normal way; until then any catering tip on it goes to the person picked here.`,
        defaultChoice: "staff",
        options: [
          { choice: "staff", label: "Pay this person", effect: "The event's catering tip, if it has one, is paid to them." },
        ],
        candidates,
        defaultPayee,
        evidence: { date, deal_id: deal.id },
      }),
    );
  }
  return out;
}

/**
 * §3.7 — no bake shift worked.
 *
 * Olo tips are split by Pastry Opener shifts worked. A window where nobody
 * worked one strands the money, and is a schedule anomaly in its own right: the
 * norm is at least 2 a week, 4 a period. One case per window, with a staff
 * picker for any stranded Olo money, default Sophia (ruled 2026-09-22).
 *
 * A window in which the store never opened is not asked about.
 */
function checkBakeShifts(views: PunchView[], input: VerifyInput, profiles: Map<string, ProfileRow>): Finding[] {
  const { window } = input;
  const exceptions = input.storeHoursExceptions ?? [];
  const closedRanges = input.closedRanges ?? [];
  const anyOpen = windowDates(window).some(
    (date) => resolveOpenWindow(date, input.storeHours, exceptions, closedRanges).state === "open",
  );
  if (!anyOpen) return [];
  const worked = input.shifts.filter(
    (s) =>
      s.position === PASTRY_POSITION &&
      !!s.employee_id &&
      inWindow(nyWallClock(s.starts_at).date, window) &&
      views.some((v) => v.shift?.id === s.id && v.employeeId === s.employee_id),
  );
  if (worked.length > 0) return [];
  return [
    finding("3.7", {
      key: `3.7:olo:${window.end}`,
      status: "needs_ruling",
      severity: "warn",
      summary: `No ${PASTRY_POSITION} shift was worked in this period (the norm is at least ${BAKE_SHIFT_NORM_PER_PERIOD}). Schedule anomaly: any Olo tips have nobody to split over and go to the person picked here.`,
      defaultChoice: "staff",
      options: [{ choice: "staff", label: "Pay this person", effect: "Any stranded Olo tips for the period are paid to them." }],
      candidates: staffCandidates(input, profiles),
      defaultPayee: defaultTipPayee(input, profiles),
      evidence: {},
    }),
  ];
}

/**
 * What stands for one choice-with-default case, and the flags it raises.
 *
 * Flags (ruled 2026-09-22) never block; the approver sees them:
 *   §1.9       a night paid to the manager who changed its dropdown
 *   §3.5/§3.7  money paid to the manager who approved the run, default or not
 */
function settleChoice(f: Finding, approval: ApprovalRow | null, profiles: Map<string, ProfileRow>): void {
  if (!f.defaultChoice) return;
  const r = f.ruling;
  const payeeOf = (id: string | null | undefined): Person | null =>
    id ? { id, name: nameOf(profiles, id) } : null;
  f.effective = r
    ? { choice: r.choice, payee: payeeOf(r.payee_id), source: "recorded" }
    : { choice: f.defaultChoice, payee: f.defaultPayee ?? null, source: "default" };
  const flags: string[] = [];
  const payee = f.effective.payee;
  if (f.check === "1.9" && r && payee && r.decided_by === payee.id) {
    flags.push(`${payee.name} set this night's dropdown to pay themselves the solo-close bonus.`);
  }
  if ((f.check === "3.5" || f.check === "3.7") && payee && approval?.approved_by === payee.id) {
    flags.push(`Paid to ${payee.name}, who approved this run.`);
  }
  f.flags = flags;
}

/** A case is answered when a choice is recorded, or its default can stand. */
function isAnswered(f: Finding): boolean {
  if (f.ruling) return true;
  if (!f.defaultChoice) return false;
  return !choicePays(f.check, f.defaultChoice) || !!f.defaultPayee;
}

/** §1.10 — how every blank shift_id was resolved, and the ones that were not. */
function checkCoverPunches(views: PunchView[], window: PayWindow): Finding[] {
  const out: Finding[] = [];
  for (const v of views) {
    if (!inWindow(v.date, window)) continue;
    if (v.row.shift_id !== null) continue;

    if (v.match === "person_date" && v.shift) {
      out.push(
        finding("1.10", {
          key: `1.10:punch:${v.row.id}`,
          status: "auto_resolved",
          severity: "info",
          summary: `${v.name} ${formatDayLabel(v.date)}: punch has no shift_id.`,
          resolution: `Joined to their own shift ${v.shift.id} (${v.shift.position ?? "no position"}) by person and date.`,
          evidence: { employee_id: v.employeeId, employee_name: v.name, date: v.date, punch_ids: [v.row.id], shift_ids: [v.shift.id] },
        }),
      );
    } else if (v.match === "cover" && v.shift) {
      out.push(
        finding("1.10", {
          key: `1.10:punch:${v.row.id}`,
          status: "auto_resolved",
          severity: "info",
          summary: `${v.name} ${formatDayLabel(v.date)}: punch has no shift_id, and they had no shift of their own.`,
          resolution: `Covered ${v.coverFor ?? "somebody"}'s shift ${v.shift.id} (${v.shift.position ?? "no position"}), whose hours bracket the punch.`,
          evidence: { employee_id: v.employeeId, employee_name: v.name, date: v.date, punch_ids: [v.row.id], shift_ids: [v.shift.id] },
        }),
      );
    } else {
      out.push(
        finding("1.10", {
          key: `1.10:punch:${v.row.id}`,
          status: "auto_resolved",
          severity: "warn",
          summary: `${v.name} ${formatDayLabel(v.date)}: punch has no shift_id and no shift was found for it.`,
          resolution: "Left unscheduled. It is classified by 1.4 or 1.6 if its length calls for it, and paid as punched otherwise.",
          evidence: { employee_id: v.employeeId, employee_name: v.name, date: v.date, punch_ids: [v.row.id] },
        }),
      );
    }
  }
  return out;
}

/** §1.11 — a catering shift with no deal_id. A scheduling-time flag. */
function checkCateringWithoutDeal(shifts: ShiftRow[], window: PayWindow, profiles: Map<string, ProfileRow>): Finding[] {
  const out: Finding[] = [];
  for (const shift of shifts) {
    if ((shift.position ?? "").trim() !== CATERING_POSITION) continue;
    const date = nyWallClock(shift.starts_at).date;
    if (!inWindow(date, window)) continue;
    if (shift.deal_id != null) continue;
    out.push(
      finding("1.11", {
        key: `1.11:shift:${shift.id}`,
        status: "auto_resolved",
        severity: "info",
        summary: `Shift ${shift.id} on ${formatDayLabel(date)} (${shift.employee_id ? nameOf(profiles, shift.employee_id) : "unassigned"}) is Catering with no deal.`,
        resolution:
          "Reported, not blocking: the rule puts this flag at scheduling time, not payroll time. Its hours are still catering hours.",
        evidence: {
          date,
          shift_ids: [shift.id],
          employee_id: shift.employee_id ?? undefined,
          employee_name: shift.employee_id ? nameOf(profiles, shift.employee_id) : undefined,
        },
      }),
    );
  }
  return out;
}

/** §1.12 — deals.staff_count against who actually punched the event. */
function checkCateringUnderPunched(views: PunchView[], shifts: ShiftRow[], window: PayWindow, deals: DealRow[]): Finding[] {
  if (deals.length === 0) return [];
  const dealById = new Map(deals.map((d) => [d.id, d]));

  // Who punched against each deal, via the shift each punch was matched to.
  const punchedByDeal = new Map<number, Set<string>>();
  for (const v of views) {
    const dealId = v.shift?.deal_id;
    if (dealId == null) continue;
    const set = punchedByDeal.get(dealId);
    if (set) set.add(v.employeeId);
    else punchedByDeal.set(dealId, new Set([v.employeeId]));
  }

  const dealsInWindow = new Set<number>();
  for (const shift of shifts) {
    if (shift.deal_id == null) continue;
    if (!inWindow(nyWallClock(shift.starts_at).date, window)) continue;
    dealsInWindow.add(shift.deal_id);
  }

  const out: Finding[] = [];
  for (const dealId of [...dealsInWindow].sort((a, b) => a - b)) {
    const deal = dealById.get(dealId);
    if (!deal || !deal.staff_count || deal.staff_count <= 0) continue;
    const punched = punchedByDeal.get(dealId)?.size ?? 0;
    if (punched >= deal.staff_count) continue;
    out.push(
      finding("1.12", {
        key: `1.12:deal:${dealId}`,
        status: "auto_resolved",
        severity: "warn",
        summary: `${deal.company ?? `Deal ${dealId}`}${deal.event_date ? ` ${formatDayLabel(deal.event_date)}` : ""}: ${punched} of ${deal.staff_count} crew punched.`,
        resolution:
          "Reported. Hours are paid as punched; if somebody worked it and did not punch, fix the punch and verify again.",
        evidence: { deal_id: dealId, date: deal.event_date ?? undefined },
      }),
    );
  }
  return out;
}

/**
 * §1.13 — deleted rows.
 *
 * A null `auditDeletes` means migration 25 is not applied, and that is the one
 * finding in this module that blocks on absence rather than on evidence. The
 * spec is explicit that the audit trail is "a precondition for trusting
 * anything above": with no log, "nothing was deleted" and "we cannot see what
 * was deleted" look identical, and the second one is what the 2026-09-23 run
 * actually had.
 */
function checkDeletedRows(input: VerifyInput, profiles: Map<string, ProfileRow>): Finding[] {
  const { window } = input;
  if (input.auditDeletes === null || input.auditDeletes === undefined) {
    return [
      finding("1.13", {
        key: `1.13:no-audit-table`,
        status: "needs_fix",
        severity: "error",
        summary: "There is no audit table, so a punch or shift deleted inside this window would leave no trace.",
        evidence: { notes: ["Apply time-app/supabase/migration_25.sql, then run Verify again."] },
      }),
    ];
  }

  const out: Finding[] = [];
  for (const row of input.auditDeletes) {
    if (row.op !== "DELETE" || !row.before_image) continue;
    const image = row.before_image;
    const stamp =
      row.table_name === "time_entries"
        ? (image.clock_in_at as string | undefined)
        : (image.starts_at as string | undefined);
    if (!stamp) continue;
    const date = nyWallClock(stamp).date;
    if (!inWindow(date, window)) continue;

    const employeeId = image.employee_id as string | undefined;
    const who = row.actor_uid
      ? nameOf(profiles, row.actor_uid)
      : row.actor_role
        ? `the ${row.actor_role} key`
        : `the database role ${row.db_role}`;
    const what = row.table_name === "time_entries" ? "punch" : "shift";

    out.push(
      finding("1.13", {
        key: `1.13:${row.table_name}:${row.row_id ?? row.id}`,
        status: "auto_resolved",
        severity: "warn",
        summary: `${what} ${row.row_id ?? "?"} for ${employeeId ? nameOf(profiles, employeeId) : "someone"} on ${formatDayLabel(date)} was deleted by ${who} on ${formatDayLabel(nyWallClock(row.at).date)}.`,
        resolution: "Reported with its before-image. If it should not have gone, re-enter it and verify again.",
        evidence: {
          date,
          employee_id: employeeId,
          employee_name: employeeId ? nameOf(profiles, employeeId) : undefined,
          punch_ids: row.table_name === "time_entries" && row.row_id ? [row.row_id] : undefined,
          shift_ids: row.table_name === "shifts" && row.row_id ? [row.row_id] : undefined,
          notes: [JSON.stringify(image)],
        },
      }),
    );
  }
  return out;
}

/** §1.14 — a full_name that is really an email address (the invite-flow bug). */
function checkNameHygiene(profiles: ProfileRow[]): Finding[] {
  return profiles
    .filter((p) => (p.full_name ?? "").includes("@"))
    .map((p) =>
      finding("1.14", {
        key: `1.14:profile:${p.id}`,
        status: "auto_resolved",
        severity: "warn",
        summary: `${p.full_name} is a login email, not a name.`,
        resolution:
          "Cosmetic for pay — the QBO join is on qbo_employee_id, never a name (2.5) — but fix it on the Team page so the run summary reads properly.",
        evidence: { employee_id: p.id, employee_name: p.full_name ?? undefined },
      }),
    );
}

// ---------------------------------------------------------------------------
// The whole check
// ---------------------------------------------------------------------------

export function verifyTimesheets(input: VerifyInput): VerifyResult {
  const profiles = new Map(input.profiles.map((p) => [p.id, p]));
  const views = buildPunchViews(input);
  const { window } = input;

  // §1.2 and §1.3 detect; §1.4 decides. They are reported in their own groups
  // so the person can see WHY a punch is in front of them, with the finding
  // pointing at the 1.4 entry that acts on it.
  const long = checkLongPunches(views, window);
  const autoClosed = checkAutoClosed(views, window);
  const reasons = new Map<number, string[]>();
  for (const v of long) reasons.set(v.row.id, [...(reasons.get(v.row.id) ?? []), `${describeDuration(v.hours!)} > ${LONG_SHIFT_HOURS}h`]);
  for (const v of autoClosed) reasons.set(v.row.id, [...(reasons.get(v.row.id) ?? []), "closed by the next clock-in"]);

  const runaways = [...long, ...autoClosed].filter(
    (v, i, all) => all.findIndex((other) => other.row.id === v.row.id) === i,
  );
  const runawayIds = new Set(runaways.map((v) => v.row.id));

  const findings: Finding[] = [
    ...checkPreconditions(input),
    ...checkOpenPunches(views, window),
    ...long.map((v) =>
      finding("1.2", {
        key: `1.2:punch:${v.row.id}`,
        status: "auto_resolved",
        severity: "warn",
        summary: `${v.name} ${formatDayLabel(v.date)}: punch ${v.row.id} ran ${describeDuration(v.hours!)}.`,
        resolution: `Handled by 1.4 (finding 1.4:punch:${v.row.id}).`,
        evidence: { employee_id: v.employeeId, employee_name: v.name, date: v.date, punch_ids: [v.row.id], hours: round2(v.hours!) },
      }),
    ),
    ...autoClosed.map((v) =>
      finding("1.3", {
        key: `1.3:punch:${v.row.id}`,
        status: "auto_resolved",
        severity: "warn",
        summary: `${v.name} ${formatDayLabel(v.date)}: punch ${v.row.id} was closed by their own next clock-in — a missed clock-out.`,
        resolution: `Handled by 1.4 (finding 1.4:punch:${v.row.id}).`,
        evidence: { employee_id: v.employeeId, employee_name: v.name, date: v.date, punch_ids: [v.row.id] },
      }),
    ),
    ...checkTruncation(runaways, reasons),
    ...checkShortPunches(views, window, runawayIds),
    ...checkTestPunches(views, window),
    ...checkOverlaps(views, window),
    ...checkCoverageGaps(views, input),
    ...checkClosingPunch(views, input, profiles),
    ...checkCoverPunches(views, window),
    ...checkCateringWithoutDeal(input.shifts, window, profiles),
    ...checkCateringUnderPunched(views, input.shifts, window, input.deals ?? []),
    ...checkDeletedRows(input, profiles),
    ...checkNameHygiene(input.profiles),
    ...checkCrewlessEvents(input, profiles),
    ...checkBakeShifts(views, input, profiles),
  ];

  // Attach any recorded ruling. Keyed on (check, finding key), so a ruling
  // survives re-running Verify and disappears if the finding it answered does.
  const rulings = new Map((input.rulings ?? []).map((r) => [`${r.check_id}|${r.finding_key}`, r]));
  const approval = input.approval ?? null;
  for (const f of findings) {
    if (f.status !== "needs_ruling") continue;
    f.ruling = rulings.get(`${f.check}|${f.key}`) ?? null;
    settleChoice(f, approval, profiles);
  }

  const needsRuling = findings.filter((f) => f.status === "needs_ruling");
  const ruled = needsRuling.filter((f) => f.ruling);
  const defaulted = needsRuling.filter((f) => !f.ruling && isAnswered(f));
  const needsFix = findings.filter((f) => f.status === "needs_fix");

  const groups: CheckGroup[] = CHECK_ORDER.map((check) => ({
    check,
    title: RULES[check].title,
    rule: RULES[check].rule,
    findings: findings.filter((f) => f.check === check),
  })).filter((g) => g.findings.length > 0);

  return {
    window,
    findings,
    groups,
    counts: {
      total: findings.length,
      autoResolved: findings.filter((f) => f.status === "auto_resolved").length,
      needsRuling: needsRuling.length,
      ruled: ruled.length,
      defaulted: defaulted.length,
      needsFix: needsFix.length,
    },
    ready: needsFix.length === 0 && needsRuling.every(isAnswered),
    approval,
    approvalState: approvalStateOf(approval, ruled),
    flags: findings.flatMap((f) => (f.flags ?? []).map((message) => ({ key: f.key, message }))),
  };
}

/**
 * An approval is of the choices as they stood when it was given. A choice
 * recorded after it reopens the run: the approver never saw that version.
 */
export function approvalStateOf(approval: ApprovalRow | null, ruled: Finding[]): ApprovalState {
  if (!approval) return "not_approved";
  const at = new Date(approval.approved_at).getTime();
  const changedAfter = ruled.some((f) => f.ruling?.decided_at && new Date(f.ruling.decided_at).getTime() > at);
  return changedAfter ? "stale" : "approved";
}
