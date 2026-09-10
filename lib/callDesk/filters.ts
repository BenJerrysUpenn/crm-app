// Facet filtering for the call desk queue (bj-finance #412).
//
// Pure data logic — no React, no DOM — so the rules can be read (and later
// tested) without a renderer. The queue is a few hundred rows, so everything
// here is a straight pass over the array; no indexes, no caches.

import { contactTypeLabel } from "./format";
import {
  dispositionLabel,
  DISPOSITION_VALUES,
  type CallDeskRow,
} from "./types";

/** The bucket every null / blank value falls into. */
export const NONE = "none";

export type FacetKey =
  | "last_contact_type"
  | "last_disposition"
  | "ever_booked"
  | "party_type_booked"
  | "booked_event_type"
  | "category"
  | "city"
  | "status"
  | "calls";

export type Facet = {
  key: FacetKey;
  label: string;
  /** The row's raw bucket value, or null when the row has nothing here. */
  getValue: (row: CallDeskRow) => string | null;
  /** Human label for a bucket. Defaults to the value itself, "—" for NONE. */
  valueLabel?: (v: string) => string;
  /**
   * Closed domains list their values so a hand-edited or stale URL can be
   * ignored rather than filtering the queue down to nothing. Open domains
   * (city, category, party type…) accept whatever the data holds.
   */
  allowedValues?: string[];
};

