// The Metrics page's saved views (bj-finance #671): the API routes and the
// page's loader, against the stand-in Supabase (lib/testing/fakeSupabase.ts,
// which applies migration 39's rules: a manager's own rows only, one live
// view per name). supabase/migration_39_verify.sql proves those rules
// against a real Postgres.
//
//   npm test

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";
import { createClient } from "@supabase/supabase-js";

type Handler = (request: Request, ctx?: { params: { id: string } }) => Promise<Response>;

const viewsRoute = await loadAppModule<{ POST: Handler }>("app/api/metrics/views/route.ts");
const viewRoute = await loadAppModule<{ PATCH: Handler }>("app/api/metrics/views/[id]/route.ts");
const prefsRoute = await loadAppModule<{ PUT: Handler }>("app/api/metrics/preferences/route.ts");
const { loadViews } = await loadAppModule<typeof import("./metrics/viewsServer.ts")>("lib/metrics/viewsServer.ts");

const ALINA = "00000000-0000-0000-0000-00000000000a";
const ALEX = "00000000-0000-0000-0000-00000000000d";
const SAM = "00000000-0000-0000-0000-00000000000b";

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: ALINA, role: "manager", active: false, full_name: "Alina" },
      { id: ALEX, role: "manager", active: false, full_name: "Alex" },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
    ],
    metric_views: [{ id: 1, owner_id: ALEX, name: "Alex's", position: 0, widgets: [], archived_at: null }],
    metric_preferences: [],
  });
});

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://finance.test/api/metrics/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

const json = async (r: Response) => (await r.json()) as Record<string, any>;

test("only a manager may save, change or point at a view", async () => {
  assert.equal((await viewsRoute.POST(req("POST", "views", { name: "Mine" }))).status, 403); // signed out
  db.signIn(SAM);
  assert.equal((await viewsRoute.POST(req("POST", "views", { name: "Mine" }))).status, 403);
  assert.equal((await viewRoute.PATCH(req("PATCH", "views/1", { name: "x" }), { params: { id: "1" } })).status, 403);
  assert.equal((await prefsRoute.PUT(req("PUT", "preferences", { active_view_id: "1" }))).status, 403);
});

test("a manager saves a view: name cleaned, widgets cleaned, placed last, theirs", async () => {
  db.signIn(ALINA);
  const r1 = await viewsRoute.POST(req("POST", "views", { name: "  My  catering view ", widgets: [{ id: "a", metric: "catering_ar", settings: {} }, { metric: "nope" }] }));
  assert.equal(r1.status, 201);
  const v1 = (await json(r1)).view;
  assert.equal(v1.name, "My catering view");
  assert.deepEqual(v1.widgets, [{ id: "a", metric: "catering_ar", settings: { period: "mtd" } }]);
  const r2 = await viewsRoute.POST(req("POST", "views", { name: "Second" }));
  assert.equal((await json(r2)).view.position, 1);
  const mine = await loadViews(signedInClient(ALINA), ALINA);
  assert.deepEqual(mine.mode === "server" && mine.views.map((v) => v.name), ["My catering view", "Second"]);
});

test("names: blank refused, and no two live views of one person share one", async () => {
  db.signIn(ALINA);
  assert.equal((await viewsRoute.POST(req("POST", "views", { name: "   " }))).status, 400);
  assert.equal((await viewsRoute.POST(req("POST", "views", { name: "Finance" }))).status, 201);
  const dup = await viewsRoute.POST(req("POST", "views", { name: "finance" }));
  assert.equal(dup.status, 409);
  assert.match((await json(dup)).error, /already have a view called "finance"/);
  // Alex's view name is no obstacle to Alina.
  assert.equal((await viewsRoute.POST(req("POST", "views", { name: "Alex's" }))).status, 201);
});

test("renaming a view onto another of your live views' names is a 409, and the view keeps its name", async () => {
  db.signIn(ALINA);
  await viewsRoute.POST(req("POST", "views", { name: "Finance" }));
  const id = (await json(await viewsRoute.POST(req("POST", "views", { name: "Catering" })))).view.id as string;
  const r = await viewRoute.PATCH(req("PATCH", `views/${id}`, { name: " FINANCE " }), { params: { id } });
  assert.equal(r.status, 409);
  assert.match((await json(r)).error, /already have a view called "FINANCE"/);
  const state = await loadViews(signedInClient(ALINA), ALINA);
  assert.deepEqual(state.mode === "server" && state.views.map((v) => v.name), ["Finance", "Catering"]);
});

test("a manager can keep twenty live views; the twenty-first is refused", async () => {
  db.signIn(ALINA);
  for (let i = 1; i <= 20; i++) assert.equal((await viewsRoute.POST(req("POST", "views", { name: `View ${i}` }))).status, 201, `view ${i}`);
  const over = await viewsRoute.POST(req("POST", "views", { name: "View 21" }));
  assert.equal(over.status, 409);
  assert.match((await json(over)).error, /You have 20 views/);
});

