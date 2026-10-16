// Saved views (bj-finance #671): names, widget lists and the editor's moves.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VIEWS, MAX_WIDGETS, addWidget, checkName, cleanName, cleanWidgets, freeName, moveView, moveWidget,
  removeWidget, updateWidgetSettings, type View,
} from "./views.ts";

const view = (over: Partial<View> = {}): View => ({ id: "1", name: "Mine", position: 0, widgets: [], ...over });

test("names are trimmed, spaces collapsed, 1 to 60 characters", () => {
  assert.deepEqual(cleanName("  My   finance view "), { ok: true, name: "My finance view" });
  assert.equal(cleanName("   ").ok, false);
  assert.equal(cleanName(42).ok, false);
  assert.equal(cleanName("x".repeat(61)).ok, false);
  assert.equal(cleanName("x".repeat(60)).ok, true);
});

test("a name is taken by another view regardless of case and spacing", () => {
  const views = [view({ id: "1", name: "Finance" }), view({ id: "2", name: "Catering" })];
  assert.deepEqual(checkName(views, " finance "), { ok: false, error: 'You already have a view called "Finance".' });
  assert.deepEqual(checkName(views, "Finance", "1"), { ok: true, name: "Finance" }); // renaming a view to itself
  assert.equal(checkName(views, "   ").ok, false); // still cleaned first
  assert.equal(freeName(views, "Finance"), "Finance 2");
  assert.equal(freeName(views, "New view"), "New view");
});

test("cleanWidgets drops unknown metrics, fixes settings, keeps ids unique, caps the list", () => {
  const out = cleanWidgets([
    { id: "a", metric: "catering_ar", settings: { period: "12m" } }, // not a period AR offers
    { id: "a", metric: "leads", settings: { period: "13w", stream: "catering" } }, // duplicate id; leads has no stream
    { id: "b", metric: "drop_tables", settings: {} },
    { id: "c", metric: "sales_vs_target", settings: { period: "12m", stream: "concessions" } },
    { id: "d", metric: "sales_vs_target", settings: { stream: "everything" } },
    "junk",
  ]);
  assert.deepEqual(out.map((w) => w.metric), ["catering_ar", "leads", "sales_vs_target", "sales_vs_target"]);
  assert.deepEqual(out[0].settings, { period: "mtd" });
  assert.notEqual(out[1].id, "a");
  assert.deepEqual(out[1].settings, { period: "13w" });
  assert.deepEqual(out[2].settings, { period: "12m", stream: "concessions" });
  assert.deepEqual(out[3].settings, { period: "mtd", stream: "all" });
  assert.deepEqual(cleanWidgets({ not: "a list" }), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, metric: "leads", settings: {} }));
  assert.equal(cleanWidgets(many).length, MAX_WIDGETS);
});

test("a month-set metric keeps a chosen month as YYYY-MM; other metrics never carry one", () => {
  const out = cleanWidgets([
    { id: "a", metric: "labor_vs_target", settings: { month: "2030-10" } },
    { id: "b", metric: "labor_vs_target", settings: { month: "2030-13" } },
    { id: "c", metric: "labor_vs_target", settings: { month: "October" } },
    { id: "d", metric: "labor_vs_target", settings: {} },
    { id: "e", metric: "labour", settings: { period: "4w", month: "2030-10" } },
  ]);
  assert.deepEqual(out.map((w) => w.settings), [
    { period: "mtd", month: "2030-10" },
    { period: "mtd" }, // not a month: back to the default, the last full month
    { period: "mtd" },
    { period: "mtd" },
    { period: "4w" },
  ]);
  let v = addWidget(view(), "labor_vs_target");
  v = updateWidgetSettings(v, v.widgets[0].id, { month: "2030-09" });
  assert.deepEqual(v.widgets[0].settings, { period: "mtd", month: "2030-09" });
});

test("the default views are a finance page and a catering page, already clean", () => {
  assert.deepEqual(DEFAULT_VIEWS.map((v) => v.name), ["Finance", "Catering"]);
  for (const v of DEFAULT_VIEWS) assert.deepEqual(cleanWidgets(v.widgets), v.widgets);
});

test("the editor adds, removes, moves and re-sets widgets", () => {
  let v = view();
  v = addWidget(v, "leads");
  v = addWidget(v, "catering_ar");
  v = addWidget(v, "sales_vs_target");
  assert.deepEqual(v.widgets.map((w) => w.metric), ["leads", "catering_ar", "sales_vs_target"]);
  const [a, , c] = v.widgets;
  v = moveWidget(v, c.id, -1);
  assert.deepEqual(v.widgets.map((w) => w.metric), ["leads", "sales_vs_target", "catering_ar"]);
  v = moveWidget(v, a.id, -1); // already first
  assert.equal(v.widgets[0].id, a.id);
  v = updateWidgetSettings(v, c.id, { stream: "catering", period: "12m" });
  assert.deepEqual(v.widgets[1].settings, { period: "12m", stream: "catering" });
  v = updateWidgetSettings(v, a.id, { period: "mtd" }); // not offered: back to the default
  assert.deepEqual(v.widgets[0].settings, { period: "8w" });
  v = removeWidget(v, a.id);
  assert.deepEqual(v.widgets.map((w) => w.metric), ["sales_vs_target", "catering_ar"]);
});

test("views move left and right and are renumbered", () => {
  const views = [view({ id: "a", position: 0 }), view({ id: "b", name: "B", position: 1 }), view({ id: "c", name: "C", position: 2 })];
  assert.deepEqual(moveView(views, "c", -1).map((v) => [v.id, v.position]), [["a", 0], ["c", 1], ["b", 2]]);
  assert.deepEqual(moveView(views, "a", -1).map((v) => v.id), ["a", "b", "c"]);
});
