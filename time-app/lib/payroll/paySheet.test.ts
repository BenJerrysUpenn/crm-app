// Unit tests for the pay table (bj-finance #519, Alina 2026-10-05).
//
//   npm test        (node --test — Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QBO_COLUMNS,
  inFlight,
  inputsChangedAt,
  micros,
  money,
  payTableBlocker,
  qboCell,
  qboTotal,
  rateCell,
  requestView,
  wagesCell,
  type PaySheetBuild,
  type PaySheetJson,
  type PaySheetMeta,
  type PaySheetState,
  type SheetRow,
} from "./paySheet.ts";
import { payWindowEnding } from "./window.ts";
import type { AuditRow } from "./verify.ts";

const resolved = payWindowEnding("2026-10-04");
if (!resolved.ok) throw new Error("fixture window");
const W = resolved.window;

function row(over: Partial<SheetRow> = {}): SheetRow {
  return {
    person: "Diamond Bailey",
    display: "Bailey, Diamond",
    qbo_employee_id: "Q1",
    salaried: false,
    hours: 49,
    overtime_hours: 2,
    regular_hours: 47,
    offcycle_hours: 0,
    hours_owed: 49,
    pool_cents: 2156,
    catering_cents: 0,
    olo_cents: 4246,
    tips_cents: 6402,
    solo_close_cents: 3000,
    travel_cents: 0,
    pay_type: "hourly",
    hourly_rate: 19,
    wages_cents: 95000,
    wages_basis: "hourly",
    catering_hours: 0,
    premium_hours: 0,
    premium_cents: 0,
    premium_ot_cents: 0,
    premium_ot: [],
    evidence: {
      punch_ids: [],
      punches: [],
      week_hours: [42, 7],
      in_store_hours: 49,
      off_site_hours: 0,
      raw_hours: 49,
      solo_close_nights: ["2026-09-21"],
      solo_close_by_choice: [],
      pool_rule: "per-shift (#209)",
      catering_events: [],
      pastry_shifts_covered: 1,
      owner: false,
    },
    ...over,
  };
}

function sheet(over: Partial<PaySheetJson> = {}): PaySheetJson {
  return {
    sheet_version: 2,
    window: { start: W.start, end: W.end, pay_date: W.payDate, weeks: [["2026-09-21", "2026-09-27"], ["2026-09-28", "2026-10-04"]] },
    pool_rule: "per-shift",
    rows: [row()],
    totals: {
      hours: 49,
      overtime_hours: 2,
      regular_hours: 47,
      wages_cents: 95000,
      wages_unpriced: [],
      tips_cents: 6402,
      solo_close_cents: 3000,
      travel_cents: 0,
      catering_hours: 0,
      premium_cents: 0,
      premium_ot_cents: 0,
    },
    solo_close_nights: [],
    open_items: [],
    flags: [],
    ...over,
  };
}

const STARTED = "2026-10-05T21:00:00.500000+00:00";

function built(over: Partial<PaySheetBuild> = {}): PaySheetBuild {
  return {
    id: 7,
    window_end: W.end,
    status: "built",
    requested_by: null,
    requested_at: STARTED,
    started_at: STARTED,
    built_at: "2026-10-05T21:01:10+00:00",
    built_by: "modules.payroll_publish@abc on mac",
    source_fingerprint: "f",
    open_items: 0,
    error: null,
    sheet: sheet(),
    ...over,
  };
}

function state(over: Partial<Extract<PaySheetState, { available: true }>> = {}): PaySheetState {
  return { available: true, built: built(), latest: built(), changedAt: null, builds: 1, ...over };
}

function audit(table: string, at: string, image: Record<string, unknown>, which: "before" | "after" = "after"): AuditRow {
  return {
    id: 1,
    table_name: table,
    row_id: 1,
    op: which === "after" ? "INSERT" : "DELETE",
    at,
    actor_uid: null,
    actor_role: null,
    db_role: "postgres",
    before_image: which === "before" ? image : null,
    after_image: which === "after" ? image : null,
  };
}

// ---------- QBO's grid -----------------------------------------------------------

test("columns follow QBO's Run Payroll grid: hours, then the flat amounts", () => {
  assert.deepEqual(
    QBO_COLUMNS.map((c) => c.label),
    ["Regular hours", "Overtime hours", "Paycheck tips", "Solo close", "Catering premium", "Catering premium OT", "Travel reimbursement"],
  );
});

