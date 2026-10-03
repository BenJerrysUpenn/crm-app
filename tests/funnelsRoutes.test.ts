// The Funnels tab's two routes, end to end against a stand-in Supabase
// (bj-finance #422).
//
//   * GET /api/funnels returns the loop status, the funnel over the window the
//     URL asks for, and the exception queue; refuses a signed-out caller; and
//     tells "migration not run yet" (503) apart from a real failure (500).
//   * POST /api/funnels/suppress validates the prospect id and suppresses it
//     through the call desk's existing do-not-call RPC, surfacing its error.
//
// Supabase is the system boundary: the stand-in below holds rows per table and
// applies the filters a query chains, so the routes and lib/funnels run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => {
  const state = {
    user: { email: "manager@example.com" } as { email: string } | null,
    tables: {} as Record<string, Row[]>,
    tableErrors: {} as Record<string, { message: string; code?: string }>,
    // One read only, keyed "table:columns" as the route selects them.
    readErrors: {} as Record<string, { message: string; code?: string }>,
    rpcCalls: [] as Array<{ name: string; args: Row }>,
    rpcError: null as { message: string; code?: string } | null,
  };

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let head = false;
    let cols = "";
    let order: { col: string; asc: boolean } | null = null;
    let limit = Infinity;
    const q: any = {
      select(c: string, opts?: { head?: boolean }) {
        cols = c;
        head = !!opts?.head;
        return q;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return q;
      },
      neq(c: string, v: unknown) {
        filters.push((r) => r[c] !== v);
        return q;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return q;
      },
      gte(c: string, v: string) {
        filters.push((r) => String(r[c]) >= v);
        return q;
      },
      not(c: string, op: string, v: unknown) {
        if (op !== "is" || v !== null) throw new Error(`unexpected not ${op}`);
        filters.push((r) => r[c] != null);
        return q;
      },
      order(col: string, opts: { ascending: boolean }) {
        order = { col, asc: opts.ascending };
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        const err = state.tableErrors[table] ?? state.readErrors[`${table}:${cols}`];
        if (err) return Promise.resolve({ data: null, count: null, error: err }).then(resolve, reject);
        let rows = (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, b) =>
            asc
              ? String(a[col]).localeCompare(String(b[col]))
              : String(b[col]).localeCompare(String(a[col])),
          );
        }
        rows = rows.slice(0, limit);
        const out = head
          ? { data: null, count: rows.length, error: null }
          : { data: rows, count: null, error: null };
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return q;
  }

  const client = {
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => query(table),
    async rpc(name: string, args: Row) {
      state.rpcCalls.push({ name, args });
      return { data: null, error: state.rpcError };
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.client }));

const { GET } = await import("@/app/api/funnels/route");
const { POST: suppress } = await import("@/app/api/funnels/suppress/route");

const NOW = new Date("2026-09-25T16:00:00Z"); // Fri, noon in New York

function deal(id: number, over: Row): Row {
  return {
    id,
    stage: "New",
    archived: 0,
    contact_email: `d${id}@acme.com`,
    contact_first_name: null,
    contact_last_name: null,
    company: null,
    event_type: "Corporate",
    created_at: "2026-09-20T12:00:00Z",
    updated_at: "2026-09-20T12:00:00Z",
    total_with_tax: null,
    subtotal_pretax: null,
    signed_contract_total: null,
    gmail_thread_id: null,
    ...over,
  };
}

function get(window?: string): Promise<Response> {
  const url = new URL("http://localhost/api/funnels");
  if (window) url.searchParams.set("window", window);
  return GET(new NextRequest(url));
}

