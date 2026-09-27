// Autofill for the manual "New deal" form from what we already know.
//
// Alina, 2026-09-27: "Why aren't we auto-filling from the information we
// already know about the person?" The form already asks POST /api/deals/dedupe
// who matches the typed email or phone — prior deals (including the 9,450
// archived Salesforce-migrated ones) and outreach prospects. This module turns
// the best of those matches into values for the form's EMPTY fields.
//
// The rules, all enforced here so the component only wires them up:
//
//   * Only contact and venue fields are ever filled (AUTOFILL_FIELDS). Event
//     fields — date, times, guest count, event type, package, flavors,
//     toppings, extras — never are: it is a new event, and last year's date
//     or head count copied silently into a new deal is worse than a blank.
//   * A field that holds something the human typed is never overwritten.
//     "Typed" is decided by value: a field still holding exactly what autofill
//     put there is autofill's; anything else is the human's.
//   * Autofilled values follow the chosen match. Pick another match and they
//     are replaced; undo, or type a different email so nobody matches, and
//     they are cleared. Human values are untouched throughout.
//   * The lookup keys are the human's: an email or phone that autofill put in
//     is not sent back to the dedupe check, so autofill cannot keep an old
//     match alive after the human has typed somebody else's number.

import type { DealFormPayload } from "@/lib/callDesk/dealForm";
import type { DedupeMatch } from "@/lib/dealIntake";

/** The only form fields autofill may write. Contact and venue, never event. */
export const AUTOFILL_FIELDS = [
  "contact_first_name",
  "contact_last_name",
  "contact_email",
  "contact_phone",
  "company",
  "venue_name",
  "venue_address",
] as const satisfies readonly (keyof DealFormPayload)[];

export type AutofillField = (typeof AUTOFILL_FIELDS)[number];
export type AutofillValues = Partial<Record<AutofillField, string>>;

export type AutofillSource = { kind: DedupeMatch["kind"]; id: number };

export type AutofillState = {
  /** The match the current autofilled values came from, or null. */
  source: AutofillSource | null;
  /** What autofill put in each field it filled. */
  values: AutofillValues;
  /** A match the human undid. It is not auto-applied again; they can still
   *  pick it by hand from the duplicate list. */
  dismissed: AutofillSource | null;
};

export const EMPTY_AUTOFILL: AutofillState = {
  source: null,
  values: {},
  dismissed: null,
};

export function sameSource(
  a: AutofillSource | null | undefined,
  b: AutofillSource | null | undefined,
): boolean {
  return a != null && b != null && a.kind === b.kind && a.id === b.id;
}

export function describeSource(source: AutofillSource): string {
  return source.kind === "deal"
    ? `deal #${source.id}`
    : `prospect #${source.id}`;
}

/** "Dana Okafor-Reyes" → first "Dana", last "Okafor-Reyes". The same split the
 *  call desk has always used to seed the form from a prospect's name. */
export function splitName(full: string | null | undefined): {
  first: string;
  last: string;
} {
  const s = (full ?? "").trim();
  const space = s.indexOf(" ");
  return space === -1
    ? { first: s, last: "" }
    : { first: s.slice(0, space), last: s.slice(space + 1).trim() };
}

/** What one match can fill. Blank values are left out, so a match never
 *  "fills" a field with nothing. */
export function autofillValues(match: DedupeMatch): AutofillValues {
  // A deal carries first and last name separately once the dedupe route has
  // attached its details; without them (a prospect, or the follow-up read
  // failed) the joined name is split the way the call desk splits it.
  const hasSplitName =
    match.kind === "deal" &&
    (match.first_name !== undefined || match.last_name !== undefined);
  const split = splitName(match.name);
  const raw: Record<AutofillField, string | null | undefined> = {
    contact_first_name: hasSplitName ? match.first_name : split.first,
    contact_last_name: hasSplitName ? match.last_name : split.last,
    contact_email: match.email,
    contact_phone: match.phone,
    company: match.company,
    // Prospects have no venue: outreach knows a city, not an address.
    venue_name: match.kind === "deal" ? match.venue_name : null,
    venue_address: match.kind === "deal" ? match.venue_address : null,
  };
  const out: AutofillValues = {};
  for (const field of AUTOFILL_FIELDS) {
    const v = (raw[field] ?? "").trim();
    if (v) out[field] = v;
  }
  return out;
}

function strength(match: DedupeMatch): number {
  const email = match.matched.includes("email");
  const phone = match.matched.includes("phone");
  // An email is one person's; a phone is often an office line shared by
  // several. So both beats email beats phone.
  return email && phone ? 0 : email ? 1 : 2;
}

function recency(match: DedupeMatch): string {
  return match.touched_at ?? match.event_date ?? "";
}

/** Matches in the order autofill prefers them: strongest match first, then
 *  deals before prospects (a deal is what this customer actually booked,
 *  with a venue), then the most recently touched. Returns a new array. */
