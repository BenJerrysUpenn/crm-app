// Funnels tab — the pure half (bj-finance #422).
//
// These tests pin the rules a reviewer has to trust without running the app:
// the profile derivation, the window arithmetic, and — the one that must never
// regress — outreach->deal attribution via the ACTIVITY JOIN, never created_at.

import { describe, expect, it } from "vitest";
import {
  deriveProfile,
  emailDomain,
  isBusinessDomain,
  isPennDomain,
  normalizeEventType,
} from "@/lib/funnels/profile";
import {
  DEFAULT_WINDOW,
  parseWindow,
  semesterStart,
  windowStart,
} from "@/lib/funnels/windows";
import {
  computeBelowMin,
  computeDealFunnel,
  computeOutreachFunnel,
  computeQuoteLatency,
  median,
  pct,
  weekStartISO,
} from "@/lib/funnels/compute";
import { ageLabel, gmailLink, money, pctLabel } from "@/components/funnels/format";
import type {
  DealRow,
  OutreachEventRow,
  ProspectRow,
} from "@/lib/funnels/types";

// --- profile derivation ------------------------------------------------------

describe("profile derivation", () => {
  it("normalizes dirty event_type", () => {
    expect(normalizeEventType("  Bar   Or Bat  MITZVAH ")).toBe(
      "bar or bat mitzvah",
    );
    expect(normalizeEventType(null)).toBe("");
  });

  it("reads the email domain, penn and business flags", () => {
    expect(emailDomain("A@Wharton.UPenn.edu")).toBe("wharton.upenn.edu");
    expect(isPennDomain("wharton.upenn.edu")).toBe(true);
    expect(isPennDomain("penn.edu")).toBe(false);
    expect(isPennDomain("notupenn.edu")).toBe(false);
    expect(isBusinessDomain("acme.com")).toBe(true);
    expect(isBusinessDomain("gmail.com")).toBe(false);
    expect(isBusinessDomain("")).toBe(false);
  });

  it("follows the spec's literal precedence: occasion before channel", () => {
    // A Penn address with no matching occasion -> penn_account.
    expect(deriveProfile("Study Break", "dev@upenn.edu")).toBe("penn_account");
    expect(deriveProfile(null, "dev@wharton.upenn.edu")).toBe("penn_account");
    // Occasion wins over the Penn channel (wedding/mitzvah/office before penn).
    expect(deriveProfile("Wedding", "dev@upenn.edu")).toBe("wedding");
    expect(deriveProfile("Corporate", "x@seas.upenn.edu")).toBe("office_admin");
    // The Penn channel wins over a family occasion (penn before family).
    expect(deriveProfile("Birthday Party", "dev@upenn.edu")).toBe("penn_account");
  });

  it("maps wedding / mitzvah / family event types", () => {
    expect(deriveProfile("Bridal Shower", "a@gmail.com")).toBe("wedding");
    expect(deriveProfile("Rehearsal Dinner", "a@gmail.com")).toBe("wedding");
    expect(deriveProfile("Bar or Bat Mitzvah", "a@gmail.com")).toBe("mitzvah");
    expect(deriveProfile("Birthday Party", "a@gmail.com")).toBe(
      "family_celebration",
    );
    expect(deriveProfile("Baby Shower", "a@yahoo.com")).toBe(
      "family_celebration",
    );
  });

  it("office_admin only when corporate AND a business domain", () => {
    expect(deriveProfile("Employee Appreciation", "hr@acme.com")).toBe(
      "office_admin",
    );
    // Corporate event but a consumer inbox -> not office_admin.
    expect(deriveProfile("Employee Appreciation", "someone@gmail.com")).toBe(
      "unclassified",
    );
  });

  it("falls through to unclassified", () => {
    expect(deriveProfile("Memorial Softball Outing", "a@gmail.com")).toBe(
      "unclassified",
    );
    expect(deriveProfile(null, null)).toBe("unclassified");
  });
});

// --- windows -----------------------------------------------------------------

