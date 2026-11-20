// The Labor Hours Planning local preview's loader (bj-finance #742):
// loadPreviewData() reads production through psql in read-only sessions and
// the planning inputs from a local file. psql is the system boundary, so a
// stand-in psql on PATH answers each SELECT from invented rows and records how
// it was run. Pins that the loader reads nothing unless the preview is on,
// that every session it opens is read-only with the password kept off the
// command line, and how the inputs file's closed days stand in for the live
// ones. Invented names, dates and credentials only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { loadAppModule } from "../testing/fakeSupabase.ts";

type PreviewModule = typeof import("./laborPlanningPreview.ts");
const { loadPreviewData } = await loadAppModule<PreviewModule>("lib/metrics/laborPlanningPreview.ts");

// Wednesday 2030-10-16, midday in New York.
const NOW = new Date("2030-10-16T16:00:00Z");
const PASSWORD = "invented-secret";

// Answers `-c "select ... from (<sql>) t"` with the rows given for the first
// table the inner SELECT names, and logs its argv and libpq environment.
const FAKE_PSQL = `#!/usr/bin/env node
const fs = require("node:fs");
const sql = process.argv[process.argv.indexOf("-c") + 1];
const table = /from \\(\\s*select[\\s\\S]*?\\bfrom ([a-z_]+)/i.exec(sql)[1];
fs.appendFileSync(process.env.FAKE_PSQL_LOG, JSON.stringify({ table, argv: process.argv.slice(2), PGPASSWORD: process.env.PGPASSWORD, PGOPTIONS: process.env.PGOPTIONS }) + "\\n");
const rows = JSON.parse(process.env.FAKE_PSQL_ROWS || "{}")[table] || [];
process.stdout.write(JSON.stringify(rows));
`;

const saved = Object.fromEntries(
  ["NODE_ENV", "LOCAL_PREVIEW", "DIRECT_DATABASE_URL", "LABOR_PLANNING_SEED", "LABOR_PLANNING_HISTORY", "PATH", "FAKE_PSQL_LOG", "FAKE_PSQL_ROWS"].map((k) => [k, process.env[k]]),
);
let dir: string;
let log: string;
let seedFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "labor-planning-preview-load-"));
  await writeFile(join(dir, "psql"), FAKE_PSQL);
  await chmod(join(dir, "psql"), 0o755);
  log = join(dir, "psql.log");
  seedFile = join(dir, "seed.json");
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = "development";
  env.LOCAL_PREVIEW = "1";
  env.DIRECT_DATABASE_URL = `postgresql://preview_reader:${PASSWORD}@db.invalid:5432/postgres`;
  env.LABOR_PLANNING_SEED = seedFile;
  env.LABOR_PLANNING_HISTORY = join(dir, "history.json");
  env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  env.FAKE_PSQL_LOG = log;
  env.FAKE_PSQL_ROWS = JSON.stringify({});
});

afterEach(async () => {
  const env = process.env as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

const sessions = async () =>
  (await readFile(log, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { table: string; argv: string[]; PGPASSWORD: string; PGOPTIONS: string });

test("with the preview off the loader refuses and opens no database session", async () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  await assert.rejects(loadPreviewData(NOW), /the local preview is off/);
  assert.deepEqual(await sessions(), []);
});

test("every database session is read-only, and the password is never on the command line", async () => {
  await writeFile(seedFile, JSON.stringify({}));
  await loadPreviewData(NOW);
  const runs = await sessions();
  assert.ok(runs.length > 0);
  for (const r of runs) {
    assert.equal(r.PGOPTIONS, "-c default_transaction_read_only=on", r.table);
    assert.equal(r.PGPASSWORD, PASSWORD, r.table);
    assert.ok(!r.argv.some((a) => a.includes(PASSWORD)), r.table);
  }
});

test("a closed day in the inputs file stands in for the live one on its date; other live closed days are shown as live", async () => {
  (process.env as Record<string, string | undefined>).FAKE_PSQL_ROWS = JSON.stringify({
    store_hours_exceptions: [
      { date: "2030-10-14", label: "Past closure", is_closed: true, opens: null, closes: null },
      { date: "2030-12-24", label: "Early close", is_closed: false, opens: "12:00:00", closes: "16:00:00" },
      { date: "2030-12-25", label: "Live holiday", is_closed: true, opens: null, closes: null },
    ],
  });
  await writeFile(seedFile, JSON.stringify({ closed_days: [{ date: "2030-12-25", label: "File holiday" }, { date: "2031-01-01", label: "File new year" }] }));
  const p = await loadPreviewData(NOW);
  assert.deepEqual(
    p.inputs.exceptions.map((e) => [e.date, e.label, e.is_closed]),
    [["2030-12-24", "Early close", false], ["2030-12-25", "File holiday", true], ["2031-01-01", "File new year", true]],
    "from today on, the file's row on a date in both",
  );
  assert.deepEqual(p.liveClosedDays, ["2030-12-24"]);
});

test("an inputs file that cannot be read is named, never read as no seasons", async () => {
  await writeFile(seedFile, "{ not json");
  const p = await loadPreviewData(NOW);
  assert.equal(p.inputs.problems.length, 1);
  assert.match(p.inputs.problems[0], /^The inputs file could not be read: /);
  assert.ok(p.data.problems.some((x) => x.startsWith("seasons and events not read: ")), p.data.problems.join("; "));
});
