import type { PfMeta } from "@/lib/pf/types";
import { fmtEasternDate } from "@/lib/dateFormat";

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

const cents = (c: number) =>
  (c < 0 ? "−" : "") +
  "$" +
  Math.abs(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

// "Categorized through …" (bj-finance #223): the newest day up to which the
// 08:00 bookkeeping pass has given every transaction a real category. Rows
// after it still carry Monarch's own category until the next pass.
export function categorizedStamp(meta: PfMeta): string {
  if (meta.categorized_through)
    return `Categorized through ${fmtEasternDate(meta.categorized_through)}`;
  return "⚠ Not categorized by the bookkeeping pass yet";
}

// "Data as of …" line + a loud warning when the feed failed reconciliation.
// `stamp` adds the categorized-through line (shown on /safe).
export default function MetaBanner({
  meta,
  stamp = false,
}: {
  meta: PfMeta;
  stamp?: boolean;
}) {
  return (
    <div>
      <p className="meta-line">
        Data as of {fmtWhen(meta.generated_at)} · {meta.row_count} rows ·
        source {meta.source}
      </p>
      {stamp && (
        <p
          className={`meta-stamp${meta.categorized_through ? "" : " stale"}`}
        >
          {categorizedStamp(meta)}
        </p>
      )}
      {!meta.reconciliation.ok && (
        <div className="meta-warn" role="alert">
          ⚠ Feed reconciliation FAILED — raw export sums to{" "}
          {cents(meta.reconciliation.raw_sum_cents)} but the ledger sums to{" "}
          {cents(meta.reconciliation.ledger_sum_cents)}. Treat every number on
          this page as unverified until the feed is fixed.
        </div>
      )}
    </div>
  );
}
