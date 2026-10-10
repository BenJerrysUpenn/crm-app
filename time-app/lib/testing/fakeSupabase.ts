// A stand-in for the Supabase project, at the HTTP boundary, so route handlers
// can be driven the way a phone drives them. Test support only: nothing under
// app/ or lib/ outside lib/testing imports this.
//
// What is real: the route handler, every lib module it calls, supabase-js and
// @supabase/ssr. What is faked: `fetch` (the network to Supabase) and the
// request's cookies (next/headers, which only exists inside Next's server).
//
// The fake speaks just enough PostgREST for the routes under test (eq / gte /
// lte / is / in filters and not.<filter>, order, limit and offset, single, maybeSingle, a head
// request's exact count, insert and update with return=representation, and
// the database functions in RPC below) and answers /auth/v1/user from the session cookie.
// Row Level Security is emulated for time_entries only, with the policies
// migrations 12 and 30 install (supabase/migration_30_verify.sql proves those
// against a real Postgres): anyone signed in reads their own punches, only a
// manager inserts, updates or deletes one through their session, and the
// service role is not held to RLS. travel_reimbursements and lyft_ride_reports
// (migration 37) are read as their policies say: your own, or all for a
// manager. shift_notices and shift_digests (migration 38) are the service
// role's alone. Every other table is readable by any signed-in caller.
//
// Storage (migration 37's travel-reimbursements bucket) is faked too: signed
// upload URLs, signed read URLs and downloads, under the bucket's policies
// (your own folder; a manager reads all and alone writes under adjustments/).
// Any other origin (Resend, Twilio, Google) goes to `external`, which a test sets.

import * as nodeModule from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TIME = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SUPABASE_URL = "http://fake-project.supabase.test";
export const ANON_KEY = "fake-anon-key";
export const SERVICE_KEY = "fake-service-role-key";
// The database's now(): what a column default stamps.
export const DB_NOW = "2026-09-28T14:00:00.000Z";

type Row = Record<string, unknown>;
type Caller = { kind: "service" } | { kind: "anon" } | { kind: "user"; id: string };

export type FakeSupabase = {
  tables: Record<string, Row[]>;
  // Runs before each write reaches the "database" (with the table, or
  // "rpc/<name>" for a database function): lets a test move the world
  // underneath the route between its read and its write, as a fob tap would.
  beforeWrite: ((table: string) => void) | null;
  // Columns a migration has not added yet, per table. A write naming one is
  // refused as hosted PostgREST does (PGRST204, "schema cache"); seed the rows
  // without the column too, as select("*") would return them.
  missingColumns: Record<string, string[]>;
  // Tables a migration has not created yet: every request to one is refused
  // as hosted PostgREST does (PGRST205, "schema cache").
  missingTables: string[];
  // Storage objects, keyed "<bucket>/<path>". A signed upload URL does not
  // create one; a test puts the bytes here as the browser's upload would.
  storage: Record<string, Uint8Array>;
  // Paths a signed upload URL was minted for, as "<bucket>/<path>".
  signedUploads: string[];
  // Requests to any origin but Supabase's. Null: such a request fails the test.
  external: ((request: Request) => Response | Promise<Response>) | null;
  // auth.users emails by user id, for emailForUser (lib/notify.ts). Nobody
  // listed here has an email, so their notifications go by text or not at all.
  emails: Record<string, string>;
  signIn(userId: string): void;
  // The Cookie header a browser with this session sends (for middleware).
  cookieHeader(): string;
  rows(table: string): Row[];
};

let cookieJar = new Map<string, string>();
let tokens = new Map<string, string>(); // access token -> user id
let fake: FakeSupabase;

// ---- module resolution: the "@/..." alias, extensionless imports, next/* ---
type Resolved = { url: string; shortCircuit?: boolean };
type ResolveHook = (
  specifier: string,
  context: { parentURL?: string },
  next: (specifier: string, context: { parentURL?: string }) => Resolved,
) => Resolved;
type LoadHook = (
  url: string,
  context: object,
  next: (url: string, context: object) => { format?: string; source?: unknown },
) => { format?: string; source?: unknown; shortCircuit?: boolean };
// module.registerHooks is in Node 22.15+, newer than the @types/node this app pins.
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: { resolve: ResolveHook; load: LoadHook }) => void;
};

