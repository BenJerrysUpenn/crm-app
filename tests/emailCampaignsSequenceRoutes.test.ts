// The shared sequence copy's routes, end to end against a stand-in Supabase
// (supabase/crm/013). Only the database client is faked: the routes run the
// real sequenceRepoForRequest and supabaseSequenceRepo.
//
//   * POST /api/email-campaigns/sequences/rescue applies the rescue rules
//     end to end: blank skipped, new saved, different kept as a conflict.
//   * PUT saves one row; DELETE (reset) removes it so the seed shows again.
//   * Both refuse a caller who is not signed in, and a bad key.
//   * supabaseSequenceRepo treats a unique violation as "a row is already
//     there" (insert) and "this copy is already kept" (conflict), never as
//     a reason to overwrite; any other database error reaches the caller.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLane, resolveSequence } from "@/lib/emailCampaignsPrototype/sharedSequences";
import { SEED_SEQUENCES } from "@/lib/emailCampaignsPrototype/sequences";

type PgError = { code: string; message: string };

// The three crm/013 tables, with the constraints the repo relies on: the
// primary keys, and the conflicts table's unique index on (kind, key, doc).
const db = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  // JSON with sorted object keys: stands in for md5(doc::text), since jsonb
  // stores object keys in its own order.
  const sorted = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(sorted).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${sorted((v as Row)[k])}`)
            .join(",")}}`
        : JSON.stringify(v ?? null);
  const UNIQUE: Record<string, (r: Row) => string> = {
    email_campaign_sequences: (r) => String(r.key),
    email_campaign_lane_blocks: (r) => String(r.tier),
    email_campaign_sequence_conflicts: (r) => `${r.kind}|${r.key}|${sorted(r.doc)}`,
  };
  const state = {
    tables: {} as Record<string, Row[]>,
    signedIn: true,
    /** The next statement on this table fails with this error. */
    failNext: {} as Record<string, { code: string; message: string }>,
    /** Runs just before an insert lands (another manager's write, say). */
    beforeInsert: null as null | ((table: string) => void),
  };
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const rowsOf = (t: string) => (state.tables[t] ??= []);
  const takeFailure = (t: string) => {
    const e = state.failNext[t];
    delete state.failNext[t];
    return e ?? null;
  };
  const pick = (r: Row, cols: string) => Object.fromEntries(cols.split(",").map((c) => [c, clone(r[c] ?? null)]));

  function from(table: string) {
    const filters: [string, unknown][] = [];
    let cols = "*";
    let op: "select" | "delete" = "select";
    const matching = () => rowsOf(table).filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
    const run = (): { data: unknown; error: PgError | null } => {
      const error = takeFailure(table);
      if (error) return { data: null, error };
      if (op === "delete") {
        const gone = matching();
        state.tables[table] = rowsOf(table).filter((r) => !gone.includes(r));
        return { data: null, error: null };
      }
      return { data: matching().map((r) => pick(r, cols)), error: null };
    };
    const b = {
      select(c: string) {
        cols = c;
        return b;
      },
      delete() {
        op = "delete";
        return b;
      },
      eq(c: string, v: unknown) {
        filters.push([c, v]);
        return b;
      },
      is(c: string, v: unknown) {
        filters.push([c, v]);
        return b;
      },
      order() {
        return b;
      },
      async maybeSingle() {
        const r = run();
        return r.error ? r : { data: (r.data as unknown[])[0] ?? null, error: null };
      },
      then<T>(ok: (v: ReturnType<typeof run>) => T, bad?: (e: unknown) => T) {
        return Promise.resolve(run()).then(ok, bad);
      },
      async insert(row: Row) {
        state.beforeInsert?.(table);
        state.beforeInsert = null;
        const error = takeFailure(table);
        if (error) return { error };
        const id = UNIQUE[table](row);
        if (rowsOf(table).some((r) => UNIQUE[table](r) === id))
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        rowsOf(table).push({ resolved_at: null, ...clone(row) });
        return { error: null };
      },
      async upsert(row: Row) {
        const error = takeFailure(table);
        if (error) return { error };
        const id = UNIQUE[table](row);
        state.tables[table] = [...rowsOf(table).filter((r) => UNIQUE[table](r) !== id), clone(row)];
        return { error: null };
      },
    };
    return b;
  }

  const client = {
    auth: {
      getUser: async () => ({ data: { user: state.signedIn ? { id: "user-1" } : null } }),
    },
    from,
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.client }));

const { POST: rescuePOST } = await import("@/app/api/email-campaigns/sequences/rescue/route");
const { DELETE, PUT } = await import("@/app/api/email-campaigns/sequences/route");
const { supabaseSequenceRepo } = await import("@/lib/emailCampaignsPrototype/sequenceRepo");

const SEQ = "email_campaign_sequences";
const LANE = "email_campaign_lane_blocks";
const CONFLICT = "email_campaign_sequence_conflicts";

