// The manager Schedule page's week line against the labor target
// (bj-finance #695). The numbers come from lib/controlBoard/schedule.ts; this
// only draws them.

import type { ReactNode } from "react";

import type { ScheduleLabor } from "@/lib/controlBoard/schedule";
import { MISSING } from "@/lib/controlBoard/schedule";
import type { ScheduleLaborLoad } from "@/lib/controlBoard/scheduleLoad";

/** The Targets tab. On the time host the middleware sends it on to the finance site. */
export const TARGETS_HREF = "/payroll/targets";

const h1 = (v: number) => `${v.toFixed(1)}h`;
const MISSING_MARK = "missing";

function Strong({ children }: { children: ReactNode }) {
  return <b className="text-slate-800 dark:text-slate-200">{children}</b>;
}

function Missing({ title }: { title?: string }) {
  return (
    <b className="text-rose-600 dark:text-rose-400" title={title}>
      {MISSING_MARK}
    </b>
  );
}

function TargetsLink() {
  return (
    <a href={TARGETS_HREF} className="underline text-emerald-700 dark:text-emerald-400 hover:text-emerald-600">
      Targets page
    </a>
  );
}

/** Why the week's target is missing, in one line. */
function targetReasons(l: ScheduleLabor): string[] {
  if (l.boardEmpty) return [];
  return l.target.hours.needs;
}

export default function ScheduleLaborLine({ load }: { load: ScheduleLaborLoad }) {
  if (!load.ready) {
    return <div className="mb-3 text-sm text-rose-600 dark:text-rose-400">Labor target not available: {load.reason}</div>;
  }
  const l = load.labor;
  const reasons = targetReasons(l);
  return (
    <div className="mb-3 text-sm text-slate-600 dark:text-slate-400 space-y-1" data-testid="labor-line">
      <div>
        <span>Scheduled Hourly Labor: <Strong>{h1(l.hourlyHours)}</Strong></span>
        <span> | Target Hourly Labor: {l.target.hours.value == null
          ? <Missing title={l.boardEmpty ? MISSING.board : reasons.join("; ")} />
          : <Strong>{h1(l.target.hours.value)}</Strong>}
        </span>
      </div>
      {l.boardEmpty ? (
        <div className="text-rose-600 dark:text-rose-400">
          No labor target yet: nothing is entered on the control board. Owners enter the sales estimate, payroll target, taxes and schedule rules on the <TargetsLink />.
        </div>
      ) : reasons.length > 0 ? (
        <div className="text-rose-600 dark:text-rose-400">
          Target missing: {reasons.join("; ")}. Board values are set on the <TargetsLink />.
        </div>
      ) : null}
      {!l.labor.none && l.labor.notCounted.length > 0 && (
        <div className="text-rose-600 dark:text-rose-400">Not in the $: {l.labor.notCounted.join("; ")}.</div>
      )}
      {l.labor.none && <div className="text-rose-600 dark:text-rose-400">Hourly labor $ missing: {l.labor.notCounted.join("; ")}.</div>}
      {load.problems.map((p) => (
        <div key={p} className="text-amber-700 dark:text-amber-400">{p}</div>
      ))}
    </div>
  );
}