// Node strips TypeScript types itself but does not compile JSX, so a component
// (.tsx) under test is transpiled with the app's own TypeScript on the way in.
let typescript: typeof import("typescript") | null = null;
function compileTsx(file: string): string {
  typescript ??= nodeModule.createRequire(import.meta.url)("typescript") as typeof import("typescript");
  return typescript.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      jsx: typescript.JsxEmit.ReactJSX,
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
}

function asTsFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

let hooksRegistered = false;
function registerResolveHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/headers") {
        return { url: pathToFileURL(join(TIME, "lib", "testing", "nextHeaders.ts")).href, shortCircuit: true };
      }
      if (specifier === "next/server") return next("next/server.js", context);
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
      if (parent && parent.startsWith(TIME) && !parent.includes("node_modules")) {
        const base = specifier.startsWith("@/")
          ? join(TIME, specifier.slice(2))
          : specifier.startsWith(".")
            ? join(dirname(parent), specifier)
            : null;
        const file = base && asTsFile(base);
        if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith("file:") && url.endsWith(".tsx")) {
        return { format: "module", source: compileTsx(fileURLToPath(url)), shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

// Imports a module of this app (e.g. "app/api/clock/route.ts") the way Next
// would, against the fake project.
export async function loadAppModule<T>(relPath: string): Promise<T> {
  registerResolveHooks();
  return (await import(pathToFileURL(join(TIME, relPath)).href)) as T;
}

// ---- cookies (read by the fake next/headers) --------------------------------
export function requestCookies() {
  return {
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => void cookieJar.set(name, value),
  };
}

// ---- the fake PostgREST + GoTrue --------------------------------------------
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function callerOf(headers: Headers): Caller {
  const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (token === SERVICE_KEY) return { kind: "service" };
  const id = tokens.get(token);
  return id ? { kind: "user", id } : { kind: "anon" };
}

function isManager(caller: Caller): boolean {
  if (caller.kind !== "user") return false;
  return fake.tables.profiles?.some((p) => p.id === caller.id && p.role === "manager") ?? false;
}

const OWN_ROWS: Record<string, string> = {
  time_entries: "employee_id",
  travel_reimbursements: "profile_id",
  lyft_ride_reports: "profile_id",
};

// Migration 38: no API role but the service role touches these.
const SERVICE_ONLY = ["shift_notices", "shift_digests"];

function canRead(table: string, caller: Caller, row: Row): boolean {
  if (caller.kind === "service") return true;
  if (caller.kind === "anon" || SERVICE_ONLY.includes(table)) return false;
  const owner = OWN_ROWS[table];
  if (owner) return row[owner] === caller.id || isManager(caller);
  return true;
}

function canWrite(table: string, caller: Caller): boolean {
  if (caller.kind === "service") return true;
  if (caller.kind === "anon" || SERVICE_ONLY.includes(table)) return false;
  if (table === "time_entries") return isManager(caller);
  return true;
}

function compare(a: unknown, b: string): number {
  const x = String(a);
  return x < b ? -1 : x > b ? 1 : 0;
}

function matchesOne(cell: unknown, col: string, cond: string): boolean {
  const dot = cond.indexOf(".");
  const op = cond.slice(0, dot);
  const val = cond.slice(dot + 1);
  if (op === "not") return !matchesOne(cell, col, val);
  if (op === "in") {
    const list = val.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, ""));
    return cell !== null && cell !== undefined && list.includes(String(cell));
  }
  return (
      op === "eq" ? cell !== null && cell !== undefined && String(cell) === val
      : op === "neq" ? String(cell) !== val
      : op === "is" ? (val === "null" ? cell === null || cell === undefined : String(cell) === val)
      : op === "gte" ? cell != null && compare(cell, val) >= 0
      : op === "lte" ? cell != null && compare(cell, val) <= 0
      : op === "gt" ? cell != null && compare(cell, val) > 0
      : op === "lt" ? cell != null && compare(cell, val) < 0
      : (() => { throw new Error(`fake PostgREST: unsupported filter ${col}=${cond}`); })()
  );
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [col, cond] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(col)) continue;
    if (!matchesOne(row[col], col, cond)) return false;
  }
  return true;
}

