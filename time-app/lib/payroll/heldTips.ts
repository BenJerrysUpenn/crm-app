// The held catering-tip ledger: the arithmetic that keeps it honest.
//
// Payroll spec §3.6 (bj-finance #519): "a table, not prose: (deal, payer, tip,
// paid date, event date, status). Reconciled every run: released + held +
// pre_window == all-history invoice-tip total. The prose ledger carried a
// phantom $100 (Geraci == Burlington, deal 25188)."
//
// Catering tips are paid on Square invoices, often weeks before the event they
// belong to, and they are allocated by EVENT date (§3.4). So at any moment some
// tip money has arrived and has not been paid out. The 2026-09-23 run tracked
// that in a written note; the note had one payment entered twice under two
// names, and nothing about reading it could have caught that. Tie-out is
// arithmetic, and arithmetic belongs in code with tests around it.
//
// Money is integer cents everywhere. Not floats, not numeric: the tip split is
// largest-remainder to the cent (§3.3), so cents is the unit the whole payroll
// pipeline counts in.
//
// Pure and dependency-free, so `node --test` runs it.

export type HeldTipStatus = "held" | "released" | "pre_window";

/** One row of public.held_tips (migration 26). */
export type HeldTipRow = {
  id?: number;
  deal_id: number | null;
  payer: string | null;
  tip_cents: number;
  paid_date: string; // YYYY-MM-DD, when the money arrived
  event_date: string | null; // YYYY-MM-DD, when the work happened
  status: HeldTipStatus;
  released_in_run: string | null; // YYYY-MM-DD, the run's pay date
  source_payment_id?: string | null;
  note?: string | null;
};

export type LedgerTotals = {
  heldCents: number;
  releasedCents: number;
  preWindowCents: number;
  /** held + released + pre_window. What the ledger claims exists. */
  ledgerCents: number;
};

export function totalCents(rows: HeldTipRow[]): LedgerTotals {
  let heldCents = 0;
  let releasedCents = 0;
  let preWindowCents = 0;
  for (const row of rows) {
    if (row.status === "held") heldCents += row.tip_cents;
    else if (row.status === "released") releasedCents += row.tip_cents;
    else preWindowCents += row.tip_cents;
  }
  return { heldCents, releasedCents, preWindowCents, ledgerCents: heldCents + releasedCents + preWindowCents };
}

export type Reconciliation = LedgerTotals & {
  /** The all-history invoice-tip total from Square, in cents. */
  squareCents: number;
  /** ledger − Square. Positive means the ledger claims money Square never took. */
  differenceCents: number;
  balanced: boolean;
};

/**
 * The §3.6 tie-out: every invoice tip Square has ever taken is in exactly one
 * of the three states, so the three must add up to Square's all-history total.
 *
 * Exact equality, deliberately. There is no tolerance to set: both sides are
 * integer cents summed from records, and a one-cent difference is a real error
 * — a dropped row or a transposed amount — not rounding.
 */
export function reconcile(rows: HeldTipRow[], squareCents: number): Reconciliation {
  const totals = totalCents(rows);
  const differenceCents = totals.ledgerCents - squareCents;
  return { ...totals, squareCents, differenceCents, balanced: differenceCents === 0 };
}

/**
 * Rows that look like the same money entered twice.
 *
 * The phantom $100 was one Square payment against deal 25188 written into the
 * prose ledger under two different payer names — "Geraci" and "Burlington" —
 * which is why payer is NOT part of the key here. Same deal, same day, same
 * amount is the signal; the names were the disguise.
 *
 * A row carrying a `source_payment_id` is exempt: that id is the payment's own
 * identity and the database enforces it unique, so two rows with different ids
 * are two payments however alike they look. Two rows sharing an id are also
 * reported — that shape cannot reach the database, but it can reach this
 * function from an import that has not been written yet.
 */
export type DuplicateGroup = {
  reason: "same-payment-id" | "same-deal-date-amount";
  key: string;
  rows: HeldTipRow[];
  /** What the duplicate is worth: everything past the first row. */
  excessCents: number;
};

export function findDuplicates(rows: HeldTipRow[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  const byPaymentId = new Map<string, HeldTipRow[]>();
  for (const row of rows) {
    const id = (row.source_payment_id ?? "").trim();
    if (!id) continue;
    const list = byPaymentId.get(id);
    if (list) list.push(row);
    else byPaymentId.set(id, [row]);
  }
  for (const [key, list] of byPaymentId) {
    if (list.length > 1) {
      groups.push({
        reason: "same-payment-id",
        key,
        rows: list,
        excessCents: list.slice(1).reduce((sum, r) => sum + r.tip_cents, 0),
      });
    }
  }

  const byNatural = new Map<string, HeldTipRow[]>();
  for (const row of rows) {
    if ((row.source_payment_id ?? "").trim()) continue; // identified: not a guess
    if (row.deal_id === null) continue; // no deal to be the same deal as
    const key = `${row.deal_id}|${row.paid_date}|${row.tip_cents}`;
    const list = byNatural.get(key);
    if (list) list.push(row);
    else byNatural.set(key, [row]);
  }
  for (const [key, list] of byNatural) {
    if (list.length > 1) {
      groups.push({
        reason: "same-deal-date-amount",
        key,
        rows: list,
        excessCents: list.slice(1).reduce((sum, r) => sum + r.tip_cents, 0),
      });
    }
  }

  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Which held rows a run is allowed to release.
 *
 * A tip is released when the EVENT has happened on or before the window end
 * (§3.4 allocates by `deals.event_date`), regardless of when the money arrived.
 * A held row whose event is still in the future stays held — that is the whole
 * point of the table — and a held row with no event date at all cannot be
 * judged, so it stays held and is reported rather than guessed at.
 *
 * `released` and `pre_window` rows are never touched: released money has been
 * paid, and pre-window money is carried only so the tie-out balances.
 */
export function releasableForWindow(
  rows: HeldTipRow[],
  windowEnd: string,
): { release: HeldTipRow[]; stillHeld: HeldTipRow[]; undated: HeldTipRow[] } {
  const release: HeldTipRow[] = [];
  const stillHeld: HeldTipRow[] = [];
  const undated: HeldTipRow[] = [];
  for (const row of rows) {
    if (row.status !== "held") continue;
    if (!row.event_date) undated.push(row);
    else if (row.event_date <= windowEnd) release.push(row);
    else stillHeld.push(row);
  }
  return { release, stillHeld, undated };
}

/** "$1,234.56" from integer cents. Negative renders as "-$1.00". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
