// COI logic — the pure half (bj-finance #343).
//
// These are the rules a reviewer has to trust without running the app: what
// state a deal's COI is in, and what fields a Hartford certificate request
// carries. The status window is deliberately identical to the production
// conformance check `revive.coi_required_unsent` in Catering-Manager
// health/conformance.sql, so these tests also pin that agreement.

import { describe, expect, it } from "vitest";
import type { Deal } from "@/lib/types";
import {
  buildCoiRequest,
  buildCoiSentPatch,
  coiStatus,
  COI_URGENT_WINDOW_DAYS,
  daysUntil,
  formatEventDate,
  formatTimeRange,
} from "@/lib/coi";
import { easternTodayYmd } from "@/lib/dateFormat";

// A deal with everything nulled — override only what a test cares about.
function mkDeal(overrides: Partial<Deal> = {}): Deal {
  const base: Partial<Deal> = {
    id: 1,
    stage: "Booked Paid",
    company: null,
    contact_first_name: null,
    contact_last_name: null,
    contact_email: null,
    contact_phone: null,
    event_date: null,
    event_start_time: null,
    event_end_time: null,
    event_type: null,
    event_name: null,
    venue_name: null,
    venue_address: null,
    guest_count: null,
    tax_exempt: 0,
    is_outdoor: 0,
    coi_required: null,
    coi_sent_at: null,
    billing_street: null,
    billing_city: null,
    billing_state: null,
    billing_zip: null,
    notes: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
  return { ...base, ...overrides } as Deal;
}

const TODAY = "2026-09-25";

describe("daysUntil", () => {
  it("counts whole days forward", () => {
    expect(daysUntil("2026-09-30", TODAY)).toBe(5);
  });
  it("is 0 on the event day", () => {
    expect(daysUntil("2026-09-25", TODAY)).toBe(0);
  });
  it("goes negative for past events", () => {
    expect(daysUntil("2026-09-20", TODAY)).toBe(-5);
  });
  it("returns null on an unparseable or missing date", () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil("soon", TODAY)).toBeNull();
  });
  it("returns null when today itself is unparseable, not a day count", () => {
    expect(daysUntil("2026-09-30", "")).toBeNull();
    expect(daysUntil("2026-09-30", "not-a-date")).toBeNull();
  });
});

describe("coiStatus", () => {
  it("is not_required when the flag is unset", () => {
    expect(coiStatus(mkDeal({ coi_required: null }), TODAY)).toBe("not_required");
    expect(coiStatus(mkDeal({ coi_required: 0 }), TODAY)).toBe("not_required");
  });

  it("counts only coi_required = 1 as required, as the prod check does", () => {
    // The prod check reads `coi_required = 1`; any other stored value is not a
    // requirement there, so it must not raise a badge here either.
    const d = mkDeal({ coi_required: 2, event_date: "2026-09-26" });
    expect(coiStatus(d, TODAY)).toBe("not_required");
  });

  it("is sent once coi_sent_at is stamped, whatever the date", () => {
    const d = mkDeal({
      coi_required: 1,
      coi_sent_at: "2026-09-24T15:00:00Z",
      event_date: "2026-09-26",
    });
    expect(coiStatus(d, TODAY)).toBe("sent");
  });

  it("treats a blank coi_sent_at as unsent", () => {
    const d = mkDeal({ coi_required: 1, coi_sent_at: "   ", event_date: "2026-12-01" });
    expect(coiStatus(d, TODAY)).toBe("needed");
  });

  it("is needed_urgent inside the 14-day window (matches the prod check)", () => {
    // The prod check's window is 14 days, written here as the spec's literal:
    // comparing against COI_URGENT_WINDOW_DAYS would move with the constant
    // and could never catch the CRM drifting from the instrument.
    expect(COI_URGENT_WINDOW_DAYS).toBe(14);
    const edge = mkDeal({ coi_required: 1, event_date: "2026-10-09" }); // +14d
    expect(coiStatus(edge, TODAY)).toBe("needed_urgent");
    const today = mkDeal({ coi_required: 1, event_date: TODAY });
    expect(coiStatus(today, TODAY)).toBe("needed_urgent");
  });

  it("is needed (not urgent) beyond 14 days or in the past", () => {
    const far = mkDeal({ coi_required: 1, event_date: "2026-10-10" }); // +15d
    expect(coiStatus(far, TODAY)).toBe("needed");
    const past = mkDeal({ coi_required: 1, event_date: "2026-09-20" });
    expect(coiStatus(past, TODAY)).toBe("needed");
    const undated = mkDeal({ coi_required: 1, event_date: null });
    expect(coiStatus(undated, TODAY)).toBe("needed");
  });
});

