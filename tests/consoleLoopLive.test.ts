// The Email campaigns console on the live loop tables (loopLive.ts) and its
// five writes (loopActions.ts). Pins that waiting-for-approval and held
// emails are told apart, that test counts come from what happened after each
// sent email, that a run without recorded limits says so instead of showing
// zeros, and that the API refuses anything but the five actions. Invented
// people and figures; crm-app is public.

import { describe, expect, it } from "vitest";
import { buildLoopLive, emptyLoop, limitsOf, outcomesOf, type LiveRows } from "@/lib/emailCampaignsPrototype/console/loopLive";
import { loopItems } from "@/lib/emailCampaignsPrototype/console/loop";
import { doneWords, rpcFor, saveOutcome } from "@/lib/emailCampaignsPrototype/console/loopActions";
import type { OutcomeEvent } from "@/lib/emailCampaignsPrototype/console/load";

// Tuesday 17 Nov 2026, 3pm in New York.
const NOW = new Date("2026-11-17T20:00:00Z");

const LIMITS = {
  sending: { daily_cap: 200, baseline_share: 0.2, max_live_approaches: 4, cold_enabled: true, apollo_credits_per_week: 0, unsubscribe_pause_share: 0.02 },
  audience: { hold_back_months: 6, never_email_addresses: ["a@x.test"], never_email_domains: [], min_days_before_event: 14 },
  copy: { never: ["No promo code."], suggestions: ["One ask."], allowed_offers: ["hot_chocolate_float_party"] },
  occasions: { approved_ask: [] },
  research: { linkedin_daily_cap: 40, linkedin_min_pause_seconds: 20 },
  scorer: { sha256: "x" },
};

const approach = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  family: "f",
  opener: "o",
  structure: "s",
  ask_type: "a",
  length_band: "short" as const,
  is_baseline: false,
  brief: `${id} brief`,
  created_by: "loop",
  created_at: "2026-11-15T00:00:00Z",
  origin: "research" as const,
  purpose: "Get a reply",
  why_tried: "Because",
  evidence: [{ source: "A study", url: "https://example.test", finding: "It worked" }],
  approved_at: null,
  approved_by: null,
  ...over,
});

const draft = (id: number, approach_id: string, status: "planned" | "held" | "sent" | "skipped", over: Record<string, unknown> = {}) => ({
  id,
  sequence_id: id,
  prospect_id: id,
  touch: 1,
  send_on: "2026-11-17",
  customer_type: "warm:corporate",
  approach_id,
  assigned_by: "thompson" as const,
  subject: "Hi",
  body: "x".repeat(50),
  status,
  skip_reason: status === "skipped" ? "event too close" : null,
  event_id: status === "sent" ? 900 + id : null,
  done_at: status === "sent" || status === "skipped" ? "2026-11-16T15:30:00Z" : null,
  send_slot: "before_lunch",
  judge_note: null,
  held_at: status === "held" ? "2026-11-17T14:00:00Z" : null,
  held_by: status === "held" ? "owner@example.test" : null,
  held_reason: status === "held" ? "Wrong name" : null,
  ...over,
});

