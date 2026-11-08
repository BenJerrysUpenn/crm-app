// Referral Credits in the deal drawer (bj-finance #901).
//
// The rules are SQL in Catering-Manager migration 029 and are tested there
// (tests/test_referral_credit.py): earning, refusals, the claim conflict
// rule, stacking, expiry, the balance view, apply. What is tested here is the
// drawer's half: what it says for each verdict, which credits it offers to
// use on which deal, which pending listings it suggests, what it sends to
// each database function, and that a database without migration 029 shows a
// quiet "not set up" rather than an error. Synthetic names and addresses only.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Deal } from "@/lib/types";
import {
  APPLY_NOTE,
  applyCredit,
  balanceText,
  canTakeCredit,
  claimedAtFromDay,
  confirmCredit,
  creditRows,
  fmtDay,
  isEmail,
  isNotSetUp,
  likelyMatches,
  linkListing,
  loadPanel,
  money,
  normalizeEmail,
  recordCustomerNamed,
  recordListing,
  unapplyCredit,
  verdictText,
  type Balance,
  type Check,
  type Claim,
  type Credit,
  type PanelLoad,
  type Verdict,
} from "@/lib/referralCredit";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { ReferralBody } from "@/components/ReferralPanel";

function mkDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 10,
    stage: "Sent Quote",
    payment_status: "None",
    contact_first_name: "Dana",
    contact_last_name: "Rowe",
    contact_email: "Dana.Rowe@Example.edu",
    company: "Synthetic Club",
    ...overrides,
  } as Deal;
}

function mkCheck(verdict: Verdict, overrides: Partial<Check> = {}): Check {
  return {
    verdict,
    advocate_id: 1,
    amount: 100,
    expires_on: "2027-12-31",
    deposit_paid_at: null,
    ...overrides,
  };
}

function mkClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 1,
    advocate_id: 1,
    referred_name: "Dana Rowe",
    referred_email: null,
    named_by: "advocate",
    claimed_at: "2026-11-17T17:00:00+00:00",
    deal_id: null,
    advocates: { name: "Alice Advocate", email: "alice@example.org" },
    ...overrides,
  };
}

function mkCredit(overrides: Partial<Credit> = {}): Credit {
  return {
    id: 1,
    advocate_id: 1,
    earned_from_deal_id: 20,
    amount: 100,
    expires_on: "2027-12-31",
    status: "open",
    used_on_deal_id: null,
    ...overrides,
  };
}

const BALANCE: Balance = {
  advocate_id: 1,
  name: "Alice Advocate",
  email: "alice@example.org",
  open_count: 2,
  open_amount: 200,
  used_amount: 100,
  expired_amount: 0,
  pending_count: 1,
};

// ---------------------------------------------------------------------------
// A fake Supabase client: records rpc calls, answers table reads from a map.
// ---------------------------------------------------------------------------

type Answer = { data: unknown; error: { code?: string; message: string } | null };

function fakeSupabase(opts: {
  rpc?: Record<string, Answer>;
  tables?: Record<string, Answer>;
  email?: string;
}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const reads: { table: string; steps: string[] }[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(opts.rpc?.[fn] ?? { data: null, error: null });
    },
    from(table: string) {
      const read = { table, steps: [] as string[] };
      reads.push(read);
      const answer = opts.tables?.[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const step of ["select", "or", "order", "eq"]) {
        builder[step] = (...args: unknown[]) => {
          read.steps.push(`${step}(${args.map(String).join(",")})`);
          return builder;
        };
      }
      builder.maybeSingle = () => Promise.resolve(answer);
      builder.then = (ok: (a: Answer) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(answer).then(ok, bad);
      return builder;
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { email: opts.email ?? "m@example.org" } } }),
    },
  };
  return { client: client as unknown as SupabaseClient, calls, reads };
}

// ---------------------------------------------------------------------------

