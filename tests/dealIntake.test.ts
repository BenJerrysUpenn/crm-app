// Manual deal intake — the pure half.
//
// Nothing here touches Supabase. The rules being tested are the ones that
// decide what lands in the `deals` row, and they are the rules a reviewer has
// to trust without running the app: which sources a human may pick, what
// Salesforce is told, what is required in each mode, and when a quote job is
// queued.

import { describe, expect, it } from "vitest";
import {
  MANUAL_DEAL_SOURCES,
  SF_LEAD_STATE,
  emailKey,
  initialSfLeadState,
  isManualDealSource,
  phoneKey,
} from "@/lib/dealIntake";
import {
  DEAL_SOURCE,
  EMPTY_DEAL_FORM_PAYLOAD,
  buildDealInsert,
  disallowedInsertKeys,
  hasErrors,
  isQuoteReady,
  validateDealPayload,
  type DealFormPayload,
} from "@/lib/callDesk/dealForm";
import { planDeal, QUOTE_SKIPPED_INCOMPLETE } from "@/lib/callDesk/dealCreate";
import { toMatch } from "@/lib/dealDedupe";

const NOW = new Date("2026-09-20T18:30:00Z");

/** A payload the call desk would accept — every strict field present. */
function completePayload(over: Partial<DealFormPayload> = {}): DealFormPayload {
  return {
    ...EMPTY_DEAL_FORM_PAYLOAD,
    contact_first_name: "Dana",
    contact_last_name: "Okafor",
    contact_email: "dana@wharton.upenn.edu",
    contact_phone: "(215) 665-5323",
    event_type: "Corporate",
    venue_address: "3730 Walnut St, Philadelphia, PA",
    package_name: "Sundae Party",
    event_date: "2026-11-04",
    event_start_time: "14:00",
    event_end_time: "16:00",
    guest_count: 80,
    source: "phone",
    ...over,
  };
}

/** The thinnest thing the manual form will accept. */
function minimalPayload(over: Partial<DealFormPayload> = {}): DealFormPayload {
  return {
    ...EMPTY_DEAL_FORM_PAYLOAD,
    contact_first_name: "Dana",
    contact_phone: "215-665-5323",
    source: "walk_in",
    ...over,
  };
}

const CTX = {
  callerEmail: "josephpettine@gmail.com",
  nowUtc: NOW,
  prospectId: null as number | null,
  profileLabel: "Office admin",
};

describe("source vocabulary", () => {
  it("offers exactly the four hand-entered channels", () => {
    expect(MANUAL_DEAL_SOURCES.map((s) => s.value)).toEqual([
      "phone",
      "email",
      "walk_in",
      "other",
    ]);
  });

  // The rule this protects: 'form' is what tells the Salesforce mirror a
  // corporate Lead already exists. A human stamping it on a walk-in would
  // make the mirror hunt forever for a Lead nobody created.
  it("refuses 'form' and 'migrated'", () => {
    expect(isManualDealSource("form")).toBe(false);
    expect(isManualDealSource("migrated")).toBe(false);
    expect(isManualDealSource("")).toBe(false);
    expect(isManualDealSource("PHONE")).toBe(false);
  });
});

describe("initialSfLeadState", () => {
  it("queues every hand-entered source", () => {
    for (const s of MANUAL_DEAL_SOURCES)
      expect(initialSfLeadState(s.value)).toBe(SF_LEAD_STATE.QUEUED);
  });

  // Applying migration 023 must not change what tonight's mirror run does to
  // the 183 form deals already in scope.
  it("leaves form and migrated deals alone", () => {
    expect(initialSfLeadState("form")).toBeNull();
    expect(initialSfLeadState("migrated")).toBeNull();
  });
});

describe("dedupe keys", () => {
  it("normalises phones the way public.normalize_phone does", () => {
    expect(phoneKey("(215) 665-5323")).toBe("2156655323");
    expect(phoneKey("+1 215 665 5323")).toBe("2156655323");
    expect(phoneKey("12156655323")).toBe("2156655323");
    // Not a US 11-digit number: left alone rather than silently truncated.
    expect(phoneKey("442079460000")).toBe("442079460000");
    expect(phoneKey("")).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });

  it("lowercases and trims emails", () => {
    expect(emailKey("  Dana@Wharton.UPenn.edu ")).toBe(
      "dana@wharton.upenn.edu",
    );
    expect(emailKey("   ")).toBeNull();
  });
});

