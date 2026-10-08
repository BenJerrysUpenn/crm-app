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
// request's exact count, insert and update with return=representation) and answers /auth/v1/user from the session cookie.
// GoTrue's admin side is the `authUsers` list: invite (a new address only, as
// GoTrue refuses a registered one), list, get and update by id (a ban is the
// update's ban_duration). An id not in the list answers 404. A Postgres
// function is whatever a test puts in `rpc`; one not there answers PGRST202,
// as hosted PostgREST does before the migration that creates it.
// Row Level Security is emulated for time_entries only, with the policies
// migrations 12 and 30 install (supabase/migration_30_verify.sql proves those
// against a real Postgres): anyone signed in reads their own punches, only a
// manager inserts, updates or deletes one through their session, and the
// service role is not held to RLS. Every other table is readable by any signed-in caller.

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
  // Runs before each write reaches the "database": lets a test move the world
  // underneath the route between its read and its write, as a fob tap would.
  beforeWrite: ((table: string) => void) | null;
  // Columns a migration has not added yet, per table. A write naming one is
  // refused as hosted PostgREST does (PGRST204, "schema cache"); seed the rows
  // without the column too, as select("*") would return them.
  missingColumns: Record<string, string[]>;
  // Tables a migration has not created yet: every request to one is refused
  // as hosted PostgREST does (PGRST205, "schema cache").
  missingTables: string[];
  // Auth users (auth.users), for the admin API. Each has at least id and email.
  authUsers: Row[];
  // Postgres functions callable through rpc(), by name.
  rpc: Record<string, (args: Row) => unknown>;
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

function canRead(table: string, caller: Caller, row: Row): boolean {
  if (caller.kind === "service") return true;
  if (caller.kind === "anon") return false;
  if (table === "time_entries") return row.employee_id === caller.id || isManager(caller);
  return true;
}

function canWrite(table: string, caller: Caller): boolean {
  if (caller.kind === "service") return true;
  if (caller.kind === "anon") return false;
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
  time_entries: () => ({ clock_in_at: DB_NOW, clock_out_at: null, status: "open", manual: false }),
  // Migration 36's column defaults: a new pay table row is a queued request.
  // Migration 23's: a staffing record starts open, each of its steps pending.
  staff_lifecycle: () => ({ status: "open", created_at: DB_NOW, updated_at: DB_NOW, completed_at: null }),
  staff_lifecycle_steps: () => ({ status: "pending", claimed_at: null, attempts: 0, worker_log: null, result: null, completed_by: null, completed_at: null }),
  payroll_sheets: () => ({ status: "queued", requested_at: DB_NOW, started_at: null, built_at: null, built_by: null, source_fingerprint: null, open_items: null, error: null, sheet: null }),
};

async function handle(url: URL, method: string, headers: Headers, body: string | null): Promise<Response> {
  if (url.pathname === "/auth/v1/user") {
    const caller = callerOf(headers);
    if (caller.kind !== "user") return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    return json(200, { id: caller.id, aud: "authenticated", role: "authenticated", email: `${caller.id}@example.test` });
  }
  // The auth admin API. With no authUsers seeded (the default), emailForUser's
  // lookup (lib/notify.ts) finds nobody, so a notification is the in-app row alone.
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
  if (adminUser) {
    const user = fake.authUsers.find((u) => u.id === adminUser[1]);
    if (!user) return json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
    if (method === "PUT") Object.assign(user, JSON.parse(body ?? "{}") as Row);
    else if (method !== "GET") throw new Error(`fake Supabase: unexpected ${method} ${url.pathname}`);
    return json(200, user);
  }
  if (url.pathname === "/auth/v1/admin/users" && method === "GET") {
    return json(200, { users: fake.authUsers, aud: "authenticated" });
  }
  if (url.pathname === "/auth/v1/invite" && method === "POST") {
    const { email, data } = JSON.parse(body ?? "{}") as { email: string; data?: Row };
    if (fake.authUsers.some((u) => u.email === email)) {
      return json(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
    }
    const user = { id: crypto.randomUUID(), email, user_metadata: data ?? {} };
    fake.authUsers.push(user);
    return json(200, user);
  }
  const fn = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/)?.[1];
  if (fn) {
    const impl = fake.rpc[fn];
    if (!impl) {
      return json(404, {
        code: "PGRST202",
        details: null,
        hint: null,
        message: `Could not find the function public.${fn} in the schema cache`,
      });
    }
    return json(200, impl(JSON.parse(body ?? "{}") as Row));
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
    // upsert(..., { onConflict }): a row matching on the conflict columns is
    // merged into, as Prefer: resolution=merge-duplicates does.
    const conflict = headers.get("prefer")?.includes("resolution=merge-duplicates")
      ? (url.searchParams.get("on_conflict") ?? "id").split(",")
      : null;
    const inserted = (Array.isArray(input) ? input : [input]).map((r) => {
      const same = conflict && all.find((x) => conflict.every((c) => x[c] === r[c]));
      if (same) return Object.assign(same, r);
      const row = { ...(DEFAULTS[table]?.() ?? {}), id: all.length + 1, ...r };
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
  if (url.origin !== new URL(SUPABASE_URL).origin) throw new Error(`test tried to reach ${url.origin}`);
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
    authUsers: [],
    rpc: {},
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
