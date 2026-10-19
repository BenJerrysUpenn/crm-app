// LOCAL PREVIEW ONLY (bj-finance #742): the Labor Hours Planning card on real
// data before anything goes live. Never reachable in a production build:
// previewEnabled() is false unless NODE_ENV is "development" (Next sets
// "production" for every `next build` / `next start`) AND LOCAL_PREVIEW=1.
//
// Where the numbers come from:
//   * the production database, read with SELECT only: psql with
//     default_transaction_read_only=on, so Postgres refuses any write. The
//     DSN is DIRECT_DATABASE_URL from the environment (never a file here).
//     The same tables and filters as loadLaborPlanningRows, so the card is
//     built exactly as the Metrics page builds it.
//   * what migration 47 will hold but production does not have yet, from
//     local files outside every repo (crm-app is public):
//       LABOR_PLANNING_SEED     seasons, concession events, and the
//                               preview's own closed days
//                               (default ~/bj-finance-data/local/labor-planning-seed.json).
//                               The planning inputs editor below the card
//                               saves here (lib/metrics/laborPlanningSeed.ts),
//                               never to the database.
//       LABOR_PLANNING_HISTORY  last year's raw catering hours by day, a
//                               day marked marketing (bj-finance's
//                               `modules.labor_planning history --dry-run`)
//                               (default ~/bj-finance-data/local/catering-history.json)

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { previewEnabled } from "@/lib/localPreview";
import type { SalariedProfile } from "@/lib/controlBoard/load";
import { trendMonths, type DailySalesRow, type MonthlySalesRow } from "@/lib/controlBoard/math";
import type { SalaryRow, SettingRow } from "@/lib/controlBoard/settings";
import { CATERING_POSITION, type LaborShift } from "@/lib/controlBoard/schedule";
import { BOOKED_STAGES } from "@/lib/metrics/catering";
import { PROFILE_COLUMNS, bookingsFrom, type BookingDeal } from "@/lib/controlBoard/scheduleLoad";
import { STAFFING_KEYS, type ClosedDateRange, type StoreHoursException, type StoreHoursRow } from "@/lib/coverage";
import { seasonHoursRows } from "@/lib/storeHoursSeasons";
import { addDays, nyDay } from "./dates";
import { nyMidnight } from "./supabaseReads";
import { MARKETING_POSITION, laborHoursPlanning, planningWindow, type HistoryRow, type HistoryShift, type MarketingDealRow } from "./laborPlanning";
import { MARKETING_DEAL_COLUMNS, planningInputsFrom, type LaborPlanningRows } from "./laborPlanningLoad";
import { seedClosedDays, seedRevisions, seedSeasonRows, type Seed } from "./laborPlanningSeed";
import type { MetricsData } from "./load";
import type { ConcessionEventRow } from "@/lib/controlBoard/planningInputs";
import type { PlanningInputsData } from "@/lib/controlBoard/planningInputsLoad";

const run = promisify(execFile);

/**
 * libpq's environment for the DSN. Passed as environment, never on the
 * command line, so a failed run's message (which quotes the command) can
 * never show the password.
 */
function pgEnv(dsn: string): Record<string, string> {
  const u = new URL(dsn);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    PGSSLMODE: u.searchParams.get("sslmode") ?? "require",
    // Postgres refuses any write in this session.
    PGOPTIONS: "-c default_transaction_read_only=on",
    PGAPPNAME: "labor-planning-local-preview",
  };
}

/**
 * At most this many psql sessions at once: the pooler is in session mode with
 * a small pool shared with every other client, and a page load (or two, while
 * the dev server reloads) must not take it all.
 */
const MAX_SESSIONS = 4;
let sessions = 0;
const waiting: (() => void)[] = [];

async function session<T>(work: () => Promise<T>): Promise<T> {
  if (sessions >= MAX_SESSIONS) await new Promise<void>((go) => waiting.push(go));
  sessions++;
  try {
    return await work();
  } finally {
    sessions--;
    waiting.shift()?.();
  }
}

/** One SELECT, its rows as JSON, in a read-only session. */
async function select<T>(sql: string): Promise<T[]> {
  return session(() => selectNow<T>(sql));
}