function post(body: string): Promise<Response> {
  return suppress(
    new NextRequest("http://localhost/api/funnels/suppress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.state.user = { email: "manager@example.com" };
  db.state.tableErrors = {};
  db.state.readErrors = {};
  db.state.rpcCalls = [];
  db.state.rpcError = null;
  db.state.tables = {
    deals: [
      // Created 5 days ago and booked: in the 7-day window.
      deal(1, { stage: "Booked Paid", signed_contract_total: 1200, created_at: "2026-09-20T12:00:00Z" }),
      // Created 20 days ago: only in the 30-day window.
      deal(2, { stage: "Sent Quote", signed_contract_total: 400, created_at: "2026-09-05T12:00:00Z" }),
      // Parked at Quote Review: a draft awaiting a human send.
      deal(3, {
        stage: "Quote Review",
        contact_first_name: "Dana",
        contact_last_name: "Lee",
        company: "Acme",
        event_type: "Corporate",
        gmail_thread_id: "thr-3",
        updated_at: "2026-09-24T16:00:00Z",
        created_at: "2026-09-24T12:00:00Z",
      }),
      // Archived: invisible to every panel.
      deal(4, { stage: "Quote Review", archived: 1, created_at: "2026-09-24T12:00:00Z" }),
    ],
    quote_jobs: [
      { deal_id: 1, kind: "quote", status: "done", processed_at: "2026-09-20T15:00:00Z" },
      // A later re-quote: latency runs to the EARLIEST done job.
      { deal_id: 1, kind: "quote", status: "done", processed_at: "2026-09-22T15:00:00Z" },
      { deal_id: 2, kind: "quote", status: "pending", processed_at: null },
      // A failed job never counts as a quote produced.
      { deal_id: 3, kind: "quote", status: "error", processed_at: "2026-09-24T13:00:00Z" },
    ],
    outreach_prospects: [
      { id: 10, name: "Ana", company: "Beta Co", email: "ana@beta.com", engine: "warm", status: "sequenced" },
      { id: 11, name: null, company: null, email: "bo@gamma.com", engine: "warm", status: "handed_off" },
      { id: 12, name: null, company: null, email: "cy@delta.com", engine: "cold", status: "queued" },
    ],
    outreach_events: [
      { prospect_id: 10, event: "added", occurred_at: "2026-09-01T00:00:00Z" },
      { prospect_id: 10, event: "sequenced", occurred_at: "2026-09-25T14:00:00Z" },
      { prospect_id: 10, event: "replied", occurred_at: "2026-09-25T15:00:00Z" },
      { prospect_id: 11, event: "sequenced", occurred_at: "2026-09-10T14:00:00Z" },
      { prospect_id: 11, event: "replied", occurred_at: "2026-09-11T14:00:00Z" },
      { prospect_id: 11, event: "unsubscribed", occurred_at: "2026-09-12T14:00:00Z" },
      // 22:00 on 09-24 in New York: yesterday there, though 09-25 in UTC.
      { prospect_id: 12, event: "sequenced", occurred_at: "2026-09-25T02:00:00Z" },
      // The newest row is an import, which is not engine activity.
      { prospect_id: 12, event: "added", occurred_at: "2026-09-25T15:30:00Z" },
    ],
    outreach_suppression: [{ email: "x@y.com" }],
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/funnels", () => {
  it("refuses a signed-out caller", async () => {
    db.state.user = null;
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("reports loop status from today's sends and the job and suppression tables", async () => {
    const { loop } = await (await get()).json();
    expect(loop.warm).toEqual({
      sent_today: 1, // prospect 10 mailed today in New York; 12 mailed yesterday there
      daily_cap: 20,
      sequenced_active: 1,
      last_activity_at: "2026-09-25T15:00:00Z",
    });
    expect(loop.cold).toEqual({ gate_passed: true, gate_date: "2026-09-24", queued: 1 });
    expect(loop.quote_jobs).toEqual({ pending: 1, running: 0, error: 1 });
    expect(loop.suppression).toEqual({ total: 1, opt_out_events: 1, prospects_total: 3 });
  });

  it("fails loudly when the last-activity read fails, rather than reporting no activity", async () => {
    db.state.readErrors["outreach_events:occurred_at"] = { message: "connection reset", code: "08006" };
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "connection reset", migration_missing: false });
  });

  it("reports the cold lane's domain-age gate as not passed before its date", async () => {
    vi.setSystemTime(new Date("2026-09-20T16:00:00Z"));
    const { loop } = await (await get()).json();
    expect(loop.cold).toMatchObject({ gate_passed: false, gate_date: "2026-09-24" });
  });

  it("counts today's sends from Eastern midnight on the day the clocks go back", async () => {
    // 2026-11-01: midnight in New York is still EDT (04:00Z); 11:00 EST now.
    vi.setSystemTime(new Date("2026-11-01T16:00:00Z"));
    db.state.tables.outreach_events = [
      // 23:30 on Oct 31 in New York: yesterday.
      { prospect_id: 10, event: "sequenced", occurred_at: "2026-11-01T03:30:00Z" },
      // 00:30 on Nov 1 in New York: today.
      { prospect_id: 11, event: "sequenced", occurred_at: "2026-11-01T04:30:00Z" },
    ];
    const { loop } = await (await get()).json();
    expect(loop.warm.sent_today).toBe(1);
  });

  it("computes the funnel over the window the URL asks for", async () => {
    const week = (await (await get("7")).json()).funnel;
    expect(week.window).toBe("7");
    expect(week.window_start).toBe("2026-09-18T16:00:00.000Z");
    const weekAll = week.deal_funnel.find((r: Row) => r.profile === "__all__");
    expect(weekAll).toMatchObject({ created: 2, quoted: 1, booked: 1, booked_value: 1200 });
    expect(week.quote_latency).toMatchObject({ count: 1, median_hours: 3 });
    expect(week.outreach.find((r: Row) => r.engine === "warm").sent).toBe(1);

    const month = (await (await get()).json()).funnel; // default window is 30 days
    expect(month.window).toBe("30");
    const monthAll = month.deal_funnel.find((r: Row) => r.profile === "__all__");
    expect(monthAll).toMatchObject({ created: 3, quoted: 2, booked: 1, quoted_value: 1600 });
    expect(month.outreach.find((r: Row) => r.engine === "warm").sent).toBe(2);
  });

  it("queues Quote Review drafts and unhandled replies, not handed-off ones", async () => {
    const { exceptions } = await (await get()).json();
    expect(exceptions.drafts_awaiting_send).toEqual([
      {
        kind: "draft_awaiting_send",
        id: "draft-3",
        deal_id: 3,
        title: "Dana Lee",
        subtitle: "Corporate · Acme",
        age_hours: 24,
        gmail_thread_id: "thr-3",
        email: "d3@acme.com",
      },
    ]);
    expect(exceptions.replies_awaiting_handling).toEqual([
      {
        kind: "reply_awaiting_handling",
        id: "reply-10",
        prospect_id: 10,
        title: "Ana",
        subtitle: "Beta Co",
        age_hours: 1,
        email: "ana@beta.com",
      },
    ]);
  });

  it("leaves a suppressed prospect's reply out of the queue", async () => {
    db.state.tables.outreach_prospects.push(
      { id: 13, name: "Sue", company: null, email: "sue@eps.com", engine: "warm", status: "suppressed" },
    );
    db.state.tables.outreach_events.push(
      { prospect_id: 13, event: "replied", occurred_at: "2026-09-25T12:00:00Z" },
    );
    const { exceptions } = await (await get()).json();
    expect(exceptions.replies_awaiting_handling.map((r: Row) => r.prospect_id)).toEqual([10]);
  });

  it("lists the longest-waiting reply first, aged from its newest reply", async () => {
    db.state.tables.outreach_prospects.push(
      { id: 14, name: "Raj", company: null, email: "raj@zeta.com", engine: "cold", status: "sequenced" },
    );
    db.state.tables.outreach_events.push(
      // An "interested" reply queues like a plain one.
      { prospect_id: 14, event: "interested", occurred_at: "2026-09-20T16:00:00Z" },
      { prospect_id: 14, event: "interested", occurred_at: "2026-09-23T16:00:00Z" },
    );
    const { exceptions } = await (await get()).json();
    expect(
      exceptions.replies_awaiting_handling.map((r: Row) => [r.prospect_id, r.age_hours]),
    ).toEqual([
      [14, 48],
      [10, 1],
    ]);
  });

  it.each([
    { message: "undefined table", code: "42P01" },
    { message: "insufficient privilege", code: "42501" },
    { message: "table not found", code: "PGRST205" },
    { message: 'relation "outreach_events" does not exist', code: undefined },
    { message: "Could not find the table in the schema cache", code: undefined },
    { message: "permission denied for table outreach_events", code: undefined },
  ])("answers 503 with migration_missing when the outreach tables are not there yet: %j", async (err) => {
    db.state.tableErrors.outreach_events = err;
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: err.message,
      code: err.code ?? null,
      migration_missing: true,
    });
  });

  it("answers 500 without migration_missing on any other failure", async () => {
    db.state.tableErrors.deals = { message: "connection reset", code: "08006" };
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "connection reset",
      migration_missing: false,
    });
  });
});

