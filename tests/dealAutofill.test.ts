// Autofill on the manual New deal form — the pure half (lib/dealAutofill.ts).
//
// The rules under test: fill EMPTY contact and venue fields from the best
// dedupe match, never event fields, never anything the human typed; follow
// the chosen match; undo cleanly.

import { describe, expect, it } from "vitest";
import {
  EMPTY_DEAL_FORM_PAYLOAD,
  type DealFormPayload,
} from "@/lib/callDesk/dealForm";
import type { DedupeMatch } from "@/lib/dealIntake";
import {
  AUTOFILL_FIELDS,
  EMPTY_AUTOFILL,
  applyAutofill,
  applyAutofillPatch,
  autofillFromMatches,
  autofillLookupKeys,
  autofillValues,
  bestAutofillMatch,
  clearAutofill,
  isAutofilled,
  pickAutofill,
  rankForAutofill,
  splitName,
  type AutofillResult,
  type AutofillState,
} from "@/lib/dealAutofill";

/** A deal the dedupe route has attached details to. */
function deal(over: Partial<DedupeMatch> = {}): DedupeMatch {
  return {
    kind: "deal",
    id: 25401,
    name: "Jordan Sample",
    company: "Wharton",
    email: "jordan@example.org",
    phone: "(215) 555-0123",
    stage: "Event Complete",
    event_date: "2025-11-04",
    first_name: "Jordan",
    last_name: "Sample",
    venue_name: "Huntsman Hall",
    venue_address: "3730 Walnut St, Philadelphia, PA",
    touched_at: "2025-11-05T12:00:00",
    matched: ["email"],
    ...over,
  };
}

function prospect(over: Partial<DedupeMatch> = {}): DedupeMatch {
  return {
    kind: "prospect",
    id: 126,
    name: "Jordan Sample",
    company: "The Wharton School",
    email: "jordan@example.org",
    phone: "2155550123",
    matched: ["email"],
    ...over,
  };
}

function form(over: Partial<DealFormPayload> = {}): DealFormPayload {
  return { ...EMPTY_DEAL_FORM_PAYLOAD, source: "phone", ...over };
}

/** Apply a result the way the component does, with no keystroke in between. */
function run(
  f: DealFormPayload,
  result: AutofillResult | null,
  state: AutofillState,
): { form: DealFormPayload; state: AutofillState } {
  if (!result) return { form: f, state };
  return { form: applyAutofillPatch(f, f, result.patch), state: result.state };
}

// Fields that describe THIS event. Autofill must never copy them from an old
// deal: it is a new event.
const EVENT_FIELDS: (keyof DealFormPayload)[] = [
  "event_type",
  "event_name",
  "event_date",
  "event_start_time",
  "event_end_time",
  "guest_count",
  "is_outdoor",
  "package_name",
  "flavors",
  "toppings",
  "extras",
  "day_of_contact_name",
  "day_of_contact_phone",
  "first_note",
];

describe("what autofill may touch", () => {
  it("is contact and venue only", () => {
    expect([...AUTOFILL_FIELDS]).toEqual([
      "contact_first_name",
      "contact_last_name",
      "contact_email",
      "contact_phone",
      "company",
      "venue_name",
      "venue_address",
    ]);
    for (const f of EVENT_FIELDS) {
      expect(AUTOFILL_FIELDS as readonly string[]).not.toContain(f);
    }
  });

  it("never writes an event field, even from a match that carries them", () => {
    // A match object with stray event-ish keys on it, as a tampered or
    // future response might carry.
    const loaded = {
      ...deal(),
      event_type: "Corporate",
      guest_count: 200,
      package_name: "Sundae Party",
    } as unknown as DedupeMatch;
    const before = form({ contact_email: "jordan@example.org" });
    const { form: after } = run(
      before,
      applyAutofill(before, EMPTY_AUTOFILL, loaded),
      EMPTY_AUTOFILL,
    );
    for (const f of EVENT_FIELDS) expect(after[f]).toEqual(before[f]);
  });
});

