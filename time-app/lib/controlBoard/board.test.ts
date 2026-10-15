// The control board's content (bj-finance #693, variant D accepted
// 2026-10-14): seven categories as data, stored lines with a review-by date,
// computed lines that say what they are missing. Invented figures only.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { CATEGORIES, NOT_SET, boardSections, type BoardData, type ComputedLine, type Current, type StoredLine } from "./board.ts";
import { trendFactor } from "./math.ts";
import { SETTING_KEYS, type SalaryRow, type SettingRow } from "./settings.ts";

const TODAY = "2030-10-14";

function emptyBoard(over: Partial<BoardData> = {}): BoardData {
  return { values: new Map(), saved: new Map(), salaried: [], trend: trendFactor(TODAY, [], []), ...over };
}

function setRow(key: string, value: number, detail: Current["detail"] = {}): SettingRow {
  return { id: 1, key, value, detail, effective_from: "2030-01-01", review_by: "2031-01-01", source: "invented", method: null, recorded_by: null, recorded_at: "2030-01-01T00:00:00Z" };
}

function filled(): BoardData {
  const rows = [
    setRow("sales_estimate.in_store", 600_000),
    setRow("sales_estimate.catering", 400_000),
    setRow("target.cogs_pct", 0.2),
    setRow("target.payroll_pct", 0.3),
    setRow("target.prime_cost_pct", 0.5),
    setRow("tax.fica", 0.08, { wage_cap: null }),
    setRow("tax.futa", 0.01, { wage_cap: 10_000 }),
    setRow("tax.pa_uc", 0.02, { wage_cap: 20_000 }),
    setRow("tax.workers_comp", 1, { class_code: "0000" }),
    setRow("rule.catering_premium", 1, { cap_rate: 10 }),
    setRow("rule.solo_close", 5, { min_alone_hours: 3, out_at_or_after: "21:30" }),
  ];
  const salary: SalaryRow = { id: 1, profile_id: "p1", annual_salary: 50_000, effective_from: "2030-01-01", review_by: "2031-01-01", source: "invented", method: null, recorded_by: null, recorded_at: "2030-01-01T00:00:00Z" };
  return emptyBoard({
    values: new Map(rows.map((r) => [r.key, { value: r.value, detail: r.detail }])),
    saved: new Map(rows.map((r) => [r.key, r])),
    salaried: [{ id: "p1", name: "Person A", salary }],
  });
}

const find = (d: BoardData, id: string) => boardSections(d).flatMap((s) => s.lines).find((l) => l.id === id);

test("the board is the seven categories, in order", () => {
  assert.deepEqual(
    CATEGORIES.map((c) => c.title),
    ["Sales estimate", "Cost targets", "Salaried payroll", "Hourly payroll", "Payroll taxes", "Schedule rules", "Trend"],
  );
  assert.equal(new Set(CATEGORIES.map((c) => c.id)).size, CATEGORIES.length);
});

test("every stored setting has a line on the board, and every stored line is a known setting", () => {
  const lines = boardSections(filled()).flatMap((s) => s.lines).filter((l): l is StoredLine => l.kind === "stored");
  const keys = lines.map((l) => l.key).filter((k): k is string => k != null);
  assert.deepEqual([...keys].sort(), [...SETTING_KEYS].sort());
});

test("a never-set board shows every value as not set and every derived number as missing, never zero", () => {
  const sections = boardSections(emptyBoard());
  const lines = sections.flatMap((s) => s.lines);
  for (const l of lines.filter((l): l is StoredLine => l.kind === "stored")) {
    assert.equal(l.show, null, l.id);
    assert.equal(l.row, null, l.id);
  }
  const goal = lines.find((l) => l.id === "hourlyGoal") as ComputedLine;
  assert.equal(goal.share, "");
  assert.ok(goal.needs.includes("Total payroll target"));
  const total = lines.find((l) => l.id === "salesTotal") as ComputedLine;
  assert.equal(total.amount, null);
  assert.deepEqual(total.needs, ["In-store sales estimate", "Catering sales estimate"]);
  const fixed = lines.find((l) => l.id === "fixedPayroll") as ComputedLine;
  assert.equal(fixed.amount, 0, "nobody salaried: fixed payroll is a real zero");
  assert.match(fixed.note ?? "", /Nobody active is set to Salaried/);
  assert.equal(NOT_SET, "Not set");
});

