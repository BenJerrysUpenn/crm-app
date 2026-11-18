// The Email campaigns console on the live loop tables (loopLive.ts) and its
// five writes (loopActions.ts). Pins that waiting-for-approval and held
// emails are told apart, that test counts come from what happened after each
// sent email, that a run without recorded limits says so instead of showing
// zeros, that the API refuses anything but the five actions, and that a
// save reloads to the same place with its dialog closed. Also renders the
// loop panels (LoopBits) on those facts to pin what staff read there.
// Invented people and figures; crm-app is public.

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApproachBody, EmailBody, EmailsBody, TypeBody, WeekBody } from "@/components/emailCampaignsPrototype/console/LoopBits";
import type { LoopFacts } from "@/lib/emailCampaignsPrototype/console/loop";
import { buildLoopLive, emptyLoop, limitsOf, outcomesOf, type LiveRows } from "@/lib/emailCampaignsPrototype/console/loopLive";
import { loopItems, withHistory } from "@/lib/emailCampaignsPrototype/console/loop";
import { doneWords, reloadUrl, rpcFor, saveOutcome } from "@/lib/emailCampaignsPrototype/console/loopActions";
import { navQuery } from "@/lib/emailCampaignsPrototype/console/nav";
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

// Where the page reloads to after a save (so every panel redraws from the
// database): the same place, with the dialog or form that saved closed.
describe("reloadUrl", () => {
  const BASE = "https://crm.example.test/email-campaigns";

  it("closes the approve dialog and keeps the panel, email and tab", () => {
    expect(reloadUrl(`${BASE}?panel=emails&sel=email%3A165&modal=approve%3Aparty_first&tab=a%3Aparty_first`)).toBe(
      `${BASE}?panel=emails&sel=email%3A165&tab=a%3Aparty_first`,
    );
  });

  it("closes the hold form and keeps the panel and email", () => {
    expect(reloadUrl(`${BASE}?panel=emails&sel=email%3A7&layer=flag`)).toBe(`${BASE}?panel=emails&sel=email%3A7`);
  });

  it("closes the add-step form with the Edit lane layer", () => {
    expect(reloadUrl(`${BASE}?panel=lane%3Awarm&layer=editlane&add=step`)).toBe(`${BASE}?panel=lane%3Awarm`);
  });

  it("leaves a place with nothing open exactly as it was, filter included", () => {
    expect(reloadUrl(`${BASE}?panel=loop&dim=1`)).toBe(`${BASE}?panel=loop&dim=1`);
  });
});

// Every console navigation builds its query string with navQuery.
describe("navQuery", () => {
  const q = (s: string) => new URLSearchParams(s);

  it("keeps the add-step form open inside Edit lane", () => {
    expect(navQuery(q(""), { panel: "lane:warm", layer: "editlane", add: "step" }).toString()).toBe("panel=lane%3Awarm&layer=editlane&add=step");
  });

  it("drops the add-step form when the layer is anything but Edit lane", () => {
    expect(navQuery(q(""), { panel: "lane:warm", layer: "flag", add: "step" }).toString()).toBe("panel=lane%3Awarm&layer=flag");
  });

  it("replaces the old place and keeps query keys that are not console state", () => {
    expect(navQuery(q("scenario=quiet&panel=loop&modal=pause"), { panel: "emails" }).toString()).toBe("scenario=quiet&panel=emails");
  });
});

describe("test start dates", () => {
  it("are the day each test began, which the panels' date formatter reads (a timestamp crashed every test panel, 2026-11-18)", () => {
    const L = buildLoopLive(rows(), ctx, NOW);
    expect(Object.fromEntries(L.tests.map((t) => [t.id, t.started]))).toEqual({
      warm_first_email: "2026-11-15",
      cold_first_email: "2026-11-15",
      send_time: "2026-11-16",
    });
  });
});

describe("withHistory", () => {
  it("counts a hand-sent history in one test only, the first that has its approach", () => {
    const L = buildLoopLive(
      rows({ arms: [...rows().arms, { customer_type: "offer:corporate", approach_id: "holiday_letter", status: "live", since: "2026-11-15T00:00:00Z", reason: "offer" }] }),
      ctx,
      NOW,
    );
    const H = withHistory(L, [{ lane: "warm", sinceStart: { sent: 1000, replied: 30, deals: 10, booked: 3 } }]);
    const sends = (id: string) => H.tests.find((t) => t.id === id)!.arms.find((a) => a.approachId === "holiday_letter")!.sends;
    expect(sends("warm_first_email")).toBe(1002);
    expect(sends("offer_first_email")).toBe(0);
  });
});

