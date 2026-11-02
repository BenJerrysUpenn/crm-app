// Saving the Catering event on a shift: shifts.deal_id and a free deal_slot.
// The shift routes (app/api/shifts) call this after their manager gate. The
// reading side and the words are lib/scheduleEvents.ts.
//
// A manager's session writes the link. migration_34.sql's trigger only checks a
// non-manager changing employee_id, and migration_30's refuses a non-manager
// changing anything else, so a staff session cannot set deal_id through /rest/v1.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CATERING_POSITION } from "./handPlacedCrew";
import { nextDealSlot } from "./payroll/eventShift";
import {
  EVENT_DEAL_COLUMNS,
  EVENT_STAGES,
  isLinkableDeal,
  shiftDate,
  toScheduleEvent,
  type EventDeal,
  type ScheduleEvent,
} from "./scheduleEvents";

/** What the shift's link should become. */
export type EventLink = { kind: "keep" } | { kind: "clear" } | { kind: "link"; dealId: number };

export type EventLinkPlan = { ok: true; link: EventLink } | { ok: false; status: number; error: string };

type RequestedEvent = { ok: true; value: number | null | undefined } | { ok: false };

/** The body's deal_id: absent (undefined), None (null), or a deal's id. */
export function requestedEvent(body: Record<string, unknown>): RequestedEvent {
  if (!("deal_id" in body) || body.deal_id === undefined) return { ok: true, value: undefined };
  if (body.deal_id === null) return { ok: true, value: null };
  return Number.isInteger(body.deal_id) && (body.deal_id as number) > 0 ? { ok: true, value: body.deal_id as number } : { ok: false };
}

const UNREADABLE: EventLinkPlan = { ok: false, status: 503, error: "Couldn't read that event. Try again in a moment." };

/** Is this shift's position Catering? The selector only exists for these. */
function isCatering(position: unknown): boolean {
  return typeof position === "string" && position.trim() === CATERING_POSITION;
}

/**
 * Decide the link from what was asked and the shift as it will be.
 *
 * deal_id in the body: None clears, an event is checked (Catering only, a live
 * booked event, on the shift's New York date). No deal_id in the body: the link
 * stays, unless a Catering shift moved to a date that is not its event's. That
 * case is here as well as in the popup so no caller can leave a shift pointing
 * at another day's event. Other positions are left alone: a Marketing shift
 * linked to its deal is what marks a marketing event (lib/payroll/verify.ts).
 */
export async function planEventLink(
  supabase: SupabaseClient,
  input: {
    requested: number | null | undefined;
    before: { deal_id: number | null; starts_at: string } | null;
    startsAt: string;
    position: unknown;
  },
): Promise<EventLinkPlan> {
  const { requested, before, startsAt, position } = input;
  const afterDate = shiftDate(startsAt);
  const currentDeal = before?.deal_id ?? null;

  if (requested === null) return { ok: true, link: currentDeal === null ? { kind: "keep" } : { kind: "clear" } };

  if (requested === undefined) {
    if (currentDeal === null || !isCatering(position)) return { ok: true, link: { kind: "keep" } };
    if (before && shiftDate(before.starts_at) === afterDate) return { ok: true, link: { kind: "keep" } };
    const { data, error } = await supabase.from("deals").select("id, event_date").eq("id", currentDeal).maybeSingle();
    if (error) return UNREADABLE;
    const stillOnIt = (data as { event_date: string | null } | null)?.event_date?.slice(0, 10) === afterDate;
    return { ok: true, link: stillOnIt ? { kind: "keep" } : { kind: "clear" } };
  }

  if (!isCatering(position)) return { ok: false, status: 400, error: "Only a Catering shift can be on a catering event." };
  if (requested === currentDeal && before && shiftDate(before.starts_at) === afterDate) return { ok: true, link: { kind: "keep" } };

  const { data, error } = await supabase.from("deals").select(EVENT_DEAL_COLUMNS).eq("id", requested).maybeSingle();
  if (error) return UNREADABLE;
  const deal = data as EventDeal | null;
  if (!deal || !isLinkableDeal(deal)) return { ok: false, status: 400, error: "That event isn't booked any more." };
  if (deal.event_date?.slice(0, 10) !== afterDate) return { ok: false, status: 400, error: "That event is on a different day from this shift." };
  return { ok: true, link: { kind: "link", dealId: requested } };
}

type WriteResult<T> = { data: T | null; error: { code?: string; message: string } | null };

/**
 * Run a shift write with the link's columns in it. A new link takes the next
 * free slot. Someone saving the same event at the same moment can take that slot
 * first, which the unique index refuses, so it reads again and retries.
 */
export async function writeWithEventLink<T>(
  supabase: SupabaseClient,
  link: EventLink,
  write: (fields: { deal_id?: number | null; deal_slot?: number | null }) => PromiseLike<WriteResult<T>>,
): Promise<WriteResult<T>> {
  if (link.kind === "keep") return write({});
  if (link.kind === "clear") return write({ deal_id: null, deal_slot: null });
  let result: WriteResult<T> = { data: null, error: { message: "Could not save the event." } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = await supabase.from("shifts").select("deal_slot").eq("deal_id", link.dealId);
    if (taken.error) return { data: null, error: taken.error };
    result = await write({ deal_id: link.dealId, deal_slot: nextDealSlot((taken.data ?? []) as { deal_slot: number | null }[]) });
    if (result.error?.code !== "23505") return result;
  }
  return result;
}

function toEvents(rows: unknown): ScheduleEvent[] {
  return ((rows ?? []) as EventDeal[]).flatMap((deal) => toScheduleEvent(deal) ?? []);
}

/** The events a shift can be linked to on these dates. Null when the read failed. */
export async function loadScheduleEvents(supabase: SupabaseClient, from: string, to: string): Promise<ScheduleEvent[] | null> {
  const { data, error } = await supabase
    .from("deals")
    .select(EVENT_DEAL_COLUMNS)
    .gte("event_date", from)
    .lte("event_date", to)
    .in("stage", EVENT_STAGES)
    .eq("archived", 0);
  return error ? null : toEvents(data);
}

/**
 * The deals shifts are already linked to, at any stage. The popup needs them to
 * show a link it would not offer, such as an event that has since finished, and
 * to leave it alone. Null when the read failed.
 */
export async function loadLinkedEvents(supabase: SupabaseClient, dealIds: number[]): Promise<ScheduleEvent[] | null> {
  if (dealIds.length === 0) return [];
  const { data, error } = await supabase.from("deals").select(EVENT_DEAL_COLUMNS).in("id", dealIds);
  return error ? null : toEvents(data);
}