describe("windows", () => {
  it("defaults unknown values", () => {
    expect(parseWindow("bogus")).toBe(DEFAULT_WINDOW);
    expect(parseWindow("7")).toBe("7");
    expect(parseWindow(null)).toBe(DEFAULT_WINDOW);
  });

  it("computes day windows back from now", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const start = windowStart("7", now);
    expect(start.toISOString()).toBe("2026-09-18T12:00:00.000Z");
  });

  it("anchors the semester on Aug 1 once fall has started", () => {
    expect(semesterStart(new Date("2026-09-25T00:00:00Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    // Before August -> Jan 1 of the same year.
    expect(semesterStart(new Date("2026-03-01T00:00:00Z")).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

// --- small helpers -----------------------------------------------------------

describe("helpers", () => {
  it("median handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("pct guards divide-by-zero and rounds", () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(0, 0)).toBe(0);
    expect(pct(9, 10)).toBe(90);
  });
  it("weekStartISO snaps to Monday UTC", () => {
    // 2026-09-25 is a Friday -> Monday 2026-09-21.
    expect(weekStartISO(Date.parse("2026-09-25T12:00:00Z"))).toBe(
      "2026-09-21T00:00:00.000Z",
    );
  });
});

// --- outreach funnel + activity join ----------------------------------------

describe("outreach funnel activity join", () => {
  const START = Date.parse("2026-09-01T00:00:00Z");

  const prospects: ProspectRow[] = [
    { id: 1, email: "warm@acme.com", engine: "warm", status: "handed_off" },
    { id: 2, email: "cold@beta.com", engine: "cold", status: "sequenced" },
    { id: 3, email: "legacy@old.com", engine: "warm", status: "sequenced" },
  ];

  const events: OutreachEventRow[] = [
    { prospect_id: 1, event: "sequenced", occurred_at: "2026-09-10T09:00:00Z" },
    { prospect_id: 1, event: "replied", occurred_at: "2026-09-11T09:00:00Z" },
    { prospect_id: 1, event: "handed_off", occurred_at: "2026-09-12T09:00:00Z" },
    { prospect_id: 2, event: "sequenced", occurred_at: "2026-09-15T09:00:00Z" },
    { prospect_id: 3, event: "sequenced", occurred_at: "2026-09-16T09:00:00Z" },
  ];

  const deals: DealRow[] = [
    // Deal on prospect 1's email, TOUCHED AFTER the mail -> attributes.
    {
      id: 10,
      stage: "Booked Paid",
      contact_email: "warm@acme.com",
      event_type: "Corporate",
      created_at: "2026-09-10T10:00:00Z",
      updated_at: "2026-09-13T10:00:00Z",
      total_with_tax: 1200,
      subtotal_pretax: 1000,
      signed_contract_total: 1200,
    },
    // Legacy deal on prospect 3's email, last touched BEFORE the mail -> must
    // NOT attribute (this is the created_at trap the activity join avoids).
    {
      id: 11,
      stage: "Event Complete",
      contact_email: "legacy@old.com",
      event_type: "Birthday",
      created_at: "2025-01-01T10:00:00Z",
      updated_at: "2025-01-05T10:00:00Z",
      total_with_tax: 800,
      subtotal_pretax: 700,
      signed_contract_total: 800,
    },
  ];

  it("attributes only deals touched after the mail instant", () => {
    const [warm, cold] = computeOutreachFunnel(events, prospects, deals, START);
    expect(warm.engine).toBe("warm");
    expect(warm.sent).toBe(2); // prospects 1 and 3 mailed
    expect(warm.replied).toBe(1);
    expect(warm.handed_off).toBe(1);
    expect(warm.deal).toBe(1); // only prospect 1; prospect 3's legacy deal excluded
    expect(warm.quoted).toBe(1);
    expect(warm.booked).toBe(1);

    expect(cold.engine).toBe("cold");
    expect(cold.sent).toBe(1);
    expect(cold.deal).toBe(0);
  });

  it("counts an interested reply as replied, and ignores engine-less prospects", () => {
    const more: ProspectRow[] = [
      ...prospects,
      { id: 4, email: "nobody@gamma.com", engine: null, status: "sequenced" },
    ];
    const moreEvents: OutreachEventRow[] = [
      { prospect_id: 2, event: "interested", occurred_at: "2026-09-16T09:00:00Z" },
      { prospect_id: 4, event: "sequenced", occurred_at: "2026-09-16T09:00:00Z" },
      { prospect_id: null, event: "sequenced", occurred_at: "2026-09-16T09:00:00Z" },
      ...events,
    ];
    const [warm, cold] = computeOutreachFunnel(moreEvents, more, deals, START);
    expect(cold.replied).toBe(1);
    expect(warm.sent + cold.sent).toBe(3); // prospect 4 has no engine
  });

  it("drops mails outside the window", () => {
    const tightStart = Date.parse("2026-09-15T12:00:00Z");
    const [warm] = computeOutreachFunnel(events, prospects, deals, tightStart);
    expect(warm.sent).toBe(1); // only prospect 3 (mailed 09-16); prospect 1 mailed 09-10
  });
});

// --- deal funnel + below-min -------------------------------------------------

describe("deal funnel and below-min", () => {
  const START = Date.parse("2026-09-01T00:00:00Z");
  const deals: DealRow[] = [
    mkDeal(1, "Sent Quote", "a@acme.com", "Corporate", "2026-09-05", 500),
    mkDeal(2, "Booked Paid", "b@acme.com", "Employee Appreciation", "2026-09-06", 1500),
    mkDeal(3, "Closed Below Min", "c@gmail.com", "Birthday", "2026-09-07", 0),
    mkDeal(4, "Event Complete", "d@upenn.edu", "Study Break", "2026-09-08", 2000),
    // Out of window -> ignored entirely.
    mkDeal(5, "Booked Paid", "e@acme.com", "Corporate", "2026-08-01", 999),
  ];

  it("rolls up created/quoted/booked/complete with $", () => {
    const rows = computeDealFunnel(deals, START);
    const all = rows.find((r) => r.profile === "__all__")!;
    expect(all.created).toBe(4);
    expect(all.quoted).toBe(3); // Sent Quote, Booked Paid, Event Complete
    expect(all.booked).toBe(2); // Booked Paid, Event Complete
    expect(all.complete).toBe(1);
    expect(all.booked_value).toBe(3500);

    const office = rows.find((r) => r.profile === "office_admin")!;
    expect(office.created).toBe(2); // deals 1 and 2
    const penn = rows.find((r) => r.profile === "penn_account")!;
    expect(penn.created).toBe(1); // deal 4
  });

  it("counts below-min per profile and overall with a share", () => {
    const bm = computeBelowMin(deals, START);
    expect(bm.overall.below_min).toBe(1);
    expect(bm.overall.total).toBe(4);
    expect(bm.overall.share).toBe(25);
    const family = bm.by_profile.find((p) => p.profile === "family_celebration")!;
    expect(family.below_min).toBe(1);
    expect(family.total).toBe(1);
    expect(family.share).toBe(100);
  });
});

// --- quote latency -----------------------------------------------------------

describe("quote latency", () => {
  const START = Date.parse("2026-09-01T00:00:00Z");
  it("computes median hours and drops noise", () => {
    const r = computeQuoteLatency(
      [
        { created_at: "2026-09-10T00:00:00Z", quote_sent_at: "2026-09-10T02:00:00Z" }, // 2h
        { created_at: "2026-09-11T00:00:00Z", quote_sent_at: "2026-09-11T06:00:00Z" }, // 6h
        { created_at: "2026-09-12T00:00:00Z", quote_sent_at: "2026-09-11T00:00:00Z" }, // negative -> dropped
        { created_at: "bad", quote_sent_at: "2026-09-11T00:00:00Z" }, // unparseable -> dropped
        { created_at: "2026-08-20T00:00:00Z", quote_sent_at: "2026-08-20T09:00:00Z" }, // before window -> dropped
      ],
      START,
    );
    expect(r.count).toBe(2);
    expect(r.median_hours).toBe(4);
  });

  it("trends the median by the Monday-UTC week the deal was created in", () => {
    const r = computeQuoteLatency(
      [
        // Week of Mon 2026-09-07: 2h and 6h -> median 4.
        { created_at: "2026-09-10T00:00:00Z", quote_sent_at: "2026-09-10T02:00:00Z" },
        { created_at: "2026-09-11T00:00:00Z", quote_sent_at: "2026-09-11T06:00:00Z" },
        // Week of Mon 2026-09-14: one 1.25h quote -> rounds to 1.3.
        { created_at: "2026-09-14T00:00:00Z", quote_sent_at: "2026-09-14T01:15:00Z" },
      ],
      START,
    );
    expect(r.trend).toEqual([
      { week_start: "2026-09-07T00:00:00.000Z", median_hours: 4, count: 2 },
      { week_start: "2026-09-14T00:00:00.000Z", median_hours: 1.3, count: 1 },
    ]);
    expect(r.median_hours).toBe(2);
  });

  it("reports no median when nothing is in the window", () => {
    const r = computeQuoteLatency([], START);
    expect(r).toEqual({ median_hours: null, count: 0, trend: [] });
  });
});

describe("deal value precedence", () => {
  const START = Date.parse("2026-09-01T00:00:00Z");
  const base = mkDeal(1, "Booked Paid", "a@acme.com", "Corporate", "2026-09-05", 0);

  it("values a booked deal by its signed contract, then total, then subtotal", () => {
    const deals: DealRow[] = [
      { ...base, id: 1, signed_contract_total: 1000, total_with_tax: 900, subtotal_pretax: 800 },
      { ...base, id: 2, signed_contract_total: null, total_with_tax: 500, subtotal_pretax: 400 },
      { ...base, id: 3, signed_contract_total: null, total_with_tax: null, subtotal_pretax: 70 },
      { ...base, id: 4, signed_contract_total: null, total_with_tax: null, subtotal_pretax: null },
    ];
    const all = computeDealFunnel(deals, START).find((r) => r.profile === "__all__")!;
    expect(all.booked_value).toBe(1570);
    expect(all.quoted_value).toBe(1570);
  });

  it("does not count a quote that never booked in booked $", () => {
    const deals: DealRow[] = [
      { ...base, id: 1, stage: "Sent Quote", signed_contract_total: 300 },
      { ...base, id: 2, stage: "Booked Unpaid", signed_contract_total: 200 },
    ];
    const all = computeDealFunnel(deals, START).find((r) => r.profile === "__all__")!;
    expect(all.quoted_value).toBe(500);
    expect(all.booked_value).toBe(200);
  });
});

// --- display formatting --------------------------------------------------------

describe("display formatting", () => {
  it("links a thread when there is one, else searches the address, else the inbox", () => {
    expect(gmailLink("thr-1", "a@b.com")).toBe("https://mail.google.com/mail/u/0/#all/thr-1");
    expect(gmailLink(null, "a+x@b.com")).toBe(
      "https://mail.google.com/mail/u/0/#search/a%2Bx%40b.com",
    );
    expect(gmailLink(null, null)).toBe("https://mail.google.com/mail/u/0/#all");
  });

  it("labels ages in hours under two days, days after", () => {
    expect(ageLabel(null)).toBe("—");
    expect(ageLabel(0.4)).toBe("<1h");
    expect(ageLabel(47.4)).toBe("47h");
    expect(ageLabel(48)).toBe("2d");
  });

  it("shows whole dollars and a dash for a missing percentage", () => {
    expect(money(1234.6)).toBe("$1,235");
    expect(money(null)).toBe("$0");
    expect(pctLabel(null)).toBe("—");
    expect(pctLabel(33.3)).toBe("33.3%");
  });
});

function mkDeal(
  id: number,
  stage: string,
  email: string,
  eventType: string,
  createdDate: string,
  value: number,
): DealRow {
  return {
    id,
    stage,
    contact_email: email,
    event_type: eventType,
    created_at: `${createdDate}T12:00:00Z`,
    updated_at: `${createdDate}T12:00:00Z`,
    total_with_tax: value,
    subtotal_pretax: value,
    signed_contract_total: value,
  };
}
