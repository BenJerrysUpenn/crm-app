import type { SupabaseClient } from "@supabase/supabase-js";
import { buildStagePatch } from "@/lib/dealUpdate";
import { easternInputValue, parseEasternInput } from "@/lib/dateFormat";
import { nowIso, todayIsoEastern } from "@/lib/callDesk/dealForm";

// Reschedule event and Cancel event, the two buttons on the deal drawer.
//
// The deal is the source of truth and everything downstream follows it:
//
//   * Google Calendar mirrors `deals` through Catering-Manager's
//     `pending_calendar_actions` queue, which the imap_idle daemon drains about
//     once a minute (create / patch / delete, through modules/calendar_api.py).
//     This app never calls Google. It queues a `delete` for the old event and
//     clears `calendar_event_id` and `calendar_event_payload_hash`. Clearing
//     them, rather than leaving the event to be patched, is what makes a
//     reschedule end with a live event: someone may already have deleted the
//     event in Google, and a patch of a deleted event leaves it deleted. With
//     the id gone the calendar reconcile (the catering sweep, the daemon's
//     backlog scan) creates a fresh event from the deal. A delete of an event
//     that is already gone counts as done (calendar_api.delete_event: 404/410).
//   * Crew shifts are `shifts` rows carrying `deal_id`. They move with the
//     event, keeping their offset from its start, or are removed.
//   * Stamps made against the old date are cleared so they do not stand in for
//     the new one (CLEARED_FOR_NEW_DATE).
//   * A line is appended to `deals.notes` saying what moved, from what to what.
//
// The rules are pure (planEventChange). The reads and writes go through an
// EventChangeStore, the seam the tests drive; the web route passes the
// service-role supabase-js store at the bottom of this file.

/** The stages that show the two buttons. */
export const EVENT_CHANGE_STAGES = [
  "Booked Unpaid",
  "Booked Paid",
  "Closed Marketing Event",
] as const;

export function canChangeEvent(stage: string | null | undefined): boolean {
  return (EVENT_CHANGE_STAGES as readonly string[]).includes(stage ?? "");
}

// Catering-Manager modules/calendar_sync.py CALENDAR_STAGES: only these stages
// get a calendar event. A Closed Marketing Event deal loses its old event on a
// reschedule and is not given a new one.
const CALENDAR_STAGES = ["Booked Unpaid", "Booked Paid"];

/**
 * Deal columns stamped against the event's date, cleared by a reschedule so the
 * new date is not blocked by them:
 *   picklist_docx_path       the printed picklist carries the old date; the
 *                            morning report asks for a picklist while it is NULL
 *   day_before_draft_sent_at the day-before email went for the old date; the
 *                            sweep drafts one per event only while it is unset
 *   coi_sent_at              the certificate's description names the old date
 *                            (lib/coi.ts); unset, the COI panel asks again
 */
export const CLEARED_FOR_NEW_DATE = {
  picklist_docx_path: "picklist",
  day_before_draft_sent_at: "day-before draft stamp",
  coi_sent_at: "COI sent stamp",
} as const;

type ClearedColumn = keyof typeof CLEARED_FOR_NEW_DATE;

/** What the two actions read off the deal. */
export type EventDeal = {
  id: number;
  stage: string;
  event_date: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
  calendar_event_id: string | null;
  amount_paid: number | null;
  notes: string | null;
  picklist_docx_path: string | null;
  day_before_draft_sent_at: string | null;
  coi_sent_at: string | null;
};

export const EVENT_DEAL_COLUMNS =
  "id, stage, event_date, event_start_time, event_end_time, calendar_event_id, amount_paid, notes, picklist_docx_path, day_before_draft_sent_at, coi_sent_at";

/** A crew shift on the deal (shifts.deal_id), with the person's name when staffed. */
export type CrewShift = {
  id: number;
  starts_at: string;
  ends_at: string;
  employee_id: string | null;
  person: string | null;
};

/**
 * The staffed shifts' ids: what the dialog sends as `staffed_shift_ids` and
 * what the change compares them with before writing anything.
 */
export function staffedShiftIds(shifts: CrewShift[]): number[] {
  return shifts.filter((s) => s.employee_id).map((s) => s.id);
}

export type EventChangeRequest =
  | {
      kind: "reschedule";
      event_date: string;
      event_start_time: string;
      event_end_time: string;
    }
  | { kind: "reschedule_tbd" }
  | { kind: "cancel" };

export type ShiftMove = {
  id: number;
  starts_at: string;
  ends_at: string;
};

