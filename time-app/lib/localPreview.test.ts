// The Labor Hours Planning local preview (bj-finance #742) has no sign-in, so
// it must open only on a developer's machine: NODE_ENV=development (`next
// dev`; every production build is "production") AND LOCAL_PREVIEW=1. These
// drive its two doors, the middleware's sign-in gate and the inputs editor's
// POST route, with each condition missing and with both set. The inputs file
// is a temporary one; invented names, dates and figures only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server.js";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

const { middleware } = await loadAppModule<{ middleware: (r: NextRequest) => Promise<Response> }>("middleware.ts");
const inputs = await loadAppModule<{ POST: (r: Request) => Promise<Response> }>("app/api/dev/labor-planning-inputs/route.ts");

const SEASON = {
  name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", closed_weekdays: [],
  review_by: "2031-03-01", source: "invented", method: "by hand",
};

const saved = { NODE_ENV: process.env.NODE_ENV, LOCAL_PREVIEW: process.env.LOCAL_PREVIEW, LABOR_PLANNING_SEED: process.env.LABOR_PLANNING_SEED };
let db: FakeSupabase;
let dir: string;
let seedFile: string;

function setEnv(nodeEnv: string | undefined, localPreview: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  for (const [k, v] of [["NODE_ENV", nodeEnv], ["LOCAL_PREVIEW", localPreview]] as const) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}

beforeEach(async () => {
  db = startFakeSupabase({ profiles: [] });
  dir = await mkdtemp(join(tmpdir(), "labor-planning-preview-"));
  seedFile = join(dir, "seed.json");
  process.env.LABOR_PLANNING_SEED = seedFile;
});

afterEach(async () => {
  const env = process.env as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

function visit(path: string): NextRequest {
  const host = "time.withers-ventures.com";
  return new NextRequest(`https://${host}${path}`, { headers: { host, cookie: db.cookieHeader() } });
}

const save = (action: unknown) =>
  inputs.POST(new Request("http://localhost:3000/api/dev/labor-planning-inputs", { method: "POST", body: JSON.stringify(action) }));

const NOT_BOTH: [string, string | undefined, string | undefined][] = [
  ["a production build, even with LOCAL_PREVIEW=1", "production", "1"],
  ["the dev server without LOCAL_PREVIEW=1", "development", undefined],
  ["the dev server with LOCAL_PREVIEW set to anything but 1", "development", "true"],
];

for (const [when, nodeEnv, localPreview] of NOT_BOTH) {
  test(`${when}: the preview pages send nobody-signed-in to sign in`, async () => {
    setEnv(nodeEnv, localPreview);
    for (const path of ["/dev/labor-hours-planning", "/api/dev/labor-planning-inputs"]) {
      const res = await middleware(visit(path));
      assert.equal(res.status, 307, path);
      assert.equal(new URL(res.headers.get("location")!).pathname, "/login", path);
    }
  });

  test(`${when}: the inputs door is a 404 and writes nothing`, async () => {
    setEnv(nodeEnv, localPreview);
    const res = await save({ kind: "season", body: SEASON });
    assert.equal(res.status, 404);
    await assert.rejects(readFile(seedFile, "utf8"), { code: "ENOENT" });
  });
}

test("on the dev server with LOCAL_PREVIEW=1 the preview pages need no sign-in", async () => {
  setEnv("development", "1");
  for (const path of ["/dev/labor-hours-planning", "/api/dev/labor-planning-inputs"]) {
    const res = await middleware(visit(path));
    assert.equal(res.headers.get("location"), null, path);
    assert.equal(res.headers.get("x-middleware-next"), "1", path);
  }
  // Only those two paths: every other page still asks for sign-in.
  assert.equal((await middleware(visit("/dev/something-else"))).status, 307);
});

test("on the dev server with LOCAL_PREVIEW=1 a change is saved to the inputs file, keeping what was there", async () => {
  setEnv("development", "1");
  await writeFile(seedFile, JSON.stringify({ _about: "kept", closed_days: [{ date: "2030-12-25", label: "Test holiday" }] }));
  const res = await save({ kind: "season", body: SEASON });
  assert.equal(res.status, 200);
  const file = JSON.parse(await readFile(seedFile, "utf8"));
  assert.equal(file._about, "kept");
  assert.deepEqual(file.closed_days, [{ date: "2030-12-25", label: "Test holiday" }]);
  assert.deepEqual(file.seasons, [
    { name: "Test winter", effective_from: "2030-11-01", opens: "13:00", closes: "21:00", review_by: "2031-03-01", source: "invented", method: "by hand" },
  ]);
});

test("with no inputs file yet, the first change starts one", async () => {
  setEnv("development", "1");
  const res = await save({ kind: "closed_day", body: { date: "2030-11-28", label: "Test holiday" } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await readFile(seedFile, "utf8")), { closed_days: [{ date: "2030-11-28", label: "Test holiday" }] });
});

test("a change that does not make sense is refused with the reason, and the file is left as it was", async () => {
  setEnv("development", "1");
  const before = JSON.stringify({ closed_days: [{ date: "2030-12-25", label: "Test holiday" }] });
  await writeFile(seedFile, before);
  const res = await save({ kind: "season", body: { ...SEASON, opens: "22:00" } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /close after it opens/);
  assert.equal(await readFile(seedFile, "utf8"), before);
});

test("an inputs file that cannot be read says so, never read as empty", async () => {
  setEnv("development", "1");
  process.env.LABOR_PLANNING_SEED = dir; // a directory: reading it fails, and not with ENOENT
  const res = await save({ kind: "season", body: SEASON });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /could not be read/);
});