describe("buildCoiRequest", () => {
  it("takes the certificate holder from the venue, address and description too", () => {
    const d = mkDeal({
      coi_required: 1,
      venue_name: "Irvine Auditorium",
      venue_address: "3401 Spruce St, Philadelphia, PA 19104",
      event_name: "Alumni Reception",
      event_date: "2026-10-05",
      event_start_time: "17:00",
      event_end_time: "20:00",
      guest_count: 120,
    });
    const r = buildCoiRequest(d);
    expect(r.certificateHolderName).toBe("Irvine Auditorium");
    expect(r.certificateHolderAddress).toBe("3401 Spruce St, Philadelphia, PA 19104");
    expect(r.additionalInsured).toBe("Irvine Auditorium");
    expect(r.missing).toHaveLength(0);
    // Worked example: the exact line the human pastes into the ACORD
    // "Description of Operations" box, time range included.
    const description =
      "Ice cream catering service provided by Withers Ventures LLC " +
      "(dba Ben & Jerry's — University City) for Alumni Reception on " +
      "October 5, 2026, 5:00 PM–8:00 PM for approximately 120 guests at " +
      "Irvine Auditorium, 3401 Spruce St, Philadelphia, PA 19104. " +
      "Irvine Auditorium is included as an additional insured with respect " +
      "to this event.";
    expect(r.descriptionOfOperations).toBe(description);
  });

  it("puts each field's value under its heading in the copy-all block", () => {
    const r = buildCoiRequest(
      mkDeal({
        coi_required: 1,
        venue_name: "Irvine Auditorium",
        venue_address: "3401 Spruce St, Philadelphia, PA 19104",
        event_name: "Alumni Reception",
        event_date: "2026-10-05",
      }),
    );
    expect(r.fullText).toBe(
      [
        "CERTIFICATE HOLDER",
        "Irvine Auditorium",
        "3401 Spruce St, Philadelphia, PA 19104",
        "",
        "DESCRIPTION OF OPERATIONS / EVENT",
        "Ice cream catering service provided by Withers Ventures LLC " +
          "(dba Ben & Jerry's — University City) for Alumni Reception on " +
          "October 5, 2026 at Irvine Auditorium, 3401 Spruce St, " +
          "Philadelphia, PA 19104. Irvine Auditorium is included as an " +
          "additional insured with respect to this event.",
        "",
        "ADDITIONAL INSURED",
        "Irvine Auditorium — add as additional insured for this event",
        "",
        "NAMED INSURED (on policy — the portal auto-fills this)",
        "Withers Ventures LLC (dba Ben & Jerry's — University City)",
      ].join("\n"),
    );
  });

  it("falls back to company for the holder and billing_* for the address", () => {
    const d = mkDeal({
      coi_required: 1,
      company: "Penn Alumni Relations",
      venue_name: null,
      venue_address: null,
      billing_street: "3535 Market St",
      billing_city: "Philadelphia",
      billing_state: "PA",
      billing_zip: "19104",
      event_date: "2026-11-01",
    });
    const r = buildCoiRequest(d);
    expect(r.certificateHolderName).toBe("Penn Alumni Relations");
    expect(r.certificateHolderAddress).toBe(
      "3535 Market St, Philadelphia, PA 19104",
    );
    expect(r.missing).toHaveLength(0);
  });

  it("reports the fields that block a request when the venue is unknown", () => {
    const d = mkDeal({ coi_required: 1, event_date: null });
    const r = buildCoiRequest(d);
    expect(r.certificateHolderName).toBeNull();
    expect(r.missing).toContain("certificate holder (venue name)");
    expect(r.missing).toContain("certificate holder address");
    expect(r.missing).toContain("event date");
    // Even bare, the block is emitted with explicit placeholders.
    expect(r.fullText).toContain("venue name missing");
  });

  it("emits a pasteable block with placeholders when the deal has no venue or date", () => {
    // Worked example: with nothing to name, the description stops at the
    // event label (no "at ...", no additional-insured sentence) and every
    // holder slot in the copy-all block tells the human what to fill.
    const r = buildCoiRequest(mkDeal({ coi_required: 1 }));
    const description =
      "Ice cream catering service provided by Withers Ventures LLC " +
      "(dba Ben & Jerry's — University City) for Ice cream catering.";
    expect(r.descriptionOfOperations).toBe(description);
    expect(r.additionalInsured).toBeNull();
    expect(r.fullText).toBe(
      [
        "CERTIFICATE HOLDER",
        "(venue name missing — fill on the deal)",
        "(venue address missing — fill on the deal)",
        "",
        "DESCRIPTION OF OPERATIONS / EVENT",
        description,
        "",
        "ADDITIONAL INSURED",
        "(add the venue as additional insured)",
        "",
        "NAMED INSURED (on policy — the portal auto-fills this)",
        "Withers Ventures LLC (dba Ben & Jerry's — University City)",
      ].join("\n"),
    );
  });

  it("skips a blank venue name and falls back to the company", () => {
    const r = buildCoiRequest(
      mkDeal({ coi_required: 1, venue_name: "   ", company: "Example Holder Co" }),
    );
    expect(r.certificateHolderName).toBe("Example Holder Co");
  });

  it("names the event by event_type when there is no event_name, and a default otherwise", () => {
    expect(
      buildCoiRequest(mkDeal({ coi_required: 1, event_type: "Wedding" }))
        .descriptionOfOperations,
    ).toBe(
      "Ice cream catering service provided by Withers Ventures LLC " +
        "(dba Ben & Jerry's — University City) for Wedding.",
    );
    expect(buildCoiRequest(mkDeal({ coi_required: 1 })).descriptionOfOperations).toBe(
      "Ice cream catering service provided by Withers Ventures LLC " +
        "(dba Ben & Jerry's — University City) for Ice cream catering.",
    );
  });
});

