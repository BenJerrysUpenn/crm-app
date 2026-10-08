// The server side of Travel Reimbursements (bj-finance #210): reading them
// with their amounts, the Catering Event lookup staff cannot do themselves,
// destination miles, notices, and the receipts@ emails. Used by the API routes
// under app/api/reimbursements and app/api/payroll/reimbursements and by the
// two pages. The rules themselves are in the pure modules beside this one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { emailConfigured, sendEmail, type EmailAttachment } from "@/lib/email";
import { isMissingTable } from "@/lib/storeHours";
import { money } from "@/lib/payroll/paySheet";
import { amountsBeforeAdjustments, reimbursementCents, type Amounts, type BeforeAdjustments, type MileageRate } from "./money";
import {
  CATERING_EVENT_STAGES,
  EVENT_DEAL_COLUMNS,
  cateringEventsFromDeals,
  eventLabel,
  eventWindow,
  reasonLabel,
  type CateringEvent,
  type EventDeal,
  type ReasonKind,
} from "./events";
import { FIELD_LABEL, approversToNotify, type AdjustmentField, type Person, type ReimbursementStatus } from "./lifecycle";
import { RECEIPTS_TO, lyftRideReportEmail, travelReimbursementReceiptEmail } from "./receiptsEmail";
import { BUCKET, type ReasonValue, type ReimbursementValue } from "./submission";
import { routeEnds, routeMiles, type RouteEnds, type RouteResult } from "./routeMiles";

export const NEEDS_MIGRATION = "Travel Reimbursements need migration 37 in Supabase.";

/** Notice types (lib/notifPrefs.ts): Approvers on submit; the employee on Rejected or an Adjustment. */
export const NOTICE_SUBMITTED = "reimbursement_submitted";
export const NOTICE_DECISION = "reimbursement_decision";

export type ReimbursementRow = {
  id: number;
  profile_id: string;
  reason_kind: ReasonKind;
  deal_id: number | null;
  event_label: string | null;
  event_date: string | null;
  reason_note: string | null;
  trip_date: string;
  mileage_mode: "typed" | "destinations";
  miles: number | string;
  stops: string[] | null;
  /** Destinations mode's checkboxes (ruling 45); null when the miles are typed. */
  start_at_store: boolean | null;
  end_at_store: boolean | null;
  route_legs: { from: string; to: string; miles: number }[] | null;
  tolls_cents: number;
  parking_cents: number;
  mileage_cents_override: number | null;
  receipt_paths: string[];
  no_receipt_confirmed: boolean;
  status: ReimbursementStatus;
  rejection_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  paid_on: string | null;
  paid_by: string | null;
  receipts_emailed_at: string | null;
  submitted_at: string;
  created_at: string;
  updated_at: string;
};

export type AdjustmentRow = {
  id: number;
  reimbursement_id: number;
  field: AdjustmentField;
  old_cents: number;
  new_cents: number;
  note: string;
  evidence_path: string;
  adjusted_by: string;
  adjusted_at: string;
};

export type LyftRow = {
  id: number;
  profile_id: string;
  reason_kind: ReasonKind;
  deal_id: number | null;
  event_label: string | null;
  event_date: string | null;
  reason_note: string | null;
  trip_date: string;
  screenshot_paths: string[];
  filed_at: string;
  emailed_at: string | null;
};

export type WithAmounts = ReimbursementRow & {
  amounts: Amounts;
  adjustments: AdjustmentRow[];
  /** The amounts before the Adjustments that still stand, shown old -> new (ruling 40); null when none. */
  before_adjustments: BeforeAdjustments | null;
};

type Db = SupabaseClient;

