// The read helpers every Metrics loader shares (lib/metrics/load.ts, the
// Labor Hours Planning reads and their local preview): paging past
// PostgREST's row cap, and New York midnight as an instant to filter on.

const PAGE = 1000; // PostgREST's row cap per request
const MAX_PAGES = 50;

type Query = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }> };

/** Every row `make` selects, a page at a time; a failed page throws its error. */
export async function paged<T>(make: () => Query): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await make().range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** An ISO instant at New York midnight starting `day` (EDT or EST: the earlier, so nothing is missed). */
export function nyMidnight(day: string): string {
  return `${day}T04:00:00Z`;
}
