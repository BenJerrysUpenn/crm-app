// How the control board writes its percentages (bj-finance #693). A worked
// share lands as a float a hair below its true value (0.21874999999999997 for
// 21.875%); the board must round that tie on the worked figure, not a
// hundredth low. Every figure here is invented: crm-app is public.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { pct, pctFixed } from "./format.ts";

test("a share on a half-hundredth tie rounds up, even as the float that lands below it", () => {
  // The hourly goal works out to 21.875%; computeBoard returns it as the float
  // just under. Both the exact value and that float must show 21.88%.
  assert.equal(pctFixed(0.21875), "21.88%");
  assert.equal(pctFixed(0.21874999999999997), "21.88%");
  // The all-staff tax share, 3.125%, the same way.
  assert.equal(pctFixed(0.03125), "3.13%");
  assert.equal(pctFixed(0.031249999999999997), "3.13%");
});

test("clearing the float noise never moves a figure that is not on a tie", () => {
  assert.equal(pctFixed(0.25), "25.00%");
  assert.equal(pctFixed(308035.71 / 1_000_000), "30.80%");
  assert.equal(pct(0.0125), "1.25%");
  assert.equal(pct(0.25), "25%");
  assert.equal(pct(0.08, 3), "8%");
});

test("a figure a real amount below a tie still rounds down: only float noise is cleared", () => {
  // 21.87499% is a worked figure, not noise under 21.875%: it shows 21.87%.
  assert.equal(pctFixed(0.2187499), "21.87%");
  assert.equal(pct(0.2187499), "21.87%");
  assert.equal(pct(0.2187499, 3), "21.875%");
});
