// Funnel stage membership (bj-finance #422): which pipeline stages count as
// having reached "quoted" and "booked". Cumulative, not point-in-time: a deal
// that booked also reached quoted. The expectations below are the spec's
// literal answer per stage, not a copy of the sets in lib/stages.ts.

import { describe, expect, it } from "vitest";
import { reachedBooked, reachedQuoted, STAGES } from "@/lib/stages";

// stage -> [reached quoted, reached booked]
const EXPECTED: Record<(typeof STAGES)[number], [boolean, boolean]> = {
  Open: [false, false],
  "Quote Review": [false, false], // drafted, not yet sent: not a quote yet
  "Sent Quote": [true, false],
  "Booked Unpaid": [true, true],
  "Booked Paid": [true, true],
  "Event Complete": [true, true],
  "Closed Lost": [false, false],
  "Closed Below Min": [false, false],
  "Closed Marketing Event": [false, false],
};

describe("funnel stage membership", () => {
  it.each(STAGES.map((s) => [s, ...EXPECTED[s]] as const))(
    "%s: reached quoted %s, reached booked %s",
    (stage, quoted, booked) => {
      expect(reachedQuoted(stage)).toBe(quoted);
      expect(reachedBooked(stage)).toBe(booked);
    },
  );

  it("treats an unknown stage as reaching neither", () => {
    expect(reachedQuoted("Quoted")).toBe(false);
    expect(reachedBooked("booked paid")).toBe(false);
  });
});
