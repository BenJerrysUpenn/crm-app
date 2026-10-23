// Deal timestamps stored as naive UTC read as UTC, whatever the browser's time
// zone (crm-app "Last outbound" reads 4 hours late).
//
// Catering-Manager's db.now_iso() and the CRM's own nowIso() (lib/callDesk/
// dealForm.ts) write deals.last_outbound_at, created_at and updated_at as UTC
// with no offset ("2026-10-22T19:17:14"), and thread_messages.sent_at is the
// Date header normalised to naive UTC. `new Date()` reads such a string as the
// machine's local time, so in an Eastern browser a 3:17 PM send showed as
// 7:17 PM. Strings with a Z or an offset, and bare dates and times, keep the
// meaning they had.
//
// Every case runs under several machine time zones (process.env.TZ is switched
// per block), so the suite means the same on an Eastern laptop and a UTC CI box.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import DealCard from "@/components/DealCard";
import DealDetailDrawer from "@/components/DealDetailDrawer";
import { daysSince, formatFollowupDate, lastOutboundChipText } from "@/lib/boomerang";
import {
  fmtEasternDate,
  fmtEasternDateTime,
  fmtEasternTime,
  fmtNaiveUtcDateTime,
  parseNaiveUtc,
} from "@/lib/dateFormat";
import type { Deal } from "@/lib/types";

// The Supabase browser client is the system boundary; a static first render
// (no effects run) never calls it.
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const MACHINE_ZONES = ["America/New_York", "UTC", "America/Los_Angeles", "Asia/Kolkata"];

function mkDeal(overrides: Partial<Deal> = {}): Deal {
  const base: Partial<Deal> = {
    id: 1,
    stage: "Quote Sent",
    company: "Synthetic Co",
    contact_first_name: "Test",
    contact_last_name: "Person",
    event_date: null,
    guest_count: null,
    total_with_tax: null,
    payment_status: "Unpaid",
    last_outbound_at: null,
  };
  return { ...base, ...overrides } as Deal;
}

