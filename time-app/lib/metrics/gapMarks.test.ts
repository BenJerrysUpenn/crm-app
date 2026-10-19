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
  // An 18 px mark centred at 349 would end at 358, past the edge; moved in to 346, it ends at 355.
  assert.deepEqual(placeGapMarks([349], 18, 50, 355), [346]);
});

test("the first week's mark stays inside the left edge too", () => {
  assert.deepEqual(placeGapMarks([53], 18, 50, 355), [59]);
});

test("marks moved in are still thinned so they never overlap", () => {
  // Two last weeks both missing, 6 px apart: moved in, they would overlap, so one is drawn.
  assert.deepEqual(placeGapMarks([343, 349], 18, 50, 355), [343]);
  // 24 px apart as drawn, room enough; the last moves in to 346, 16 px from 330, so it is left out.
  assert.deepEqual(placeGapMarks([330, 354], 18, 50, 355), [330]);
});

test("a plot narrower than one mark starts the mark at the plot's left edge", () => {
  // Plot 10..20 (10 px), mark 18 px: centred at 19, it spans 10..28.
  assert.deepEqual(placeGapMarks([12], 18, 10, 20), [19]);
});