function rows(over: Partial<LiveRows> = {}): LiveRows {
  return {
    runs: [{ week_start: "2026-11-16", created_at: "2026-11-16T04:15:00Z", memo: "m".repeat(40), decisions: { asks_for_alina: ["Raise the warm cap?"], new_approaches: [] }, score: {}, digest_sent_at: null, limits: LIMITS, occasions: { "warm:corporate": { target: { id: "holiday_party_season", name: "Holiday party season", aim: "2026-12-12" }, upcoming: [] } } }],
    arms: [
      { customer_type: "warm:corporate", approach_id: "holiday_letter", status: "live", since: "2026-11-15T00:00:00Z", reason: "baseline" },
      { customer_type: "warm:corporate", approach_id: "party_first", status: "live", since: "2026-11-15T00:00:00Z", reason: "new" },
      { customer_type: "cold:office_manager", approach_id: "cold_pilot_a", status: "live", since: "2026-11-15T00:00:00Z", reason: "baseline" },
    ],
    approaches: [
      approach("holiday_letter", { is_baseline: true, origin: "human", approved_at: "2026-11-15T00:00:00Z", approved_by: "loop" }),
      approach("party_first"),
      approach("cold_pilot_a", { is_baseline: true, origin: "human", approved_at: "2026-11-15T00:00:00Z", approved_by: "loop" }),
    ],
    drafts: [
      draft(1, "holiday_letter", "sent"),
      draft(2, "holiday_letter", "planned"),
      draft(3, "party_first", "planned"),
      draft(4, "party_first", "planned"),
      draft(5, "holiday_letter", "held"),
      draft(6, "cold_pilot_a", "planned", { customer_type: "cold:office_manager", send_slot: "slump" }),
    ],
    sent: [
      { sequence_id: 1, prospect_id: 1, touch: 1, send_on: "2026-11-16", customer_type: "warm:corporate", approach_id: "holiday_letter", subject: "Hi", done_at: "2026-11-16T15:30:00Z", event_id: 901, send_slot: "before_lunch" },
      { sequence_id: 7, prospect_id: 7, touch: 1, send_on: "2026-11-16", customer_type: "warm:corporate", approach_id: "holiday_letter", subject: "Hi", done_at: "2026-11-16T15:30:00Z", event_id: 907, send_slot: "late_morning" },
    ],
    sequences: [],
    controls: { paused_at: null, paused_by: null, pause_reason: null },
    views: [],
    estimates: [],
    ...over,
  };
}

const people = new Map([1, 2, 3, 4, 5, 6, 7].map((i) => [i, { name: `Person ${i}`, company: "Co", email: `p${i}@example.test` }]));
const outcomes: OutcomeEvent[] = [
  { id: 1, prospect_id: 1, event: "replied", at: "2026-11-16T18:00:00Z", mailbox: null },
  { id: 2, prospect_id: 1, event: "deal_created", at: "2026-11-16T19:00:00Z", mailbox: null },
  // Before the email went: not caused by it.
  { id: 3, prospect_id: 7, event: "replied", at: "2026-11-01T18:00:00Z", mailbox: null },
];
const ctx = {
  people,
  outcomes,
  sends: [{ id: 901, prospect_id: 1, at: "2026-11-16T15:30:00Z", mailbox: "jake@news.benjerryphilly.com", template: null, apollo: false }],
  deals: [{ contact_email: "P1@example.test", stage: "Booked Paid", created_at: "2026-11-16T20:00:00Z" }],
  mailboxes: [
    { address: "jake@news.benjerryphilly.com", daily_allowance: 5, frozen: false, frozen_reason: null, frozen_at: null, unverified_ration: null, unverified_ration_at: null, allowance_ceiling: null, wedding_daily_allowance: null },
    { address: "jacob@news.benjerryphilly.com", daily_allowance: 5, frozen: true, frozen_reason: "x", frozen_at: null, unverified_ration: null, unverified_ration_at: null, allowance_ceiling: null, wedding_daily_allowance: null },
    { address: "alana@phillyicecreamcatering.com", daily_allowance: 15, frozen: false, frozen_reason: null, frozen_at: null, unverified_ration: null, unverified_ration_at: null, allowance_ceiling: null, wedding_daily_allowance: null },
    { address: "alina@phillyicecreamcatering.com", daily_allowance: 30, frozen: false, frozen_reason: null, frozen_at: null, unverified_ration: null, unverified_ration_at: null, allowance_ceiling: null, wedding_daily_allowance: null },
  ],
};