async function selectNow<T>(sql: string): Promise<T[]> {
  if (!previewEnabled()) throw new Error("the local preview is off");
  const dsn = process.env.DIRECT_DATABASE_URL;
  if (!dsn) throw new Error("DIRECT_DATABASE_URL is not set (the launch config reads it from ~/.config/bj-catering/env)");
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("the preview only selects");
  try {
    const { stdout } = await run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", `select coalesce(json_agg(t), '[]'::json) from (${sql}) t`], {
      env: { ...process.env, ...pgEnv(dsn) },
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T[];
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`a read-only query failed: ${stderr || (e as Error).name}`);
  }
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** The shifts the card reads besides store shifts, as PLANNING_SHIFTS_FILTER: Catering and Marketing ones, and any on a deal. */
const PLANNING_SHIFTS = `(position in (${lit(CATERING_POSITION)}, ${lit(MARKETING_POSITION)}) or deal_id is not null)`;

type HistoryFile = { from: string; through: string; days: HistoryRow[] };

async function readJson<T>(path: string): Promise<{ value: T | null; problem: string | null }> {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")) as T, problem: null };
  } catch (e) {
    return { value: null, problem: `${path}: ${(e as Error).message}` };
  }
}

export type PreviewData = {
  data: MetricsData;
  /** The planning inputs editor's rows: the inputs file's, plus the live closed days. */
  inputs: PlanningInputsData;
  /** Live closed days: shown in the editor, never changed by the preview. */
  liveClosedDays: string[];
  sources: { seed: string; history: string; historySpan: string | null; dbReadAt: string };
};

/** The inputs file the preview reads and its editor writes. */
export function seedPath(): string {
  return process.env.LABOR_PLANNING_SEED || join(homedir(), "bj-finance-data/local/labor-planning-seed.json");
}

