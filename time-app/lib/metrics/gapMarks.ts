// Where a vertical chart draws its "n/a" gap marks (bj-finance #671, #696).
//
// Pure: positions in canvas pixels in, positions out. Chart.tsx measures the
// text and the plot area and draws.

/**
 * Gap mark positions along the category axis (in order), given the room one
 * mark needs: many narrow weeks in a row, so a mark closer than that to the
 * last one drawn is left out and the marks never overlap (every gap is still
 * in the table and the reasons).
 */
export function thinGapMarks(positions: number[], room: number): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (const along of positions) {
    if (along - last < room) continue;
    out.push(along);
    last = along;
  }
  return out;
}

/**
 * Centred gap marks kept whole inside the plot area: a mark whose centre is
 * closer than half its width to either edge moves in until it fits. On a
 * phone the last week's slot is narrower than "n/a", which then ran off the
 * chart's right edge (#696); on a wide chart every mark already fits, so
 * nothing moves. Thinned as thinGapMarks does, after moving.
 */
export function placeGapMarks(positions: number[], width: number, left: number, right: number): number[] {
  const half = width / 2;
  const lo = left + half;
  const hi = Math.max(lo, right - half);
  return thinGapMarks(
    positions.map((p) => Math.min(hi, Math.max(lo, p))),
    width + 4,
  );
}
