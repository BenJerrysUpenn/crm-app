import {
  reconcileShifts,
  type ReconcileReport,
  type ShiftStore,
} from "@/lib/cateringShifts";

// The catering-shift reconcile as a command, for a scheduled job on a machine
// rather than an HTTP cron. scripts/reconcile-catering-shifts.ts wires it to
// a real Postgres connection; tests wire it to an in-memory store.
//
// It runs reconcileShifts, the same sweep the /api/cron/catering-shifts route
// runs, so the shifts it creates are identical: the cart rule, the long-shift
// warning and the idempotency all come from lib/cateringShifts.ts.
//
// Usage: reconcile-catering-shifts [--dry-run]
//   DATABASE_URL  Postgres DSN for the Supabase project (required)
//
// Prints exactly one summary line. Exit codes:
//   0  swept, every deal that needed shifts got them (or would, in a dry run)
//   1  the sweep failed, or at least one deal's shifts could not be created
//   2  bad usage: unknown argument or DATABASE_URL missing

export type OpenStore = <T>(
  dsn: string,
  opts: { readOnly: boolean },
  fn: (store: ShiftStore) => Promise<T>,
) => Promise<T>;

export type CliDeps = {
  env: Record<string, string | undefined>;
  openStore: OpenStore;
  out: (line: string) => void;
  err: (line: string) => void;
};

const USAGE = "usage: reconcile-catering-shifts [--dry-run]  (DATABASE_URL must be set)";

// A dry run reads everything a live run reads and reports what it would
// create, but its inserts never reach the database: the count it reports is
// the number of rows it would have sent. If the store can rehearse an insert
// (the Postgres store EXPLAINs it), the dry run does, so an insert the
// database would refuse fails the dry run instead of the first live run. The
// Postgres store also runs the dry run in a read-only transaction, so a write
// would be refused anyway.
export function dryRunStore(store: ShiftStore): ShiftStore {
  return {
    bookedDealsWithDeparture: () => store.bookedDealsWithDeparture(),
    dealHasShifts: (id) => store.dealHasShifts(id),
    insertShiftsIgnoringDuplicates: async (rows) => {
      await store.rehearseInsert?.(rows);
      return rows.length;
    },
  };
}

// The one line a run prints. Everything a person needs to act on is on it:
// which deals got shifts, which were flagged CHECK HOURS, which failed.
export function formatSummary(report: ReconcileReport, dryRun: boolean): string {
  const verb = dryRun ? "would create" : "created";
  const parts = [
    `[catering-shifts]${dryRun ? " DRY RUN:" : ""} scanned ${report.scanned} booked deals`,
    `${verb} ${report.created} shifts for ${report.deals} deals` +
      (report.createdFor.length > 0
        ? ` (${report.createdFor.map((d) => `#${d.dealId} x${d.shifts}`).join(", ")})`
        : ""),
  ];
  if (report.warnings.length > 0) parts.push(`warnings: ${report.warnings.join(" | ")}`);
  if (report.failed.length > 0) {
    parts.push(`FAILED: ${report.failed.map((f) => `#${f.dealId} ${f.message}`).join(" | ")}`);
  }
  return parts.join("; ");
}

export async function runReconcileCli(argv: string[], deps: CliDeps): Promise<number> {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else {
      deps.err(`[catering-shifts] unknown argument: ${arg}. ${USAGE}`);
      return 2;
    }
  }

  const dsn = deps.env.DATABASE_URL?.trim();
  if (!dsn) {
    deps.err(`[catering-shifts] DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }

  let report: ReconcileReport;
  try {
    report = await deps.openStore(dsn, { readOnly: dryRun }, (store) =>
      reconcileShifts(dryRun ? dryRunStore(store) : store),
    );
  } catch (e) {
    deps.err(`[catering-shifts] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const line = formatSummary(report, dryRun);
  if (report.failed.length > 0) {
    deps.err(line);
    return 1;
  }
  deps.out(line);
  return 0;
}