describe("autofillValues", () => {
  it("takes names, contact, company and venue from a deal", () => {
    expect(autofillValues(deal())).toEqual({
      contact_first_name: "Jordan",
      contact_last_name: "Sample",
      contact_email: "jordan@example.org",
      contact_phone: "(215) 555-0123",
      company: "Wharton",
      venue_name: "Huntsman Hall",
      venue_address: "3730 Walnut St, Philadelphia, PA",
    });
  });

  it("splits a prospect's name and gives no venue", () => {
    const values = autofillValues(
      prospect({ name: "Jordan Sample-Reyes", venue_address: "ignored" }),
    );
    expect(values.contact_first_name).toBe("Jordan");
    expect(values.contact_last_name).toBe("Sample-Reyes");
    expect(values.venue_name).toBeUndefined();
    expect(values.venue_address).toBeUndefined();
  });

  it("falls back to the joined name when a deal's details did not load", () => {
    const bare = deal({
      first_name: undefined,
      last_name: undefined,
      venue_name: undefined,
      venue_address: undefined,
    });
    const values = autofillValues(bare);
    expect(values.contact_first_name).toBe("Jordan");
    expect(values.contact_last_name).toBe("Sample");
    expect(values.venue_address).toBeUndefined();
  });

  it("leaves out blanks", () => {
    const values = autofillValues(deal({ company: "  ", venue_name: null }));
    expect("company" in values).toBe(false);
    expect("venue_name" in values).toBe(false);
  });

  it("splits names the way the call desk always has", () => {
    expect(splitName("  Jordan  ")).toEqual({ first: "Jordan", last: "" });
    expect(splitName("Jordan van der Berg")).toEqual({
      first: "Jordan",
      last: "van der Berg",
    });
    expect(splitName(null)).toEqual({ first: "", last: "" });
  });
});

describe("which match autofill uses", () => {
  it("prefers the most recent deal among equally strong matches", () => {
    const old = deal({ id: 1, touched_at: "2019-05-01T00:00:00" });
    const recent = deal({ id: 2, touched_at: "2026-03-01T00:00:00" });
    expect(bestAutofillMatch([old, recent])?.id).toBe(2);
  });

  it("prefers a deal to a prospect", () => {
    const p = prospect({ id: 9 });
    const d = deal({ id: 3, touched_at: "2019-01-01T00:00:00" });
    expect(bestAutofillMatch([p, d])?.kind).toBe("deal");
  });

  it("falls back to a prospect when there is no deal", () => {
    expect(bestAutofillMatch([prospect()])?.kind).toBe("prospect");
  });

  it("ranks both-keys over email over phone before anything else", () => {
    // A phone-only deal is often a colleague on a shared office line.
    const phoneOnlyDeal = deal({ id: 1, matched: ["phone"] });
    const emailProspect = prospect({ id: 2, matched: ["email"] });
    const bothProspect = prospect({ id: 3, matched: ["email", "phone"] });
    expect(
      rankForAutofill([phoneOnlyDeal, emailProspect, bothProspect]).map(
        (m) => m.id,
      ),
    ).toEqual([3, 2, 1]);
  });

  it("uses the event date when a deal has no timestamp", () => {
    const a = deal({ id: 1, touched_at: null, event_date: "2024-06-01" });
    const b = deal({ id: 2, touched_at: null, event_date: "2025-06-01" });
    expect(bestAutofillMatch([a, b])?.id).toBe(2);
  });

  it("skips a match with nothing to give", () => {
    const empty = deal({
      id: 1,
      name: null,
      first_name: null,
      last_name: null,
      company: null,
      email: null,
      phone: null,
      venue_name: null,
      venue_address: null,
      touched_at: "2026-09-01T00:00:00",
    });
    expect(bestAutofillMatch([empty, prospect()])?.kind).toBe("prospect");
    expect(bestAutofillMatch([])).toBeNull();
  });
});