test("an hourly row is keyed as the sheet published it", () => {
  const r = row();
  assert.deepEqual(
    QBO_COLUMNS.map((c) => qboCell(r, c.key)),
    ["47.00", "2.00", "$64.02", "$30.00", "", "", ""],
  );
  assert.equal(rateCell(r), "$19.00/h");
  assert.equal(wagesCell(r), "$950.00");
});

test("a salaried row shows salary, not hours or wages", () => {
  const r = row({ salaried: true, pay_type: "salaried", hourly_rate: null, wages_cents: null, wages_basis: "salary", overtime_hours: 0 });
  assert.equal(qboCell(r, "regular"), "salary");
  assert.equal(qboCell(r, "overtime"), "");
  assert.equal(rateCell(r), "salary");
  assert.equal(wagesCell(r), "salary");
});

test("an hourly row with no rate says so instead of a figure", () => {
  const r = row({ hourly_rate: null, wages_cents: null, wages_basis: "no_rate" });
  assert.equal(rateCell(r), "no rate");
  assert.equal(wagesCell(r), "no rate");
});

test("flat amounts and premium lines show only when there is one", () => {
  const r = row({ premium_cents: 291, premium_ot_cents: 12, travel_cents: 4536, tips_cents: 0, solo_close_cents: 0 });
  assert.equal(qboCell(r, "premium"), "$2.91");
  assert.equal(qboCell(r, "premium_ot"), "$0.12");
  assert.equal(qboCell(r, "travel"), "$45.36");
  assert.equal(qboCell(r, "tips"), "");
  assert.equal(qboCell(r, "solo"), "");
});

test("a sheet from before version 2 falls back to hours owed for Regular", () => {
  const r = row({ regular_hours: undefined, hours_owed: 24.53, overtime_hours: 0 });
  assert.equal(qboCell(r, "regular"), "24.53");
});

test("totals come from the sheet's own totals row", () => {
  const t = sheet().totals;
  assert.deepEqual(
    QBO_COLUMNS.map((c) => qboTotal(t, c.key)),
    ["47.00", "2.00", "$64.02", "$30.00", "$0.00", "$0.00", "$0.00"],
  );
  assert.equal(qboTotal({ ...t, regular_hours: undefined }, "regular"), "49.00");
});

test("money formats cents and never rounds them", () => {
  assert.equal(money(420482), "$4,204.82");
  assert.equal(money(5), "$0.05");
  assert.equal(money(-3901), "-$39.01");
  assert.equal(money(null), "—");
});

// ---------- staleness --------------------------------------------------------------

test("a punch in the period, or its padding, bears on it; the Monday after does not", () => {
  const inside = audit("time_entries", "2026-10-05T20:00:00+00:00", { clock_in_at: "2026-09-24T14:00:00+00:00" });
  const dayBefore = audit("time_entries", "2026-10-05T20:01:00+00:00", { clock_in_at: "2026-09-20T22:30:00-04:00" }, "before");
  const earlyMonday = audit("time_entries", "2026-10-05T20:02:00+00:00", { clock_in_at: "2026-10-05T04:30:00-04:00" });
  const mondayShift = audit("time_entries", "2026-10-05T20:03:00+00:00", { clock_in_at: "2026-10-05T10:00:00-04:00" });
  const twoDaysBefore = audit("shifts", "2026-10-05T20:04:00+00:00", { starts_at: "2026-09-19T18:00:00-04:00" });
  assert.equal(inputsChangedAt(W, [inside]), inside.at);
  assert.equal(inputsChangedAt(W, [inside, dayBefore]), dayBefore.at);
  assert.equal(inputsChangedAt(W, [inside, dayBefore, earlyMonday]), earlyMonday.at);
  assert.equal(inputsChangedAt(W, [inside, mondayShift, twoDaysBefore]), inside.at);
  assert.equal(inputsChangedAt(W, [mondayShift]), null);
});

test("a shift is read by starts_at; other tables never count", () => {
  const shift = audit("shifts", "2026-10-05T19:00:00+00:00", { starts_at: "2026-10-01T10:00:00-04:00" });
  const other = audit("store_hours", "2026-10-05T23:00:00+00:00", { starts_at: "2026-10-01T10:00:00-04:00" });
  const junk = audit("time_entries", "2026-10-05T23:00:00+00:00", { clock_in_at: 7 });
  assert.equal(inputsChangedAt(W, [shift, other, junk]), shift.at);
});

