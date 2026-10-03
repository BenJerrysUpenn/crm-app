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
  coiStatus,
  COI_URGENT_WINDOW_DAYS,
  daysUntil,
  formatEventDate,
  formatTimeRange,
} from "@/lib/coi";

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
});

describe("coiStatus", () => {
  it("is not_required when the flag is unset", () => {
    expect(coiStatus(mkDeal({ coi_required: null }), TODAY)).toBe("not_required");
    expect(coiStatus(mkDeal({ coi_required: 0 }), TODAY)).toBe("not_required");
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
    const edge = mkDeal({ coi_required: 1, event_date: "2026-10-09" }); // +14d
    expect(daysUntil("2026-10-09", TODAY)).toBe(COI_URGENT_WINDOW_DAYS);
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
    expect(r.descriptionOfOperations).toContain("Alumni Reception");
    expect(r.descriptionOfOperations).toContain("October 5, 2026");
    expect(r.descriptionOfOperations).toContain("120 guests");
    expect(r.descriptionOfOperations).toContain("additional insured");
    expect(r.descriptionOfOperations).toContain("Withers Ventures LLC");
    // The one-click block carries every ACORD-shaped field.
    expect(r.fullText).toContain("CERTIFICATE HOLDER");
    expect(r.fullText).toContain("DESCRIPTION OF OPERATIONS");
    expect(r.fullText).toContain("ADDITIONAL INSURED");
    expect(r.fullText).toContain("NAMED INSURED");
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

  it("uses event_type when there is no event_name, and a default otherwise", () => {
    expect(buildCoiRequest(mkDeal({ coi_required: 1, event_type: "Wedding" })).eventLabel).toBe(
      "Wedding",
    );
    expect(buildCoiRequest(mkDeal({ coi_required: 1 })).eventLabel).toBe(
      "Ice cream catering",
    );
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
});
