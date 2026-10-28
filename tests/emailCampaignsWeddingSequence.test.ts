import { describe, expect, it } from "vitest";
import {
  categorySteps,
  compute,
  everyoneOf,
  groupStanding,
  statesAt,
  stepEngagement,
  type HitRow,
  type ProspectRow,
  type RawData,
  type SentRow,
  type StepsFor,
} from "@/lib/emailCampaignsPrototype/model";
import { SEED_SEQUENCES, stepSpec, type SeqStep } from "@/lib/emailCampaignsPrototype/sequences";

// The Offer "Weddings & showers" card shows the wedding sender's sequence, the
// way Warm shows warm_sender's: a seed sequence whose steps carry `sentAs`,
// the send-history templates that mean "had this step". Catering-Manager
// outreach/wedding_copy.py and the outreach_wedding_schedule view are the
// sender's side: touch 1 is wedding_expo_v2 (the manual touch-1 sends to the
// earlier expo lists count as touch 1), touches 2 and 3 are wedding_t2 and
// wedding_t3, 30 days after the last email, with no copy yet, so the sender
// never sends them. Synthetic rows only.

const NOW = new Date("2026-10-27T20:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

let nextId = 1;
function couple(over: Partial<ProspectRow> = {}): ProspectRow {
  const id = nextId++;
  return {
    id,
    name: `Couple ${id}`,
    company: null,
    email: `c${id}@example.com`,
    status: "raw",
    engine: "warm",
    category: "wedding",
    ever_booked: false,
    last_event_date: null,
    marketing_opt_in: true,
    opt_in_source: "signup_form",
    last_outreach_at: null,
    verify_status: null,
    event_date: "2027-06-12",
    archived_at: null,
    ...over,
  };
}

function run(prospects: ProspectRow[], sent: SentRow[] = [], hits: HitRow[] = [], blockedDomains: string[] = []) {
  const payload = compute(
    { prospects, deals: [], sent, hits, suppressedEmails: [], blockedDomains, mailboxes: [] } satisfies RawData,
    NOW,
  );
  const offer = payload.tiers.find((t) => t.key === "offer")!;
  const card = offer.categories.find((c) => c.key === "wedding")!;
  return { payload, offer, card };
}

// The page's own steps from the seeds, as the client builds them.
const seedSteps = (key: string, doc = SEED_SEQUENCES[key]) => (doc?.steps ?? []).map(stepSpec);
const offerSteps: StepsFor = (catKey) =>
  categorySteps(catKey, seedSteps(`offer:${catKey}`), seedSteps("offer:everyone"));

const WEDDING = SEED_SEQUENCES["offer:wedding"];

describe("Offer Weddings & showers: the wedding sender's sequence is the card's seed", () => {
  it("has three steps: V2, then touch 2 and touch 3 thirty days apart", () => {
    expect(WEDDING).toBeDefined();
    expect(WEDDING.steps.map((s) => s.waitDays)).toEqual([0, 30, 30]);
    expect(WEDDING.steps[1].sentAs).toEqual(["wedding_t2"]);
    expect(WEDDING.steps[2].sentAs).toEqual(["wedding_t3"]);
  });

  it("counts V2, its V1 and the manual touch-1 sends to the earlier lists as step 1, and nothing else", () => {
    expect([...(WEDDING.steps[0].sentAs ?? [])].sort()).toEqual([
      "manual_wedding_t1_cherry_hill",
      "manual_wedding_t1_merion",
      "wedding_expo_rivers_2026",
      "wedding_expo_v2",
    ]);
    // The check-in and personal notes carry no touch number for the sender.
    const all = WEDDING.steps.flatMap((s) => s.sentAs ?? []);
    expect(all).not.toContain("manual_wedding_checkin");
    expect(all).not.toContain("manual_wedding_personal");
  });

  it("shows V2's subject as the sender has it, and its body with no phone number (public repo)", () => {
    expect(WEDDING.steps[0].subject).toBe("Ben & Jerry’s at {expo_name} follow-up");
    expect(WEDDING.steps[0].body).toMatch(/^Hi \{\{first_name\}\},\n\nNice to see you at the \{expo_name\} \{expo_when\}!/);
    expect(WEDDING.steps[0].body).toContain("{season_paragraph}");
    expect(WEDDING.steps[0].body).not.toMatch(/\d{3}\D?\d{3}\D?\d{4}/);
  });

  it("has no copy for touches 2 and 3 yet, so they are unwritten steps", () => {
    for (const s of WEDDING.steps.slice(1)) {
      expect(s.subject).toBe("");
      expect(s.body).toBe("");
      expect(stepSpec(s)).toEqual({ keys: s.sentAs, unwritten: true });
    }
    expect(stepSpec(WEDDING.steps[0])).toEqual(WEDDING.steps[0].sentAs);
  });

  it("treats a step with a subject or a body as written, as before", () => {
    const step = (subject: string, body: string): SeqStep => ({ id: "x", waitDays: 0, subject, body, sentAs: ["k"] });
    expect(stepSpec(step("", "A body"))).toEqual(["k"]);
    expect(stepSpec(step("A subject", ""))).toEqual(["k"]);
    expect(stepSpec(step("  ", "\n"))).toEqual({ keys: ["k"], unwritten: true });
  });
});

describe("Offer Weddings & showers: who is up next, emailed and held", () => {
  it("puts couples still due V2 in Up next and everyone who had a touch 1 in Emailed, nobody held", () => {
    const due = [couple(), couple(), couple()];
    const v2 = couple({ last_outreach_at: daysAgo(0) });
    const merion = couple({ last_outreach_at: daysAgo(4) });
    const cherry = couple({ last_outreach_at: daysAgo(6) });
    const { card } = run(
      [...due, v2, merion, cherry],
      [
        { prospect_id: v2.id, template: "wedding_expo_v2" },
        { prospect_id: merion.id, template: "manual_wedding_t1_merion" },
        { prospect_id: cherry.id, template: "manual_wedding_t1_cherry_hill" },
        { prospect_id: cherry.id, template: "manual_wedding_checkin" },
      ],
    );
    const st = statesAt(card, "monthly", offerSteps);
    expect(st).toMatchObject({ upNext: 3, emailed: 3, held: 0, unaccounted: 0 });
    expect(st.heldBy.noSequence).toBe(0);
  });

  it("never puts anyone in Up next for an unwritten step: past the period they are held, copy not written yet", () => {
    const old = couple({ last_outreach_at: daysAgo(45) });
    const { card } = run([old], [{ prospect_id: old.id, template: "wedding_expo_v2" }]);
    const st = statesAt(card, "monthly", offerSteps);
    expect(st).toMatchObject({ upNext: 0, emailed: 0, held: 1, unaccounted: 0 });
    expect(st.heldBy.notWritten).toBe(1);
    // Nothing to send to them, so Needed leaves them out.
    expect(st.withStepsLeft).toBe(0);
  });

  it("leaves someone emailed this period in Emailed while their next step is unwritten, out of Needed", () => {
    const recent = couple({ last_outreach_at: daysAgo(3) });
    const { card } = run([recent], [{ prospect_id: recent.id, template: "wedding_expo_v2" }]);
    const st = statesAt(card, "monthly", offerSteps);
    expect(st).toMatchObject({ upNext: 0, emailed: 1, held: 0, withStepsLeft: 0 });
  });

  it("moves them to Up next once touch 2 has copy", () => {
    const old = couple({ last_outreach_at: daysAgo(45) });
    const { card } = run([old], [{ prospect_id: old.id, template: "wedding_expo_v2" }]);
    const written = {
      ...WEDDING,
      steps: WEDDING.steps.map((s, i) => (i === 1 ? { ...s, subject: "Touch 2", body: "Hi {{first_name}}" } : s)),
    };
    const steps = seedSteps("offer:wedding", written);
    const st = statesAt(card, "monthly", () => steps);
    expect(st).toMatchObject({ upNext: 1, emailed: 0, held: 0 });
  });

  it("finishes a couple who had all three touches", () => {
    const done = couple({ last_outreach_at: daysAgo(70) });
    const { card } = run(
      [done],
      ["wedding_expo_v2", "wedding_t2", "wedding_t3"].map((template) => ({ prospect_id: done.id, template })),
    );
    expect(groupStanding(card.groups[0], offerSteps("wedding"))).toBe("finished");
  });

  it("counts a couple whose send is logged but whose last email date is not stamped as emailed, from the send", () => {
    // The manual Merion touch 1 left last_outreach_at empty on some rows; the
    // sender dates the last email from the send history.
    const merion = couple({ last_outreach_at: null });
    const { card } = run([merion], [{ prospect_id: merion.id, template: "manual_wedding_t1_merion", sent_at: daysAgo(4) }]);
    expect(statesAt(card, "monthly", offerSteps)).toMatchObject({ upNext: 0, emailed: 1, held: 0 });
    expect(card.groups[0].sample.newest[0].last_touch).toBe(daysAgo(4));
  });

  it("does not hold wedding-sender couples on Yahoo/Microsoft: the wedding sender mails them", () => {
    const due = couple({ email: "a@yahoo.com" });
    const sent = couple({ email: "b@hotmail.com", last_outreach_at: daysAgo(0) });
    const { card } = run([due, sent], [{ prospect_id: sent.id, template: "wedding_expo_v2" }], [], [
      "yahoo.com",
      "hotmail.com",
    ]);
    expect(statesAt(card, "monthly", offerSteps)).toMatchObject({ upNext: 1, emailed: 1, held: 0 });
  });

  it("still holds a Yahoo/Microsoft wedding enquirer who is not on the wedding sender's list", () => {
    // In the card by a wedding deal, not by their own category: warm_sender's rule.
    const p = couple({ category: null, email: "c@yahoo.com", ever_booked: true, last_event_date: "2026-08-01" });
    const payload = compute(
      {
        prospects: [p],
        deals: [
          {
            contact_email: p.email,
            event_type: "Wedding",
            stage: "Event Complete",
            event_date: "2026-08-01",
            created_at: "2026-03-01T12:00:00Z",
            last_outbound_at: null,
            source: "form",
          },
        ],
        sent: [],
        suppressedEmails: [],
        blockedDomains: ["yahoo.com"],
        mailboxes: [],
      },
      NOW,
    );
    const card = payload.tiers.find((t) => t.key === "offer")!.categories.find((c) => c.key === "wedding")!;
    expect(statesAt(card, "monthly", offerSteps).heldBy.blocked).toBe(1);
  });

  it("does not give the rest of Offer the wedding sequence", () => {
    expect(offerSteps("corporate")).toEqual([]);
  });
});

describe("Offer Weddings & showers: opens and clicks per step", () => {
  it("counts tracked sends that were opened or clicked at least once, per template, on the card", () => {
    const a = couple({ last_outreach_at: daysAgo(0) });
    const b = couple({ last_outreach_at: daysAgo(0) });
    const c = couple({ last_outreach_at: daysAgo(0) });
    const d = couple({ last_outreach_at: daysAgo(4) });
    const { card } = run(
      [a, b, c, d],
      [
        { prospect_id: a.id, template: "wedding_expo_v2", tracking_id: "aaaaaaaaaaaaaaaa" },
        { prospect_id: b.id, template: "wedding_expo_v2", tracking_id: "bbbbbbbbbbbbbbbb" },
        { prospect_id: c.id, template: "wedding_expo_v2", tracking_id: "cccccccccccccccc" },
        // Manual sends carry no tracking id.
        { prospect_id: d.id, template: "manual_wedding_t1_merion" },
      ],
      [
        // Two opens of one send count once, as outreach_engagement_by_template does.
        { prospect_id: a.id, event: "opened", tracking_id: "aaaaaaaaaaaaaaaa" },
        { prospect_id: a.id, event: "opened", tracking_id: "aaaaaaaaaaaaaaaa" },
        { prospect_id: a.id, event: "clicked", tracking_id: "aaaaaaaaaaaaaaaa" },
        { prospect_id: b.id, event: "opened", tracking_id: "bbbbbbbbbbbbbbbb" },
        // Another prospect's tracking id does not count for c.
        { prospect_id: c.id, event: "opened", tracking_id: "bbbbbbbbbbbbbbbb" },
      ],
    );
    expect(stepEngagement(card, WEDDING.steps[0].sentAs ?? [])).toEqual({ tracked: 3, opened: 2, clicked: 1 });
    expect(stepEngagement(card, WEDDING.steps[1].sentAs ?? [])).toBeNull();
  });

  it("sums the cards on the Everyone card", () => {
    const a = couple({ last_outreach_at: daysAgo(0) });
    const { offer } = run(
      [a],
      [{ prospect_id: a.id, template: "wedding_expo_v2", tracking_id: "aaaaaaaaaaaaaaaa" }],
      [{ prospect_id: a.id, event: "opened", tracking_id: "aaaaaaaaaaaaaaaa" }],
    );
    expect(stepEngagement(everyoneOf(offer), ["wedding_expo_v2"])).toEqual({ tracked: 1, opened: 1, clicked: 0 });
  });

  it("shows nothing for a step whose sends were never tracked", () => {
    const a = couple({ last_outreach_at: daysAgo(4) });
    const { card } = run([a], [{ prospect_id: a.id, template: "manual_wedding_t1_merion" }]);
    expect(stepEngagement(card, WEDDING.steps[0].sentAs ?? [])).toBeNull();
  });

  it("leaves suppressed couples' sends out, like the people themselves", () => {
    const a = couple({ last_outreach_at: daysAgo(0), status: "suppressed" });
    const b = couple({ last_outreach_at: daysAgo(0) });
    const { card } = run(
      [a, b],
      [
        { prospect_id: a.id, template: "wedding_expo_v2", tracking_id: "aaaaaaaaaaaaaaaa" },
        { prospect_id: b.id, template: "wedding_expo_v2", tracking_id: "bbbbbbbbbbbbbbbb" },
      ],
      [{ prospect_id: a.id, event: "opened", tracking_id: "aaaaaaaaaaaaaaaa" }],
    );
    expect(stepEngagement(card, ["wedding_expo_v2"])).toEqual({ tracked: 1, opened: 0, clicked: 0 });
  });
});
