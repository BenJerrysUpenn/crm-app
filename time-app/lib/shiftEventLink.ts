// Saving the event on a shift: shifts.deal_id and a free deal_slot.
// The shift routes (app/api/shifts) call this after their manager gate. The
// reading side and the words are lib/scheduleEvents.ts.
//
// A manager's session writes the link. migration_34.sql's trigger only checks a
// non-manager changing employee_id, and migration_30's refuses a non-manager
// changing anything else, so a staff session cannot set deal_id through /rest/v1.

import type { SupabaseClient } from "@supabase/supabase-js";
import { nextDealSlot } from "./payroll/eventShift";
import { createAdminClient } from "./supabase/admin";
import {
  EVENT_DEAL_COLUMNS,
  EVENT_NAME_COLUMNS,
  EVENT_STAGES,
  eventChipName,
  eventKindOf,
  isLinkableDeal,
  shiftDate,
  toScheduleEvent,
  type EventDeal,
  type EventNameDeal,
  type ScheduleEvent,
} from "./scheduleEvents";

/** What the shift's link should become. */
export type EventLink = { kind: "keep" } | { kind: "clear" } | { kind: "link"; dealId: number };

export type EventLinkPlan = { ok: true; link: EventLink } | { ok: false; status: number; error: string };

type RequestedEvent = { ok: true; value: number | null | undefined } | { ok: false; status: 400; error: string };

const NOT_A_DEAL_ID: RequestedEvent = { ok: false, status: 400, error: "deal_id must be a deal's id." };

/** The body's deal_id: absent (undefined), None (null), or a deal's id. */
export function requestedEvent(body: Record<string, unknown>): RequestedEvent {
  if (!("deal_id" in body) || body.deal_id === undefined) return { ok: true, value: undefined };
  if (body.deal_id === null) return { ok: true, value: null };
  return Number.isInteger(body.deal_id) && (body.deal_id as number) > 0 ? { ok: true, value: body.deal_id as number } : NOT_A_DEAL_ID;
}

const UNREADABLE: EventLinkPlan = { ok: false, status: 503, error: "Couldn't read that event. Try again in a moment." };

/**
 * Decide the link from what was asked and the shift as it will be.
 *
 * deal_id in the body: None clears, an event is checked (a Catering shift takes a
 * live booked event, a Marketing shift a live marketing event, on the shift's New
 * York date). Asking for the event it already has, on the same date, keeps it at
 * any stage. No deal_id in the body: the link stays, unless a Catering or Marketing
 * shift moved to a date that is not its event's. That case is here as well as in
 * the popup so no caller can leave such a shift pointing at another day's event.
 * Other positions are left alone.
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
    if (currentDeal === null || eventKindOf(position) === null) return { ok: true, link: { kind: "keep" } };
    if (before && shiftDate(before.starts_at) === afterDate) return { ok: true, link: { kind: "keep" } };
    const { data, error } = await supabase.from("deals").select("id, event_date").eq("id", currentDeal).maybeSingle();
    if (error) return UNREADABLE;
    const stillOnIt = (data as { event_date: string | null } | null)?.event_date?.slice(0, 10) === afterDate;
    return { ok: true, link: stillOnIt ? { kind: "keep" } : { kind: "clear" } };
  }

  if (eventKindOf(position) === null) return { ok: false, status: 400, error: "Only a Catering or Marketing shift can be on an event." };
  if (requested === currentDeal && before && shiftDate(before.starts_at) === afterDate) return { ok: true, link: { kind: "keep" } };

  const { data, error } = await supabase.from("deals").select(EVENT_DEAL_COLUMNS).eq("id", requested).maybeSingle();
  if (error) return UNREADABLE;
  const deal = data as EventDeal | null;
  if (!deal || !isLinkableDeal(deal, position)) return { ok: false, status: 400, error: "That event can't be chosen for this shift." };
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

/**
 * The name to show on each linked shift's chip, by deal id. Pass only the ids on
 * shifts the viewer can already see. A staff session cannot read deals (policy in
 * supabase/crm/004_call_desk_perf.sql), so this reads through the service role and
 * hands back the names and nothing else of the deal. A deal that is missing or has
 * no name is left out, and a failed read is no names: the chip goes without.
 */
export async function loadEventNames(dealIds: number[]): Promise<Record<number, string>> {
  if (dealIds.length === 0) return {};
  const { data, error } = await createAdminClient().from("deals").select(EVENT_NAME_COLUMNS).in("id", dealIds);
  if (error) return {};
  const names: Record<number, string> = {};
  for (const deal of (data ?? []) as EventNameDeal[]) {
    const name = eventChipName(deal);
    if (name) names[deal.id] = name;
  }
  return names;
}