export type EventChangePlan = {
  /** One update of `deals`, notes included. */
  dealPatch: Record<string, unknown>;
  noteLine: string;
  moves: ShiftMove[];
  deletes: number[];
  /** The Google event to queue for deletion, when the deal had one. */
  deleteCalendarEventId: string | null;
};

export type PlanResult =
  | { ok: true; plan: EventChangePlan }
  | { ok: false; status: number; error: string };

// ---------------------------------------------------------------------------
// Parsing the request
// ---------------------------------------------------------------------------

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isYmd(value: string): boolean {
  const m = YMD.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * The POST body: `{ action: "reschedule", event_date, event_start_time,
 * event_end_time, staffed_shift_ids }`, `{ action: "reschedule", date_not_set:
 * true, staffed_shift_ids }` or `{ action: "cancel", staffed_shift_ids }`.
 * `staffed_shift_ids` are the staffed shifts the dialog showed; the change is
 * refused when the crew no longer matches them.
 */
export function parseEventChangeBody(
  body: unknown,
):
  | { ok: true; request: EventChangeRequest; staffedShiftIds: number[] }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Bad JSON" };
  const b = body as Record<string, unknown>;
  const ids = b.staffed_shift_ids;
  if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x))) {
    return { ok: false, error: "staffed_shift_ids must be a list of shift ids" };
  }
  const staffedShiftIds = ids as number[];

  if (b.action === "cancel") return { ok: true, request: { kind: "cancel" }, staffedShiftIds };
  if (b.action !== "reschedule") return { ok: false, error: "action must be reschedule or cancel" };
  if (b.date_not_set === true) {
    return { ok: true, request: { kind: "reschedule_tbd" }, staffedShiftIds };
  }

  const date = typeof b.event_date === "string" ? b.event_date.trim() : "";
  const start = typeof b.event_start_time === "string" ? b.event_start_time.trim() : "";
  const end = typeof b.event_end_time === "string" ? b.event_end_time.trim() : "";
  if (!isYmd(date)) return { ok: false, error: "Pick the new date, or tick Date not set yet." };
  if (!HHMM.test(start)) return { ok: false, error: "Pick a start time (HH:MM)." };
  if (!HHMM.test(end)) return { ok: false, error: "Pick an end time (HH:MM)." };
  if (start === end) return { ok: false, error: "The end time must differ from the start time." };
  return {
    ok: true,
    request: { kind: "reschedule", event_date: date, event_start_time: start, event_end_time: end },
    staffedShiftIds,
  };
}

// ---------------------------------------------------------------------------
// Describing dates and shifts (the note, and the dialog)
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekday(ymd: string): string {
  const m = YMD.exec(ymd);
  if (!m) return "";
  return WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}

/** "Thu 2026-10-29 12:00-13:30", or "no date". */
export function describeWhen(
  date: string | null,
  start: string | null,
  end: string | null,
): string {
  if (!date) return "no date";
  const day = `${weekday(date)} ${date}`.trim();
  if (!start) return day;
  return end ? `${day} ${start}-${end}` : `${day} ${start}`;
}

/** A shift's Eastern wall-clock window: "Thu 2026-10-29 11:00-14:30". */
export function describeShiftTime(startsAt: string, endsAt: string): string {
  const s = easternInputValue(new Date(startsAt));
  const e = easternInputValue(new Date(endsAt));
  const [sDate, sTime] = s.split("T");
  const [eDate, eTime] = e.split("T");
  const end = eDate === sDate ? eTime : `${weekday(eDate)} ${eDate} ${eTime}`;
  return `${weekday(sDate)} ${sDate} ${sTime}-${end}`;
}

function shiftLabel(s: CrewShift): string {
  return s.person ?? (s.employee_id ? "someone" : "open");
}

/** "$1,234.50": how the note and the dialog write an amount. */
export function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** The instant an event starts: its Eastern date and time. */
function eventStart(date: string, time: string): Date | null {
  return parseEasternInput(`${date}T${time}`);
}

/**
 * Work out every write a reschedule or cancel makes. Pure.
 *
 * `now` stamps updated_at and dates the note; `actor` (the signed-in email)
 * goes in the note.
 */