export async function loadRates(db: Db): Promise<{ ok: true; rates: MileageRate[] } | { ok: false; error: string }> {
  const { data, error } = await db.from("mileage_rates").select("starts_on, cents_per_mile");
  if (isMissingTable(error)) return { ok: false, error: NEEDS_MIGRATION };
  if (error) return { ok: false, error: error.message };
  return { ok: true, rates: ((data ?? []) as MileageRate[]).map((r) => ({ starts_on: r.starts_on, cents_per_mile: Number(r.cents_per_mile) })) };
}

/** Rows with their amounts at today's reading of the rates, and their Adjustments, oldest first. */
export function withAmounts(rows: ReimbursementRow[], rates: MileageRate[], adjustments: AdjustmentRow[]): WithAmounts[] {
  return rows.map((r) => {
    const own = adjustments.filter((a) => a.reimbursement_id === r.id).sort((a, b) => a.adjusted_at.localeCompare(b.adjusted_at));
    return { ...r, amounts: reimbursementCents(r, rates), adjustments: own, before_adjustments: amountsBeforeAdjustments(r, own, rates) };
  });
}

// ---------- Catering Events (staff cannot read deals) ------------------------------

/** Every Catering Event in the picker's window, newest first. Service role: deals are managers-only. */
export async function listCateringEvents(today: string): Promise<{ ok: true; events: CateringEvent[] } | { ok: false; error: string }> {
  const { from, to } = eventWindow(today);
  const { data, error } = await createAdminClient()
    .from("deals")
    .select(EVENT_DEAL_COLUMNS)
    .in("stage", CATERING_EVENT_STAGES)
    .gte("event_date", from)
    .lte("event_date", to)
    .order("event_date", { ascending: false });
  if (error) return { ok: false, error: error.message };
  return { ok: true, events: cateringEventsFromDeals((data ?? []) as EventDeal[], today) };
}

/** One Catering Event by its deal id, or null unless it is in the picker's window today. */
async function findCateringEvent(dealId: number, today: string): Promise<{ ok: true; event: CateringEvent | null } | { ok: false; error: string }> {
  const { data, error } = await createAdminClient().from("deals").select(EVENT_DEAL_COLUMNS).eq("id", dealId).maybeSingle();
  if (error) return { ok: false, error: `The Catering Events could not be read: ${error.message}` };
  if (!data) return { ok: true, event: null };
  return { ok: true, event: cateringEventsFromDeals([data as EventDeal], today)[0] ?? null };
}

// ---------- destination miles ------------------------------------------------------------

/** GOOGLE_MAPS_API_KEY is server-only: it is never sent to a browser. */
export function computeRouteMiles(stops: string[], ends: RouteEnds): Promise<RouteResult> {
  return routeMiles(stops, ends, { apiKey: process.env.GOOGLE_MAPS_API_KEY });
}

// ---------- notices ------------------------------------------------------------------------

type ProfileLite = Person & { full_name: string | null; phone?: string | null };

/** The profile columns ProfileLite carries. */
const PROFILE_LITE_COLUMNS = "id, role, active, full_name, phone";

export async function profileLite(id: string): Promise<ProfileLite | null> {
  const { data } = await createAdminClient().from("profiles").select(PROFILE_LITE_COLUMNS).eq("id", id).maybeSingle();
  return (data as ProfileLite) ?? null;
}

/** On submit (and resubmit): every Approver who may decide it, but not its submitter. */
export async function notifyApprovers(subject: ProfileLite, row: Pick<ReimbursementRow, "reason_kind" | "reason_note" | "event_label" | "trip_date">, totalCents: number | null) {
  const { data } = await createAdminClient().from("profiles").select(PROFILE_LITE_COLUMNS).eq("role", "manager");
  const who = subject.full_name ?? "A staff member";
  for (const a of approversToNotify((data ?? []) as ProfileLite[], subject)) {
    const email = await emailForUser(a.id);
    await notify({
      userId: a.id,
      type: NOTICE_SUBMITTED,
      title: "Travel Reimbursement submitted",
      body: `${who}: ${reasonLabel(row)}, trip ${row.trip_date}, ${money(totalCents)}. Approve or reject it on the Reimbursements tab of Withers Finance.`,
      phone: a.phone ?? null,
      email,
    }).catch(() => {});
  }
}