describe("buildLoopLive", () => {
  const L = buildLoopLive(rows(), ctx, NOW);

  it("tells waiting-for-approval, held and sent emails apart", () => {
    const by = Object.fromEntries(L.drafts.map((d) => [d.id, d]));
    expect(by["3"].waitingApproval).toBe(true);
    expect(by["2"].waitingApproval).toBe(false);
    expect(by["5"].held).toEqual({ at: "2026-11-17T14:00:00Z", by: "owner@example.test", reason: "Wrong name" });
    expect(by["1"].mailbox).toBe("jake@news.benjerryphilly.com");
    expect(by["6"].mailbox).toMatch(/cold mailbox/);
    expect(L.approvals).toEqual([{ approachId: "party_first", n: 2 }]);
  });

  it("raises one approval item per waiting approach, and no sender alarm for them", () => {
    const items = loopItems(L);
    expect(items.filter((i) => i.id.startsWith("loop:approve:")).map((i) => i.title)).toEqual(["2 emails wait for your approval of “Party first”"]);
    // Planned and approved, due this morning, still waiting at 3pm: the sender missed it.
    expect(items.find((i) => i.id === "loop:sender")?.title).toMatch(/sent nothing today: 1 emails waiting/);
  });

  it("stays quiet about the sender once anything went out today, and flags a backlog instead", () => {
    const busy = buildLoopLive(
      rows({
        drafts: [
          draft(1, "holiday_letter", "sent", { done_at: "2026-11-17T15:30:00Z" }),
          ...Array.from({ length: 120 }, (_, i) => draft(100 + i, "holiday_letter", "planned")),
        ],
      }),
      ctx,
      NOW,
    );
    const items = loopItems(busy);
    expect(items.some((i) => i.id === "loop:sender")).toBe(false);
    // Tuesday 3pm: Wednesday to Friday left, 20 a day of room.
    expect(items.find((i) => i.id === "loop:backlog")?.title).toBe("120 emails waiting, room for about 60 by Friday");
  });

  it("counts a reply, lead and booking only when they came after the email", () => {
    const warm = L.tests.find((t) => t.id === "warm_first_email")!;
    const letter = warm.arms.find((a) => a.approachId === "holiday_letter")!;
    expect(letter.sends).toBe(2);
    expect(letter.reply.k).toBe(1);
    expect(letter.lead.k).toBe(1);
    expect(letter.booking.k).toBe(1);
    expect(letter.verdict).toBe("baseline");
    const slot = L.tests.find((t) => t.id === "send_time")!;
    expect(slot.arms.map((a) => [a.approachId, a.sends])).toEqual([
      ["late_morning", 1],
      ["before_lunch", 1],
      ["slump", 0],
    ]);
  });

  it("reads the limits and occasions the run recorded", () => {
    expect(L.limitsRecorded).toBe(true);
    expect(L.limits.dailyCap).toBe(200);
    expect(L.limits.never).toEqual(["No promo code."]);
    expect(L.limits.allowedOffers).toEqual(["Hot Chocolate Float Party"]);
    expect(L.limits.neverEmail).toBe(1);
    expect(L.types.find((t) => t.key === "warm:corporate")?.target?.name).toBe("Holiday party season");
    expect(L.run?.asks.map((a) => a.text)).toEqual(["Raise the warm cap?"]);
  });

  it("counts room from the lane's healthy mailboxes, owner left out", () => {
    expect(L.volume.warm.room).toBe(25);
    expect(L.volume.cold.room).toBe(75);
  });

  it("shows a pause, and says when limits were not recorded", () => {
    const P = buildLoopLive(
      rows({
        controls: { paused_at: "2026-11-17T13:00:00Z", paused_by: "owner@example.test", pause_reason: "Checking copy" },
        runs: [{ ...rows().runs[0], limits: null, occasions: null }],
      }),
      ctx,
      NOW,
    );
    expect(P.paused).toEqual({ since: "2026-11-17T13:00:00Z", by: "owner@example.test", why: "Checking copy" });
    expect(P.limitsRecorded).toBe(false);
    expect(loopItems(P).some((i) => i.id === "loop:sender")).toBe(false);
  });
});