const repo = () => supabaseSequenceRepo(db.client as never);
const fail = (table: string, error: PgError) => (db.state.failNext[table] = error);

const req = (method: string, body: unknown) =>
  new Request("http://localhost/api/email-campaigns/sequences", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const work = { name: "Corporate", steps: [{ id: "a", waitDays: 0, subject: "Hello", body: "Real work" }] };
const other = { name: "Corporate", steps: [{ id: "b", waitDays: 0, subject: "Hi", body: "Other work" }] };
const blank = { name: "", steps: [{ id: "c", waitDays: 0, subject: "", body: "" }] };

beforeEach(() => {
  db.state.tables = {};
  db.state.signedIn = true;
  db.state.failNext = {};
  db.state.beforeInsert = null;
});

describe("POST /api/email-campaigns/sequences/rescue", () => {
  it("skips the blank copy, saves the new one, keeps the different one as a conflict", async () => {
    await repo().put("sequence", "warm:wedding", work, "someone");
    const res = await rescuePOST(
      req("POST", {
        items: [
          { kind: "sequence", key: "warm:corporate", doc: blank },
          { kind: "sequence", key: "warm:school", doc: work },
          { kind: "sequence", key: "warm:wedding", doc: other },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { outcomes } = (await res.json()) as { outcomes: { key: string; result: string }[] };
    expect(outcomes.map((o) => `${o.key}=${o.result}`)).toEqual([
      "warm:corporate=blank",
      "warm:school=saved",
      "warm:wedding=conflict",
    ]);
    const s = await repo().load();
    expect(Object.keys(s.sequences).sort()).toEqual(["warm:school", "warm:wedding"]);
    expect(s.sequences["warm:wedding"]).toEqual(work);
    expect(s.conflicts.map((c) => `${c.kind}:${c.key}`)).toEqual(["sequence:warm:wedding"]);
  });

  it("keeps the other manager's row when their insert lands between the read and this one", async () => {
    db.state.beforeInsert = () =>
      db.state.tables[SEQ].push({ key: "warm:school", name: other.name, steps: other.steps });
    db.state.tables[SEQ] = [];
    const res = await rescuePOST(req("POST", { items: [{ kind: "sequence", key: "warm:school", doc: work }] }));
    const { outcomes } = (await res.json()) as { outcomes: { result: string }[] };
    expect(outcomes.map((o) => o.result)).toEqual(["conflict"]);
    expect((await repo().load()).sequences["warm:school"]).toEqual(other);
    expect(db.state.tables[CONFLICT]).toEqual([
      expect.objectContaining({ key: "warm:school", doc: work, shared_doc: { name: other.name, steps: other.steps } }),
    ]);
  });

  it("does nothing when the other manager's racing insert was the same copy", async () => {
    db.state.beforeInsert = () =>
      db.state.tables[SEQ].push({ key: "warm:school", name: work.name, steps: work.steps });
    db.state.tables[SEQ] = [];
    const res = await rescuePOST(req("POST", { items: [{ kind: "sequence", key: "warm:school", doc: work }] }));
    const { outcomes } = (await res.json()) as { outcomes: { result: string }[] };
    expect(outcomes.map((o) => o.result)).toEqual(["same"]);
    expect((await repo().load()).conflicts).toEqual([]);
  });

  it("refuses a caller who is not signed in", async () => {
    db.state.signedIn = false;
    const res = await rescuePOST(req("POST", { items: [{ kind: "sequence", key: "warm:school", doc: work }] }));
    expect(res.status).toBe(401);
    expect((await repo().load()).sequences).toEqual({});
  });

  it("refuses a body without an items array, or with more than 500 items", async () => {
    expect((await rescuePOST(req("POST", { items: "x" }))).status).toBe(400);
    const items = Array.from({ length: 501 }, (_, i) => ({ kind: "sequence", key: `warm:k${i}`, doc: work }));
    expect((await rescuePOST(req("POST", { items }))).status).toBe(400);
    expect((await repo().load()).sequences).toEqual({});
  });

  it("answers 500 with the database's message when a write fails", async () => {
    fail(SEQ, { code: "42501", message: "permission denied for table email_campaign_sequences" });
    const res = await rescuePOST(req("POST", { items: [{ kind: "sequence", key: "warm:school", doc: work }] }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission denied/);
  });
});

describe("PUT and DELETE /api/email-campaigns/sequences", () => {
  it("saves a sequence, and reset deletes the row so the seed shows again", async () => {
    let res = await PUT(req("PUT", { kind: "sequence", key: "cold:everyone", doc: work }));
    expect(res.status).toBe(200);
    expect(resolveSequence(await repo().load(), "cold:everyone")).toEqual(work);
    res = await DELETE(req("DELETE", { kind: "sequence", key: "cold:everyone" }));
    expect(res.status).toBe(200);
    const s = await repo().load();
    expect(s.sequences).toEqual({});
    expect(resolveSequence(s, "cold:everyone")).toBe(SEED_SEQUENCES["cold:everyone"]);
  });

  it("saves over an existing row: last write wins", async () => {
    await PUT(req("PUT", { kind: "sequence", key: "warm:school", doc: work }));
    await PUT(req("PUT", { kind: "sequence", key: "warm:school", doc: other }));
    expect((await repo().load()).sequences).toEqual({ "warm:school": other });
  });

  it("saves a lane's signature and footer, and the page reads them back for that tier only", async () => {
    const res = await PUT(req("PUT", { kind: "lane", key: "warm", doc: { signature: "S", footer: "F" } }));
    expect(res.status).toBe(200);
    const s = await repo().load();
    expect(resolveLane(s, "warm")).toEqual({ signature: "S", footer: "F" });
    expect(s.lanes.cold).toBeUndefined();
  });

  it("refuses a bad key or document", async () => {
    expect((await PUT(req("PUT", { kind: "sequence", key: "nope", doc: work }))).status).toBe(400);
    expect((await PUT(req("PUT", { kind: "lane", key: "pink", doc: { signature: "", footer: "" } }))).status).toBe(400);
    expect((await PUT(req("PUT", { kind: "sequence", key: "warm:x", doc: { steps: 3 } }))).status).toBe(400);
    expect((await DELETE(req("DELETE", { kind: "table", key: "warm:x" }))).status).toBe(400);
    const s = await repo().load();
    expect([s.sequences, s.lanes]).toEqual([{}, {}]);
  });

  it("refuses a caller who is not signed in", async () => {
    await repo().put("sequence", "warm:x", work, "someone");
    db.state.signedIn = false;
    expect((await PUT(req("PUT", { kind: "sequence", key: "warm:x", doc: other }))).status).toBe(401);
    expect((await DELETE(req("DELETE", { kind: "sequence", key: "warm:x" }))).status).toBe(401);
    expect((await repo().load()).sequences).toEqual({ "warm:x": work });
  });

  it("answers 500 with the database's message when the save or reset fails", async () => {
    fail(SEQ, { code: "42501", message: "new row violates row-level security policy" });
    let res = await PUT(req("PUT", { kind: "sequence", key: "warm:x", doc: work }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/row-level security/);
    fail(LANE, { code: "42501", message: "permission denied" });
    res = await DELETE(req("DELETE", { kind: "lane", key: "warm" }));
    expect(res.status).toBe(500);
  });
});

describe("supabaseSequenceRepo", () => {
  it("insertIfAbsent answers false on an existing row and leaves that row as it was", async () => {
    await repo().put("sequence", "warm:corporate", other, "first");
    expect(await repo().insertIfAbsent("sequence", "warm:corporate", work, "u")).toBe(false);
    expect((await repo().load()).sequences["warm:corporate"]).toEqual(other);
  });

  it("insertIfAbsent answers true when the insert goes through, with who saved it", async () => {
    expect(await repo().insertIfAbsent("sequence", "warm:corporate", work, "u")).toBe(true);
    expect(db.state.tables[SEQ]).toEqual([
      expect.objectContaining({ key: "warm:corporate", name: "Corporate", steps: work.steps, updated_by: "u" }),
    ]);
  });

  it("insertIfAbsent throws on any error other than a unique violation", async () => {
    fail(SEQ, { code: "42501", message: "denied" });
    await expect(repo().insertIfAbsent("sequence", "warm:corporate", work, "u")).rejects.toThrow(/denied/);
  });

  it("recordConflict keeps the same browser copy once, however often it is sent", async () => {
    for (let i = 0; i < 3; i++) await repo().recordConflict("sequence", "warm:x", work, other, "u");
    expect((await repo().load()).conflicts.map((c) => c.key)).toEqual(["warm:x"]);
  });

  it("recordConflict throws on any error other than a unique violation", async () => {
    fail(CONFLICT, { code: "42501", message: "denied" });
    await expect(repo().recordConflict("sequence", "warm:x", work, other, "u")).rejects.toThrow(/denied/);
  });

  it("load shows only the conflicts nobody has resolved", async () => {
    db.state.tables[CONFLICT] = [
      { kind: "sequence", key: "warm:x", doc: work, created_at: "2026-10-20T12:00:00Z", resolved_at: null },
      {
        kind: "lane",
        key: "cold",
        doc: { signature: "a", footer: "" },
        created_at: "2026-10-19T12:00:00Z",
        resolved_at: "2026-10-20T09:00:00Z",
      },
    ];
    expect((await repo().load()).conflicts).toEqual([
      { kind: "sequence", key: "warm:x", created_at: "2026-10-20T12:00:00Z" },
    ]);
  });

  it("load throws when a table cannot be read, so the page can say so", async () => {
    fail(LANE, { code: "42P01", message: 'relation "email_campaign_lane_blocks" does not exist' });
    await expect(repo().load()).rejects.toThrow(/does not exist/);
  });
});