/** The employee, on Rejected or an Adjustment (rulings 25, 35). */
export async function notifyEmployee(subject: ProfileLite, title: string, body: string) {
  const email = await emailForUser(subject.id);
  await notify({ userId: subject.id, type: NOTICE_DECISION, title, body, phone: subject.phone ?? null, email }).catch(() => {});
}

// ---------- receipts@ ------------------------------------------------------------------------

/**
 * Whether an email went to receipts@ now, and what went wrong if anything
 * did, in words for the person who pressed the button. An error with
 * emailed: true means it went but was not stamped, so a later send would
 * repeat it.
 */
export type ReceiptsEmailed = { emailed: boolean; error: string | null };

/** What each kind of record sends to receipts@, in words, and the column that stamps it sent. */
const TO_RECEIPTS = {
  travel_reimbursements: { what: "The Receipts", column: "receipts_emailed_at" },
  lyft_ride_reports: { what: "The Lyft ride report screenshots", column: "emailed_at" },
} as const;

/**
 * Record `id` of `table`: its files at `paths` in the bucket to receipts@,
 * then the stamp that says they went. Service role: the files are the staff
 * member's.
 */
async function emailToReceipts(
  table: keyof typeof TO_RECEIPTS,
  id: number,
  paths: string[],
  compose: (attachments: number) => { subject: string; text: string },
): Promise<ReceiptsEmailed> {
  const { what, column } = TO_RECEIPTS[table];
  const admin = createAdminClient();
  const files: EmailAttachment[] = [];
  for (const path of paths) {
    const { data, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !data)
      return { emailed: false, error: `${what} were not emailed to receipts@: ${path} could not be read from Storage (${error?.message ?? "no file"}).` };
    files.push({ filename: path.split("/").pop() ?? "receipt", content: new Uint8Array(await data.arrayBuffer()) });
  }
  const mail = compose(files.length);
  if (!(await sendEmail(RECEIPTS_TO, mail.subject, mail.text, files))) return { emailed: false, error: `${what} could not be emailed to receipts@.` };
  const { error } = await admin.from(table).update({ [column]: new Date().toISOString() }).eq("id", id);
  if (error) return { emailed: true, error: `${what} went to receipts@, but recording that failed (${error.message}). Do not send them again.` };
  return { emailed: true, error: null };
}

/**
 * On approval: the Receipts go to receipts@ once (ruling 30), stamped
 * receipts_emailed_at. Nothing to send, already sent, or email not set up
 * sends nothing and is not an error.
 */
export async function emailReceiptsOnApproval(row: WithAmounts, employee: string): Promise<ReceiptsEmailed> {
  if (!row.receipt_paths.length || row.receipts_emailed_at || !emailConfigured()) return { emailed: false, error: null };
  return emailToReceipts(
    "travel_reimbursements",
    row.id,
    row.receipt_paths,
    (attachments) =>
      travelReimbursementReceiptEmail({
        id: row.id,
        employee,
        reason: reasonLabel(row),
        trip_date: row.trip_date,
        tolls_cents: row.amounts.tolls_cents,
        parking_cents: row.amounts.parking_cents,
        total_cents: row.amounts.total_cents,
        attachments,
      }),
  );
}

/** On upload: the Lyft ride report goes to receipts@ (ruling 23), stamped emailed_at. */
export async function emailLyftRideReport(report: LyftRow, employee: string): Promise<ReceiptsEmailed> {
  if (!emailConfigured()) return { emailed: false, error: null };
  return emailToReceipts("lyft_ride_reports", report.id, report.screenshot_paths, (attachments) =>
    lyftRideReportEmail({ id: report.id, employee, reason: reasonLabel(report), trip_date: report.trip_date, attachments }),
  );
}

