// The control board's content: its categories and their lines (bj-finance
// #693, variant D accepted 2026-10-14). Categories are data: a new category is
// a new entry in CATEGORIES with its lines, and the page's layout does not
// change. Only the seven below exist today.
//
// A line is either STORED (a value an owner sets and reviews: it has an as-of
// date, a source, a history and a review-by chip) or COMPUTED (worked out from
// the stored ones; a missing input shows as missing, never as zero).
//
// Pure, so `node --test` runs it.

import { computeBoard, type BoardInputs, type BoardResults, type Derived, type Trend } from "./math.ts";
import { capWords, money, monthName, pct, pctFixed, per100 } from "./format.ts";
import { groupBy, inForce, settingsInForce, type SalaryRow, type SettingRow } from "./settings.ts";

/** What a stored line's value is, as the board has it now (saved, or an owner's unsaved change). */
export type Current = { value: number; detail: Record<string, number | string | null> };

export type BoardData = {
  /** Setting key -> value in force today, with any unsaved change applied. */
  values: Map<string, Current>;
  /** Setting key -> the saved row in force today (its dates and notes). */
  saved: Map<string, SettingRow>;
  /** Active salaried staff, with the salary row in force today. */
  salaried: { id: string; name: string; salary: SalaryRow | null }[];
  trend: Trend;
};

export type StoredLine = {
  kind: "stored";
  id: string;
  /** The control_settings key this line sets; null when it is set elsewhere (a salary). */
  key: string | null;
  label: string;
  /** What it is set to, in words; null when nothing is set yet. */
  show: string | null;
  row: SettingRow | SalaryRow | null;
  amount?: number | null;
  share?: string;
  note?: string;
  /** Where it is set, when it cannot be changed on this page. */
  setElsewhere?: string;
  extra?: string;
  total?: boolean;
  indent?: number;
};

export type ComputedLine = {
  kind: "computed";
  id: string;
  label: string;
  basis?: string;
  amount?: number | null;
  share?: string;
  /** What a missing number is waiting for. */
  needs: string[];
  note?: string;
  total?: boolean;
  indent?: number;
  /** The stored line it uses most: clicking it opens that line. */
  opens?: string;
};

export type Line = StoredLine | ComputedLine;
export type Ctx = { d: BoardData; r: BoardResults };
export type Category = { id: string; title: string; intro: string; lines: (x: Ctx) => Line[] };

export const NOT_SET = "Not set";
export const EMPTY_CATEGORY = "Nothing is set in this category yet.";

const num = (c: Current | undefined, name: string): number | null => {
  const v = c?.detail[name];
  return typeof v === "number" ? v : null;
};
const text = (c: Current | undefined, name: string): string | null => {
  const v = c?.detail[name];
  return typeof v === "string" && v ? v : null;
};

/** The math's inputs from the board's values. */
function boardInputs(d: Pick<BoardData, "values" | "salaried">): BoardInputs {
  const v = (k: string) => d.values.get(k)?.value ?? null;
  const tax = (k: string) => {
    const c = d.values.get(k);
    return c ? { rate: c.value, wageCap: num(c, "wage_cap") } : null;
  };
  return {
    salesInStore: v("sales_estimate.in_store"),
    salesCatering: v("sales_estimate.catering"),
    cogsPct: v("target.cogs_pct"),
    payrollPct: v("target.payroll_pct"),
    primeCostPct: v("target.prime_cost_pct"),
    fica: tax("tax.fica"),
    futa: tax("tax.futa"),
    paUc: tax("tax.pa_uc"),
    workersCompPer100: v("tax.workers_comp"),
    salaried: d.salaried.map((p) => ({ id: p.id, name: p.name, salary: p.salary ? Number(p.salary.annual_salary) : null })),
  };
}

/** How a payroll tax reads: its rate, and the wage cap it stops at or "on all wages". */
const taxWords = (c: Current) => `${pct(c.value, 3)} ${capWords(num(c, "wage_cap"))}`;

const ofSales = (r: BoardResults, n: number | null) =>
  n != null && r.salesTotal.value ? pctFixed(n / r.salesTotal.value) : "";
const share = (x: Derived) => (x.value == null ? "" : pctFixed(x.value));

function stored(d: BoardData, key: string, label: string, show: (c: Current) => string, more: Partial<StoredLine> = {}): StoredLine {
  const c = d.values.get(key);
  return { kind: "stored", id: key, key, label, show: c ? show(c) : null, row: d.saved.get(key) ?? null, indent: 1, ...more };
}

function computed(id: string, label: string, x: Derived, more: Partial<ComputedLine> = {}): ComputedLine {
  return { kind: "computed", id, label, amount: x.value, needs: x.needs, indent: 1, ...more };
}