export async function loadPreviewData(now: Date = new Date()): Promise<PreviewData> {
  if (!previewEnabled()) throw new Error("the local preview is off");
  const today = nyDay(now.toISOString());
  const w = planningWindow(today);
  const { last, lastYear } = trendMonths(today);
  const seedFile = seedPath();
  const historyPath = process.env.LABOR_PLANNING_HISTORY || join(homedir(), "bj-finance-data/local/catering-history.json");
  const problems: string[] = [];

  const dailyFrom = [w.salesFrom, lastYear].sort()[0];
  const [settings, salaries, salaried, monthly, daily, profiles, storeHours, exceptions, closed, deals, marketingDeals, shifts, historyShifts, seed, history] =
    await Promise.all([
      select<SettingRow>(`select id, key, value::float8 as value, detail, effective_from::text, review_by::text, source, method, recorded_by, recorded_at from control_settings`),
      select<SalaryRow>(`select id, profile_id, annual_salary::float8 as annual_salary, effective_from::text, review_by::text, source, method, recorded_by, recorded_at from profile_salaries`),
      select<{ id: string; full_name: string | null; archived_at: string | null }>(
        `select id, full_name, archived_at from profiles where pay_type = 'salaried' and is_overhead = false order by full_name`,
      ),
      select<MonthlySalesRow>(`select month::text, source, in_store::float8 as in_store from sales_monthly where month in (${lit(last)}, ${lit(lastYear)})`),
      select<DailySalesRow>(
        `select day::text, in_store::float8 as in_store, basis, source from sales_daily_in_store where day >= ${lit(dailyFrom)} and day <= ${lit(today)} order by day`,
      ),
      select<Record<string, unknown>>(`select ${PROFILE_COLUMNS} from profiles order by id`),
      select<StoreHoursRow>(`select weekday, is_closed, opens::text, closes::text from store_hours`),
      select<StoreHoursException>(
        `select date::text, label, is_closed, opens::text, closes::text from store_hours_exceptions where date between ${lit(w.firstWeek)} and ${lit(w.lastDay)}`,
      ),
      select<ClosedDateRange>(
        `select title, start_date::text, end_date::text from annotations where business_closed and start_date <= ${lit(w.lastDay)} and end_date >= ${lit(w.firstWeek)}`,
      ),
      select<BookingDeal>(
        `select id, stage, payment_status, event_date, created_at, subtotal_pretax::float8 as subtotal_pretax, total_with_tax::float8 as total_with_tax, amount_paid::float8 as amount_paid, company, source, archived, labor_hours, staff_count from deals where event_date >= ${lit(w.firstWeek)} and event_date <= ${lit(`${w.lastDay}T23:59:59`)} order by id`,
      ),
      select<MarketingDealRow>(`select ${MARKETING_DEAL_COLUMNS} from deals where event_type ilike 'marketing%' order by id`),
      select<LaborShift>(
        `select id, employee_id, starts_at, ends_at, position, deal_id from shifts where ${PLANNING_SHIFTS} and starts_at >= ${lit(nyMidnight(addDays(w.firstWeek, -1)))} and starts_at <= ${lit(nyMidnight(addDays(w.lastDay, 2)))} order by id`,
      ),
      select<HistoryShift>(
        `select starts_at, ends_at, position, deal_id from shifts where ${PLANNING_SHIFTS} and starts_at >= ${lit(nyMidnight(addDays(w.lastYearFrom, -1)))} and starts_at <= ${lit(nyMidnight(addDays(today, 1)))} order by id`,
      ),
      readJson<Seed>(seedFile),
      readJson<HistoryFile>(historyPath),
    ]);

  // Booked: the same rule as loadCateringBookings, over the same rows.
  const ids = deals.map((d) => d.id);
  const booked = ids.length
    ? await select<{ deal_id: number }>(
        `select deal_id from deal_events where field = 'stage' and new_value in (${BOOKED_STAGES.map(lit).join(", ")}) and deal_id in (${ids.join(", ")})`,
      )
    : [];
  const bookings = bookingsFrom(deals, new Set(booked.map((e) => e.deal_id)), w.firstWeek, w.lastDay, today);

  if (seed.problem) problems.push(`seasons and events not read: ${seed.problem}`);
  if (history.problem) problems.push(`last year's catering hours not read: ${history.problem}`);
  const s = seed.value ?? {};
  const seasons = seedSeasonRows(s);
  const concessionEvents = seedRevisions(s.concession_events) as unknown as ConcessionEventRow[];
  // The file's closed days stand in for store_hours_exceptions: on a date in
  // both, the file's row is the one shown.
  const fileClosed = seedClosedDays(s);
  const liveKept = exceptions.filter((e) => !fileClosed.some((f) => f.date === e.date)).map((e) => ({ date: e.date, label: e.label ?? null, is_closed: e.is_closed, opens: e.opens ?? null, closes: e.closes ?? null, created_at: null }));
  const allExceptions = [...liveKept, ...fileClosed].sort((a, b) => a.date.localeCompare(b.date));

  const rows: LaborPlanningRows = {
    today,
    settings,
    salaries,
    salaried: salaried.map((p): SalariedProfile => ({ id: p.id, name: p.full_name ?? "Unnamed", archivedOn: p.archived_at ? nyDay(p.archived_at) : null })),
    monthly,
    daily: daily.filter((r) => r.day.startsWith(last.slice(0, 7)) || r.day.startsWith(lastYear.slice(0, 7))),
    profiles: profiles as LaborPlanningRows["profiles"],
    sales: daily.filter((r) => r.day >= w.salesFrom && r.day <= w.salesTo).map((r) => ({ day: r.day, in_store: r.in_store })),
    storeHours: [...storeHours, ...seasonHoursRows(seasons)],
    exceptions: allExceptions,
    closedRanges: closed,
    bookings,
    marketingDeals,
    shifts,
    historyLoaded: history.value ? history.value.days.map((d) => ({ day: d.day, hours: Number(d.hours), kind: d.kind })) : null,
    historyShifts,
    concessionEvents,
    problems,
  };

  const data: MetricsData = {
    today,
    targets: null,
    catering: null,
    ar: null,
    labour: null,
    forward: null,
    leads: null,
    outreach: null,
    quotes: null,
    laborTarget: null,
    laborPlanning: laborHoursPlanning(planningInputsFrom(rows)),
    feed: { status: "not_enabled" },
    problems,
  };
  return {
    data,
    inputs: {
      unavailable: null,
      seasons,
      concession: concessionEvents,
      exceptions: allExceptions.filter((e) => e.date >= today),
      staffing: settings.filter((r) => STAFFING_KEYS.includes(r.key)),
      problems: seed.problem ? [`The inputs file could not be read: ${seed.problem}`] : [],
    },
    liveClosedDays: liveKept.filter((e) => e.date >= today).map((e) => e.date),
    sources: {
      seed: seedFile,
      history: historyPath,
      historySpan: history.value ? `${history.value.from} to ${history.value.through}` : null,
      dbReadAt: now.toISOString(),
    },
  };
}