export function planEventChange(
  deal: EventDeal,
  shifts: CrewShift[],
  request: EventChangeRequest,
  ctx: { now: Date; actor: string },
): PlanResult {
  if (!canChangeEvent(deal.stage)) {
    return {
      ok: false,
      status: 409,
      error: `Only a deal at ${EVENT_CHANGE_STAGES.join(", ")} can be rescheduled or cancelled; this one is ${deal.stage}.`,
    };
  }

  const updatedAt = ctx.now.toISOString();
  const prefix = `[${todayIsoEastern(ctx.now)}]`;
  const oldWhen = describeWhen(deal.event_date, deal.event_start_time, deal.event_end_time);
  const calendarCleared = { calendar_event_id: null, calendar_event_payload_hash: null };
  const deleteCalendarEventId = deal.calendar_event_id?.trim() ? deal.calendar_event_id : null;
  const calendarSentence = deleteCalendarEventId
    ? "Calendar event queued for deletion and its link cleared."
    : "No calendar event was linked.";

  const stampsSet = (Object.keys(CLEARED_FOR_NEW_DATE) as ClearedColumn[]).filter((c) => {
    const v = deal[c];
    return typeof v === "string" && v.trim() !== "";
  });
  const clears: Record<string, null> = {};
  for (const c of Object.keys(CLEARED_FOR_NEW_DATE)) clears[c] = null;
  const stampsSentence = stampsSet.length
    ? ` Cleared for the old date: ${stampsSet.map((c) => CLEARED_FOR_NEW_DATE[c]).join(", ")}.`
    : "";
  const picklistHint = deal.picklist_docx_path?.trim() ? " Regenerate the picklist." : "";

  const removedSentence = shifts.length
    ? ` Crew shifts removed: ${shifts
        .map((s) => `${shiftLabel(s)} ${describeShiftTime(s.starts_at, s.ends_at)}`)
        .join("; ")}.`
    : "";

  if (request.kind === "cancel") {
    const paid = typeof deal.amount_paid === "number" && deal.amount_paid > 0;
    const noteLine =
      `${prefix} Event cancelled (${ctx.actor}): ${oldWhen}, ${deal.stage} to Closed Lost. ` +
      calendarSentence +
      removedSentence +
      (paid ? ` Paid ${money(deal.amount_paid as number)}; any refund is done by hand in Square.` : "");
    return {
      ok: true,
      plan: {
        dealPatch: {
          ...buildStagePatch("Closed Lost"),
          ...calendarCleared,
          updated_at: updatedAt,
          notes: appendNote(deal.notes, noteLine),
        },
        noteLine,
        moves: [],
        deletes: shifts.map((s) => s.id),
        deleteCalendarEventId,
      },
    };
  }

  if (request.kind === "reschedule_tbd") {
    const noteLine =
      `${prefix} Rescheduled, new date not set (${ctx.actor}). Was ${oldWhen}. ` +
      calendarSentence +
      removedSentence +
      stampsSentence +
      picklistHint;
    return {
      ok: true,
      plan: {
        dealPatch: {
          event_date: null,
          ...calendarCleared,
          ...clears,
          updated_at: updatedAt,
          notes: appendNote(deal.notes, noteLine),
        },
        noteLine,
        moves: [],
        deletes: shifts.map((s) => s.id),
        deleteCalendarEventId,
      },
    };
  }

  const { event_date: date, event_start_time: start, event_end_time: end } = request;
  if (
    deal.event_date === date &&
    deal.event_start_time === start &&
    deal.event_end_time === end
  ) {
    return { ok: false, status: 400, error: "That is the date and time the event already has." };
  }
  const newWhen = describeWhen(date, start, end);

  // Every shift keeps its offset from the event's start, so all of them move
  // by the distance between the old start and the new one. A deal with no old
  // start time is measured from the new start time on the old date: its
  // shifts keep their time of day and change day. A deal with no old date
  // has nothing to measure from, and its shifts stay where they are.
  const moves: ShiftMove[] = [];
  let shiftsSentence = "";
  if (shifts.length && deal.event_date) {
    const from = eventStart(deal.event_date, deal.event_start_time || start);
    const to = eventStart(date, start);
    if (!from || !to) {
      return { ok: false, status: 400, error: "Could not read the event's start time." };
    }
    const delta = to.getTime() - from.getTime();
    if (delta !== 0) {
      const parts: string[] = [];
      for (const s of shifts) {
        const startsAt = new Date(new Date(s.starts_at).getTime() + delta).toISOString();
        const endsAt = new Date(new Date(s.ends_at).getTime() + delta).toISOString();
        moves.push({ id: s.id, starts_at: startsAt, ends_at: endsAt });
        parts.push(
          `${shiftLabel(s)} ${describeShiftTime(s.starts_at, s.ends_at)} to ${describeShiftTime(startsAt, endsAt)}`,
        );
      }
      shiftsSentence = ` Crew shifts moved with it: ${parts.join("; ")}.`;
    }
  } else if (shifts.length) {
    shiftsSentence = ` ${shifts.length} crew shift${shifts.length === 1 ? "" : "s"} left where ${shifts.length === 1 ? "it was" : "they were"}: the deal had no date to move them from.`;
  }

  const calendarNext = CALENDAR_STAGES.includes(deal.stage)
    ? " A fresh event is created on the new date by the calendar reconcile."
    : ` A ${deal.stage} deal gets no calendar event.`;

  const noteLine =
    `${prefix} Rescheduled (${ctx.actor}): ${oldWhen} to ${newWhen}. ` +
    calendarSentence +
    calendarNext +
    shiftsSentence +
    stampsSentence +
    picklistHint;
  return {
    ok: true,
    plan: {
      dealPatch: {
        event_date: date,
        event_start_time: start,
        event_end_time: end,
        ...calendarCleared,
        ...clears,
        updated_at: updatedAt,
        notes: appendNote(deal.notes, noteLine),
      },
      noteLine,
      moves,
      deletes: [],
      deleteCalendarEventId,
    },
  };
}