test("a choice made from the period or dated inside it bears on it, even when reset", () => {
  const reset = audit("payroll_rulings", "2026-10-05T21:30:00+00:00", { window_end: "2026-10-18", case_date: "2026-10-02" }, "before");
  const fromPeriod = audit("payroll_rulings", "2026-10-05T21:20:00+00:00", { window_end: "2026-10-04", case_date: null });
  const elsewhere = audit("payroll_rulings", "2026-10-05T22:00:00+00:00", { window_end: "2026-10-18", case_date: "2026-10-06" });
  assert.equal(inputsChangedAt(W, [fromPeriod, elsewhere]), fromPeriod.at);
  assert.equal(inputsChangedAt(W, [fromPeriod, reset, elsewhere]), reset.at);
  const ruling = { window_end: "2026-10-04", case_date: "2026-09-30", decided_at: "2026-10-05T21:40:00+00:00", created_at: "2026-10-05T21:10:00+00:00" };
  assert.equal(inputsChangedAt(W, [reset], [ruling]), ruling.decided_at);
  assert.equal(inputsChangedAt(W, [], [{ ...ruling, window_end: "2026-10-18", case_date: "2026-10-08" }]), null);
});

test("microseconds order two writes Date would call equal", () => {
  assert.ok(micros("2026-10-05T21:00:00.500001+00:00") > micros(STARTED));
  assert.equal(micros("2026-10-05T21:00:00.5+00:00"), micros(STARTED));
  assert.ok(micros("2026-10-05T21:00:01+00:00") > micros(STARTED));
});

// ---------- the gate -----------------------------------------------------------------

test("before migration 36 the pay table is not available, and that blocks", () => {
  const blocker = payTableBlocker({ available: false, reason: "it needs migration 36." });
  assert.match(blocker ?? "", /not available yet: it needs migration 36/);
});

test("(b) no pay table built for the period", () => {
  assert.match(payTableBlocker(state({ built: null, latest: null })) ?? "", /Build the pay table/);
});

test("(c) open items block, counted from the row or the sheet", () => {
  assert.match(payTableBlocker(state({ built: built({ open_items: 2 }) })) ?? "", /2 open items\. Fix them/);
  const one = built({ open_items: null, sheet: sheet({ open_items: [{ code: "x", clause: "§2.5", message: "m" }] }) });
  assert.match(payTableBlocker(state({ built: one })) ?? "", /1 open item\. Fix it/);
});

test("(d) a change after the build started blocks; one before it, or at it, does not", () => {
  assert.match(
    payTableBlocker(state({ changedAt: "2026-10-05T21:00:00.600000+00:00" })) ?? "",
    /changed at .* after the pay table was built/,
  );
  assert.equal(payTableBlocker(state({ changedAt: "2026-10-05T20:59:00+00:00" })), null);
  assert.equal(payTableBlocker(state({ changedAt: STARTED })), null);
  assert.equal(payTableBlocker(state()), null);
});

// ---------- the Rebuild button's state -------------------------------------------------

function meta(over: Partial<PaySheetMeta>): PaySheetMeta {
  return { ...built(), ...over } as PaySheetMeta;
}

test("request state reads queued / building / built / failed", () => {
  assert.equal(requestView({ available: false, reason: "x" }).tone, "none");
  assert.match(requestView(state({ latest: null })).text, /No pay table has been built/);
  const queued = state({ latest: meta({ status: "queued", started_at: null, built_at: null }) });
  assert.match(requestView(queued).text, /^Queued /);
  assert.equal(inFlight(queued), true);
  const building = state({ latest: meta({ status: "building", built_at: null }) });
  assert.match(requestView(building).text, /^Building since /);
  assert.equal(inFlight(building), true);
  const claimedNoStart = state({ latest: meta({ status: "building", started_at: null, built_at: null }) });
  assert.match(requestView(claimedNoStart).text, /^Building since /);
  assert.match(requestView(state()).text, /^Built /);
  assert.equal(requestView(state()).tone, "ok");
  assert.equal(inFlight(state()), false);
  assert.match(requestView(state({ latest: meta({ status: "built", built_at: null }) })).text, /^Built /);
  const failed = state({ latest: meta({ status: "failed", error: "FileNotFoundError: Square Reports" }) });
  assert.deepEqual(requestView(failed), { tone: "error", text: "The last build failed: FileNotFoundError: Square Reports." });
  assert.match(requestView(state({ latest: meta({ status: "failed", error: null }) })).text, /no error was recorded/);
  assert.equal(inFlight({ available: false, reason: "x" }), false);
});