describe("customer types", () => {
  it("each count their own planned and held emails as waiting to send", () => {
    const L = buildLoopLive(rows(), ctx, NOW);
    expect(L.types.find((t) => t.key === "warm:corporate")!.ready).toBe(4);
    expect(L.types.find((t) => t.key === "cold:office_manager")!.ready).toBe(1);
  });
});

// --- the loop panels, rendered as staff read them ---------------------------

const panel = (L: LoopFacts) => ({
  L,
  items: [],
  nav: {},
  go: () => {},
  say: () => {},
  Proto: (p: { label: string }) => p.label,
  act: async () => true,
  Row: (p: { k: string; children: ReactNode }) => createElement("p", null, `${p.k}: `, p.children),
  Alerts: () => null,
});
// The panel as text: tags dropped, entities read, whitespace squeezed.
const words = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const OFFER_ARM = { customer_type: "offer:corporate", approach_id: "holiday_letter", status: "live" as const, since: "2026-11-15T00:00:00Z", reason: "offer" };

describe("type panel", () => {
  it("says how many of the type's emails wait to send", () => {
    const L = buildLoopLive(rows(), ctx, NOW);
    expect(words(createElement(TypeBody, { ...panel(L), t: L.types.find((t) => t.key === "warm:corporate")! }))).toContain("4 waiting to send");
  });
});

describe("week panel", () => {
  it("says so when nothing but starts was decided and there is no earlier week", () => {
    const text = words(createElement(WeekBody, panel(buildLoopLive(rows(), ctx, NOW))));
    expect(text).toContain("Also decided Nothing else this week.");
    expect(text).toContain("Earlier weeks None yet: this is the loop's first week.");
  });
  it("lists the other decisions and the earlier weeks instead when there are some", () => {
    const [run] = rows().runs;
    const L = buildLoopLive(
      rows({
        runs: [
          { ...run, decisions: { retire: [["warm:corporate", "party_first", "Too few replies"]] } },
          { ...run, week_start: "2026-11-09", created_at: "2026-11-09T04:15:00Z", memo: "First week went out." },
        ],
      }),
      ctx,
      NOW,
    );
    const text = words(createElement(WeekBody, panel(L)));
    expect(text).toContain("Set aside “Party first”");
    expect(text).not.toContain("Nothing else this week.");
    expect(text).toContain("Week of Nov 9");
    expect(text).not.toContain("None yet");
  });
  it("shows a started approach's purpose only when it has one, and no empty stop rule", () => {
    const [run] = rows().runs;
    const started = (purpose: string) =>
      words(
        createElement(
          WeekBody,
          panel(
            buildLoopLive(
              rows({
                runs: [{ ...run, decisions: { new_approaches: [{ id: "party_first", customer_types: ["warm:corporate"], why_tried: "Parties book early" }] } }],
                approaches: [...rows().approaches.filter((a) => a.id !== "party_first"), approach("party_first", { purpose })],
              }),
              ctx,
              NOW,
            ),
          ),
        ),
      );
    expect(started("Get a reply")).toContain("Meant to get a reply");
    expect(started("")).not.toContain("Meant to");
    expect(started("Get a reply")).not.toContain("Stop it if");
  });
});

describe("emails panel", () => {
  it("offers only the types that have emails in its type filter, offer types marked", () => {
    const L = buildLoopLive(
      rows({
        arms: [...rows().arms, OFFER_ARM, { customer_type: "warm:exec_admin", approach_id: "holiday_letter", status: "live" as const, since: "2026-11-15T00:00:00Z", reason: "baseline" }],
        drafts: [...rows().drafts, draft(8, "holiday_letter", "planned", { customer_type: "offer:corporate" })],
      }),
      ctx,
      NOW,
    );
    expect(L.types.some((t) => t.key === "warm:exec_admin")).toBe(true);
    const select = renderToStaticMarkup(createElement(EmailsBody, panel(L))).match(/<select aria-label="Customer type".*?<\/select>/)![0];
    expect([...select.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1].replace(/<!-- -->/g, ""))).toEqual(["Every type", "Cold: Office managers", "Offer: Companies", "Companies"]);
  });
});