describe("validateDealPayload — call_desk mode is unchanged", () => {
  it("accepts a complete payload", () => {
    expect(hasErrors(validateDealPayload(completePayload()))).toBe(false);
  });

  it("still demands email, phone, package, date, times and guests", () => {
    const errors = validateDealPayload(minimalPayload({ source: "phone" }), {
      mode: "call_desk",
    });
    expect(Object.keys(errors).sort()).toEqual(
      [
        "contact_email",
        "event_date",
        "event_end_time",
        "event_start_time",
        "event_type",
        "guest_count",
        "package_name",
        "venue_address",
      ].sort(),
    );
  });

  // The default must stay strict, because the call desk does not pass a mode.
  it("defaults to call_desk", () => {
    expect(validateDealPayload(minimalPayload())).toEqual(
      validateDealPayload(minimalPayload(), { mode: "call_desk" }),
    );
  });
});

describe("validateDealPayload — manual mode", () => {
  const manual = { mode: "manual" as const };

  it("accepts a name, a phone and a source", () => {
    expect(hasErrors(validateDealPayload(minimalPayload(), manual))).toBe(
      false,
    );
  });

  it("accepts a name, an email and a source", () => {
    const payload = minimalPayload({
      contact_phone: "",
      contact_email: "dana@wharton.upenn.edu",
      source: "email",
    });
    expect(hasErrors(validateDealPayload(payload, manual))).toBe(false);
  });

  it("requires a name", () => {
    const errors = validateDealPayload(
      minimalPayload({ contact_first_name: " " }),
      manual,
    );
    expect(errors.contact_first_name).toBeTruthy();
  });

  it("requires at least one contact method, and says so on both", () => {
    const errors = validateDealPayload(
      minimalPayload({ contact_phone: "", contact_email: "" }),
      manual,
    );
    expect(errors.contact_email).toBeTruthy();
    expect(errors.contact_phone).toBe(errors.contact_email);
  });

  it("requires a source, and refuses one outside the list", () => {
    expect(
      validateDealPayload(minimalPayload({ source: "" }), manual).source,
    ).toBeTruthy();
    expect(
      validateDealPayload(
        minimalPayload({ source: "form" as never }),
        manual,
      ).source,
    ).toBeTruthy();
  });

  // Optional does not mean unchecked: a typed date still has to be a date.
  it("still format-checks anything that was filled in", () => {
    const errors = validateDealPayload(
      minimalPayload({
        contact_email: "not-an-email",
        event_date: "4th Nov",
        event_start_time: "2pm",
        guest_count: -3,
      }),
      manual,
    );
    expect(errors.contact_email).toBe("That does not look like an email address");
    expect(errors.event_date).toBe("Use YYYY-MM-DD");
    expect(errors.event_start_time).toBe("Use HH:MM (24h)");
    expect(errors.guest_count).toBeTruthy();
  });
});

describe("isQuoteReady", () => {
  it("is true for everything the call desk collects", () => {
    expect(isQuoteReady(completePayload())).toBe(true);
  });

  it.each([
    ["venue_address", { venue_address: "" }],
    ["event_date", { event_date: "" }],
    ["package_name", { package_name: "" }],
    ["guest_count", { guest_count: null }],
  ])("is false without %s", (_field, over) => {
    expect(isQuoteReady(completePayload(over as Partial<DealFormPayload>))).toBe(
      false,
    );
  });
});

