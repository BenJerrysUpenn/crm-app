// The roster join between this app and QuickBooks Payroll.
//
// Payroll spec §2.5 (bj-finance #519): "Withers-time `profiles` ↔ QBO by a
// stored map (`profiles.qbo_employee_id`), never by name ('piper' = Kieran
// Flint; QBO itself returns different display names per endpoint)."
//
// The 2026-09-23 run matched people by name and could not: one person's
// Withers-time name was a nickname, and QBO's own endpoints disagree with each
// other about display names, so there is no string on either side that is both
// stable and comparable. The id is Intuit's local employee id
// (`Intuit.ems.iop`), typed in once per person on the Team page.
//
// Pure and dependency-free — no supabase, no React, no next — so `node --test`
// runs it directly, and the API route and the UI validate identically.

/** Same shape lib/storeHours.ts uses, so callers handle both the same way. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The longest id we will store. Intuit's local employee ids are short numeric
 * strings; 64 is far above anything real and well under any storage concern.
 * Its job is to catch a paste of the wrong thing entirely.
 */
export const MAX_QBO_EMPLOYEE_ID = 64;

// Digits, letters, dash and underscore. Real ids are numeric, but the id is
// Intuit's to shape, not ours, so the check is on characters that could not be
// part of any id rather than on a format we have guessed.
const ALLOWED = /^[A-Za-z0-9_-]+$/;

/**
 * Normalise what a manager typed into what the column stores.
 *
 * Blank in every dialect — undefined, null, "", "   " — becomes null, which is
 * "not mapped". This matters more than it looks: the unique index is partial on
 * `qbo_employee_id is not null`, so an empty string would sit in the index
 * pretending to be a mapping and the second person cleared the same way would
 * collide with the first.
 *
 * Whitespace around the value is stripped (a copy-paste from QBO usually brings
 * some). Whitespace inside is an error rather than something to squeeze out: it
 * means two things were pasted, and guessing which one is the id is worse than
 * asking.
 */
export function parseQboEmployeeId(value: unknown, field = "QBO employee id"): Parsed<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { ok: true, value: String(value) };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${field} must be text.` };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > MAX_QBO_EMPLOYEE_ID) {
    return { ok: false, error: `${field} is too long to be an employee id.` };
  }
  if (trimmed.includes("@")) {
    // The commonest wrong paste, and the one that would look plausible in a
    // text column for months. QBO ids are not email addresses.
    return { ok: false, error: `${field} is the id from QuickBooks, not an email address.` };
  }
  if (!ALLOWED.test(trimmed)) {
    return {
      ok: false,
      error: `${field} should be the plain id from QuickBooks — digits and letters only, no spaces.`,
    };
  }
  return { ok: true, value: trimmed };
}

/** One person's side of the map, as the roster check reads it. */
export type RosterProfile = {
  id: string;
  full_name: string | null;
  active: boolean;
  qbo_employee_id?: string | null;
};

/**
 * Who is not mapped yet.
 *
 * Only active people: a former employee with no id is not a problem to fix, and
 * listing them would bury the one person who is about to be paid and cannot be.
 * Ordered by name so the list reads the same way twice.
 */
export function unmappedProfiles(profiles: RosterProfile[]): RosterProfile[] {
  return profiles
    .filter((p) => p.active && !(p.qbo_employee_id ?? "").trim())
    .sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""));
}

/**
 * Two Withers-time people pointing at one QBO employee.
 *
 * The database's partial unique index makes this impossible to save, so this is
 * for reading a roster that came from somewhere else (an import, a restore, or
 * the state of things before the index was applied) and for telling the manager
 * what is wrong rather than showing them a constraint violation.
 */
export function duplicateMappings(profiles: RosterProfile[]): { qbo_employee_id: string; profiles: RosterProfile[] }[] {
  const byId = new Map<string, RosterProfile[]>();
  for (const p of profiles) {
    const id = (p.qbo_employee_id ?? "").trim();
    if (!id) continue;
    const list = byId.get(id);
    if (list) list.push(p);
    else byId.set(id, [p]);
  }
  return [...byId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([qbo_employee_id, list]) => ({ qbo_employee_id, profiles: list }))
    .sort((a, b) => a.qbo_employee_id.localeCompare(b.qbo_employee_id));
}