// ---------- from a parsed submission to the row's columns ----------------------------------

type ResolvedColumns = Pick<
  ReimbursementRow,
  | "reason_kind" | "deal_id" | "event_label" | "event_date" | "reason_note" | "trip_date" | "mileage_mode"
  | "miles" | "stops" | "start_at_store" | "end_at_store" | "route_legs" | "tolls_cents" | "parking_cents" | "receipt_paths"
  | "no_receipt_confirmed"
>;

/**
 * Why a submission was not resolved, with the status the route answers: 400
 * for the staff member to fix, 503 when a read it needs failed.
 */
export type Unresolved = { ok: false; error: string; status: 400 | 503 };

/** The Reason's columns: a Catering Event must still be in the picker's window. */
export async function resolveReason(
  v: ReasonValue,
  today: string,
): Promise<{ ok: true; cols: Pick<ReimbursementRow, "reason_kind" | "deal_id" | "event_label" | "event_date" | "reason_note"> } | Unresolved> {
  if (v.reason_kind === "errands")
    return { ok: true, cols: { reason_kind: "errands", deal_id: null, event_label: null, event_date: null, reason_note: v.reason_note } };
  const found = await findCateringEvent(v.event_id!, today);
  if (!found.ok) return { ...found, status: 503 };
  const event = found.event;
  if (!event) return { ok: false, error: "That Catering Event is not in the list (the last 365 days, up to today). Pick it again.", status: 400 };
  return { ok: true, cols: { reason_kind: "catering_event", deal_id: event.id, event_label: eventLabel(event), event_date: event.date, reason_note: v.reason_note } };
}

/**
 * Everything a submission writes, with destination miles computed here and a
 * Mileage rate checked for the trip date. A missing migration is `loadRates`'
 * failure, answered 503 before this runs.
 */
export async function resolveSubmission(
  v: ReimbursementValue,
  today: string,
  rates: MileageRate[],
): Promise<{ ok: true; cols: ResolvedColumns } | Unresolved> {
  const reason = await resolveReason(v, today);
  if (!reason.ok) return reason;
  let miles = v.miles ?? 0;
  let legs: ReimbursementRow["route_legs"] = null;
  const ends = v.mileage_mode === "destinations" ? routeEnds(v) : null;
  if (ends) {
    const route = await computeRouteMiles(v.stops!, ends);
    if (!route.ok) return { ...route, status: 400 };
    miles = route.miles;
    legs = route.legs;
  }
  if (!(miles > 0) && v.tolls_cents === 0 && v.parking_cents === 0)
    return { ok: false, error: "There is nothing to pay back: add miles, tolls or parking.", status: 400 };
  if (miles > 0 && reimbursementCents({ trip_date: v.trip_date, miles, tolls_cents: 0, parking_cents: 0, mileage_cents_override: null }, rates).rate == null)
    return { ok: false, error: `There is no Mileage rate for ${v.trip_date}. Ask a manager.`, status: 400 };
  return {
    ok: true,
    cols: {
      ...reason.cols,
      trip_date: v.trip_date,
      mileage_mode: v.mileage_mode,
      miles,
      stops: v.stops,
      start_at_store: ends?.start_at_store ?? null,
      end_at_store: ends?.end_at_store ?? null,
      route_legs: legs,
      tolls_cents: v.tolls_cents,
      parking_cents: v.parking_cents,
      receipt_paths: v.receipt_paths,
      no_receipt_confirmed: v.no_receipt_confirmed,
    },
  };
}

// ---------- the Approver's routes ----------------------------------------------------------

/** "<Field> changed from $a to $b: note" for the employee's notice. */
export function adjustmentText(a: Pick<AdjustmentRow, "field" | "old_cents" | "new_cents" | "note">): string {
  return `${FIELD_LABEL[a.field]} changed from ${money(a.old_cents)} to ${money(a.new_cents)}: ${a.note}`;
}
