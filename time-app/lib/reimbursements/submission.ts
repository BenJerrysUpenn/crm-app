// What a staff member sends to submit or edit a Travel Reimbursement, or to
// file a Lyft ride report, checked before anything is written (bj-finance #210).
//
//   * Reason: Groceries / errands, which needs a "what for / where" note
//     (ruling 12), or a Catering Event picked from the list (16, 17).
//   * Trip date: a real day, not in the future. No pay-period limit (11).
//   * Mileage: typed miles, or destinations: stops after the store, "return
//     to start" on unless turned off (14). Destination miles are computed on
//     the server (lib/reimbursements/routeMiles.ts), never taken from the browser.
//   * Tolls and parking: optional amounts on any Reason (3, 4, 8).
//   * Receipts: the staff member's own uploads. Tolls or parking with no
//     Receipt needs "Are you sure there is no receipt?" answered yes (9).
//
// Pure, so `node --test` runs it.

import { isISODate } from "../holidays.ts";
import { centsFromDollars, milesFromInput } from "./money.ts";
import { cleanStops } from "./routeMiles.ts";
import type { ReasonKind } from "./events.ts";

export const CONFIRM_NO_RECEIPT = "Are you sure there is no receipt?";
export const MAX_FILES = 10;
const MAX_NOTE = 500;

export type ReasonValue = { reason_kind: ReasonKind; event_id: number | null; reason_note: string | null };

export type ReimbursementValue = ReasonValue & {
  trip_date: string;
  mileage_mode: "typed" | "destinations";
  /** Typed miles; null in destinations mode until the server computes them. */
  miles: number | null;
  stops: string[] | null;
  return_to_start: boolean | null;
  tolls_cents: number;
  parking_cents: number;
  receipt_paths: string[];
  no_receipt_confirmed: boolean;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; confirm?: "no_receipt" };