describe("small helpers", () => {
  it("normalises and checks emails", () => {
    expect(normalizeEmail("  Dana.Rowe@Example.EDU ")).toBe("dana.rowe@example.edu");
    expect(normalizeEmail(null)).toBe("");
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
  });

  it("formats money and days", () => {
    expect(money(100)).toBe("$100");
    expect(money(12.5)).toBe("$12.50");
    expect(fmtDay("2027-12-31")).toBe("Dec 31, 2027");
    expect(fmtDay("2026-11-17T17:00:00+00:00")).toBe("Nov 17, 2026");
  });

  it("sends a reply date as noon Eastern", () => {
    expect(claimedAtFromDay("2026-11-17")).toBe("2026-11-17 12:00 America/New_York");
  });

  it("knows which errors mean migration 029 is missing", () => {
    for (const code of ["42P01", "42883", "PGRST202", "PGRST205"])
      expect(isNotSetUp({ code, message: "x" })).toBe(true);
    expect(isNotSetUp({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isNotSetUp({ message: "no code" })).toBe(false);
    expect(isNotSetUp(null)).toBe(false);
  });
});

describe("what the drawer says about a referral", () => {
  const cases: [Verdict, string][] = [
    ["earned_already", "Alice earned a $100 Referral Credit for this booking."],
    ["earns", "Alice has a $100 Referral Credit for this booking that is not recorded yet."],
    ["not_paid", "Alice earns a $100 Referral Credit once this deposit is paid, by Dec 31, 2026."],
    ["late", "No Referral Credit: the deposit was paid after Dec 31, 2026."],
    ["returning", "No Referral Credit: this customer had booked or asked about an event with us before."],
    ["self_referral", "No Referral Credit: an Advocate cannot refer their own event."],
    ["no_email", "No Referral Credit yet: add the customer's email so we can check they are new."],
    ["no_advocate", "No Advocate on this deal."],
  ];
  it.each(cases)("%s", (verdict, text) => {
    expect(verdictText(mkCheck(verdict), "Alice")).toBe(text);
  });

  it("names the Advocate when a listing came after the enquiry", () => {
    expect(verdictText(mkCheck("listed_after_enquiry"), "Alice")).toContain(
      "If the customer names Alice, record that below.",
    );
    expect(verdictText(mkCheck("not_paid"), null)).toContain("the Advocate earns");
  });
});

describe("pending listings the drawer suggests", () => {
  const deal = mkDeal();
  it("matches the same email, or the contact's name", () => {
    const byEmail = mkClaim({ id: 1, referred_name: "D.", referred_email: "dana.rowe@example.edu" });
    const byName = mkClaim({ id: 2, referred_name: "dana rowe from the club" });
    const lastOnly = mkClaim({ id: 3, referred_name: "Pat Rowe" });
    const linked = mkClaim({ id: 4, referred_email: "dana.rowe@example.edu", deal_id: 99 });
    expect(likelyMatches([byEmail, byName, lastOnly, linked], deal).map((c) => c.id)).toEqual([1, 2]);
  });

  it("matches a last name alone when the deal has no first name", () => {
    const claim = mkClaim({ referred_name: "Pat Rowe" });
    expect(likelyMatches([claim], mkDeal({ contact_first_name: null }))).toHaveLength(1);
    expect(likelyMatches([claim], mkDeal({ contact_last_name: null, contact_email: null }))).toHaveLength(0);
  });
});

describe("the Advocate's credits on their own deal", () => {
  const today = "2026-11-20";
  it("offers open credits on an open deal, and undo only where used here", () => {
    const deal = mkDeal({ id: 30, stage: "Booked Paid", payment_status: "Deposit Paid" });
    const rows = creditRows(
      [
        mkCredit({ id: 1 }),
        mkCredit({ id: 2, status: "used", used_on_deal_id: 30 }),
        mkCredit({ id: 3, status: "used", used_on_deal_id: 31 }),
        mkCredit({ id: 4, status: "expired", expires_on: "2026-01-31" }),
        mkCredit({ id: 5, expires_on: "2026-11-19" }),
      ],
      deal,
      today,
    );
    expect(rows.map((r) => [r.credit.id, r.label, r.canApply, r.canUndo])).toEqual([
      [1, "$100 from deal #20, good through Dec 31, 2027", true, false],
      [2, "$100 from deal #20, used on this event", false, true],
      [3, "$100 from deal #20, used on deal #31", false, false],
      [4, "$100 from deal #20, expired Jan 31, 2026", false, false],
      [5, "$100 from deal #20, expired Nov 19, 2026", false, false],
    ]);
  });

  it("offers nothing on a deal with nothing left to pay", () => {
    for (const deal of [
      mkDeal({ stage: "Event Complete" }),
      mkDeal({ stage: "Closed Lost" }),
      mkDeal({ stage: "Booked Paid", payment_status: "Paid in Full" }),
    ]) {
      expect(canTakeCredit(deal)).toBe(false);
      expect(creditRows([mkCredit()], deal, today)[0].canApply).toBe(false);
    }
    expect(canTakeCredit(mkDeal({ stage: "Booked Unpaid" }))).toBe(true);
  });

  it("adds up the headline", () => {
    expect(balanceText(BALANCE)).toBe("$200 open (2 credits) · $100 used");
    expect(balanceText({ ...BALANCE, open_count: 1, open_amount: 100, used_amount: 0, expired_amount: 100 }))
      .toBe("$100 open (1 credit) · $100 expired");
  });
});

describe("loading the panel", () => {
  it("reads the check, the claims, and the Advocate's balance and credits", async () => {
    const onDeal = mkClaim({ id: 7, deal_id: 10, named_by: "customer" });
    const pendingMine = mkClaim({ id: 8, advocate_id: 5, referred_name: "Pat Lee" });
    const pendingOther = mkClaim({ id: 9, advocate_id: 6, referred_name: "Sam Roe" });
    const { client, calls, reads } = fakeSupabase({
      rpc: { referral_credit_check: { data: mkCheck("earned_already"), error: null } },
      tables: {
        referral_claims: { data: [onDeal, pendingMine, pendingOther], error: null },
        referral_credit_balances: { data: { ...BALANCE, advocate_id: 5 }, error: null },
        referral_credits: { data: [mkCredit({ advocate_id: 5 })], error: null },
      },
    });
    const load = (await loadPanel(client, mkDeal())) as Extract<PanelLoad, { state: "ready" }>;
    expect(load.state).toBe("ready");
    expect(calls).toEqual([{ fn: "referral_credit_check", args: { p_deal_id: 10 } }]);
    expect(load.data.claims.map((c) => c.id)).toEqual([7]);
    expect(load.data.suggestions).toEqual([]);
    expect(load.data.listed.map((c) => c.id)).toEqual([8]);
    expect(load.data.credits).toHaveLength(1);
    expect(reads.map((r) => r.table)).toEqual([
      "referral_claims",
      "referral_credit_balances",
      "referral_credits",
    ]);
    expect(reads[0].steps).toContain("or(deal_id.eq.10,deal_id.is.null)");
    expect(reads[1].steps).toContain("eq(email,dana.rowe@example.edu)");
    expect(reads[2].steps).toContain("eq(advocate_id,5)");
  });

  it("suggests matching listings when no one has claimed the deal", async () => {
    const { client } = fakeSupabase({
      rpc: { referral_credit_check: { data: mkCheck("no_advocate", { advocate_id: null }), error: null } },
      tables: {
        referral_claims: {
          data: [mkClaim({ id: 3, referred_email: "dana.rowe@example.edu" })],
          error: null,
        },
        referral_credit_balances: { data: null, error: null },
      },
    });
    const load = (await loadPanel(client, mkDeal())) as Extract<PanelLoad, { state: "ready" }>;
    expect(load.data.suggestions.map((c) => c.id)).toEqual([3]);
    expect(load.data.advocate).toBeNull();
    expect(load.data.listed).toEqual([]);
  });

  it("skips the Advocate reads on a deal with no email", async () => {
    const { client, reads } = fakeSupabase({
      rpc: { referral_credit_check: { data: mkCheck("no_email"), error: null } },
    });
    const load = await loadPanel(client, mkDeal({ contact_email: null }));
    expect(load.state).toBe("ready");
    expect(reads.map((r) => r.table)).toEqual(["referral_claims"]);
  });

  it("says 'not set up' when migration 029 is missing, and shows other errors", async () => {
    const missing = fakeSupabase({
      rpc: { referral_credit_check: { data: null, error: { code: "PGRST202", message: "x" } } },
    });
    expect(await loadPanel(missing.client, mkDeal())).toEqual({ state: "not_set_up" });
    for (const table of ["referral_claims", "referral_credit_balances", "referral_credits"]) {
      const broken = fakeSupabase({
        rpc: { referral_credit_check: { data: mkCheck("earned_already"), error: null } },
        tables: {
          referral_credit_balances: { data: BALANCE, error: null },
          [table]: { data: null, error: { code: "42501", message: `${table} refused` } },
        },
      });
      expect(await loadPanel(broken.client, mkDeal())).toEqual({
        state: "error",
        message: `${table} refused`,
      });
    }
  });
});

describe("what each action sends to the database", () => {
  it("records the Advocate the customer named", async () => {
    const { client, calls } = fakeSupabase({ email: "manager@example.org" });
    expect(await recordCustomerNamed(client, mkDeal(), " Alice Advocate ", " ALICE@example.org "))
      .toEqual({ error: null });
    expect(calls).toEqual([{
      fn: "referral_claim_add",
      args: {
        p_advocate_name: "Alice Advocate",
        p_advocate_email: "alice@example.org",
        p_referred_name: "Dana Rowe",
        p_referred_email: "dana.rowe@example.edu",
        p_named_by: "customer",
        p_deal_id: 10,
        p_actor: "crm:manager@example.org",
      },
    }]);
  });

  it("names the customer by company, then deal number, when the contact has no name", async () => {
    const { client, calls } = fakeSupabase({});
    await recordCustomerNamed(client, mkDeal({ contact_first_name: null, contact_last_name: null }), "A", "a@example.org");
    await recordCustomerNamed(
      client,
      mkDeal({ contact_first_name: null, contact_last_name: null, company: null, contact_email: null }),
      "A",
      "a@example.org",
    );
    expect(calls.map((c) => [c.args.p_referred_name, c.args.p_referred_email])).toEqual([
      ["Synthetic Club", "dana.rowe@example.edu"],
      ["deal #10", null],
    ]);
  });

  it("records an Advocate's listing with the date of their reply", async () => {
    const { client, calls } = fakeSupabase({});
    await recordListing(
      client,
      { name: "Alice Advocate", email: "Alice@example.org" },
      { name: " Pat Lee ", email: "" },
      "2026-11-17",
    );
    expect(calls[0]).toEqual({
      fn: "referral_claim_add",
      args: {
        p_advocate_name: "Alice Advocate",
        p_advocate_email: "alice@example.org",
        p_referred_name: "Pat Lee",
        p_referred_email: null,
        p_named_by: "advocate",
        p_deal_id: null,
        p_actor: "crm:m@example.org",
        p_claimed_at: "2026-11-17 12:00 America/New_York",
      },
    });
  });

  it("links, confirms, applies and undoes, and passes refusals through", async () => {
    const { client, calls } = fakeSupabase({
      rpc: {
        referral_credit_apply: {
          data: null,
          error: { code: "P0001", message: "deal 3 has nothing left to pay" },
        },
      },
    });
    expect(await linkListing(client, 4, 10)).toEqual({ error: null });
    expect(await confirmCredit(client, 10)).toEqual({ error: null });
    expect(await applyCredit(client, 2, 3)).toEqual({ error: "deal 3 has nothing left to pay" });
    expect(await unapplyCredit(client, 2)).toEqual({ error: null });
    expect(calls).toEqual([
      { fn: "referral_claim_link", args: { p_claim_id: 4, p_deal_id: 10 } },
      { fn: "referral_credit_confirm", args: { p_deal_id: 10 } },
      { fn: "referral_credit_apply", args: { p_credit_id: 2, p_deal_id: 3, p_actor: "crm:m@example.org" } },
      { fn: "referral_credit_unapply", args: { p_credit_id: 2 } },
    ]);
  });

  it("tells whoever applies a credit to take it off the quote by hand for now", () => {
    expect(APPLY_NOTE).toContain("take $100 off the quote by hand");
  });
});

describe("the Referrals section", () => {
  const noop = () => {};
  function render(load: PanelLoad | null, deal = mkDeal(), extra: { error?: string; note?: string } = {}) {
    return renderToStaticMarkup(
      createElement(ReferralBody, {
        deal,
        load,
        busy: false,
        error: extra.error ?? null,
        note: extra.note ?? null,
        onCustomerNamed: noop,
        onLink: noop,
        onConfirm: noop,
        onListing: noop,
        onApply: noop,
        onUndo: noop,
      }),
    );
  }

  it("shows loading, not set up, and load errors", () => {
    expect(render(null)).toContain("Loading");
    expect(render({ state: "not_set_up" })).toContain("Referral Credits are not set up in the database yet.");
    expect(render({ state: "error", message: "boom" })).toContain("Could not load referrals: boom");
  });

  it("shows who referred the customer and what it earns", () => {
    const html = render({
      state: "ready",
      data: {
        check: mkCheck("not_paid"),
        claims: [
          mkClaim({ id: 1, deal_id: 10, named_by: "customer" }),
          mkClaim({ id: 2, advocate_id: 2, deal_id: 10, advocates: { name: "Bob Advocate", email: "b@example.org" } }),
        ],
        suggestions: [],
        advocate: null,
        credits: [],
        listed: [],
      },
    });
    expect(html).toContain("Alice Advocate");
    expect(html).toContain("the customer named them");
    expect(html).toContain("Alice Advocate earns a $100 Referral Credit once this deposit is paid");
    expect(html).toContain("Bob Advocate listed them on Nov 17, 2026");
    expect(html).toContain("None. They have not referred anyone yet.");
    expect(html).not.toContain("Record the Referral Credit");
  });

  it("offers to record a due credit, link a suggestion, and use open credits", () => {
    const deal = mkDeal({ id: 30, stage: "Booked Unpaid" });
    const html = render(
      {
        state: "ready",
        data: {
          check: mkCheck("earns", { advocate_id: 1 }),
          claims: [mkClaim({ deal_id: 30, named_by: "advocate" })],
          suggestions: [mkClaim({ id: 5, referred_name: "Dana R", referred_email: "d@example.edu" })],
          advocate: BALANCE,
          credits: [mkCredit({ id: 1 }), mkCredit({ id: 2, status: "used", used_on_deal_id: 30 })],
          listed: [mkClaim({ id: 6, referred_name: "Pat Lee", referred_email: "pat@example.edu" })],
        },
      },
      deal,
      { note: APPLY_NOTE, error: "refused" },
    );
    expect(html).toContain("they listed this customer");
    expect(html).toContain("Record the Referral Credit");
    expect(html).toContain("This is them");
    expect(html).toContain("$200 open (2 credits) · $100 used");
    expect(html).toContain("Use on this event");
    expect(html).toContain("Undo");
    expect(html).toContain("Pat Lee (pat@example.edu), listed Nov 17, 2026");
    expect(html).toContain("take $100 off the quote by hand");
    expect(html).toContain("refused");
  });

  it("asks for the customer's name and email before they can refer anyone", () => {
    const html = render(
      {
        state: "ready",
        data: {
          check: mkCheck("no_advocate", { advocate_id: null }),
          claims: [],
          suggestions: [],
          advocate: null,
          credits: [],
          listed: [],
        },
      },
      mkDeal({ contact_email: null }),
    );
    expect(html).toContain("No Advocate yet.");
    expect(html).toContain("a Referral Credit needs it to check they are new");
    expect(html).toContain("needs the customer&#x27;s name and email before they can refer anyone");
  });
});
