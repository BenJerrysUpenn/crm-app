// "n/a" gap marks on a vertical chart (bj-finance #671, #696).
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { placeGapMarks, thinGapMarks } from "./gapMarks.ts";

test("marks closer than the room they need are thinned, in order", () => {
  assert.deepEqual(thinGapMarks([10, 20, 40, 45, 70], 22), [10, 40, 70]);
  assert.deepEqual(thinGapMarks([], 22), []);
});

test("on a wide chart nothing moves", () => {
  // Desktop: 640 px plot, 5 weeks, 128 px slots, centres 64 px in from each edge.
  const centres = [104, 232, 360, 488, 616];
  assert.deepEqual(placeGapMarks([centres[4]], 18, 40, 680), [616]);
  assert.deepEqual(placeGapMarks(centres, 18, 40, 680), centres);
});

test("on a phone the last week's mark stays inside the plot's right edge", () => {
  // 375 px phone: plot 50..355, 26 weeks, slots under 12 px; the last centre is 6 px from the edge.
  const right = 355;
  const [x] = placeGapMarks([right - 6], 18, 50, right);
  assert.equal(x, right - 9);
  assert.ok(x + 9 <= right, "the text's right end is inside the plot");
});

test("the first week's mark stays inside the left edge too", () => {
  assert.deepEqual(placeGapMarks([53], 18, 50, 355), [59]);
});

test("marks moved in are still thinned so they never overlap", () => {
  // Two last weeks both missing, 6 px apart: moved in, they would overlap, so one is drawn.
  assert.deepEqual(placeGapMarks([343, 349], 18, 50, 355), [343]);
});

test("a plot narrower than one mark centres it", () => {
  assert.deepEqual(placeGapMarks([12], 18, 10, 20), [19]);
});
