// PROTOTYPE (bj-finance #811): the console's sales lane numbers
// (metrics_snapshots kind 'sales_lanes'). Pins that a null number stays
// "not measured" (never 0), that a payload breaking the contract is refused
// whole, the states before and after a build, and the badges the numbers raise
// through attentionItems(). Invented figures; crm-app is public.

import { describe, expect, it } from "vitest";
import { buildFacts } from "@/lib/emailCampaignsPrototype/console/facts";
import { attentionItems } from "@/lib/emailCampaignsPrototype/console/attention";
import { syntheticData } from "@/lib/emailCampaignsPrototype/console/synthetic";
import { emptyState } from "@/lib/emailCampaignsPrototype/sharedSequences";
import {
  alertLane,
  buildSalesLanes,
  parseSalesLanes,
  perDay7,
  salesLanesFixture,
  type SalesLanesData,
} from "@/lib/emailCampaignsPrototype/console/salesLanes";

// Friday Nov 13 2026, 4pm in New York.
const NOW = new Date("2026-11-13T21:00:00Z");

const payload = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  as_of: "2026-11-13T11:00:00Z",
  period: "2026-11-12",
  since: "2026-08-01",
  lanes: [
    {
      lane: "cold",
      target_daily_sends: 100,
      yesterday: { sent: 0 },
      last_7d: { sent: 0 },
      month_to_date: { sent: 0, booked: 0 },
      since_start: { sent: null, delivered: 300, opened: 20, opened_human: 7, replied: 1, booked: 0 },
    },
    { lane: "warm", target_daily_sends: 25, yesterday: {}, last_7d: { sent: 140 }, month_to_date: {}, since_start: {} },
  ],
  mailboxes: [],
  offers: [{ offer: "holiday_gift_2030", sent: 10, opened: 4, opened_human: 1, clicked: 1, replied: 1, open_deal_ids: [90001], booked_deal_ids: [] }],
  alerts: [{ severity: "red", text: "Cold sent 0 emails in the last 7 days; target is 100 a day" }],
  sources: { imap_alina: "ok", apollo: "error: 401 from Apollo" },
  ...over,
});

const read = (p: unknown, builtAt = "2026-11-13T11:05:00Z"): SalesLanesData =>
  buildSalesLanes({ status: "read", row: { period: "2026-11-12", built_at: builtAt, payload: p } }, NOW);

function itemsWith(sales: SalesLanesData) {
  const { raw, extras } = syntheticData(NOW);
  return attentionItems(buildFacts(raw, extras, emptyState(), NOW, sales));
}

describe("reading the sales lane numbers", () => {
  it("keeps a null or missing number as not measured, never 0", () => {
    const s = parseSalesLanes(payload())!;
    const cold = s.lanes[0];
    expect(cold.sinceStart.sent).toBeNull();
    expect(cold.sinceStart.delivered).toBe(300);
    expect(cold.sinceStart.openedByPerson).toBe(7);
    expect(cold.sinceStart.deals).toBeNull(); // missing key
    expect(cold.monthToDate.booked).toBe(0);
  });

  it("names each source that could not be read, and leaves out the ones that were", () => {
    expect(parseSalesLanes(payload())!.sourceProblems).toEqual([{ source: "apollo", detail: "401 from Apollo" }]);
  });

  it("refuses a payload of another schema, or one with a number that is not a number, or an alert outside red and amber", () => {
    expect(parseSalesLanes(payload({ schema: 2 }))).toBeNull();
    expect(parseSalesLanes({ ...payload(), schema: undefined })).toBeNull();
    const bad = payload();
    (bad.lanes[0].since_start as Record<string, unknown>).replied = "1";
    expect(parseSalesLanes(bad)).toBeNull();
    expect(parseSalesLanes(payload({ alerts: [{ severity: "green", text: "fine" }] }))).toBeNull();
    expect(parseSalesLanes(payload({ offers: [{ offer: "x", open_deal_ids: ["25523"] }] }))).toBeNull();
  });

  it("works out emails a day over 7 days, and leaves it unmeasured when the week is", () => {
    const s = parseSalesLanes(payload())!;
    expect(perDay7(s.lanes[1])).toBe(20);
    expect(perDay7({ ...s.lanes[1], last7d: { ...s.lanes[1].last7d, sent: null } })).toBeNull();
  });

  it("is empty with no row, stale when built before today in New York, unrecognised when unreadable as schema 1", () => {
    expect(buildSalesLanes({ status: "read", row: null }, NOW)).toEqual({ status: "empty" });
    const today = read(payload());
    expect(today.status === "ok" && today.stale).toBe(false);
    // 11:30pm Nov 12 in New York, though already Nov 13 in UTC.
    const lastNight = read(payload(), "2026-11-13T04:30:00Z");
    expect(lastNight.status === "ok" && lastNight.stale).toBe(true);
    expect(read({ schema: 7 })).toEqual({ status: "unrecognised", builtAt: "2026-11-13T11:05:00Z" });
  });

  it("homes an alert on the lane its words start with", () => {
    expect(alertLane("Cold sent 0 emails in the last 7 days")).toBe("cold");
    expect(alertLane("Warm: wedding has nobody up next")).toBe("wedding");
    expect(alertLane("Holiday Gift: 3 deals waiting")).toBe("offer");
    expect(alertLane("Warm reply rate fell")).toBe("warm");
    expect(alertLane("Coldplay tickets")).toBeNull();
    expect(alertLane("Instagram spend has no bookings")).toBeNull();
  });
});

