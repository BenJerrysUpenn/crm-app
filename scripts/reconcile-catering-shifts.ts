// Local catering-shift reconciler: creates missing shifts for booked
// catering deals, straight against Postgres. Replaces the Drive copy of
// reconcile_catering_shifts.py (crm-app #33). All logic lives in lib/; this
// file only wires it to the process.
//
//   set -a && . ~/.config/bj-catering/env && set +a
//   npm run reconcile-shifts -- --dry-run   # read-only report
//   npm run reconcile-shifts                # creates the shifts
import { withPgShiftStore } from "@/lib/cateringShiftsPg";
import { runReconcileCli } from "@/lib/reconcileCli";

runReconcileCli(process.argv.slice(2), {
  env: process.env,
  openStore: withPgShiftStore,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[catering-shifts] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
