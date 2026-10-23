// The amount format the /money transaction table and the change-category
// dialog share (lib/pf/format.ts, bj-finance #223): dollars to the cent, with
// a true minus sign (U+2212) rather than a hyphen.

import { describe, expect, it } from "vitest";
import { fmt2 } from "@/lib/pf/format";

describe("fmt2", () => {
  it("shows a charge with a true minus sign, thousands grouped, to the cent", () => {
    expect(fmt2(-1234.5)).toBe("−$1,234.50");
  });

  it("shows money in without a sign", () => {
    expect(fmt2(1234567)).toBe("$1,234,567.00");
  });

  it("rounds to the cent", () => {
    expect(fmt2(-12.346)).toBe("−$12.35");
    expect(fmt2(0.5)).toBe("$0.50");
  });
});
