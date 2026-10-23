// The control board's stored values (bj-finance #693, spec #692): every value
// is dated, a change adds a new dated value, the value in force on a day is
// the latest one on or before it, and each has a review-by chip. Every figure
// here is invented: crm-app is public.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SETTINGS,
  addMonthsTo,
  historyOf,
  inForce,
  parseSalaryInput,
  parseSettingInput,
  reviewState,
  settingsInForce,
  type SettingRow,
} from "./settings.ts";

function row(over: Partial<SettingRow>): SettingRow {
  return {
    id: 1, key: "target.payroll_pct", value: 0.5, detail: {}, effective_from: "2030-01-01", review_by: "2031-01-01",
    source: "invented", method: null, recorded_by: null, recorded_at: "2030-01-01T12:00:00Z", ...over,
  };
}

// ---- the value in force -------------------------------------------------------------

test("a change adds a dated value: the value in force on a day is the latest one on or before it", () => {
  const rows = [
    row({ id: 1, value: 0.1, effective_from: "2030-01-01" }),
    row({ id: 2, value: 0.2, effective_from: "2030-04-01" }),
    row({ id: 3, value: 0.3, effective_from: "2030-09-01" }),
  ];
  assert.equal(inForce(rows, "2029-12-31"), null, "nothing before the first as-of date");
  assert.equal(inForce(rows, "2030-01-01")?.value, 0.1);
  assert.equal(inForce(rows, "2030-03-31")?.value, 0.1, "past months compute with the value in force then");
  assert.equal(inForce(rows, "2030-04-01")?.value, 0.2);
  assert.equal(inForce(rows, "2030-08-31")?.value, 0.2);
  assert.equal(inForce(rows, "2031-06-01")?.value, 0.3);
});

test("a same-day correction wins over the value it corrects (later recorded, then higher id), as control_settings_on() does", () => {
  const rows = [
    // The correction has the lower id, so only recorded_at can pick it.
    row({ id: 6, value: 0.2, effective_from: "2030-04-01", recorded_at: "2030-04-01T10:00:00Z" }),
    row({ id: 5, value: 0.25, effective_from: "2030-04-01", recorded_at: "2030-04-01T11:00:00Z" }),
  ];
  assert.equal(inForce(rows, "2030-04-02")?.value, 0.25);
  const sameInstant = [row({ id: 7, value: 0.3, effective_from: "2030-04-01" }), row({ id: 8, value: 0.35, effective_from: "2030-04-01" })];
  assert.equal(inForce(sameInstant, "2030-04-02")?.value, 0.35);
});

test("a value dated in the future is in the history but not in force yet", () => {
  const rows = [row({ id: 1, value: 0.1, effective_from: "2030-01-01" }), row({ id: 2, value: 0.2, effective_from: "2030-12-01" })];
  assert.equal(inForce(rows, "2030-06-01")?.value, 0.1);
  assert.deepEqual(historyOf(rows).map((r) => r.id), [2, 1], "history is newest first");
});

test("settingsInForce gives one row per key", () => {
  const rows = [
    row({ id: 1, key: "target.payroll_pct", value: 0.1 }),
    row({ id: 2, key: "target.payroll_pct", value: 0.2, effective_from: "2030-02-01" }),
    row({ id: 3, key: "target.cogs_pct", value: 0.3 }),
  ];
  const now = settingsInForce(rows, "2030-06-01");
  assert.equal(now.size, 2);
  assert.equal(now.get("target.payroll_pct")?.value, 0.2);
  assert.equal(now.get("target.cogs_pct")?.value, 0.3);
});

// ---- the review-by chip --------------------------------------------------------------

test("the review-by chip is green, yellow within one month, red once past due", () => {
  assert.equal(reviewState("2030-08-01", "2030-06-15"), "ok");
  assert.equal(reviewState("2030-07-16", "2030-06-15"), "ok", "a month and a day away is still green");
  assert.equal(reviewState("2030-07-15", "2030-06-15"), "soon", "one month away turns yellow");
  assert.equal(reviewState("2030-06-15", "2030-06-15"), "soon", "due today is yellow, not red");
  assert.equal(reviewState("2030-06-14", "2030-06-15"), "overdue");
  assert.equal(addMonthsTo("2030-01-15", 12), "2031-01-15");
});

// ---- what an owner may submit -----------------------------------------------------------

const note = { effective_from: "2030-01-01", review_by: "2031-01-01", source: "  invented  ", method: "" };

test("every value needs an as-of date, a review-by date not before it, and where it came from", () => {
  const ok = parseSettingInput({ key: "target.payroll_pct", value: 0.5, ...note });
  assert.ok(ok.ok);
  assert.equal(ok.value.source, "invented");
  assert.equal(ok.value.method, null, "a blank method is stored as not written down");
  assert.equal(parseSettingInput({ key: "target.payroll_pct", value: 0.5, ...note, effective_from: "2030-02-30" }).ok, false);
  assert.equal(parseSettingInput({ key: "target.payroll_pct", value: 0.5, ...note, review_by: "2029-12-31" }).ok, false);
  assert.equal(parseSettingInput({ key: "target.payroll_pct", value: 0.5, ...note, source: "  " }).ok, false);
  assert.equal(parseSettingInput({ key: "target.payroll_pct", value: 0.5, ...note, review_by: undefined }).ok, false);
});