test("rename, re-lay-out and reorder a view; archive it instead of deleting", async () => {
  db.signIn(ALINA);
  const id = (await json(await viewsRoute.POST(req("POST", "views", { name: "Mine" })))).view.id as string;
  const renamed = await viewRoute.PATCH(req("PATCH", `views/${id}`, { name: "Ours", position: 4, widgets: [{ id: "x", metric: "leads", settings: { period: "13w" } }] }), { params: { id } });
  assert.equal(renamed.status, 200);
  assert.deepEqual((await json(renamed)).view, { id, name: "Ours", position: 4, widgets: [{ id: "x", metric: "leads", settings: { period: "13w" } }] });
  const archived = await viewRoute.PATCH(req("PATCH", `views/${id}`, { archived: true }), { params: { id } });
  assert.equal(archived.status, 200);
  const row = db.rows("metric_views").find((r) => String(r.id) === id)!;
  assert.ok(row.archived_at, "archived, not removed");
  // Archived views are gone from the page and the API's reach.
  const after = await loadViews(signedInClient(ALINA), ALINA);
  assert.equal(after.mode === "server" && after.views.some((v) => v.id === id), false);
  assert.equal((await viewRoute.PATCH(req("PATCH", `views/${id}`, { name: "Back" }), { params: { id } })).status, 404);
  assert.equal((await viewRoute.PATCH(req("PATCH", `views/${id}`, { archived: false }), { params: { id } })).status, 400);
});

test("another manager's view is invisible: changing it is a 404 and it stays as it was", async () => {
  db.signIn(ALINA);
  const r = await viewRoute.PATCH(req("PATCH", "views/1", { name: "Hijacked" }), { params: { id: "1" } });
  assert.equal(r.status, 404);
  assert.equal((await prefsRoute.PUT(req("PUT", "preferences", { active_view_id: "1" }))).status, 404);
  // Alex still sees his view under its own name.
  db.signIn(ALEX);
  const alexs = await loadViews(signedInClient(ALEX), ALEX);
  assert.deepEqual(alexs.mode === "server" && alexs.views.map((v) => v.name), ["Alex's"]);
});

test("bad PATCH bodies are refused", async () => {
  db.signIn(ALINA);
  const id = (await json(await viewsRoute.POST(req("POST", "views", { name: "Mine" })))).view.id as string;
  for (const body of [{}, { position: -1 }, { position: 1.5 }, { widgets: "all" }, { name: "" }]) {
    assert.equal((await viewRoute.PATCH(req("PATCH", `views/${id}`, body), { params: { id } })).status, 400, JSON.stringify(body));
  }
  assert.equal((await viewRoute.PATCH(req("PATCH", "views/abc", { name: "x" }), { params: { id: "abc" } })).status, 404);
});

test("the open view is remembered per person: insert the first time, update after", async () => {
  db.signIn(ALINA);
  const a = (await json(await viewsRoute.POST(req("POST", "views", { name: "A" })))).view.id as string;
  const b = (await json(await viewsRoute.POST(req("POST", "views", { name: "B" })))).view.id as string;
  assert.equal((await prefsRoute.PUT(req("PUT", "preferences", { active_view_id: a }))).status, 200);
  assert.equal((await prefsRoute.PUT(req("PUT", "preferences", { active_view_id: b }))).status, 200);
  // Two preference rows would make the read ambiguous and open the first view, not B.
  const state = await loadViews(signedInClient(ALINA), ALINA);
  assert.equal(state.mode === "server" && state.activeId, b);
});

test("before migration 39 every route answers 503 views_not_enabled, and the loader says 'local'", async () => {
  db.missingTables = ["metric_views", "metric_preferences"];
  db.signIn(ALINA);
  const r = await viewsRoute.POST(req("POST", "views", { name: "Mine" }));
  assert.equal(r.status, 503);
  assert.equal((await json(r)).code, "views_not_enabled");
  assert.equal((await viewRoute.PATCH(req("PATCH", "views/3", { name: "x" }), { params: { id: "3" } })).status, 503);
  assert.equal((await prefsRoute.PUT(req("PUT", "preferences", { active_view_id: "3" }))).status, 503);
  const supabase = signedInClient(ALINA);
  assert.deepEqual(await loadViews(supabase, ALINA), { mode: "local" });
});

function signedInClient(userId: string) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer token-for-${userId}` } },
    auth: { persistSession: false },
  });
}

test("a manager with no views is given Finance and Catering, saved as theirs; the remembered view opens", async () => {
  db.signIn(ALINA);
  const supabase = signedInClient(ALINA);
  const first = await loadViews(supabase, ALINA);
  assert.equal(first.mode, "server");
  if (first.mode !== "server") return;
  assert.deepEqual(first.views.map((v) => v.name), ["Finance", "Catering"]);
  assert.equal(first.activeId, first.views[0].id);
  assert.equal((await prefsRoute.PUT(req("PUT", "preferences", { active_view_id: first.views[1].id }))).status, 200);
  const again = await loadViews(supabase, ALINA);
  assert.equal(again.mode === "server" && again.views.length, 2, "not seeded twice");
  assert.equal(again.mode === "server" && again.activeId, first.views[1].id);
});