// order=col.desc,col2.asc (nulls last either way, as Postgres does for asc).
function sortBy(rows: Row[], order: string): Row[] {
  const keys = order.split(",").map((term) => {
    const [col, dir] = term.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { col, sign } of keys) {
      const x = a[col];
      const y = b[col];
      if (x == null || y == null) {
        if (x == null && y == null) continue;
        return x == null ? 1 : -1;
      }
      const c = typeof x === "number" && typeof y === "number" ? x - y : compare(x, String(y));
      if (c !== 0) return sign * c;
    }
    return 0;
  });
}

function represent(rows: Row[], headers: Headers, status: number): Response {
  if (headers.get("accept")?.startsWith("application/vnd.pgrst.object+json")) {
    if (rows.length !== 1) {
      return json(406, {
        code: "PGRST116",
        details: `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      });
    }
    return json(status, rows[0]);
  }
  return json(status, rows);
}

const DEFAULTS: Record<string, () => Row> = {
  // Migration 37's column defaults.
  travel_reimbursements: () => ({
    status: "submitted", stops: null, start_at_store: null, end_at_store: null, route_legs: null, tolls_cents: 0, parking_cents: 0,
    mileage_cents_override: null, receipt_paths: [], no_receipt_confirmed: false, rejection_reason: null,
    decided_by: null, decided_at: null, paid_on: null, paid_by: null, receipts_emailed_at: null,
    deal_id: null, event_label: null, event_date: null, reason_note: null,
    submitted_at: DB_NOW, created_at: DB_NOW, updated_at: DB_NOW,
  }),
  travel_reimbursement_adjustments: () => ({ adjusted_at: DB_NOW }),
  lyft_ride_reports: () => ({ filed_at: DB_NOW, emailed_at: null, deal_id: null, event_label: null, event_date: null, reason_note: null }),
  time_entries: () => ({ clock_in_at: DB_NOW, clock_out_at: null, status: "open", manual: false }),
  // Migration 36's column defaults: a new pay table row is a queued request.
  payroll_sheets: () => ({ status: "queued", requested_at: DB_NOW, started_at: null, built_at: null, built_by: null, source_fingerprint: null, open_items: null, error: null, sheet: null }),
};

// ---- database functions (POST /rest/v1/rpc/<name>) ------------------------------
// Each as its migration defines it, reduced to what the routes rely on; the
// SQL itself is proven against Postgres by its migration's _verify.sql.
const RPC: Record<string, (args: Row, caller: Caller) => Response> = {
  // Migration 37: an Adjustment, all or nothing. The row must be as the
  // Approver saw it (updated_at); otherwise nothing is written and it returns null.
  adjust_travel_reimbursement(args, caller) {
    if (!isManager(caller)) {
      return json(403, { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "travel_reimbursement_adjustments"' });
    }
    const row = fake.tables.travel_reimbursements?.find((r) => r.id === args.p_id && r.updated_at === args.p_seen_updated_at);
    if (!row) return json(200, null);
    const column = { mileage: "mileage_cents_override", tolls: "tolls_cents", parking: "parking_cents" }[String(args.p_field)];
    if (!column) return json(400, { code: "23514", details: null, hint: null, message: "new row violates check constraint" });
    Object.assign(row, { [column]: args.p_new_cents, updated_at: new Date().toISOString() });
    const adjustments = (fake.tables.travel_reimbursement_adjustments ??= []);
    const adjustment: Row = {
      ...DEFAULTS.travel_reimbursement_adjustments(),
      id: adjustments.length + 1,
      reimbursement_id: args.p_id,
      field: args.p_field,
      old_cents: args.p_old_cents,
      new_cents: args.p_new_cents,
      note: args.p_note,
      evidence_path: args.p_evidence_path,
      adjusted_by: (caller as { id: string }).id,
    };
    adjustments.push(adjustment);
    return json(200, { reimbursement: row, adjustment });
  },
  // Migration 38: claim today's 8pm shift summaries. Each person with queued
  // shift notices and no summary yet for p_day gets one: their notices are
  // taken off the queue and returned. Anyone already summarised that day keeps
  // theirs queued for the next day. The service role alone may call it.
  claim_shift_digests(args, caller) {
    if (caller.kind !== "service") {
      return json(401, { code: "42501", details: null, hint: null, message: "permission denied for function claim_shift_digests" });
    }
    const day = String(args.p_day);
    const digests = (fake.tables.shift_digests ??= []);
    const notices = (fake.tables.shift_notices ??= []);
    const due = [...new Set(notices.map((n) => n.employee_id))];
    const fresh = due.filter((e) => !digests.some((d) => d.employee_id === e && d.digest_day === day));
    for (const e of fresh) digests.push({ employee_id: e, digest_day: day, claimed_at: new Date().toISOString() });
    const claimed = notices.filter((n) => fresh.includes(n.employee_id));
    fake.tables.shift_notices = notices.filter((n) => !claimed.includes(n));
    return json(200, claimed.map((n) => ({ employee_id: n.employee_id, shift_id: n.shift_id, notice: n.notice })));
  },
};

// ---- Storage ------------------------------------------------------------------
const REIMBURSEMENT_BUCKET = "travel-reimbursements";

/** Migration 37's storage.objects policies, for that bucket; others are open. */
function storageMay(op: "read" | "write", caller: Caller, bucket: string, path: string): boolean {
  if (caller.kind === "service") return true;
  if (caller.kind === "anon") return false;
  if (bucket !== REIMBURSEMENT_BUCKET) return true;
  const folder = path.split("/")[0];
  if (op === "read") return folder === caller.id || isManager(caller);
  return folder === caller.id || (folder === "adjustments" && isManager(caller));
}

function handleStorage(url: URL, method: string, headers: Headers): Response {
  const caller = callerOf(headers);
  const rest = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\//, ""));
  const refuse = () => json(403, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
  let m = /^object\/upload\/sign\/([^/]+)\/(.+)$/.exec(rest);
  if (m && method === "POST") {
    const [, bucket, path] = m;
    if (!storageMay("write", caller, bucket, path)) return refuse();
    fake.signedUploads.push(`${bucket}/${path}`);
    return json(200, { url: `/object/upload/sign/${bucket}/${path}?token=upload-token-${fake.signedUploads.length}` });
  }
  m = /^object\/sign\/([^/]+)\/(.+)$/.exec(rest);
  if (m && method === "POST") {
    const [, bucket, path] = m;
    if (!(`${bucket}/${path}` in fake.storage)) return json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    if (!storageMay("read", caller, bucket, path)) return json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    return json(200, { signedURL: `/object/sign/${bucket}/${path}?token=read-token` });
  }
  m = /^object\/([^/]+)\/(.+)$/.exec(rest);
  if (m && (method === "GET" || method === "HEAD")) {
    const [, bucket, path] = m;
    const bytes = fake.storage[`${bucket}/${path}`];
    if (!bytes || !storageMay("read", caller, bucket, path)) {
      return method === "HEAD" ? new Response(null, { status: 400 }) : json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    }
    return new Response(method === "HEAD" ? null : (bytes as unknown as BodyInit), { status: 200, headers: { "content-type": "application/octet-stream" } });
  }
  throw new Error(`fake Supabase: unexpected storage ${method} ${url.pathname}`);
}

async function handle(url: URL, method: string, headers: Headers, body: string | null): Promise<Response> {
  if (url.pathname.startsWith("/storage/v1/")) return handleStorage(url, method, headers);
  if (url.pathname === "/auth/v1/user") {
    const caller = callerOf(headers);
    if (caller.kind !== "user") return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    return json(200, { id: caller.id, aud: "authenticated", role: "authenticated", email: `${caller.id}@example.test` });
  }
  // emailForUser's auth-admin lookup (lib/notify.ts): the address a test put
  // in `emails`, or no such user.
  if (url.pathname.startsWith("/auth/v1/admin/users/")) {
    const id = decodeURIComponent(url.pathname.slice("/auth/v1/admin/users/".length));
    const email = fake.emails[id];
    if (!email) return json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
    return json(200, { id, aud: "authenticated", role: "authenticated", email });
  }
  const fn = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/)?.[1];
  if (fn && method === "POST") {
    const rpc = RPC[fn];
    if (!rpc) throw new Error(`fake Supabase: unexpected rpc ${fn}`);
    fake.beforeWrite?.(`rpc/${fn}`);
    return rpc(JSON.parse(body ?? "{}") as Row, callerOf(headers));
  }
  const table = url.pathname.match(/^\/rest\/v1\/(\w+)$/)?.[1];
  if (!table) throw new Error(`fake Supabase: unexpected ${method} ${url.pathname}`);
  if (fake.missingTables.includes(table)) {
    return json(404, {
      code: "PGRST205",
      details: null,
      hint: null,
      message: `Could not find the table 'public.${table}' in the schema cache`,
    });
  }
  const caller = callerOf(headers);
  const all = (fake.tables[table] ??= []);

  if (method === "GET" || method === "HEAD") {
    let rows = all.filter((r) => canRead(table, caller, r) && matches(r, url.searchParams));
    const order = url.searchParams.get("order");
    if (order) rows = sortBy(rows, order);
    const total = rows.length;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.get("limit");
    rows = rows.slice(offset, limit ? offset + Number(limit) : undefined);
    // select(..., { count: "exact", head: true }): no body, the count in Content-Range.
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-range": total ? `0-${total - 1}/${total}` : `*/${total}` } });
    }
    return represent(rows, headers, 200);
  }

  fake.beforeWrite?.(table);

  if (method === "POST" || method === "PATCH") {
    const parsed = JSON.parse(body ?? "null") as Row | Row[] | null;
    const keys = (Array.isArray(parsed) ? parsed : [parsed ?? {}]).flatMap((r) => Object.keys(r));
    const absent = keys.find((k) => fake.missingColumns[table]?.includes(k));
    if (absent) {
      return json(400, {
        code: "PGRST204",
        details: null,
        hint: null,
        message: `Could not find the '${absent}' column of '${table}' in the schema cache`,
      });
    }
  }

  if (method === "POST") {
    if (!canWrite(table, caller)) {
      return json(403, {
        code: "42501",
        details: null,
        hint: null,
        message: `new row violates row-level security policy for table "${table}"`,
      });
    }
    const input = JSON.parse(body ?? "null") as Row | Row[];
    const inserted = (Array.isArray(input) ? input : [input]).map((r) => {
      const row = { ...(DEFAULTS[table]?.() ?? {}), ...r, id: all.length + 1 };
      all.push(row);
      return row;
    });
    return represent(inserted, headers, 201);
  }

  if (method === "PATCH") {
    // RLS on UPDATE hides the rows the caller may not write; it does not error.
    const patch = JSON.parse(body ?? "{}") as Row;
    const hit = all.filter((r) => canWrite(table, caller) && canRead(table, caller, r) && matches(r, url.searchParams));
    for (const r of hit) Object.assign(r, patch);
    return represent(hit, headers, 200);
  }

  if (method === "DELETE") {
    const hit = all.filter((r) => canWrite(table, caller) && canRead(table, caller, r) && matches(r, url.searchParams));
    fake.tables[table] = all.filter((r) => !hit.includes(r));
    return represent(hit, headers, 200);
  }

  throw new Error(`fake Supabase: unexpected ${method} /rest/v1/${table}`);
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== new URL(SUPABASE_URL).origin) {
    if (fake.external) return fake.external(request);
    throw new Error(`test tried to reach ${url.origin}`);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
  return handle(url, request.method, request.headers, body);
}

// A fresh project: the given tables, nobody signed in, fetch pointed at it.
export function startFakeSupabase(tables: Record<string, Row[]>): FakeSupabase {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  globalThis.fetch = fakeFetch as typeof fetch;
  cookieJar = new Map();
  tokens = new Map();
  fake = {
    tables: structuredClone(tables),
    beforeWrite: null,
    missingColumns: {},
    missingTables: [],
    storage: {},
    signedUploads: [],
    external: null,
    emails: {},
    signIn(userId) {
      const accessToken = `token-for-${userId}`;
      tokens.set(accessToken, userId);
      const session = {
        access_token: accessToken,
        refresh_token: `refresh-for-${userId}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: userId, aud: "authenticated", role: "authenticated" },
      };
      const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
      cookieJar.set(`sb-${ref}-auth-token`, JSON.stringify(session));
    },
    cookieHeader() {
      return [...cookieJar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
    },
    rows(table) {
      return fake.tables[table] ?? [];
    },
  };
  return fake;
}