test("a filled board shows each value in words with its review-by row, and the derived numbers", () => {
  const d = filled();
  const fica = find(d, "tax.fica") as StoredLine;
  assert.equal(fica.show, "8% on all wages");
  assert.equal(fica.row?.review_by, "2031-01-01");
  assert.equal((find(d, "tax.futa") as StoredLine).show, "1% on the first $10,000");
  assert.equal((find(d, "rule.catering_premium") as StoredLine).show, "+$1.00/hr, up to $10.00/hr");
  assert.match((find(d, "rule.solo_close") as StoredLine).note ?? "", /alone 3h or more and clocks out at or after 21:30/);
  assert.equal((find(d, "tax.workers_comp") as StoredLine).note, "Policy class 0000");
  const goal = find(d, "hourlyGoal") as ComputedLine;
  assert.deepEqual(goal.needs, []);
  assert.match(goal.share ?? "", /^\d+\.\d{2}%$/);
});

test("each salaried person's salary is on the board, set on the Team page, with its taxes beneath it", () => {
  const d = filled();
  const salary = find(d, "salary:p1") as StoredLine;
  assert.equal(salary.label, "Person A, salary");
  assert.equal(salary.key, null, "not a board setting: it is set on the Team page");
  assert.equal(salary.setElsewhere, "Set on the Team page");
  assert.equal(salary.show, "$50,000 a year");
  const fica = find(d, "salary:p1:fica") as ComputedLine;
  assert.equal(fica.amount, 4_000);
  assert.equal(fica.opens, "tax.fica", "clicking a tax under a salary opens the tax's line");

  const unset = boardSections({ ...d, salaried: [{ id: "p2", name: "Person B", salary: null }] }).flatMap((s) => s.lines);
  assert.equal((unset.find((l) => l.id === "salary:p2") as StoredLine).show, null);
  const unsetFica = unset.find((l) => l.id === "salary:p2:fica") as ComputedLine;
  assert.equal(unsetFica.amount, null, "no amount under a salary that is not set");
  assert.equal(unsetFica.basis, "8% on all wages");
  assert.deepEqual((unset.find((l) => l.id === "fixedPayroll") as ComputedLine).needs, ["Person B's salary"]);
});

test("an unsaved change recomputes every total that uses it", () => {
  const d = filled();
  const before = find(d, "target.payroll_pct");
  const changed = new Map(d.values);
  changed.set("target.payroll_pct", { value: 0.4, detail: {} });
  const after = find({ ...d, values: changed }, "target.payroll_pct") as StoredLine;
  assert.equal((before as StoredLine).amount, 300_000);
  assert.equal(after.amount, 400_000);
  assert.equal((after.row as SettingRow | null)?.value, 0.3, "the saved row is still the one in force");
});

test("the trend line shows both inputs, and says when one is missing", () => {
  const withData = { ...filled(), trend: trendFactor(TODAY, [{ month: "2030-09-01", source: "qbo", in_store: 9_000 }, { month: "2029-09-01", source: "seller", in_store: 10_000 }], []) };
  const t = find(withData, "trend") as ComputedLine;
  assert.equal(t.basis, "0.900");
  assert.match(t.note ?? "", /Sep 2030 \(QBO\) \$9,000 ÷ Sep 2029 \(seller's books\) \$10,000/);
  const missing = find(filled(), "trend") as ComputedLine;
  assert.equal(missing.basis, undefined);
  assert.ok(missing.needs.length === 2);
  assert.match(missing.note ?? "", /Sep 2030 \(no sales on file\) ÷ Sep 2029 \(no sales on file\)/);
});
