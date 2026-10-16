// The control board's derived numbers (bj-finance #692 spec, Alina 2026-10-13):
// fixed payroll, hourly dollars, the hourly goal and the trend factor. The
// Targets tab and the Schedule page's labor line (#695, schedule.ts) import
// them; the Labor vs target metric (#696) is to import them too, not
// recompute them.
//
//   Fixed payroll  = salaries of everyone salaried and not archived + their
//                    employer taxes WITH the wage caps + workers' comp on the
//                    salaries. Being on the schedule (profiles.active) does
//                    not matter: a salaried manager off the schedule is paid.
//   Hourly dollars = (payroll target x sales estimate - fixed payroll)
//                    / (1 + employer tax rates + workers' comp rate), so hourly
//                    staff's taxes and workers' comp fit inside the target too.
//                    Hourly wages carry the full rates, no caps.
//   Hourly goal    = hourly dollars / sales estimate.
//   Trend factor   = last full month's in-store sales / the same month a year
//                    earlier, in-store only on both sides.
//
// A missing input is missing, never zero: every derived number is null with
// the names of what it needs until each input is set.
//
// Pure: no I/O, so `node --test` runs it.

export type TaxRate = { rate: number; wageCap: number | null };

export type SalariedPerson = { id: string; name: string; salary: number | null };

export type BoardInputs = {
  salesInStore: number | null;
  salesCatering: number | null;
  cogsPct: number | null;
  payrollPct: number | null;
  primeCostPct: number | null;
  fica: TaxRate | null;
  futa: TaxRate | null;
  paUc: TaxRate | null;
  /** Dollars per $100 of wages. */
  workersCompPer100: number | null;
  /** Salaried staff (pay_type 'salaried', archived_at null; profiles.active not consulted), salary in force or null. */
  salaried: SalariedPerson[];
};

export type SalariedLine = {
  id: string;
  name: string;
  salary: number | null;
  fica: number | null;
  futa: number | null;
  uc: number | null;
  wc: number | null;
  total: number | null;
};

/** A derived number, or null and what it is waiting for. */
export type Derived = { value: number | null; needs: string[] };

export type BoardResults = {
  salesTotal: Derived;
  cogsDollars: Derived;
  totalPayroll: Derived;
  /** COGS plus payroll at their targets, in dollars and as a share. */
  primeDollars: Derived;
  primeShare: Derived;
  salaried: SalariedLine[];
  salaries: Derived;
  fixedTaxesWc: Derived;
  fixedPayroll: Derived;
  /** FICA + FUTA + UC + WC as a fraction of hourly wages, no caps. */
  hourlyLoad: Derived;
  /** Payroll target less fixed payroll. */
  hourlyPool: Derived;
  hourlyDollars: Derived;
  hourlyLoadDollars: Derived;
  hourlyGoalPct: Derived;
  /** Employer taxes and WC for everyone: salaried (with caps) plus hourly (no caps). */
  allTaxesWc: Derived;
  /** The same, as a share of sales. */
  allTaxesWcPct: Derived;
};

export const NEEDS = {
  salesInStore: "In-store sales estimate",
  salesCatering: "Catering sales estimate",
  cogsPct: "COGS target",
  payrollPct: "Total payroll target",
  fica: "FICA",
  futa: "FUTA",
  paUc: "PA UC",
  workersComp: "Workers' comp",
} as const;

const known = (value: number, needs: string[] = []): Derived => (needs.length ? { value: null, needs } : { value, needs: [] });

/** Combine derived inputs: the function runs only when all are known. */
function from(parts: Derived[], fn: (...v: number[]) => number | null, extraNeeds: string[] = []): Derived {
  const needs = [...new Set([...parts.flatMap((p) => p.needs), ...extraNeeds])];
  if (needs.length) return { value: null, needs };
  const v = fn(...parts.map((p) => p.value as number));
  return v == null || !Number.isFinite(v) ? { value: null, needs: ["sales above zero"] } : { value: v, needs: [] };
}

function input(v: number | null, name: string): Derived {
  return v == null ? { value: null, needs: [name] } : { value: v, needs: [] };
}

function capped(pay: number, r: TaxRate): number {
  return (r.wageCap == null ? pay : Math.min(pay, r.wageCap)) * r.rate;
}