describe("limitsOf and outcomesOf", () => {
  it("returns null for a run with no recorded limits", () => {
    expect(limitsOf(null)).toBeNull();
    expect(limitsOf({})).toBeNull();
  });
  const sentTo1 = [{ sequence_id: 1, prospect_id: 1, touch: 1, send_on: "2026-11-16", customer_type: "warm:x", approach_id: "a", subject: "s", done_at: "2026-11-16T15:00:00Z", event_id: 1 }];
  it("matches a booking to the email's person whatever the case of either address", () => {
    const o = outcomesOf(sentTo1, [], [{ contact_email: "p1@EXAMPLE.test", stage: "Booked Unpaid", created_at: "2026-11-17T00:00:00Z" }], new Map([[1, "P1@example.test"]]));
    expect(o).toEqual([{ reply: false, lead: false, booking: true }]);
  });
  it("counts no booking made before the send, and no deal that is not booked", () => {
    const o = outcomesOf(
      sentTo1,
      [],
      [
        { contact_email: "p1@example.test", stage: "Booked Unpaid", created_at: "2026-11-10T00:00:00Z" },
        { contact_email: "p1@example.test", stage: "Lead", created_at: "2026-11-17T00:00:00Z" },
      ],
      new Map([[1, "p1@example.test"]]),
    );
    expect(o).toEqual([{ reply: false, lead: false, booking: false }]);
  });
});

describe("emptyLoop", () => {
  it("says why and raises nothing but the missing run", () => {
    const E = emptyLoop(NOW, "The loop's tables are not readable yet.");
    expect(E.unavailable).toMatch(/not readable/);
    expect(loopItems(E).map((i) => i.id)).toEqual(["loop:run"]);
  });
});

describe("rpcFor and doneWords", () => {
  it("maps each of the five actions to its function", () => {
    expect(rpcFor({ action: "approve", approach: "party_first" })).toEqual({ fn: "outreach_loop_approve", args: { p_approach: "party_first" } });
    expect(rpcFor({ action: "hold", draft: 12, reason: "  Wrong name  " })).toEqual({ fn: "outreach_loop_hold", args: { p_draft: 12, p_reason: "Wrong name" } });
    expect(rpcFor({ action: "release", draft: 12 })).toEqual({ fn: "outreach_loop_release", args: { p_draft: 12 } });
    expect(rpcFor({ action: "pause", reason: "x" })).toEqual({ fn: "outreach_loop_pause", args: { p_reason: "x" } });
    expect(rpcFor({ action: "resume" })).toEqual({ fn: "outreach_loop_resume", args: {} });
  });
  it("refuses anything else", () => {
    expect(rpcFor({ action: "approve", approach: "Robert'); drop table--" })).toBeNull();
    expect(rpcFor({ action: "hold", draft: "12" })).toBeNull();
    expect(rpcFor({ action: "release", draft: -1 })).toBeNull();
    expect(rpcFor({ action: "send" })).toBeNull();
    expect(rpcFor(null)).toBeNull();
  });
  it("tells the manager what each saved action does to the sending", () => {
    expect(doneWords({ action: "approve", approach: "x" })).toMatch(/^Approved\..*go out in their next send times/);
    expect(doneWords({ action: "hold", draft: 1, reason: "" })).toMatch(/^Held\..*will not send unless you release it/);
    expect(doneWords({ action: "release", draft: 1 })).toMatch(/^Released\..*goes out in its next send time/);
    expect(doneWords({ action: "pause", reason: "" })).toMatch(/^Paused\..*sends nothing until you resume/);
    expect(doneWords({ action: "resume" })).toMatch(/^Resumed\..*picks up at its next send time/);
  });
});