describe("easternTodayYmd, the today COI status is measured from", () => {
  it("is still yesterday in Philadelphia late in the evening (UTC already tomorrow)", () => {
    // 02:30 UTC on Sep 26 is 10:30 PM EDT on Sep 25.
    expect(easternTodayYmd(new Date("2026-09-26T02:30:00Z"))).toBe("2026-09-25");
  });
  it("rolls over at Eastern midnight, not UTC midnight", () => {
    // 04:30 UTC on Sep 26 is 12:30 AM EDT on Sep 26.
    expect(easternTodayYmd(new Date("2026-09-26T04:30:00Z"))).toBe("2026-09-26");
  });
});

describe("coiStatus window edges", () => {
  it("drops out of urgent the day after the event", () => {
    const yesterday = mkDeal({ coi_required: 1, event_date: "2026-09-24" });
    expect(coiStatus(yesterday, TODAY)).toBe("needed");
  });
});

describe("buildCoiRequest billing fallback", () => {
  it("composes a partial billing address without dangling separators", () => {
    const r = buildCoiRequest(
      mkDeal({
        coi_required: 1,
        company: "Example Holder Co",
        billing_street: null,
        billing_city: "Philadelphia",
        billing_state: "PA",
        billing_zip: null,
        event_date: "2026-11-01",
      }),
    );
    expect(r.certificateHolderAddress).toBe("Philadelphia, PA");
  });

  it("copies the holder and billing address without stray padding", () => {
    // What the human pastes into the certificate request must not carry the
    // whitespace a hand-typed deal field picked up.
    const r = buildCoiRequest(
      mkDeal({
        coi_required: 1,
        venue_name: "  Example Hall ",
        billing_street: " 10 Example St ",
        billing_city: " Philadelphia",
        billing_state: "PA ",
        billing_zip: " 19104 ",
      }),
    );
    expect(r.certificateHolderName).toBe("Example Hall");
    expect(r.additionalInsured).toBe("Example Hall");
    expect(r.certificateHolderAddress).toBe("10 Example St, Philadelphia, PA 19104");
  });

  it("prefers the venue address over billing when both exist", () => {
    const r = buildCoiRequest(
      mkDeal({
        coi_required: 1,
        venue_name: "Example Hall",
        venue_address: "1 Example Way, Philadelphia, PA 19104",
        billing_street: "99 Other St",
        billing_city: "Camden",
        billing_state: "NJ",
        billing_zip: "08101",
      }),
    );
    expect(r.certificateHolderAddress).toBe("1 Example Way, Philadelphia, PA 19104");
  });
});

