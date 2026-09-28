// Which fields the guided deal form marks as required, per mode.
//
// Staff read a red asterisk as mandatory, so the asterisks are the form's
// promise about what the validator will refuse, and they are checked against
// each other here. On the manual New deal form that means only Source and
// First name: a venue address in particular is optional there.
//
// There is no DOM in this test environment, so the component source is read
// as text: every `<Field ...>` opening tag is found, its label read, and its
// `required` attribute evaluated for each mode.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_DEAL_FORM_PAYLOAD,
  isRequiredField,
  REQUIRED_FIELDS,
  validateDealPayload,
  type DealFormMode,
  type DealFormPayload,
} from "@/lib/callDesk/dealForm";

const SOURCE = readFileSync(
  resolve(__dirname, "../components/callDesk/GenerateDealForm.tsx"),
  "utf8",
);

type FieldTag = { label: string; required: string | null };

/** Every `<Field ...>` opening tag in the form, with its raw `required`. */
function fieldTags(): FieldTag[] {
  const out: FieldTag[] = [];
  for (const m of SOURCE.matchAll(/<Field\s([^>]*)>/g)) {
    const attrs = m[1];
    const label = /label="([^"]*)"/.exec(attrs)?.[1];
    if (!label) continue;
    // `required={...}`, or the bare word `required` as its own attribute.
    const expr = /\brequired=\{([^}]*)\}/.exec(attrs)?.[1];
    const bare = /(^|\s)required(\s|$)/.test(attrs);
    out.push({ label, required: expr ?? (bare ? "true" : null) });
  }
  return out;
}

/** Evaluate a `required` expression the way the component would. */
function isMarked(expr: string | null, mode: DealFormMode): boolean {
  if (expr == null) return false;
  if (expr === "true") return true;
  if (expr === "strictReq") return mode === "call_desk";
  const call = /^isRequiredField\("([a-z_]+)", mode\)$/.exec(expr.trim());
  if (call) {
    return isRequiredField(call[1] as keyof DealFormPayload, mode);
  }
  throw new Error(`Unrecognised required expression: ${expr}`);
}

function markedLabels(mode: DealFormMode): string[] {
  return fieldTags()
    .filter((f) => isMarked(f.required, mode))
    .map((f) => f.label)
    .sort();
}

describe("required markers on the manual New deal form", () => {
  it("finds the form's fields (the scan itself works)", () => {
    const labels = fieldTags().map((f) => f.label);
    expect(labels).toContain("Venue address");
    expect(labels).toContain("First name");
  });

  it("marks only the minimal set: source and first name", () => {
    // Email and phone are "one of the two" in manual mode, which the form
    // says in their hint rather than with an asterisk on both.
    expect(markedLabels("manual")).toEqual(["First name", "Source"]);
  });

  it("does not mark the venue address", () => {
    const venue = fieldTags().find((f) => f.label === "Venue address");
    expect(isMarked(venue?.required ?? null, "manual")).toBe(false);
  });
});

describe("required markers on the call desk form are unchanged", () => {
  it("marks everything the call desk has always required", () => {
    expect(markedLabels("call_desk")).toEqual(
      [
        "Date",
        "Email",
        "End",
        "Event type",
        "First name",
        "Guest count",
        "Phone",
        "Start",
        "Venue address",
      ].sort(),
    );
  });
});

describe("REQUIRED_FIELDS agrees with validateDealPayload", () => {
  // A payload with every field filled, so blanking one field at a time shows
  // exactly which blanks the validator refuses.
  const full: DealFormPayload = {
    ...EMPTY_DEAL_FORM_PAYLOAD,
    contact_first_name: "Dana",
    contact_last_name: "Okafor",
    contact_email: "dana@example.org",
    contact_phone: "(215) 555-0123",
    company: "Wharton",
    customer_profile: "office_admin",
    event_type: "Corporate",
    event_name: "Fall mixer",
    event_date: "2026-11-04",
    event_start_time: "14:00",
    event_end_time: "16:00",
    venue_name: "Huntsman Hall",
    venue_address: "3730 Walnut St, Philadelphia, PA",
    guest_count: 80,
    package_name: "Sundae Party",
    how_did_you_hear: "Returning",
    day_of_contact_name: "Sam",
    day_of_contact_phone: "215-555-0100",
    first_note: "Called back",
    source: "phone",
  };

  const blankable = (Object.keys(full) as (keyof DealFormPayload)[]).filter(
    (k) => typeof full[k] === "string" || k === "guest_count",
  );

  for (const mode of ["call_desk", "manual"] as const) {
    it(`${mode}: a blank field is refused exactly when it is required`, () => {
      for (const key of blankable) {
        const blank = key === "guest_count" ? null : "";
        const errors = validateDealPayload(
          { ...full, [key]: blank },
          { mode },
        );
        expect(
          { key, refused: key in errors },
        ).toEqual({ key, refused: isRequiredField(key, mode) });
      }
    });
  }

  it("manual mode requires only a name and a source", () => {
    expect([...REQUIRED_FIELDS.manual].sort()).toEqual(
      ["contact_first_name", "source"].sort(),
    );
    expect(isRequiredField("venue_address", "manual")).toBe(false);
    expect(isRequiredField("venue_address", "call_desk")).toBe(true);
  });
});