describe("buildDealInsert", () => {
  it("stamps the chosen source and queues Salesforce", () => {
    const row = buildDealInsert(minimalPayload({ source: "walk_in" }), CTX);
    expect(row.source).toBe("walk_in");
    expect(row.sf_lead_state).toBe(SF_LEAD_STATE.QUEUED);
    expect(row.stage).toBe("Open");
    expect(row.payment_status).toBe("None");
    expect(row.is_active).toBe(1);
  });

  it("never emits a column outside the allowlist", () => {
    expect(disallowedInsertKeys(buildDealInsert(completePayload(), CTX))).toEqual(
      [],
    );
  });

  // A tampered body reaching the builder must not become a form deal.
  it("falls back to phone, never to form, on a bad source", () => {
    const row = buildDealInsert(
      minimalPayload({ source: "form" as never }),
      CTX,
    );
    expect(row.source).toBe(DEAL_SOURCE);
    expect(row.sf_lead_state).toBe(SF_LEAD_STATE.QUEUED);
  });

  it("records who typed it in and where it came from", () => {
    const row = buildDealInsert(
      minimalPayload({ source: "walk_in", first_note: "wants vegan" }),
      CTX,
    );
    expect(row.notes).toBe(
      "[2026-09-20] Created by hand by josephpettine@gmail.com " +
        "(source: Walk-in). Profile: Office admin.\n" +
        "[2026-09-20] wants vegan",
    );
    expect(row.lead_source).toBe("josephpettine@gmail.com");
  });

  it("keeps the call desk's own provenance line", () => {
    const row = buildDealInsert(completePayload(), { ...CTX, prospectId: 126 });
    expect(row.notes).toContain("Created from call desk");
    expect(row.notes).toContain("(prospect #126)");
    expect(row.source).toBe("phone");
  });
});

describe("planDeal", () => {
  it("queues retriage then quote for a complete deal", () => {
    const plan = planDeal({
      payload: completePayload(),
      prospectId: 126,
      callerEmail: CTX.callerEmail,
      profileLabel: "",
      nowUtc: NOW,
    });
    expect(plan.jobs.map((j) => j.kind)).toEqual(["retriage", "quote"]);
    expect(plan.quoteSkippedReason).toBeNull();
  });

  it("queues nothing there is not enough to price", () => {
    const plan = planDeal({
      payload: minimalPayload(),
      prospectId: null,
      callerEmail: CTX.callerEmail,
      profileLabel: "",
      nowUtc: NOW,
    });
    expect(plan.jobs).toEqual([]);
    expect(plan.quoteSkippedReason).toBe(QUOTE_SKIPPED_INCOMPLETE);
  });

  it("plans prospect events only when there is a prospect", () => {
    const withProspect = planDeal({
      payload: completePayload(),
      prospectId: 126,
      callerEmail: CTX.callerEmail,
      profileLabel: "",
      nowUtc: NOW,
    });
    expect(withProspect.events.map((e) => e.event)).toEqual([
      "deal_created",
      "handed_off",
    ]);

    const manual = planDeal({
      payload: completePayload(),
      prospectId: null,
      callerEmail: CTX.callerEmail,
      profileLabel: "",
      nowUtc: NOW,
    });
    expect(manual.events).toEqual([]);
  });
});

describe("dedupe match shaping", () => {
  it("labels which keys matched and carries deal context", () => {
    expect(
      toMatch({
        kind: "deal",
        id: 25401,
        name: "Dana Okafor",
        company: "Wharton",
        email: "dana@wharton.upenn.edu",
        phone: "(215) 665-5323",
        stage: "Booked Paid",
        event_date: "2026-11-04",
        matched_email: true,
        matched_phone: true,
      }),
    ).toEqual({
      kind: "deal",
      id: 25401,
      name: "Dana Okafor",
      company: "Wharton",
      email: "dana@wharton.upenn.edu",
      phone: "(215) 665-5323",
      stage: "Booked Paid",
      event_date: "2026-11-04",
      matched: ["email", "phone"],
    });
  });

  it("omits deal-only fields for a prospect", () => {
    const match = toMatch({
      kind: "prospect",
      id: 126,
      name: "Dana Okafor",
      company: null,
      email: null,
      phone: "2156655323",
      stage: null,
      event_date: null,
      matched_email: false,
      matched_phone: true,
    });
    expect(match.matched).toEqual(["phone"]);
    expect("stage" in match).toBe(false);
  });
});