test("a setting must be one the board knows, and its number fit its kind", () => {
  assert.equal(parseSettingInput({ key: "target.made_up", value: 0.5, ...note }).ok, false);
  assert.equal(parseSettingInput({ key: "target.payroll_pct", value: 1.5, ...note }).ok, false, "a share is at most 100%");
  assert.equal(parseSettingInput({ key: "target.payroll_pct", value: -0.1, ...note }).ok, false);
  assert.equal(parseSettingInput({ key: "target.payroll_pct", value: "abc", ...note }).ok, false);
  assert.equal(parseSettingInput({ key: "target.payroll_pct", ...note }).ok, false, "the main number is required");
  assert.equal(parseSettingInput({ key: "sales_estimate.in_store", value: "$1,000.50", ...note }).ok, true);
});

test("a tax's wage cap is optional: blank means on all wages; zero is refused", () => {
  const all = parseSettingInput({ key: "tax.fica", value: 0.01, detail: { wage_cap: "" }, ...note });
  assert.ok(all.ok);
  assert.deepEqual(all.value.detail, { wage_cap: null });
  const capped = parseSettingInput({ key: "tax.futa", value: 0.01, detail: { wage_cap: 1000 }, ...note });
  assert.ok(capped.ok);
  assert.deepEqual(capped.value.detail, { wage_cap: 1000 });
  assert.equal(parseSettingInput({ key: "tax.futa", value: 0.01, detail: { wage_cap: 0 }, ...note }).ok, false);
});

test("the schedule rules store their parts: the catering cap, and the solo-close hours and cut-off", () => {
  const prem = parseSettingInput({ key: "rule.catering_premium", value: 1, detail: { cap_rate: 10 }, ...note });
  assert.ok(prem.ok);
  assert.deepEqual(prem.value.detail, { cap_rate: 10 });
  assert.equal(parseSettingInput({ key: "rule.catering_premium", value: 1, ...note }).ok, false, "the cap is part of the rule");
  const solo = parseSettingInput({ key: "rule.solo_close", value: 5, detail: { min_alone_hours: 3, out_at_or_after: "21:30" }, ...note });
  assert.ok(solo.ok);
  assert.deepEqual(solo.value.detail, { min_alone_hours: 3, out_at_or_after: "21:30" });
  assert.equal(parseSettingInput({ key: "rule.solo_close", value: 5, detail: { min_alone_hours: 3, out_at_or_after: "9pm" }, ...note }).ok, false);
  assert.equal(parseSettingInput({ key: "rule.solo_close", value: 5, detail: { min_alone_hours: 0, out_at_or_after: "21:30" }, ...note }).ok, false);
  const wc = parseSettingInput({ key: "tax.workers_comp", value: 1.5, detail: { class_code: " 1234 " }, ...note });
  assert.ok(wc.ok);
  assert.deepEqual(wc.value.detail, { class_code: "1234" });
  assert.equal(parseSettingInput({ key: "tax.workers_comp", value: 1.5, detail: { class_code: "x".repeat(41) }, ...note }).ok, false, "a class code is at most 40 characters");
});

test("open-up and close-down are whole minutes: zero is a value, a negative, a fraction or more than four hours is refused", () => {
  for (const key of ["staffing.open_up_minutes", "staffing.close_down_minutes"]) {
    const ok = parseSettingInput({ key, value: "20", ...note });
    assert.ok(ok.ok, key);
    assert.equal(ok.value.value, 20);
    assert.deepEqual(ok.value.detail, {});
    assert.equal(parseSettingInput({ key, value: 0, ...note }).ok, true, `${key}: no time is still a value`);
    assert.equal(parseSettingInput({ key, value: -5, ...note }).ok, false);
    assert.equal(parseSettingInput({ key, value: 12.5, ...note }).ok, false);
    assert.equal(parseSettingInput({ key, value: 240, ...note }).ok, true, `${key}: four hours is the most, and allowed`);
    assert.equal(parseSettingInput({ key, value: 241, ...note }).ok, false);
    assert.equal(parseSettingInput({ key, ...note }).ok, false, "required");
  }
});

test("only the fields a setting declares are stored", () => {
  const p = parseSettingInput({ key: "target.cogs_pct", value: 0.2, detail: { wage_cap: 5 }, ...note });
  assert.ok(p.ok);
  assert.deepEqual(p.value.detail, {});
});

test("the board's keys are dotted lower-case words, as the database requires, and each has its main number", () => {
  for (const s of SETTINGS) {
    assert.match(s.key, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, s.key);
    assert.ok(s.fields.some((f) => f.name === "value"), s.key);
  }
  assert.equal(new Set(SETTINGS.map((s) => s.key)).size, SETTINGS.length);
});

test("a salary is a dated, non-negative annual amount for one person", () => {
  const id = "00000000-0000-0000-0000-00000000000b";
  const ok = parseSalaryInput({ profile_id: id, annual_salary: "1,234.567", ...note });
  assert.ok(ok.ok);
  assert.equal(ok.value.annual_salary, 1234.57);
  assert.equal(parseSalaryInput({ profile_id: "nobody", annual_salary: 1, ...note }).ok, false);
  assert.equal(parseSalaryInput({ profile_id: id, annual_salary: -1, ...note }).ok, false);
  assert.equal(parseSalaryInput({ profile_id: id, ...note }).ok, false);
  assert.equal(parseSalaryInput({ profile_id: id, annual_salary: 1, ...note, source: "" }).ok, false);
});