/** deals.notes is an append-only log, one entry per line (as the calls route writes it). */
export function appendNote(existing: string | null, line: string): string {
  return existing ? `${existing}\n${line}` : line;
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

/** The reads and writes, and nothing else. Every rule is above. */
export interface EventChangeStore {
  readDeal(dealId: number): Promise<EventDeal | null>;
  /** The deal's shifts (shifts.deal_id), earliest first, staffed ones named. */
  readCrewShifts(dealId: number): Promise<CrewShift[]>;
  /**
   * Close the deal's open `create` and `patch` rows in pending_calendar_actions,
   * the way the daemon supersedes them, so a payload queued for the old date
   * cannot recreate or move the event after this change. Open `delete` rows
   * are left to run. Returns how many it closed.
   */
  supersedeOpenCalendarWrites(dealId: number, nowNaiveUtc: string): Promise<number>;
  /**
   * Update the deal only if its stage, event_date and calendar_event_id are
   * still what `deal` read. False when the row had changed (nothing written).
   */
  updateDealIfUnchanged(deal: EventDeal, patch: Record<string, unknown>): Promise<boolean>;
  enqueueCalendarDelete(dealId: number, eventId: string): Promise<void>;
  /** Move one shift of the deal. Throws when it is gone or the write fails. */
  moveShift(dealId: number, move: ShiftMove, nowIsoUtc: string): Promise<void>;
  deleteShifts(dealId: number, ids: number[]): Promise<void>;
}

/**
 * How a 500 starts when the deal was written but a later step was not: the
 * dialog tells such an answer from a failed change by it.
 */
export const DEAL_SAVED_PREFIX = "The deal was saved";

export type ApplyResult =
  | { ok: true; noteLine: string; moved: number; removed: number }
  | { ok: false; status: number; error: string };

function sameIds(a: number[], b: number[]): boolean {
  const x = [...new Set(a)].sort((p, q) => p - q);
  const y = [...new Set(b)].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Reschedule or cancel. The deal is written first, in one update: it is the
 * source of truth, so a failure after it leaves the deal right and says
 * exactly what still needs doing by hand.
 */
export async function applyEventChange(
  store: EventChangeStore,
  dealId: number,
  request: EventChangeRequest,
  staffedIdsShown: number[],
  ctx: { now: Date; actor: string },
): Promise<ApplyResult> {
  const deal = await store.readDeal(dealId);
  if (!deal) return { ok: false, status: 404, error: "Deal not found" };

  const shifts = await store.readCrewShifts(dealId);
  if (!sameIds(staffedShiftIds(shifts), staffedIdsShown)) {
    return {
      ok: false,
      status: 409,
      error: "Who is on this event's crew changed since the dialog opened. Close it and open it again to see the crew.",
    };
  }

  const planned = planEventChange(deal, shifts, request, ctx);
  if (!planned.ok) return planned;
  const { plan } = planned;

  await store.supersedeOpenCalendarWrites(dealId, nowIso(ctx.now));

  const written = await store.updateDealIfUnchanged(deal, plan.dealPatch);
  if (!written) {
    return {
      ok: false,
      status: 409,
      error: "The deal changed while the dialog was open. Close it and try again.",
    };
  }

  const problems: string[] = [];
  if (plan.deleteCalendarEventId) {
    try {
      await store.enqueueCalendarDelete(dealId, plan.deleteCalendarEventId);
    } catch (e) {
      problems.push(
        `the old calendar event (${plan.deleteCalendarEventId}) could not be queued for deletion (${message(e)}); delete it in Google Calendar by hand`,
      );
    }
  }

  let moved = 0;
  for (const move of plan.moves) {
    try {
      await store.moveShift(dealId, move, ctx.now.toISOString());
      moved += 1;
    } catch (e) {
      problems.push(`shift ${move.id} did not move (${message(e)}); move it on the Schedule page`);
    }
  }

  let removed = 0;
  if (plan.deletes.length) {
    try {
      await store.deleteShifts(dealId, plan.deletes);
      removed = plan.deletes.length;
    } catch (e) {
      problems.push(
        `the crew shifts (${plan.deletes.join(", ")}) were not removed (${message(e)}); remove them on the Schedule page`,
      );
    }
  }

  if (problems.length) {
    return { ok: false, status: 500, error: `${DEAL_SAVED_PREFIX}, but ${problems.join("; ")}.` };
  }
  return { ok: true, noteLine: plan.noteLine, moved, removed };
}

// ---------------------------------------------------------------------------
// The supabase-js store (service role: shifts and pending_calendar_actions are
// outside the CRM user's RLS)
// ---------------------------------------------------------------------------

/** Who a staffed shift belongs to: the name the schedule shows. */
export function personName(p: { full_name?: string | null; preferred_name?: string | null }): string {
  return p.preferred_name?.trim() || p.full_name?.trim() || "Unnamed person";
}

export function supabaseEventChangeStore(admin: SupabaseClient): EventChangeStore {
  return {
    async readDeal(dealId) {
      const { data, error } = await admin
        .from("deals")
        .select(EVENT_DEAL_COLUMNS)
        .eq("id", dealId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as EventDeal | null) ?? null;
    },

    async readCrewShifts(dealId) {
      const { data, error } = await admin
        .from("shifts")
        .select("id, starts_at, ends_at, employee_id")
        .eq("deal_id", dealId)
        .order("starts_at", { ascending: true });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<Omit<CrewShift, "person">>;
      const people = [...new Set(rows.map((r) => r.employee_id).filter(Boolean))] as string[];
      const names = new Map<string, string>();
      if (people.length) {
        const { data: profiles, error: pErr } = await admin
          .from("profiles")
          .select("id, full_name, preferred_name")
          .in("id", people);
        if (pErr) throw new Error(pErr.message);
        for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; preferred_name: string | null }>) {
          names.set(p.id, personName(p));
        }
      }
      return rows.map((r) => ({
        ...r,
        person: r.employee_id ? names.get(r.employee_id) ?? "Unnamed person" : null,
      }));
    },

    async supersedeOpenCalendarWrites(dealId, nowNaiveUtc) {
      const { data, error } = await admin
        .from("pending_calendar_actions")
        .select("id, source")
        .eq("deal_id", dealId)
        .is("processed_at", null)
        .in("action", ["create", "patch"]);
      if (error) throw new Error(error.message);
      let closed = 0;
      for (const row of (data ?? []) as Array<{ id: number; source: string | null }>) {
        const { error: uErr } = await admin
          .from("pending_calendar_actions")
          .update({ processed_at: nowNaiveUtc, source: `${row.source ?? ""} (superseded)` })
          .eq("id", row.id)
          .is("processed_at", null);
        if (uErr) throw new Error(uErr.message);
        closed += 1;
      }
      return closed;
    },

    async updateDealIfUnchanged(deal, patch) {
      let q = admin.from("deals").update(patch).eq("id", deal.id).eq("stage", deal.stage);
      q = deal.event_date == null ? q.is("event_date", null) : q.eq("event_date", deal.event_date);
      q =
        deal.calendar_event_id == null
          ? q.is("calendar_event_id", null)
          : q.eq("calendar_event_id", deal.calendar_event_id);
      const { data, error } = await q.select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async enqueueCalendarDelete(dealId, eventId) {
      const { error } = await admin.from("pending_calendar_actions").insert({
        deal_id: dealId,
        action: "delete",
        event_id: eventId,
        payload: {},
        new_hash: null,
        source: "crm-app",
      });
      if (error) throw new Error(error.message);
    },

    async moveShift(dealId, move, nowIsoUtc) {
      const { data, error } = await admin
        .from("shifts")
        .update({ starts_at: move.starts_at, ends_at: move.ends_at, updated_at: nowIsoUtc })
        .eq("id", move.id)
        .eq("deal_id", dealId)
        .select("id");
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new Error("the shift is no longer on this deal");
    },

    async deleteShifts(dealId, ids) {
      const { error } = await admin.from("shifts").delete().eq("deal_id", dealId).in("id", ids);
      if (error) throw new Error(error.message);
    },
  };
}