/** Trim to null so "" and "   " bucket as NONE alongside a real null. */
function text(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

/** Ordered — this is the order the filter sheet lists its groups in. */
export const FACETS: Facet[] = [
  {
    key: "last_contact_type",
    label: "Last contact",
    getValue: (r) => text(r.last_contact_type),
    valueLabel: (v) => (v === NONE ? "—" : contactTypeLabel(v)),
    allowedValues: ["call", "reply", "email", NONE],
  },
  {
    key: "last_disposition",
    label: "Last outcome",
    getValue: (r) => text(r.last_disposition),
    valueLabel: (v) =>
      v === NONE ? "No outcome yet" : (dispositionLabel(v) ?? v),
    allowedValues: [...DISPOSITION_VALUES, NONE],
  },
  {
    key: "ever_booked",
    label: "Booked before",
    // Never NONE: a prospect either has a booked deal behind them or doesn't.
    getValue: (r) => (r.ever_booked ? "yes" : "no"),
    valueLabel: (v) => (v === "yes" ? "Yes" : "No"),
    allowedValues: ["yes", "no"],
  },
  {
    key: "party_type_booked",
    label: "Party type",
    getValue: (r) => text(r.party_type_booked),
  },
  {
    key: "booked_event_type",
    label: "Booked event type",
    getValue: (r) => text(r.booked_event_type),
  },
  { key: "category", label: "Category", getValue: (r) => text(r.category) },
  { key: "city", label: "City", getValue: (r) => text(r.city) },
  { key: "status", label: "Status", getValue: (r) => text(r.status) },
  {
    key: "calls",
    label: "Calls",
    getValue: (r) => ((r.calls_count ?? 0) > 0 ? "1+" : "0"),
    allowedValues: ["0", "1+"],
  },
];

export const FACET_KEYS: FacetKey[] = FACETS.map((f) => f.key);

const BY_KEY = new Map<FacetKey, Facet>(FACETS.map((f) => [f.key, f]));

export function getFacet(key: FacetKey): Facet {
  const facet = BY_KEY.get(key);
  if (!facet) throw new Error(`Unknown facet: ${key}`);
  return facet;
}

export function facetValue(facet: Facet, row: CallDeskRow): string {
  return facet.getValue(row) ?? NONE;
}

export function facetValueLabel(facet: Facet, value: string): string {
  if (facet.valueLabel) return facet.valueLabel(value);
  return value === NONE ? "—" : value;
}

/** Selected values per facet. A missing or empty list means "don't filter". */
export type FacetSelection = Partial<Record<FacetKey, string[]>>;

/** AND across facets, OR within one. */
export function applyFacets(
  rows: CallDeskRow[],
  selection: FacetSelection,
): CallDeskRow[] {
  const active = FACETS.filter((f) => (selection[f.key]?.length ?? 0) > 0);
  if (!active.length) return rows;
  return rows.filter((row) =>
    active.every((f) => selection[f.key]!.includes(facetValue(f, row))),
  );
}

export type FacetCount = { value: string; label: string; count: number };

/**
 * Counts per value for one facet, measured against rows already narrowed by
 * every OTHER facet. That is what makes the numbers useful: they say what
 * picking this value would leave, not what the whole queue holds.
 */
export function facetCounts(
  rows: CallDeskRow[],
  selection: FacetSelection,
  facetKey: FacetKey,
): FacetCount[] {
  const facet = getFacet(facetKey);
  const others: FacetSelection = { ...selection };
  delete others[facetKey];

  const counts = new Map<string, number>();
  for (const row of applyFacets(rows, others)) {
    const v = facetValue(facet, row);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // A selected value can count zero once the other facets bite. Keep its chip
  // anyway, or there is no way to switch it back off from the sheet.
  for (const v of selection[facetKey] ?? []) {
    if (!counts.has(v)) counts.set(v, 0);
  }

  return Array.from(counts, ([value, count]) => ({
    value,
    count,
    label: facetValueLabel(facet, value),
  })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function distinctValueCount(
  rows: CallDeskRow[],
  facetKey: FacetKey,
): number {
  const facet = getFacet(facetKey);
  const seen = new Set<string>();
  for (const row of rows) seen.add(facetValue(facet, row));
  return seen.size;
}

/**
 * The facets worth offering: one whose value is the same on every row filters
 * nothing, so it is hidden — unless something in it is already selected, in
 * which case hiding it would strand that selection.
 */
export function visibleFacets(
  rows: CallDeskRow[],
  selection: FacetSelection,
): Facet[] {
  return FACETS.filter(
    (f) =>
      (selection[f.key]?.length ?? 0) > 0 || distinctValueCount(rows, f.key) > 1,
  );
}

/* selection edits — all return a new object, none mutate ------------------ */

export function addFacetValue(
  selection: FacetSelection,
  key: FacetKey,
  value: string,
): FacetSelection {
  const current = selection[key] ?? [];
  if (current.includes(value)) return selection;
  return { ...selection, [key]: [...current, value] };
}

export function removeFacetValue(
  selection: FacetSelection,
  key: FacetKey,
  value: string,
): FacetSelection {
  const current = selection[key];
  if (!current?.includes(value)) return selection;
  const next = current.filter((v) => v !== value);
  const out = { ...selection };
  if (next.length) out[key] = next;
  else delete out[key];
  return out;
}

export function toggleFacetValue(
  selection: FacetSelection,
  key: FacetKey,
  value: string,
): FacetSelection {
  return selection[key]?.includes(value)
    ? removeFacetValue(selection, key, value)
    : addFacetValue(selection, key, value);
}

export function isSelected(
  selection: FacetSelection,
  key: FacetKey,
  value: string,
): boolean {
  return Boolean(selection[key]?.includes(value));
}

/** How many individual values are switched on, across every facet. */
export function activeFacetCount(selection: FacetSelection): number {
  return FACET_KEYS.reduce((n, k) => n + (selection[k]?.length ?? 0), 0);
}

export type ActiveChip = {
  key: FacetKey;
  value: string;
  facetLabel: string;
  valueLabel: string;
};

/** One entry per selected value, in facet order — the removable chip row. */
export function activeChips(selection: FacetSelection): ActiveChip[] {
  const chips: ActiveChip[] = [];
  for (const facet of FACETS) {
    for (const value of selection[facet.key] ?? []) {
      chips.push({
        key: facet.key,
        value,
        facetLabel: facet.label,
        valueLabel: facetValueLabel(facet, value),
      });
    }
  }
  return chips;
}

/* sorting ----------------------------------------------------------------- */

export type SortDirection = "desc" | "asc";

/** Milliseconds to sort a row by, or null when the row has no contact date. */
function sortTime(row: CallDeskRow): number | null {
  const raw = row.last_contact_at ?? row.last_outreach_at;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/**
 * Order the queue by last contact — "desc" (the default) is newest first.
 * prospect_id breaks ties so the order never wobbles between refreshes.
 *
 * A row with no contact date at all has no place on a timeline, so it sits at
 * the bottom whichever way round the list is; "oldest first" would otherwise
 * open on the rows we know least about.
 */
export function sortRows(
  rows: CallDeskRow[],
  direction: SortDirection = "desc",
): CallDeskRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ta = sortTime(a);
    const tb = sortTime(b);
    if (ta === null || tb === null) {
      if (ta !== tb) return ta === null ? 1 : -1;
      return sign * (a.prospect_id - b.prospect_id);
    }
    return sign * (ta - tb) || sign * (a.prospect_id - b.prospect_id);
  });
}

/* URL round-trip ---------------------------------------------------------- */

/** Query param carrying the sort direction. Absent means "desc". */
export const SORT_PARAM = "sort";

export function parseSort(searchParams: URLSearchParams): SortDirection {
  return searchParams.get(SORT_PARAM) === "asc" ? "asc" : "desc";
}


/**
 * One query param per facet, comma-separated:
 * `?last_contact_type=call,reply&ever_booked=yes`, plus `?sort=asc`.
 *
 * Unknown keys and values are dropped rather than thrown, so a stale or
 * hand-typed link degrades to a looser filter instead of an error page.
 * Values are assumed comma-free — the queue's own columns are.
 */
export function parseSelection(searchParams: URLSearchParams): FacetSelection {
  const out: FacetSelection = {};
  for (const facet of FACETS) {
    const raw = searchParams.get(facet.key);
    if (!raw) continue;
    const values: string[] = [];
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (!v || values.includes(v)) continue;
      if (facet.allowedValues && !facet.allowedValues.includes(v)) continue;
      values.push(v);
    }
    if (values.length) out[facet.key] = values;
  }
  return out;
}

export function serializeSelection(
  selection: FacetSelection,
  sort: SortDirection = "desc",
): URLSearchParams {
  const params = new URLSearchParams();
  for (const facet of FACETS) {
    const values = selection[facet.key];
    if (values?.length) params.set(facet.key, values.join(","));
  }
  // Only the non-default direction is written, so a plain /call-desk link
  // stays plain.
  if (sort === "asc") params.set(SORT_PARAM, "asc");
  return params;
}
