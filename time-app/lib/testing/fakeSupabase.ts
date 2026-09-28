// A stand-in for the Supabase project, at the HTTP boundary, so route handlers
// can be driven the way a phone drives them. Test support only: nothing under
// app/ or lib/ outside lib/testing imports this.
//
// What is real: the route handler, every lib module it calls, supabase-js and
// @supabase/ssr. What is faked: `fetch` (the network to Supabase) and the
// request's cookies (next/headers, which only exists inside Next's server).
//
// The fake speaks just enough PostgREST for the routes under test (eq / gte /
// lte / is / in filters, limit, single, maybeSingle, insert and update with
// return=representation) and answers /auth/v1/user from the session cookie.
// Row Level Security is emulated for time_entries only, with the policies
// migrations 12 and 30 install (supabase/migration_30_verify.sql proves those
// against a real Postgres): anyone signed in reads their own punches, only a
// manager inserts, updates or deletes one through their session, and the
// service role is not held to RLS. Every other table is readable by any signed-in caller.

import * as nodeModule from "node:module";
import { existsSync, statSync } from "node:fs";
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
// module.registerHooks is in Node 22.15+, newer than the @types/node this app pins.
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: { resolve: ResolveHook }) => void;
};

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
  // public.is_manager() as migration 31 writes it: role in ('manager', 'owner').
  // Spelled out here, not taken from lib/roles.ts, so the stand-in database
  // cannot drift along with the code under test.
  return fake.tables.profiles?.some((p) => p.id === caller.id && ["manager", "owner"].includes(p.role as string)) ?? false;
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

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [col, cond] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(col)) continue;
    const dot = cond.indexOf(".");
    const op = cond.slice(0, dot);
    const val = cond.slice(dot + 1);
    const cell = row[col];
    const ok =
      op === "eq" ? cell !== null && cell !== undefined && String(cell) === val
      : op === "neq" ? String(cell) !== val
      : op === "is" ? (val === "null" ? cell === null || cell === undefined : String(cell) === val)
      : op === "gte" ? cell != null && compare(cell, val) >= 0
      : op === "lte" ? cell != null && compare(cell, val) <= 0
      : op === "gt" ? cell != null && compare(cell, val) > 0
      : op === "lt" ? cell != null && compare(cell, val) < 0
      : op === "in" ? val.slice(1, -1).split(",").map((v) => v.replace(/^"(.*)"$/, "$1")).includes(String(cell))
      : (() => { throw new Error(`fake PostgREST: unsupported filter ${col}=${cond}`); })();
    if (!ok) return false;
  }
  return true;
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
};

async function handle(url: URL, method: string, headers: Headers, body: string | null): Promise<Response> {
  if (url.pathname === "/auth/v1/user") {
    const caller = callerOf(headers);
    if (caller.kind !== "user") return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    return json(200, { id: caller.id, aud: "authenticated", role: "authenticated", email: `${caller.id}@example.test` });
  }
  const table = url.pathname.match(/^\/rest\/v1\/(\w+)$/)?.[1];
  if (!table) throw new Error(`fake Supabase: unexpected ${method} ${url.pathname}`);
  const caller = callerOf(headers);
  const all = (fake.tables[table] ??= []);

  if (method === "GET") {
    let rows = all.filter((r) => canRead(table, caller, r) && matches(r, url.searchParams));
    const limit = url.searchParams.get("limit");
    if (limit) rows = rows.slice(0, Number(limit));
    return represent(rows, headers, 200);
  }

  fake.beforeWrite?.(table);

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