describe("the badges the sales numbers raise", () => {
  it("a red alert is a warning on the lane it names, and bubbles under lanes", () => {
    const item = itemsWith(read(payload())).find((i) => i.rule === "sales_alert")!;
    expect(item.level).toBe("warning");
    expect(item.path).toEqual(["lanes", "cold", "sales"]);
    expect(item.home).toEqual({ kind: "lane", lane: "cold" });
    expect(item.title).toBe("Cold sent 0 emails in the last 7 days; target is 100 a day");
  });

  it("an alert naming no lane lives in the sales numbers panel, an amber one as a caution", () => {
    const item = itemsWith(read(payload({ alerts: [{ severity: "amber", text: "Instagram spend $400 with no booking" }] }))).find(
      (i) => i.rule === "sales_alert",
    )!;
    expect(item.level).toBe("caution");
    expect(item.path).toEqual(["sales"]);
    expect(item.area).toBe("Sales");
  });

  it("an offer with open deals is one Ready item, however many deals", () => {
    const offers = [{ offer: "holiday_gift_2030", open_deal_ids: [90001, 90002], booked_deal_ids: [] }];
    const found = itemsWith(read(payload({ offers }))).filter((i) => i.rule === "offer_deal_open");
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("ready");
    expect(found[0].title).toBe("2 Holiday Gift 2030 deals open");
    expect(found[0].detail).toBe("Deal #90001, #90002: not booked yet.");
  });

  it("no numbers built yet raises nothing; numbers not built today, or not readable, raise one caution", () => {
    const sales = (d: SalesLanesData) => itemsWith(d).filter((i) => i.rule.startsWith("sales") || i.rule === "offer_deal_open");
    expect(sales({ status: "empty" })).toEqual([]);
    const stale = sales(read({ ...payload(), alerts: [], offers: [] }, "2026-11-11T11:00:00Z"));
    expect(stale.map((i) => [i.rule, i.level])).toEqual([["sales_not_current", "caution"]]);
    expect(stale[0].title).toBe("Sales numbers were last built Nov 11");
    expect(sales({ status: "unreadable", message: "permission denied" }).map((i) => i.title)).toEqual(["Cannot read the sales numbers"]);
  });

  it("a stopped mailbox's item says what it sent yesterday against its lane's daily target", () => {
    const fixture = read(salesLanesFixture(NOW));
    const frozen = itemsWith(fixture).find((i) => i.id.startsWith("frozen:") && i.detail.includes("Cold target"));
    expect(frozen?.detail).toMatch(/Sent yesterday: 0; Cold target 100 a day$/);
  });
});