export function computeBoard(i: BoardInputs): BoardResults {
  const inStore = input(i.salesInStore, NEEDS.salesInStore);
  const catering = input(i.salesCatering, NEEDS.salesCatering);
  const salesTotal = from([inStore, catering], (a, b) => a + b);
  const cogsPct = input(i.cogsPct, NEEDS.cogsPct);
  const payrollPct = input(i.payrollPct, NEEDS.payrollPct);
  const cogsDollars = from([salesTotal, cogsPct], (s, p) => s * p);
  const totalPayroll = from([salesTotal, payrollPct], (s, p) => s * p);
  const primeDollars = from([cogsDollars, totalPayroll], (a, b) => a + b);
  const primeShare = from([cogsPct, payrollPct], (a, b) => a + b);

  const rateNeeds = [
    ...(i.fica ? [] : [NEEDS.fica]),
    ...(i.futa ? [] : [NEEDS.futa]),
    ...(i.paUc ? [] : [NEEDS.paUc]),
    ...(i.workersCompPer100 == null ? [NEEDS.workersComp] : []),
  ];
  const wc = i.workersCompPer100 == null ? null : i.workersCompPer100 / 100;

  const salaried: SalariedLine[] = i.salaried.map((p) => {
    const pay = p.salary;
    const line: SalariedLine = {
      id: p.id,
      name: p.name,
      salary: pay,
      fica: pay != null && i.fica ? capped(pay, i.fica) : null,
      futa: pay != null && i.futa ? capped(pay, i.futa) : null,
      uc: pay != null && i.paUc ? capped(pay, i.paUc) : null,
      wc: pay != null && wc != null ? pay * wc : null,
      total: null,
    };
    if (pay != null && line.fica != null && line.futa != null && line.uc != null && line.wc != null) {
      line.total = pay + line.fica + line.futa + line.uc + line.wc;
    }
    return line;
  });
  const salaryNeeds = i.salaried.filter((p) => p.salary == null).map((p) => `${p.name}'s salary`);
  const salaries = known(i.salaried.reduce((a, p) => a + (p.salary ?? 0), 0), salaryNeeds);
  const fixedPayroll = known(salaried.reduce((a, s) => a + (s.total ?? 0), 0), [...salaryNeeds, ...(i.salaried.length ? rateNeeds : [])]);
  const fixedTaxesWc = from([fixedPayroll, salaries], (f, s) => f - s);

  const hourlyLoad = known(
    (i.fica?.rate ?? 0) + (i.futa?.rate ?? 0) + (i.paUc?.rate ?? 0) + (wc ?? 0),
    rateNeeds,
  );
  const hourlyPool = from([totalPayroll, fixedPayroll], (t, f) => t - f);
  const hourlyDollars = from([hourlyPool, hourlyLoad], (pool, load) => pool / (1 + load));
  const hourlyLoadDollars = from([hourlyDollars, hourlyLoad], (h, load) => h * load);
  const hourlyGoalPct = from([hourlyDollars, salesTotal], (h, s) => (s > 0 ? h / s : null));
  const allTaxesWc = from([fixedTaxesWc, hourlyLoadDollars], (f, h) => f + h);
  const allTaxesWcPct = from([allTaxesWc, salesTotal], (t, s) => (s > 0 ? t / s : null));

  return {
    salesTotal, cogsDollars, totalPayroll, primeDollars, primeShare, salaried, salaries, fixedTaxesWc, fixedPayroll,
    hourlyLoad, hourlyPool, hourlyDollars, hourlyLoadDollars, hourlyGoalPct, allTaxesWc, allTaxesWcPct,
  };
}

// ---------------------------------------------------------------------------
// The trend factor
// ---------------------------------------------------------------------------

/** A row of public.sales_monthly (migration 41). */
export type MonthlySalesRow = { month: string; source: "qbo" | "seller"; in_store: number };
/** A row of public.sales_daily_in_store (migration 41). */
export type DailySalesRow = { day: string; in_store: number; basis: "booked" | "in_transit"; source: "square" | "seller" };

export type MonthSales =
  | { month: string; value: number; source: "qbo" | "seller" | "daily"; note: string }
  | { month: string; value: null; source: null; note: string };

export type Trend = { lastMonth: MonthSales; sameMonthLastYear: MonthSales; factor: Derived };

/** The first day of the month `n` months from the month of `day`. */
export function monthStart(day: string, n = 0): string {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

function daysIn(month: string): string[] {
  const out: string[] = [];
  const next = monthStart(month, 1);
  for (let d = new Date(`${month}T12:00:00Z`); d.toISOString().slice(0, 10) < next; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * One month's in-store sales. Our closed books (QBO) first, then the seller's
 * books; failing both, the daily register sales when every day of the month
 * has a row. Otherwise missing.
 */
export function monthSales(month: string, monthly: MonthlySalesRow[], daily: DailySalesRow[]): MonthSales {
  for (const source of ["qbo", "seller"] as const) {
    const row = monthly.find((r) => r.month === month && r.source === source);
    if (row) return { month, value: Number(row.in_store), source, note: source === "qbo" ? "QBO" : "seller's books" };
  }
  const days = daysIn(month);
  const byDay = new Map(daily.filter((r) => r.day.startsWith(month.slice(0, 7))).map((r) => [r.day, r]));
  const missing = days.filter((d) => !byDay.has(d)).length;
  if (missing === 0) {
    const rows = days.map((d) => byDay.get(d)!);
    const unsettled = rows.filter((r) => r.basis === "in_transit").length;
    return {
      month,
      value: rows.reduce((a, r) => a + Number(r.in_store), 0),
      source: "daily",
      note: `daily sales, all ${days.length} days${unsettled ? `, ${unsettled} not settled yet` : ""}`,
    };
  }
  return {
    month,
    value: null,
    source: null,
    note: missing === days.length ? "no sales on file" : `${missing} of ${days.length} days missing`,
  };
}

/** The two months the trend factor compares: the last full month before `today`'s, and the same month a year earlier. */
export function trendMonths(today: string): { last: string; lastYear: string } {
  return { last: monthStart(today, -1), lastYear: monthStart(today, -13) };
}

/** Last full month (in New York, from `today`) over the same month a year earlier. */
export function trendFactor(today: string, monthly: MonthlySalesRow[], daily: DailySalesRow[]): Trend {
  const { last, lastYear } = trendMonths(today);
  const lastMonth = monthSales(last, monthly, daily);
  const sameMonthLastYear = monthSales(lastYear, monthly, daily);
  const needs = [
    ...(lastMonth.value == null ? [`in-store sales for ${last.slice(0, 7)}`] : []),
    ...(sameMonthLastYear.value == null ? [`in-store sales for ${lastYear.slice(0, 7)}`] : []),
  ];
  let factor: Derived;
  if (needs.length) factor = { value: null, needs };
  else if (!(sameMonthLastYear.value! > 0)) factor = { value: null, needs: [`in-store sales above zero for ${lastYear.slice(0, 7)}`] };
  else factor = { value: lastMonth.value! / sameMonthLastYear.value!, needs: [] };
  return { lastMonth, sameMonthLastYear, factor };
}
