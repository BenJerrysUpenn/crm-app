// The two manual-intake routes, end to end against a stand-in Supabase.
//
//   * POST /api/deals takes a deal with no venue address: validation passes,
//     the row is built with venue_address NULL, and the insert goes through.
//   * POST /api/call-desk/deals still refuses the same thing (strict mode is
//     unchanged).
//   * POST /api/deals/dedupe returns matched deals with the details the New
//     deal form autofills from, and degrades to the bare matches if that
//     read fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    rpcRows: [] as Array<Record<string, unknown>>,
    dealRows: [] as Array<Record<string, unknown>>,
    dealSelectError: null as { message: string } | null,
    dealSelects: [] as Array<{ columns: string; ids: unknown[] }>,
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  };

  const client = {
    auth: {
      getUser: async () => ({
        data: { user: { email: "caller1@example.com" } },
      }),
    },
    async rpc(name: string) {
      if (name !== "deal_dedupe_candidates")
        throw new Error(`unexpected rpc ${name}`);
      return { data: state.rpcRows, error: null };
    },
    from(table: string) {
      if (table === "deal_form_options") {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return b;
      }
      if (table === "deals") {
        let columns = "";
        let pendingInsert: Record<string, unknown> | null = null;
        const b = {
          select: (cols: string) => {
            columns = cols;
            return b;
          },
          in: async (_col: string, ids: unknown[]) => {
            state.dealSelects.push({ columns, ids });
            if (state.dealSelectError)
              return { data: null, error: state.dealSelectError };
            return {
              data: state.dealRows.filter((r) => ids.includes(r.id)),
              error: null,
            };
          },
          insert: (row: Record<string, unknown>) => {
            pendingInsert = row;
            state.inserts.push({ table, row });
            return b;
          },
          single: async () =>
            pendingInsert
              ? { data: { id: 99001 }, error: null }
              : { data: null, error: { message: "no insert" } },
        };
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.client }));

const { POST: createManual } = await import("@/app/api/deals/route");
const { POST: createCallDesk } = await import("@/app/api/call-desk/deals/route");
const { POST: dedupe } = await import("@/app/api/deals/dedupe/route");

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Name, phone, source. No venue address, no event at all. */
const THIN = {
  contact_first_name: "Jordan",
  contact_phone: "215-555-0123",
  source: "walk_in",
  venue_address: "",
};

beforeEach(() => {
  db.state.rpcRows = [];
  db.state.dealRows = [];
  db.state.dealSelectError = null;
  db.state.dealSelects = [];
  db.state.inserts = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/deals without a venue address", () => {
  it("passes validation and returns the dry-run row with no address", async () => {
    const res = await createManual(post(THIN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(body.deal_insert.venue_address).toBeNull();
    expect(body.deal_insert.contact_first_name).toBe("Jordan");
    // Nothing to price yet, and it says so rather than queueing a job.
    expect(body.quote_jobs).toEqual([]);
    expect(body.quote_skipped).toBeTruthy();
  });

  it("writes the deal with venue_address NULL when writes are live", async () => {
    vi.stubEnv("CALL_DESK_DEAL_WRITES", "live");
    const res = await createManual(post(THIN));
    expect(res.status).toBe(200);
    expect((await res.json()).deal_id).toBe(99001);
    const inserted = db.state.inserts.find((i) => i.table === "deals");
    expect(inserted?.row.venue_address).toBeNull();
    expect(inserted?.row.source).toBe("walk_in");
  });
});

describe("POST /api/call-desk/deals is unchanged", () => {
  it("still refuses a deal with no venue address", async () => {
    const res = await createCallDesk(
      post({
        prospect_id: 126,
        contact_first_name: "Jordan",
        contact_email: "jordan@example.org",
        contact_phone: "215-555-0123",
        event_type: "Corporate",
        package_name: "Sundae Party",
        event_date: "2026-11-04",
        event_start_time: "14:00",
        event_end_time: "16:00",
        guest_count: 80,
        venue_address: "",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Object.keys(body.field_errors)).toEqual(["venue_address"]);
  });
});

describe("POST /api/deals/dedupe", () => {
  const rpcDeal = {
    kind: "deal",
    id: 25401,
    name: "Jordan Sample",
    company: "Wharton",
    email: "jordan@example.org",
    phone: "(215) 555-0123",
    stage: "Event Complete",
    event_date: "2025-11-04",
    matched_email: true,
    matched_phone: false,
  };
  const rpcProspect = {
    kind: "prospect",
    id: 126,
    name: "Jordan Sample",
    company: null,
    email: "jordan@example.org",
    phone: null,
    stage: null,
    event_date: null,
    matched_email: true,
    matched_phone: false,
  };

  it("attaches the matched deal's names, venue and recency", async () => {
    db.state.rpcRows = [rpcProspect, rpcDeal];
    db.state.dealRows = [
      {
        id: 25401,
        contact_first_name: "Jordan",
        contact_last_name: "Sample",
        venue_name: "Huntsman Hall",
        venue_address: "3730 Walnut St, Philadelphia, PA",
        updated_at: "2025-11-05T12:00:00",
        created_at: "2025-09-01T09:00:00",
      },
    ];
    const res = await dedupe(post({ email: "jordan@example.org" }));
    const body = await res.json();
    // One read, by id, of matched deals only.
    expect(db.state.dealSelects).toHaveLength(1);
    expect(db.state.dealSelects[0].ids).toEqual([25401]);
    const d = body.matches.find((m: { kind: string }) => m.kind === "deal");
    expect(d).toMatchObject({
      id: 25401,
      first_name: "Jordan",
      last_name: "Sample",
      venue_name: "Huntsman Hall",
      venue_address: "3730 Walnut St, Philadelphia, PA",
      touched_at: "2025-11-05T12:00:00",
    });
    const p = body.matches.find((m: { kind: string }) => m.kind === "prospect");
    expect(p.venue_address).toBeUndefined();
  });

  it("returns the bare matches if the details read fails", async () => {
    db.state.rpcRows = [rpcDeal];
    db.state.dealSelectError = { message: "permission denied" };
    const res = await dedupe(post({ email: "jordan@example.org" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].id).toBe(25401);
    expect("venue_address" in body.matches[0]).toBe(false);
  });

  it("does not read deals when only prospects matched", async () => {
    db.state.rpcRows = [rpcProspect];
    await dedupe(post({ email: "jordan@example.org" }));
    expect(db.state.dealSelects).toHaveLength(0);
  });
});