describe("applyAutofill", () => {
  it("fills every empty field from the match", () => {
    const before = form({ contact_email: "jordan@example.org" });
    const { form: after, state } = run(
      before,
      applyAutofill(before, EMPTY_AUTOFILL, deal()),
      EMPTY_AUTOFILL,
    );
    expect(after.contact_first_name).toBe("Jordan");
    expect(after.contact_last_name).toBe("Sample");
    expect(after.contact_phone).toBe("(215) 555-0123");
    expect(after.company).toBe("Wharton");
    expect(after.venue_name).toBe("Huntsman Hall");
    expect(after.venue_address).toBe("3730 Walnut St, Philadelphia, PA");
    expect(state.source).toEqual({ kind: "deal", id: 25401 });
  });

  it("never overwrites what the human typed", () => {
    const before = form({
      contact_first_name: "Danielle",
      contact_email: "JORDAN@example.org",
      venue_address: "Irvine Auditorium",
    });
    const { form: after, state } = run(
      before,
      applyAutofill(before, EMPTY_AUTOFILL, deal()),
      EMPTY_AUTOFILL,
    );
    expect(after.contact_first_name).toBe("Danielle");
    expect(after.contact_email).toBe("JORDAN@example.org");
    expect(after.venue_address).toBe("Irvine Auditorium");
    // ...and does not claim them as autofilled.
    expect(isAutofilled(after, state, "contact_first_name")).toBe(false);
    expect(isAutofilled(after, state, "venue_address")).toBe(false);
    // The empty ones were still filled.
    expect(after.contact_last_name).toBe("Sample");
    expect(isAutofilled(after, state, "contact_last_name")).toBe(true);
  });

  it("treats an autofilled field the human then edited as theirs", () => {
    const start = form({ contact_email: "jordan@example.org" });
    const filled = run(
      start,
      applyAutofill(start, EMPTY_AUTOFILL, deal()),
      EMPTY_AUTOFILL,
    );
    const edited = { ...filled.form, venue_address: "Houston Hall" };
    expect(isAutofilled(edited, filled.state, "venue_address")).toBe(false);

    // Switching to another match leaves the edit alone.
    const other = deal({ id: 2, venue_address: "Penn Park", first_name: "D." });
    const { form: after } = run(
      edited,
      pickAutofill(edited, filled.state, other),
      filled.state,
    );
    expect(after.venue_address).toBe("Houston Hall");
    expect(after.contact_first_name).toBe("D.");
  });
});

describe("following the matches", () => {
  const typed = form({ contact_email: "jordan@example.org" });

  it("auto-applies the best match when matches arrive", () => {
    const result = autofillFromMatches(typed, EMPTY_AUTOFILL, [
      prospect(),
      deal(),
    ]);
    expect(result?.state.source).toEqual({ kind: "deal", id: 25401 });
    expect(result?.patch.venue_address).toBe(
      "3730 Walnut St, Philadelphia, PA",
    );
  });

  it("does nothing when there are no matches and nothing was filled", () => {
    expect(autofillFromMatches(typed, EMPTY_AUTOFILL, [])).toBeNull();
  });

  it("keeps a match the human picked while it is still in the list", () => {
    const p = prospect();
    const picked = run(typed, pickAutofill(typed, EMPTY_AUTOFILL, p), EMPTY_AUTOFILL);
    expect(autofillFromMatches(picked.form, picked.state, [deal(), p])).toBeNull();
  });

  it("takes autofilled values back out when nobody matches any more", () => {
    const filled = run(
      typed,
      autofillFromMatches(typed, EMPTY_AUTOFILL, [deal()]),
      EMPTY_AUTOFILL,
    );
    // The human typed a different email; that person is new.
    const retyped = { ...filled.form, contact_email: "sam@example.com" };
    const { form: after, state } = run(
      retyped,
      autofillFromMatches(retyped, filled.state, []),
      filled.state,
    );
    expect(after.contact_email).toBe("sam@example.com");
    expect(after.contact_first_name).toBe("");
    expect(after.venue_address).toBe("");
    expect(state.source).toBeNull();
  });

  it("swaps autofilled values when a different person matches", () => {
    const filled = run(
      typed,
      autofillFromMatches(typed, EMPTY_AUTOFILL, [deal()]),
      EMPTY_AUTOFILL,
    );
    const sam = deal({
      id: 30000,
      name: "Sam Lee",
      first_name: "Sam",
      last_name: "Lee",
      company: null,
      venue_name: null,
      venue_address: "Drexel, Philadelphia",
    });
    const { form: after } = run(
      filled.form,
      autofillFromMatches(filled.form, filled.state, [sam]),
      filled.state,
    );
    expect(after.contact_first_name).toBe("Sam");
    expect(after.venue_address).toBe("Drexel, Philadelphia");
    // Wharton came from Jordan's deal and Sam's has no company: emptied, not kept.
    expect(after.company).toBe("");
    expect(after.venue_name).toBe("");
  });
});