describe("formatters", () => {
  it("formats a calendar date with no timezone shift", () => {
    expect(formatEventDate("2026-01-01")).toBe("January 1, 2026");
    expect(formatEventDate("2026-12-31")).toBe("December 31, 2026");
    expect(formatEventDate(null)).toBeNull();
    expect(formatEventDate("nope")).toBeNull();
  });

  it("formats a 24h time range into 12h", () => {
    expect(formatTimeRange("17:00", "20:30")).toBe("5:00 PM–8:30 PM");
    expect(formatTimeRange("09:15", null)).toBe("9:15 AM");
    expect(formatTimeRange("00:00", null)).toBe("12:00 AM");
    expect(formatTimeRange(null, null)).toBeNull();
  });

  it("puts noon and the 12 o'clock hour in the afternoon", () => {
    expect(formatTimeRange("12:00", "12:45")).toBe("12:00 PM–12:45 PM");
  });

  it("reads the calendar date from a stored value with a time or padding after it", () => {
    expect(formatEventDate("2026-09-25T00:00:00Z")).toBe("September 25, 2026");
    expect(formatEventDate(" 2026-09-25 ")).toBe("September 25, 2026");
  });

  it("shows the end time alone when only the end is known", () => {
    expect(formatTimeRange(null, "20:00")).toBe("8:00 PM");
  });

  it("rejects an out-of-range hour or month", () => {
    expect(formatTimeRange("25:00", null)).toBeNull();
    expect(formatEventDate("2026-13-01")).toBeNull();
  });
});

describe("buildCoiSentPatch — the write contract the panel applies", () => {
  it("stamps coi_sent_at with the sent time and updated_at with the write time", () => {
    // Distinct instants, so a patch that swapped the two arguments fails.
    expect(
      buildCoiSentPatch("2026-10-04T15:30:00.000Z", "2026-10-04T15:31:07.000Z"),
    ).toEqual({
      coi_sent_at: "2026-10-04T15:30:00.000Z",
      updated_at: "2026-10-04T15:31:07.000Z",
    });
  });

  it("clears coi_sent_at to null on Undo while still stamping updated_at", () => {
    expect(buildCoiSentPatch(null, "2026-10-04T16:00:00.000Z")).toEqual({
      coi_sent_at: null,
      updated_at: "2026-10-04T16:00:00.000Z",
    });
  });
});