export function rankForAutofill(matches: DedupeMatch[]): DedupeMatch[] {
  return [...matches].sort((a, b) => {
    const s = strength(a) - strength(b);
    if (s !== 0) return s;
    const k = (a.kind === "deal" ? 0 : 1) - (b.kind === "deal" ? 0 : 1);
    if (k !== 0) return k;
    const r = recency(b).localeCompare(recency(a));
    if (r !== 0) return r;
    return b.id - a.id;
  });
}

/** The match autofill would use on its own: the top-ranked one that has
 *  anything to give. */
export function bestAutofillMatch(matches: DedupeMatch[]): DedupeMatch | null {
  return (
    rankForAutofill(matches).find(
      (m) => Object.keys(autofillValues(m)).length > 0,
    ) ?? null
  );
}

/** Whether `field` currently holds a value autofill put there. */
export function isAutofilled(
  form: DealFormPayload,
  state: AutofillState,
  field: AutofillField,
): boolean {
  const v = state.values[field];
  return v !== undefined && form[field] === v;
}

export type AutofillResult = {
  /** Only the fields that change. */
  patch: AutofillValues;
  state: AutofillState;
};

/** Fill from `match` (or, with null, take autofill's values back out).
 *
 *  For each autofill field: a value the human typed is kept; an empty field
 *  or one still holding autofill's value takes the match's value; if the
 *  match has none, a field autofill had filled is emptied again. */
export function applyAutofill(
  form: DealFormPayload,
  state: AutofillState,
  match: DedupeMatch | null,
): AutofillResult {
  const incoming = match ? autofillValues(match) : {};
  const patch: AutofillValues = {};
  const values: AutofillValues = {};
  for (const field of AUTOFILL_FIELDS) {
    const current = form[field];
    const ours = isAutofilled(form, state, field);
    if (!ours && current.trim() !== "") continue; // the human's; never touched
    const next = incoming[field];
    if (next) {
      values[field] = next;
      if (current !== next) patch[field] = next;
    } else if (ours) {
      patch[field] = "";
    }
  }
  return {
    patch,
    state: {
      source:
        match && Object.keys(values).length > 0
          ? { kind: match.kind, id: match.id }
          : null,
      values,
      dismissed: state.dismissed,
    },
  };
}

/** Undo: empty every field autofill still owns, and do not auto-apply the
 *  same match again. */
export function clearAutofill(
  form: DealFormPayload,
  state: AutofillState,
): AutofillResult {
  const result = applyAutofill(form, state, null);
  return {
    patch: result.patch,
    state: { ...result.state, dismissed: state.source ?? state.dismissed },
  };
}

/** The human picked a match from the list: fill from it, even one they undid
 *  before. */
export function pickAutofill(
  form: DealFormPayload,
  state: AutofillState,
  match: DedupeMatch,
): AutofillResult {
  return applyAutofill(form, { ...state, dismissed: null }, match);
}

/** What to do when a fresh set of dedupe matches arrives. Returns null when
 *  nothing should change.
 *
 *  A match already in use (auto-applied or picked by hand) is kept for as
 *  long as it is still in the list. Otherwise the best match is applied —
 *  unless it is the one the human undid — and when there is none, whatever
 *  autofill filled from a match that no longer matches is taken back out. */
export function autofillFromMatches(
  form: DealFormPayload,
  state: AutofillState,
  matches: DedupeMatch[],
): AutofillResult | null {
  if (state.source && matches.some((m) => sameSource(m, state.source))) {
    return null;
  }
  const best = bestAutofillMatch(matches);
  const target = best && !sameSource(best, state.dismissed) ? best : null;
  if (!target && Object.keys(state.values).length === 0) return null;
  return applyAutofill(form, state, target);
}

/** Apply a patch computed against `base` to the form as it is NOW, skipping
 *  any field the human changed in between (the dedupe answer is async, and a
 *  keystroke that lands while it is in flight is the human's). */
export function applyAutofillPatch(
  now: DealFormPayload,
  base: DealFormPayload,
  patch: AutofillValues,
): DealFormPayload {
  let next = now;
  for (const field of AUTOFILL_FIELDS) {
    const v = patch[field];
    if (v === undefined || now[field] !== base[field]) continue;
    if (next === now) next = { ...now };
    next[field] = v;
  }
  return next;
}

/** The email and phone to look up: only what the human typed. A value
 *  autofill put there is left out, so it cannot keep an old match alive. */
export function autofillLookupKeys(
  form: DealFormPayload,
  state: AutofillState,
): { email: string; phone: string } {
  return {
    email: isAutofilled(form, state, "contact_email") ? "" : form.contact_email,
    phone: isAutofilled(form, state, "contact_phone") ? "" : form.contact_phone,
  };
}