for (const zone of MACHINE_ZONES) {
  describe(`machine time zone ${zone}`, () => {
    const saved = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = zone;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });

    describe("parseNaiveUtc", () => {
      it("reads a naive date-time as UTC", () => {
        expect(parseNaiveUtc("2026-10-22T19:17:14")?.toISOString()).toBe(
          "2026-10-22T19:17:14.000Z",
        );
      });

      it("reads the space-separated and fractional naive shapes as UTC", () => {
        expect(parseNaiveUtc("2026-05-19 02:41:28")?.toISOString()).toBe(
          "2026-05-19T02:41:28.000Z",
        );
        expect(parseNaiveUtc("2026-05-21T20:33:14.846462")?.toISOString()).toBe(
          "2026-05-21T20:33:14.846Z",
        );
        expect(parseNaiveUtc("2026-10-22T19:17")?.toISOString()).toBe(
          "2026-10-22T19:17:00.000Z",
        );
      });

      it("leaves a string with Z or an offset as it was", () => {
        const cases: [string, string][] = [
          ["2026-10-22T14:42:25.311Z", "2026-10-22T14:42:25.311Z"],
          ["2026-05-22T12:33:35Z", "2026-05-22T12:33:35.000Z"],
          ["2026-09-10 02:52:13.632291+00", "2026-09-10T02:52:13.632Z"],
          ["2026-10-22T15:17:14-04:00", "2026-10-22T19:17:14.000Z"],
        ];
        for (const [stored, instant] of cases) {
          expect(parseNaiveUtc(stored)?.toISOString()).toBe(instant);
        }
      });

      it("leaves a bare date as it was, and answers null for nothing or junk", () => {
        // A bare ISO date is UTC midnight, as `new Date()` has always read it.
        expect(parseNaiveUtc("2026-05-07")?.toISOString()).toBe("2026-05-07T00:00:00.000Z");
        expect(parseNaiveUtc(null)).toBeNull();
        expect(parseNaiveUtc("")).toBeNull();
        expect(parseNaiveUtc("not a date")).toBeNull();
      });
    });

    describe("fmtNaiveUtcDateTime", () => {
      it("shows a naive UTC send at its Eastern time", () => {
        // A send at 3:17 PM ET, stored 19:17:14.
        expect(fmtNaiveUtcDateTime("2026-10-22T19:17:14")).toBe("Oct 22, 2026, 3:17 PM");
        // A send at 7:33 PM ET, stored 23:33:32.
        expect(fmtNaiveUtcDateTime("2026-10-21T23:33:32")).toBe("Oct 21, 2026, 7:33 PM");
      });

      it("puts a send after 8 PM Eastern on the Eastern day, not the UTC one", () => {
        expect(fmtNaiveUtcDateTime("2026-10-23T03:30:00")).toBe("Oct 22, 2026, 11:30 PM");
      });

      it("follows daylight saving time", () => {
        // Standard time: UTC-5.
        expect(fmtNaiveUtcDateTime("2026-12-01T20:00:00")).toBe("Dec 1, 2026, 3:00 PM");
        // Spring forward, 2026-03-08 at 2 AM EST (07:00 UTC).
        expect(fmtNaiveUtcDateTime("2026-03-08T06:30:00")).toBe("Mar 8, 2026, 1:30 AM");
        expect(fmtNaiveUtcDateTime("2026-03-08T07:30:00")).toBe("Mar 8, 2026, 3:30 AM");
        // Fall back, 2026-11-01 at 2 AM EDT (06:00 UTC): both read 1:30 AM.
        expect(fmtNaiveUtcDateTime("2026-11-01T05:30:00")).toBe("Nov 1, 2026, 1:30 AM");
        expect(fmtNaiveUtcDateTime("2026-11-01T06:30:00")).toBe("Nov 1, 2026, 1:30 AM");
      });

      it("shows a Z or offset value at the Eastern time of the instant it names", () => {
        const cases: [string, string][] = [
          ["2026-10-22T14:42:25.311Z", "Oct 22, 2026, 10:42 AM"],
          ["2026-09-10 02:52:13.632291+00", "Sep 9, 2026, 10:52 PM"],
          ["2026-10-22T15:17:14-04:00", "Oct 22, 2026, 3:17 PM"],
        ];
        for (const [stored, shown] of cases) {
          expect(fmtNaiveUtcDateTime(stored)).toBe(shown);
          expect(fmtEasternDateTime(stored)).toBe(shown);
        }
      });

      it("leaves a bare date, nothing, and junk as before", () => {
        // UTC midnight on May 7 is 8 PM Eastern on May 6, as fmtEasternDateTime shows it.
        expect(fmtNaiveUtcDateTime("2026-05-07")).toBe("May 6, 2026, 8:00 PM");
        expect(fmtEasternDateTime("2026-05-07")).toBe("May 6, 2026, 8:00 PM");
        expect(fmtNaiveUtcDateTime(null)).toBe("");
        expect(fmtNaiveUtcDateTime("not a date")).toBe("not a date");
      });
    });

    describe("event dates and times stay Eastern wall-clock", () => {
      it("does not shift a bare date or a bare time", () => {
        expect(fmtEasternDate("2026-10-22")).toBe("Oct 22, 2026");
        expect(fmtEasternDate("2026-03-08")).toBe("Mar 8, 2026");
        expect(fmtEasternDate("2026-11-01")).toBe("Nov 1, 2026");
        expect(fmtEasternTime("15:17")).toBe("3:17 PM");
        expect(fmtEasternTime("00:05:00")).toBe("12:05 AM");
      });
    });

    describe("the Last outbound card line", () => {
      it("formatFollowupDate shows the Eastern time", () => {
        expect(formatFollowupDate("2026-10-22T19:17:14")).toBe("Oct 22, 2026, 3:17 PM");
        expect(formatFollowupDate(null)).toBe("never");
      });

      it("the card's hover shows the Eastern time", () => {
        const html = renderToStaticMarkup(
          createElement(DealCard, {
            deal: mkDeal({ last_outbound_at: "2026-10-22T19:17:14" }),
            dragging: true,
          }),
        );
        expect(html).toContain("Oct 22, 2026, 3:17 PM");
        expect(html).not.toContain("7:17 PM");
      });
    });

    describe("the deal drawer's Pipeline rows", () => {
      it("show Last outbound, Created and Updated at their Eastern times", () => {
        const html = renderToStaticMarkup(
          createElement(DealDetailDrawer, {
            deal: mkDeal({
              last_outbound_at: "2026-10-22T19:17:14",
              created_at: "2026-10-01T13:05:00",
              updated_at: "2026-10-23T03:30:00",
            }),
            onClose: () => {},
          }),
        );
        const row = (label: string, value: string) =>
          new RegExp(`>${label}</div><div[^>]*>${value}</div>`);
        expect(html).toMatch(row("Last outbound", "Oct 22, 2026, 3:17 PM"));
        expect(html).toMatch(row("Created", "Oct 1, 2026, 9:05 AM"));
        expect(html).toMatch(row("Updated", "Oct 22, 2026, 11:30 PM"));
      });
    });

    describe("daysSince counts Eastern calendar days", () => {
      const at = (iso: string) => new Date(iso);

      it("a send earlier the same Eastern day is today", () => {
        // 3:17 PM ET send, read at 11 PM ET the same day.
        const now = at("2026-10-23T03:00:00Z");
        expect(daysSince("2026-10-22T19:17:14", now)).toBe(0);
        expect(lastOutboundChipText(mkDeal({ last_outbound_at: "2026-10-22T19:17:14" }), now)).toBe(
          "today",
        );
      });

      it("a send at 11:30 PM ET read at 9 AM ET next morning is 1d", () => {
        // Stored 03:30 UTC on the 23rd: the UTC day matches "today", the Eastern one does not.
        const now = at("2026-10-23T13:00:00Z");
        expect(daysSince("2026-10-23T03:30:00", now)).toBe(1);
        expect(lastOutboundChipText(mkDeal({ last_outbound_at: "2026-10-23T03:30:00" }), now)).toBe(
          "1d",
        );
      });

      it("a send at 3:17 PM ET read at 12:30 AM ET the next day is 1d", () => {
        const now = at("2026-10-23T04:30:00Z");
        expect(daysSince("2026-10-22T19:17:14", now)).toBe(1);
      });

      it("counts across the spring-forward and fall-back nights", () => {
        // Mar 7 11:30 PM EST to Mar 8 11:30 PM EDT: 23 hours, one day.
        expect(daysSince("2026-03-08T04:30:00", at("2026-03-09T03:30:00Z"))).toBe(1);
        // Oct 31 11:30 PM EDT to Nov 1 11:30 PM EST: 25 hours, one day.
        expect(daysSince("2026-11-01T03:30:00", at("2026-11-02T04:30:00Z"))).toBe(1);
      });

      it("reads a Z value as the same instant", () => {
        const now = at("2026-10-23T13:00:00Z");
        expect(daysSince("2026-10-23T03:30:00.000Z", now)).toBe(1);
        expect(daysSince("2026-10-22T19:17:14Z", now)).toBe(1);
      });

      it("is negative for a future stamp and null for nothing or junk", () => {
        expect(daysSince("2026-10-25T16:00:00", at("2026-10-23T13:00:00Z"))).toBe(-2);
        expect(daysSince(null, at("2026-10-23T13:00:00Z"))).toBeNull();
        expect(daysSince("junk", at("2026-10-23T13:00:00Z"))).toBeNull();
        expect(lastOutboundChipText(mkDeal({ last_outbound_at: null }))).toBe("never");
      });

      it("counts a week as 7", () => {
        expect(daysSince("2026-10-15T19:17:14", at("2026-10-22T14:00:00Z"))).toBe(7);
      });
    });
  });
}