describe("undo", () => {
  const typed = form({
    contact_email: "jordan@example.org",
    contact_first_name: "Danielle",
  });

  it("empties what autofill filled and keeps what the human typed", () => {
    const filled = run(
      typed,
      autofillFromMatches(typed, EMPTY_AUTOFILL, [deal()]),
      EMPTY_AUTOFILL,
    );
    const edited = { ...filled.form, company: "Wharton MBA office" };
    const { form: after, state } = run(
      edited,
      clearAutofill(edited, filled.state),
      filled.state,
    );
    expect(after.contact_first_name).toBe("Danielle");
    expect(after.contact_email).toBe("jordan@example.org");
    expect(after.company).toBe("Wharton MBA office");
    expect(after.contact_last_name).toBe("");
    expect(after.venue_address).toBe("");
    expect(state.values).toEqual({});
  });

  it("does not auto-apply the undone match again, but lets the human pick it", () => {
    const filled = run(
      typed,
      autofillFromMatches(typed, EMPTY_AUTOFILL, [deal()]),
      EMPTY_AUTOFILL,
    );
    const undone = run(
      filled.form,
      clearAutofill(filled.form, filled.state),
      filled.state,
    );
    expect(
      autofillFromMatches(undone.form, undone.state, [deal()]),
    ).toBeNull();

    const repicked = run(
      undone.form,
      pickAutofill(undone.form, undone.state, deal()),
      undone.state,
    );
    expect(repicked.form.venue_address).toBe(
      "3730 Walnut St, Philadelphia, PA",
    );
    expect(repicked.state.dismissed).toBeNull();
  });
});

describe("the async edges", () => {
  it("never overwrites a keystroke that landed while the lookup was in flight", () => {
    const base = form({ contact_email: "jordan@example.org" });
    const result = applyAutofill(base, EMPTY_AUTOFILL, deal());
    // The human typed a last name before the answer came back.
    const now = { ...base, contact_last_name: "O" };
    const after = applyAutofillPatch(now, base, result.patch);
    expect(after.contact_last_name).toBe("O");
    expect(after.contact_first_name).toBe("Jordan");
  });

  it("looks up only what the human typed", () => {
    // Human typed a phone; autofill filled the email from the match.
    const typed = form({ contact_phone: "215-555-0123" });
    const filled = run(
      typed,
      autofillFromMatches(typed, EMPTY_AUTOFILL, [
        deal({ matched: ["phone"] }),
      ]),
      EMPTY_AUTOFILL,
    );
    expect(filled.form.contact_email).toBe("jordan@example.org");
    expect(autofillLookupKeys(filled.form, filled.state)).toEqual({
      email: "",
      phone: "215-555-0123",
    });
    // Once the human edits the email it is theirs, and it is looked up.
    const edited = { ...filled.form, contact_email: "dana.o@example.org" };
    expect(autofillLookupKeys(edited, filled.state).email).toBe(
      "dana.o@example.org",
    );
  });
});
