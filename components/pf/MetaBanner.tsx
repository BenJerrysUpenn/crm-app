import type { PfMeta } from "@/lib/pf/types";

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

// "Data as of …" line + a loud warning when the feed failed reconciliation.
export default function MetaBanner({ meta }: { meta: PfMeta }) {
  return (
    <div>
      <p className="meta-line">
        Data as of {fmtWhen(meta.generated_at)} · {meta.row_count} rows ·
        source {meta.source}
      </p>
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
