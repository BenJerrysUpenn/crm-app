import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRawData } from "@/lib/emailCampaignsPrototype/load";
import { compute, type ProspectRow, type RawData } from "@/lib/emailCampaignsPrototype/model";

// Offer-tier routing (bj-finance #425, owners' ruling): Offer = booked in the
// last 12 months OR an explicit opt-in (opt_in_source 'explicit_yes' or
// 'signup_form'). The 'booked' basis seeded on past bookers is not an opt-in,
// so a booker from more than 12 months ago stays in Warm as a past booker.
// Mirrors Catering-Manager outreach/migrations/009_offers_opt_in.sql.

const NOW = new Date("2026-09-28T12:00:00Z");

let nextId = 1;
function prospect(over: Partial<ProspectRow>): ProspectRow {
  const id = nextId++;
  return {
    id,
    name: `Person ${id}`,
    company: null,
    email: `p${id}@example.com`,
    status: "raw",
    engine: "warm",
    category: null,
    ever_booked: false,
    last_event_date: null,
    marketing_opt_in: false,
    opt_in_source: null,
    last_outreach_at: null,
    verify_status: null,
    ...over,
  };
}

function data(prospects: ProspectRow[]): RawData {
  return { prospects, deals: [], sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] };
}

function placement(p: ProspectRow) {
  const payload = compute(data([p]), NOW);
  const tier = payload.tiers.find((t) => t.total === 1);
  const cat = tier?.categories.find((c) => c.total === 1);
  return { tier: tier?.key, cat: cat?.key, flows: payload.flows };
}

describe("Email campaigns tier routing: Offer needs a recent booking or an explicit opt-in", () => {
  it("routes a 'booked'-basis opt-in who last booked over 12 months ago to Warm, as a past booker", () => {
    const r = placement(
      prospect({ ever_booked: true, last_event_date: "2025-03-14", marketing_opt_in: true, opt_in_source: "booked" }),
    );
    expect(r.tier).toBe("warm");
    expect(r.cat).toBe("past_booker");
    expect(r.flows.offerOptedIn).toBe(0);
    expect(r.flows.offerToWarm).toBe(1);
  });

  it("routes an explicit_yes opt-in to Offer and counts it as opted in", () => {
    const r = placement(
      prospect({ ever_booked: true, last_event_date: "2024-06-01", marketing_opt_in: true, opt_in_source: "explicit_yes" }),
    );
    expect(r.tier).toBe("offer");
    expect(r.flows.offerOptedIn).toBe(1);
    expect(r.flows.offerBookedRecent).toBe(0);
  });

  it("routes a signup_form opt-in who never booked to Offer", () => {
    const r = placement(prospect({ marketing_opt_in: true, opt_in_source: "signup_form" }));
    expect(r.tier).toBe("offer");
    expect(r.flows.offerOptedIn).toBe(1);
  });

  it("routes a booker from the last 12 months to Offer, opted in or not", () => {
    for (const over of [
      { marketing_opt_in: false, opt_in_source: null },
      { marketing_opt_in: true, opt_in_source: "booked" },
    ]) {
      const r = placement(prospect({ ever_booked: true, last_event_date: "2026-05-02", ...over }));
      expect(r.tier).toBe("offer");
      expect(r.flows.offerBookedRecent).toBe(1);
      expect(r.flows.offerOptedIn).toBe(0);
    }
  });

  it("routes an opt-in with no recorded source to Warm, not Offer", () => {
    const r = placement(prospect({ marketing_opt_in: true, opt_in_source: null }));
    expect(r.tier).toBe("warm");
    expect(r.cat).toBe("no_deal");
    expect(r.flows.offerOptedIn).toBe(0);
  });

  it("ignores an explicit source when marketing_opt_in is false", () => {
    const r = placement(prospect({ marketing_opt_in: false, opt_in_source: "explicit_yes" }));
    expect(r.tier).toBe("warm");
  });
});

// The database is the system boundary: a fake PostgREST client that returns
// only the columns each query selects, as the real one does.
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>): SupabaseClient {
  const project = (row: Record<string, unknown>, columns: string) =>
    Object.fromEntries(
      columns.split(",").map((spec) => {
        const [alias, expr] = spec.includes(":") ? spec.split(":") : [spec, spec];
        const [col, key] = expr.split("->>");
        const v = row[col];
        return [alias, key ? (v as Record<string, unknown> | null)?.[key] ?? null : v ?? null];
      }),
    );
  const query = (table: string, columns: string, head: boolean) => {
    let rows = tables[table] ?? [];
    let from = 0;
    let to = Infinity;
    const q = {
      eq: (col: string, val: unknown) => ((rows = rows.filter((r) => r[col] === val)), q),
      order: () => q,
      range: (a: number, b: number) => ((from = a), (to = b), q),
      then: (resolve: (r: unknown) => void) =>
        resolve(
          head
            ? { count: rows.length, error: null }
            : { data: rows.slice(from, to + 1).map((r) => project(r, columns)), error: null },
        ),
    };
    return q;
  };
  return {
    from: (table: string) => ({
      select: (columns: string, opts?: { head?: boolean }) => query(table, columns, !!opts?.head),
    }),
  } as unknown as SupabaseClient;
}

describe("Email campaigns loader feeds the opt-in basis to tier routing", () => {
  it("puts a loaded explicit opt-in in Offer and a loaded 'booked'-basis opt-in in Warm", async () => {
    const booked = { ever_booked: true, last_event_date: "2025-01-20", marketing_opt_in: true };
    const supabase = fakeSupabase({
      outreach_prospects: [
        { ...prospect({ ...booked, opt_in_source: "explicit_yes" }), id: 101 },
        { ...prospect({ ...booked, opt_in_source: "booked" }), id: 102 },
      ],
    });
    const payload = compute(await loadRawData(supabase), NOW);
    const total = (key: string) => payload.tiers.find((t) => t.key === key)?.total;
    expect(total("offer")).toBe(1);
    expect(total("warm")).toBe(1);
    expect(payload.flows.offerOptedIn).toBe(1);
    expect(payload.flows.offerToWarm).toBe(1);
  });
});