describe("POST /api/funnels/suppress", () => {
  it("refuses a signed-out caller and suppresses nothing", async () => {
    db.state.user = null;
    const res = await post(JSON.stringify({ prospect_id: 10 }));
    expect(res.status).toBe(401);
    expect(db.state.rpcCalls).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(db.state.rpcCalls).toEqual([]);
  });

  it.each([{}, { prospect_id: 0 }, { prospect_id: -3 }, { prospect_id: 1.5 }, { prospect_id: "abc" }])(
    "rejects a prospect id that is not a positive integer: %j",
    async (body) => {
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(db.state.rpcCalls).toEqual([]);
    },
  );

  it.each(["null", "42", "[]", '"10"'])(
    "answers a JSON body that is not an object with the same 400 as a missing id: %s",
    async (raw) => {
      const res = await post(raw);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "prospect_id required" });
      expect(db.state.rpcCalls).toEqual([]);
    },
  );

  it("suppresses through the call desk's do-not-call RPC", async () => {
    const res = await post(JSON.stringify({ prospect_id: 10 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.state.rpcCalls).toEqual([
      { name: "call_desk_do_not_call", args: { p_prospect_id: 10, p_call_event_id: null } },
    ]);
  });

  it("surfaces the RPC's error as a 500", async () => {
    db.state.rpcError = { message: "permission denied for function", code: "42501" };
    const res = await post(JSON.stringify({ prospect_id: 10 }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "permission denied for function",
      code: "42501",
    });
  });
});