export const CATEGORIES: Category[] = [
  {
    id: "sales",
    title: "Sales estimate",
    intro: "What we expect to sell over the next 12 months, kept realistic with no stretch built in. The cost targets below are shares of this total.",
    lines: ({ d, r }) => [
      stored(d, "sales_estimate.in_store", "In-store sales", (c) => money(c.value, true), { amount: d.values.get("sales_estimate.in_store")?.value ?? null, share: ofSales(r, d.values.get("sales_estimate.in_store")?.value ?? null) }),
      stored(d, "sales_estimate.catering", "Catering sales", (c) => money(c.value, true), { amount: d.values.get("sales_estimate.catering")?.value ?? null, share: ofSales(r, d.values.get("sales_estimate.catering")?.value ?? null) }),
      computed("salesTotal", "Total sales estimate", r.salesTotal, { share: r.salesTotal.value ? "100.00%" : "", total: true, indent: 0 }),
    ],
  },
  {
    id: "costs",
    title: "Cost targets",
    intro: "The share of sales each cost should stay within.",
    lines: ({ d, r }) => [
      stored(d, "target.cogs_pct", "Cost of goods (COGS)", (c) => pct(c.value), { amount: r.cogsDollars.value, share: d.values.has("target.cogs_pct") ? pctFixed(d.values.get("target.cogs_pct")!.value) : "" }),
      stored(d, "target.payroll_pct", "Total payroll", (c) => pct(c.value), { amount: r.totalPayroll.value, share: d.values.has("target.payroll_pct") ? pctFixed(d.values.get("target.payroll_pct")!.value) : "" }),
      stored(d, "target.prime_cost_pct", "Prime cost (COGS plus payroll)", (c) => pct(c.value), {
        amount: r.primeDollars.value, share: share(r.primeShare), total: true, indent: 0,
        note: "The amount and share are COGS plus payroll at their targets.",
      }),
    ],
  },
  {
    id: "salaried",
    title: "Salaried payroll",
    intro: "Salaries plus the employer taxes and workers' comp on them. This is fixed payroll: it is paid whatever sales come in.",
    lines: ({ d, r }) => {
      const fica = d.values.get("tax.fica");
      const futa = d.values.get("tax.futa");
      const uc = d.values.get("tax.pa_uc");
      const wc = d.values.get("tax.workers_comp");
      const basis = (c: Current | undefined) => (c ? taxWords(c) : NOT_SET);
      return [
        ...r.salaried.flatMap((s, i): Line[] => {
          const person = d.salaried[i];
          // Under a salary that is not set, the taxes show their rates and no amount; the salary line says Not set.
          const missing = (x: number | null, what: string) => (x == null && s.salary != null ? [what] : []);
          return [
            {
              kind: "stored", id: `salary:${s.id}`, key: null, label: `${s.name}, salary`, row: person.salary,
              show: s.salary == null ? null : `${money(s.salary)} a year`,
              setElsewhere: "Set on the Team page", amount: s.salary, share: ofSales(r, s.salary), indent: 1,
              extra: "Salaries are set on the Team page. They show here because fixed payroll is built from them.",
            },
            computed(`salary:${s.id}:fica`, "FICA", { value: s.fica, needs: missing(s.fica, "FICA") }, { basis: basis(fica), share: ofSales(r, s.fica), indent: 2, opens: "tax.fica" }),
            computed(`salary:${s.id}:futa`, "FUTA", { value: s.futa, needs: missing(s.futa, "FUTA") }, { basis: basis(futa), share: ofSales(r, s.futa), indent: 2, opens: "tax.futa" }),
            computed(`salary:${s.id}:uc`, "PA UC", { value: s.uc, needs: missing(s.uc, "PA UC") }, { basis: basis(uc), share: ofSales(r, s.uc), indent: 2, opens: "tax.pa_uc" }),
            computed(`salary:${s.id}:wc`, "Workers' comp", { value: s.wc, needs: missing(s.wc, "Workers' comp") }, { basis: wc ? per100(wc.value) : NOT_SET, share: ofSales(r, s.wc), indent: 2, opens: "tax.workers_comp" }),
          ];
        }),
        computed("fixedPayroll", "Fixed payroll", r.fixedPayroll, {
          share: ofSales(r, r.fixedPayroll.value), total: true, indent: 0,
          note: r.salaried.length ? undefined : "Nobody active is set to Salaried on the Team page.",
        }),
      ];
    },
  },
  {
    id: "hourly",
    title: "Hourly payroll",
    intro: "What the payroll target leaves for hourly staff once fixed payroll is paid. Their taxes and workers' comp come out of the same amount. The hourly goal is the share of sales the schedule can spend on hourly wages.",
    lines: ({ r }) => [
      computed("hourlyPool", "Payroll target less fixed payroll", r.hourlyPool, { share: ofSales(r, r.hourlyPool.value), opens: "target.payroll_pct" }),
      computed("hourlyDollars", "Hourly wages", r.hourlyDollars, {
        basis: r.hourlyLoad.value == null ? undefined : `÷ ${(1 + r.hourlyLoad.value).toFixed(5)}`,
        share: ofSales(r, r.hourlyDollars.value),
        note: "The amount left, divided by 1 plus the hourly tax and workers' comp rate, so those costs fit inside the payroll target too.",
      }),
      computed("hourlyLoad", "Hourly taxes and workers' comp", r.hourlyLoadDollars, {
        basis: r.hourlyLoad.value == null ? undefined : pct(r.hourlyLoad.value, 3), share: ofSales(r, r.hourlyLoadDollars.value),
      }),
      computed("hourlyGoal", "Hourly goal (hourly wages as a share of sales)", { value: null, needs: r.hourlyGoalPct.needs }, {
        share: share(r.hourlyGoalPct), total: true, indent: 0, note: "The schedule sets each day's target from this.",
      }),
      computed("allTaxesWc", "Taxes and workers' comp, all staff", r.allTaxesWc, { share: share(r.allTaxesWcPct) }),
    ],
  },
  {
    id: "taxes",
    title: "Payroll taxes",
    intro: "Employer taxes and workers' comp, as a share of wages. On a salary, a tax with a wage cap stops once pay passes the cap. Hourly wages are counted at the full rate with no cap.",
    lines: ({ d }) => [
      stored(d, "tax.fica", "FICA (employer share)", taxWords),
      stored(d, "tax.futa", "Federal unemployment (FUTA)", taxWords),
      stored(d, "tax.pa_uc", "PA unemployment (UC)", taxWords),
      stored(d, "tax.workers_comp", "Workers' comp", (c) => per100(c.value), {
        note: text(d.values.get("tax.workers_comp"), "class_code") ? `Policy class ${text(d.values.get("tax.workers_comp"), "class_code")}` : undefined,
      }),
    ],
  },
  {
    id: "schedule",
    title: "Schedule rules",
    intro: "Pay rules the schedule adds to the cost of a shift.",
    lines: ({ d }) => {
      const prem = d.values.get("rule.catering_premium");
      const solo = d.values.get("rule.solo_close");
      const capRate = num(prem, "cap_rate");
      return [
        stored(d, "rule.catering_premium", "Catering premium", (c) => `+${money(c.value, true)}/hr${capRate == null ? "" : `, up to ${money(capRate, true)}/hr`}`, {
          note: "Added to each Catering shift hour. Pay with the premium never goes past the cap.",
        }),
        stored(d, "rule.solo_close", "Solo-close bonus", (c) => `${money(c.value, true)} a night`, {
          note: solo ? `Paid when the closer is alone ${num(solo, "min_alone_hours") ?? "?"}h or more and clocks out at or after ${text(solo, "out_at_or_after") ?? "?"}.` : undefined,
        }),
      ];
    },
  },
  {
    id: "trend",
    title: "Trend",
    intro: "How this year's in-store sales compare with last year's. The schedule multiplies last year's sales for the same weekday by this factor to project each day.",
    lines: ({ d }) => {
      const t = d.trend;
      const side = (m: Trend["lastMonth"]) => `${monthName(m.month)} (${m.note})${m.value == null ? "" : ` ${money(m.value)}`}`;
      return [
        computed("trend", "Trend factor", t.factor, {
          amount: undefined,
          basis: t.factor.value == null ? undefined : t.factor.value.toFixed(3),
          note: `${side(t.lastMonth)} ÷ ${side(t.sameMonthLastYear)}. Worked out from the sales history.`,
        }),
      ];
    },
  },
];

/** The board as sections of lines, in category order. */
export function boardSections(d: BoardData): { cat: Category; lines: Line[] }[] {
  const r = computeBoard(boardInputs(d));
  return CATEGORIES.map((cat) => ({ cat, lines: cat.lines({ d, r }) }));
}

/**
 * The board's derived numbers with every value as it stood on `day`: the
 * settings in force then and each active salaried person's salary in force
 * then. The schedule (bj-finance #695) reads a day's hourly goal from this.
 */
export function boardOn(
  day: string,
  settings: SettingRow[],
  salaries: SalaryRow[],
  salaried: { id: string; name: string }[],
): BoardResults {
  const values = new Map<string, Current>();
  for (const [key, row] of settingsInForce(settings, day)) values.set(key, { value: row.value, detail: row.detail });
  const byPerson = groupBy(salaries, "profile_id");
  return computeBoard(boardInputs({ values, salaried: salaried.map((p) => ({ ...p, salary: inForce(byPerson.get(p.id) ?? [], day) })) }));
}