describe("saveOutcome", () => {
  const resume = { action: "resume" } as const;
  const answer = (ok: boolean, redirected = false, statusText = "") => ({ ok, redirected, statusText });
  it("counts an action saved only on the route's own {ok: true}", () => {
    expect(saveOutcome(resume, answer(true), { ok: true })).toEqual({ saved: true, words: "Resumed. The sender picks up at its next send time." });
  });
  it("is not saved when a lapsed login answers with the sign-in page (a redirected 200)", () => {
    expect(saveOutcome(resume, answer(true, true), {})).toEqual({ saved: false, words: "Not saved: you are signed out. Sign in again and retry." });
  });
  it("is not saved on a 200 that is not the route's {ok: true}", () => {
    expect(saveOutcome(resume, answer(true), {})).toEqual({ saved: false, words: "Not saved: no answer from the server" });
  });
  it("says the route's own refusal when it gives one", () => {
    expect(saveOutcome(resume, answer(false, false, "Forbidden"), { error: "permission denied" })).toEqual({ saved: false, words: "Not saved: permission denied" });
  });
  it("falls back to the HTTP status text when the route gives no reason", () => {
    expect(saveOutcome(resume, answer(false, false, "Bad Gateway"), {})).toEqual({ saved: false, words: "Not saved: Bad Gateway" });
  });
});

// --- review answers (PR 160): one mailbox rule each, the real DST switch,
// and lane-named sales items kept on the console's sales panel.
import { etInstant } from "@/lib/emailCampaignsPrototype/console/loopLive";
import { handLane, loopLane } from "@/lib/emailCampaignsPrototype/console/mailboxLanes";
import { consoleItems, type AttentionItem } from "@/lib/emailCampaignsPrototype/console/attention";

describe("etInstant", () => {
  it("follows New York's real daylight-time switch, not the month", () => {
    // Daylight time 2026: 8 March to 1 November.
    expect(etInstant("2026-03-06", "10:30")).toBe("2026-03-06T15:30:00.000Z");
    expect(etInstant("2026-03-09", "10:30")).toBe("2026-03-09T14:30:00.000Z");
    expect(etInstant("2026-10-30", "15:00")).toBe("2026-10-30T19:00:00.000Z");
    expect(etInstant("2026-11-02", "15:00")).toBe("2026-11-02T20:00:00.000Z");
  });
});

describe("mailbox lanes", () => {
  it("names the loop's own mailboxes as the sender does, owner left out", () => {
    expect(loopLane("jake@news.benjerryphilly.com")).toBe("warm");
    expect(loopLane("Alana@PhillyIceCreamCatering.com")).toBe("cold");
    expect(loopLane("alina@phillyicecreamcatering.com")).toBeNull();
    expect(loopLane("catering@benjerryphilly.com")).toBeNull();
  });
  it("puts every benjerryphilly domain in the warm hand-run lane", () => {
    expect(handLane("benjerryphilly.com")).toBe("warm");
    expect(handLane("news.benjerryphilly.com")).toBe("warm");
    expect(handLane("phillyicecreamcatering.com")).toBe("cold");
    expect(handLane("News.BenJerryPhilly.com")).toBe("warm");
  });
});

describe("consoleItems", () => {
  const base = { level: "warning", area: "Cold", pathLabel: "Lanes › Cold", openedAt: null, stale: false, fixes: ["x"], affects: [], detail: "" } as const;
  it("keeps a lane-named sales alert on the sales panel and drops the lane's own rules", () => {
    const items = [
      { ...base, id: "a", rule: "sales_alert", title: "Cold sent 0", path: ["lanes", "cold", "sales"], home: { kind: "lane", lane: "cold" } },
      { ...base, id: "b", rule: "step_no_copy", title: "Step 2", path: ["lanes", "cold", "step:2"], home: { kind: "lane", lane: "cold" } },
      { ...base, id: "c", rule: "reply_aging", title: "Reply", path: ["replies"], home: { kind: "reply", id: "1" } },
    ] as unknown as AttentionItem[];
    const out = consoleItems(items);
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
    expect(out[0].path).toEqual(["sales", "cold", "sales"]);
    expect(out[0].home).toEqual({ kind: "sales" });
  });
});
