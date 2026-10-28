// A small in-memory stand-in for the supabase-js query builder: enough of
// select / insert / update / delete with eq, is and in filters, order, and
// maybeSingle for the event-change store to run against real rows. A filter
// that is not implemented throws, so a store that starts using one fails
// loudly instead of matching everything.

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export type FakeDb = {
  tables: Record<string, Row[]>;
  /** table -> message: the next write to that table fails with it. */
  failWrites: Record<string, string>;
  /** table -> message: the next read of that table fails with it. */
  failReads: Record<string, string>;
  /**
   * table -> columns it does not have: an update naming one is refused with
   * PostgREST's PGRST204, as a database short of a migration answers.
   */
  missingColumns: Record<string, string[]>;
  nextId: Record<string, number>;
};

type FakeError = { message: string; code?: string };

export function makeFakeDb(): FakeDb {
  return { tables: {}, failWrites: {}, failReads: {}, missingColumns: {}, nextId: {} };
}

function builder(db: FakeDb, table: string) {
  const filters: Filter[] = [];
  let op: "select" | "update" | "delete" | "insert" = "select";
  let patch: Row = {};
  let inserted: Row[] = [];
  let returning = false;
  let orderBy: { col: string; asc: boolean } | null = null;

  const rows = () => (db.tables[table] ??= []);

  function run(): { data: unknown; error: FakeError | null } {
    if (op === "update") {
      const missing = (db.missingColumns[table] ?? []).find((c) => c in patch);
      if (missing) {
        return {
          data: null,
          error: { code: "PGRST204", message: `Could not find the '${missing}' column of '${table}' in the schema cache` },
        };
      }
    }
    if (op === "select" && db.failReads[table]) {
      const message = db.failReads[table];
      delete db.failReads[table];
      return { data: null, error: { message } };
    }
    if (op !== "select" && db.failWrites[table]) {
      const message = db.failWrites[table];
      delete db.failWrites[table];
      return { data: null, error: { message } };
    }
    if (op === "insert") {
      for (const r of inserted) {
        const id = (db.nextId[table] = (db.nextId[table] ?? 1000) + 1);
        rows().push({ id, ...r });
      }
      return { data: null, error: null };
    }
    const matched = rows().filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of matched) Object.assign(r, patch);
      return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null };
    }
    if (op === "delete") {
      db.tables[table] = rows().filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    const out = matched.map((r) => ({ ...r }));
    if (orderBy) {
      const { col, asc } = orderBy;
      out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    return { data: out, error: null };
  }

  const b = {
    select(_cols?: string) {
      if (op !== "select") returning = true;
      return b;
    },
    insert(r: Row | Row[]) {
      op = "insert";
      inserted = Array.isArray(r) ? r : [r];
      return b;
    },
    update(p: Row) {
      op = "update";
      patch = p;
      return b;
    },
    delete() {
      op = "delete";
      return b;
    },
    eq(col: string, v: unknown) {
      filters.push((r) => r[col] === v);
      return b;
    },
    is(col: string, v: null) {
      if (v !== null) throw new Error("fake supabase: is() only supports null");
      filters.push((r) => r[col] == null);
      return b;
    },
    in(col: string, vs: unknown[]) {
      filters.push((r) => vs.includes(r[col]));
      return b;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderBy = { col, asc: opts?.ascending !== false };
      return b;
    },
    async maybeSingle() {
      const { data, error } = run();
      return { data: Array.isArray(data) ? data[0] ?? null : null, error };
    },
    async single() {
      const { data, error } = run();
      return { data: Array.isArray(data) ? data[0] ?? null : null, error };
    },
    then<T>(resolve: (v: { data: unknown; error: FakeError | null }) => T, reject?: (e: unknown) => T) {
      try {
        return Promise.resolve(run()).then(resolve, reject);
      } catch (e) {
        return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
      }
    },
  };
  return b;
}

export function fakeClient(db: FakeDb, user: () => { id: string; email?: string } | null) {
  return {
    auth: { getUser: async () => ({ data: { user: user() } }) },
    from: (table: string) => builder(db, table),
  };
}
