// The deal drawer's note on a failed picklist. The catering worker refuses a
// picklist it cannot fully count (a missing guest count or flavours, or an
// item with no quantity rule) and fails the job with the reason, rather than
// printing a blank for the packer (Catering-Manager, 2026-11-12). The drawer
// shows that failure, with when it happened, whenever the deal's latest
// picklist job is a failed one, so the reason survives closing the drawer.

import { fmtNaiveUtcDateTime } from "./dateFormat";
import type { QuoteJob } from "./types";

export type PicklistFailure = { at: string; reason: string };

type JobFields = Pick<
  QuoteJob,
  "kind" | "status" | "created_at" | "processed_at" | "error_message"
>;

// The worker's message reads "RuntimeError: Picklist refused to render:
// #931: <reason>". Staff need the reason only.
const WORKER_PREFIXES = [
  /^\w+(Error|Exception): /,
  /^Picklist refused to render: /,
  /^#\d+: /,
];

export function lastPicklistFailure(
  job: JobFields | null,
): PicklistFailure | null {
  if (!job || job.kind !== "picklist" || job.status !== "error") return null;
  let reason = (job.error_message ?? "").trim();
  for (const prefix of WORKER_PREFIXES) reason = reason.replace(prefix, "");
  return {
    at: fmtNaiveUtcDateTime(job.processed_at ?? job.created_at),
    reason: reason || "no reason recorded",
  };
}