type Ctx = { profileId: string; today: string };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseReason(input: unknown): Parsed<ReasonValue> {
  const r = obj(input);
  const note = typeof r.note === "string" ? r.note.trim().slice(0, MAX_NOTE) : "";
  if (r.kind === "errands") {
    if (!note) return { ok: false, error: "Groceries / errands needs a note: what for / where (e.g. Restaurant Depot, cones)." };
    return { ok: true, value: { reason_kind: "errands", event_id: null, reason_note: note } };
  }
  if (r.kind === "catering_event") {
    const id = Number(r.event_id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Pick the Catering Event this trip was for." };
    return { ok: true, value: { reason_kind: "catering_event", event_id: id, reason_note: note || null } };
  }
  return { ok: false, error: "Pick a Reason: Groceries / errands, or a Catering Event." };
}

function parseTripDate(input: unknown, today: string): Parsed<string> {
  if (typeof input !== "string" || !isISODate(input)) return { ok: false, error: "Give the trip date." };
  if (input > today) return { ok: false, error: "The trip date cannot be in the future." };
  return { ok: true, value: input };
}

/** Paths of the staff member's own uploads of one kind: "<id>/<kind>/<file>". */
function ownPaths(input: unknown, profileId: string, kind: "receipts" | "lyft"): Parsed<string[]> {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: "Bad file list." };
  if (input.length > MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} files.` };
  const prefix = `${profileId}/${kind}/`;
  for (const p of input) {
    if (typeof p !== "string" || !p.startsWith(prefix) || p.includes("..") || !/^[\w./-]+$/.test(p))
      return { ok: false, error: "A file is not one of your uploads. Upload it again." };
  }
  return { ok: true, value: input as string[] };
}

export function parseReimbursement(body: unknown, ctx: Ctx): Parsed<ReimbursementValue> {
  const b = obj(body);
  const reason = parseReason(b.reason);
  if (!reason.ok) return reason;
  const trip = parseTripDate(b.trip_date, ctx.today);
  if (!trip.ok) return trip;

  const m = obj(b.mileage);
  let mileage: Pick<ReimbursementValue, "mileage_mode" | "miles" | "stops" | "return_to_start">;
  if (m.mode === "destinations") {
    const stops = cleanStops(m.stops);
    if (!stops.ok) return stops;
    mileage = { mileage_mode: "destinations", miles: null, stops: stops.stops, return_to_start: m.return_to_start !== false };
  } else if (m.mode === "typed") {
    const miles = milesFromInput(m.miles === "" || m.miles == null ? "0" : m.miles);
    if (miles == null) return { ok: false, error: "Type the miles as a number, one decimal place at most (e.g. 12.3)." };
    mileage = { mileage_mode: "typed", miles, stops: null, return_to_start: null };
  } else {
    return { ok: false, error: "Say how the miles are given: typed, or from destinations." };
  }

  const tolls = centsFromDollars(b.tolls);
  if (tolls == null) return { ok: false, error: "Tolls must be an amount in dollars, like 4.50." };
  const parking = centsFromDollars(b.parking);
  if (parking == null) return { ok: false, error: "Parking must be an amount in dollars, like 12.00." };

  const receipts = ownPaths(b.receipt_paths, ctx.profileId, "receipts");
  if (!receipts.ok) return receipts;
  const confirmed = b.no_receipt_confirmed === true;
  if ((tolls > 0 || parking > 0) && receipts.value.length === 0 && !confirmed)
    return { ok: false, error: CONFIRM_NO_RECEIPT, confirm: "no_receipt" };

  if (mileage.mileage_mode === "typed" && !(mileage.miles! > 0) && tolls === 0 && parking === 0)
    return { ok: false, error: "There is nothing to pay back: add miles, tolls or parking." };

  return {
    ok: true,
    value: {
      ...reason.value,
      trip_date: trip.value,
      ...mileage,
      tolls_cents: tolls,
      parking_cents: parking,
      receipt_paths: receipts.value,
      no_receipt_confirmed: confirmed,
    },
  };
}

export type LyftValue = ReasonValue & { trip_date: string; screenshot_paths: string[] };

export function parseLyftRideReport(body: unknown, ctx: Ctx): Parsed<LyftValue> {
  const b = obj(body);
  const reason = parseReason(b.reason);
  if (!reason.ok) return reason;
  const trip = parseTripDate(b.trip_date, ctx.today);
  if (!trip.ok) return trip;
  const shots = ownPaths(b.screenshot_paths, ctx.profileId, "lyft");
  if (!shots.ok) return shots;
  if (shots.value.length === 0) return { ok: false, error: "Upload the Lyft ride report screenshot." };
  return { ok: true, value: { ...reason.value, trip_date: trip.value, screenshot_paths: shots.value } };
}

// ---------- upload paths ---------------------------------------------------------

/** The private Storage bucket for Receipts, Lyft ride reports and evidence (ADR 0002). */
export const BUCKET = "travel-reimbursements";

/** Photos from a phone, or a PDF. */
export const ALLOWED_EXT = ["jpg", "jpeg", "png", "heic", "heif", "webp", "pdf"];
export const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf"];

/**
 * Where an upload goes in the travel-reimbursements bucket: the staff member's
 * own folder for Receipts and Lyft ride reports, adjustments/<id> for an
 * Approver's evidence (ADR 0002). The name is made here, never taken from the
 * browser, so it cannot reach another folder.
 */
export function uploadPath(
  u: { folder: string; kind: "receipts" | "lyft" | "evidence"; ext: unknown; content_type: unknown },
  random: () => string = () => Math.random().toString(36).slice(2, 10),
): { ok: true; path: string } | { ok: false; error: string } {
  const ext = typeof u.ext === "string" ? u.ext.trim().toLowerCase().replace(/^\./, "") : "";
  if (!ALLOWED_EXT.includes(ext)) return { ok: false, error: "Upload a photo (JPG, PNG, HEIC, WebP) or a PDF." };
  if (typeof u.content_type !== "string" || !ALLOWED_CONTENT_TYPES.includes(u.content_type.toLowerCase()))
    return { ok: false, error: "Upload a photo (JPG, PNG, HEIC, WebP) or a PDF." };
  const dir = u.kind === "evidence" ? u.folder : `${u.folder}/${u.kind}`;
  return { ok: true, path: `${dir}/${Date.now()}-${random()}.${ext}` };
}