describe("email panel", () => {
  const aimedAt = (occasion_id: string) => {
    const L = buildLoopLive(
      rows({
        // A name unlike its id, so reading the name and spelling out the id differ.
        runs: [{ ...rows().runs[0], occasions: { "warm:corporate": { target: { id: "holiday_party_season", name: "Office holiday parties", aim: "2026-12-12" }, upcoming: [] } } }],
        sequences: [{ id: 2, occasion_id, event_date: "2026-12-12", date_basis: "occasion", date_source: "occasion_calendar", date_confidence: null, planned_steps: 1 }] as LiveRows["sequences"],
      }),
      ctx,
      NOW,
    );
    return words(createElement(EmailBody, { ...panel(L), d: L.drafts.find((d) => d.id === "2")! })).match(/Aimed at: [^(]*/)![0].trim();
  };
  it("names the occasion it is aimed at, not its id", () => {
    expect(aimedAt("holiday_party_season")).toBe("Aimed at: Office holiday parties on Dec 12");
  });
  it("spells out an occasion the type does not list", () => {
    expect(aimedAt("spring_fling")).toBe("Aimed at: Spring fling on Dec 12");
  });
});

describe("approach panel", () => {
  const H = (replied: number) =>
    withHistory(
      buildLoopLive(rows({ arms: [...rows().arms, OFFER_ARM] }), ctx, NOW),
      [{ lane: "warm", sinceStart: { sent: 1000, replied, deals: replied, booked: 0 } }],
    );
  const body = (L: LoopFacts, id = "holiday_letter") => words(createElement(ApproachBody, { ...panel(L), id }));

  it("counts one reply and one lead in the singular, more in the plural", () => {
    expect(body(H(1))).toContain("Before the loop: 1,000 sent, 1 reply, 1 lead, 0 booked.");
    expect(body(H(30))).toContain("Before the loop: 1,000 sent, 30 replies, 30 leads, 0 booked.");
  });
  it("names its row in each test by that test's tier", () => {
    // The chart rows carry their label as a title; the offer test once read "Past customers" too.
    const titles = [...renderToStaticMarkup(createElement(ApproachBody, { ...panel(H(1)), id: "holiday_letter" })).matchAll(/<span class="truncate[^"]*" title="([^"]*)"/g)].map((m) => m[1]);
    expect(titles).toEqual(["Past customers", "Offer"]);
  });
  it("says who approved it: a person by address, the loop by name", () => {
    expect(body(H(1))).toContain("Approved Nov 14: loop.");
    const L = buildLoopLive(
      rows({ approaches: [...rows().approaches.filter((a) => a.id !== "cold_pilot_a"), approach("cold_pilot_a", { approved_at: "2026-11-15T00:00:00Z", approved_by: "owner@example.test" })] }),
      ctx,
      NOW,
    );
    expect(body(L, "cold_pilot_a")).toContain("Approved Nov 14 by owner@example.test.");
  });
});

import { depthOf, nextState, popAction } from "@/lib/emailCampaignsPrototype/console/nav";

describe("console history depth", () => {
  // Simulates the browser's history stack: each entry keeps the state the
  // console stored with it, and Back moves the cursor without telling us.
  function browser(start: unknown) {
    const stack: unknown[] = [start];
    let at = 0;
    return {
      push: () => { stack.splice(at + 1); stack.push(nextState(stack[at], "push")); at++; },
      replace: () => { stack[at] = nextState(stack[at], "replace"); },
      back: () => { at = Math.max(0, at - 1); },
      esc: () => (popAction(stack[at]) === "back" ? ((at = at - 1), "back") : "replace"),
      at: () => at,
      state: () => stack[at],
    };
  }
  it("push, push, Back, Esc lands on the first level, never off the console", () => {
    const b = browser(null); // a deep link: the page's own entry carries no depth
    b.push(); // open a type
    b.push(); // open another
    b.back(); // the browser's own Back
    expect(b.esc()).toBe("back"); // up to the page's entry
    expect(b.at()).toBe(0);
    expect(b.esc()).toBe("replace"); // closes the deep-linked panel in place, does not leave
  });
  it("stepping with replace keeps the depth, so Esc goes up to the list", () => {
    const b = browser(null);
    b.push(); // open an email from the list
    b.replace(); // next email
    b.replace(); // next email
    expect(depthOf(b.state())).toBe(1);
    expect(b.esc()).toBe("back");
    expect(b.at()).toBe(0);
  });
  it("reads a missing or odd state as depth 0", () => {
    for (const s of [null, undefined, {}, { consoleDepth: "2" }, { consoleDepth: -1 }]) expect(depthOf(s)).toBe(0);
  });
});
