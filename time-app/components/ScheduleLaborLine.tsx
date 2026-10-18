// The manager Schedule page's week lines against the labor target
// (bj-finance #695): Target, Scheduled and Remaining Hourly Labor as an
// aligned label | hours | $ block (Alina, 2026-10-16). The numbers come
// from lib/controlBoard/schedule.ts; this only draws them.

import type { ReactNode } from "react";

import type { ScheduleLabor } from "@/lib/controlBoard/schedule";
import { MISSING } from "@/lib/controlBoard/schedule";
import type { ScheduleLaborLoad } from "@/lib/controlBoard/scheduleLoad";

/** The Targets tab. On the time host the middleware sends it on to the finance site. */
export const TARGETS_HREF = "/payroll/targets";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
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

const MINUS = "\u2212";
/** The week block's cells: labels left (they wrap before the table overflows a 375px phone), numbers right in tabular figures, never wrapped. */
const LABEL = "pr-3 py-0.5 text-left font-normal";
const NUM = "pl-3 py-0.5 text-right tabular-nums whitespace-nowrap";

/**
 * Remaining Hourly Labor = target - scheduled, hours and $ (Alina,
 * 2026-10-16). Null when either side is missing. A value counts as negative
 * only when it still is at the precision shown, so the line never reads
 * "-0.0h" in red.
 */
export function remainingHourlyLabor(l: Pick<ScheduleLabor, "target" | "hourlyHours" | "labor">): { hours: string; dollars: string; negative: boolean } | null {
  if (l.target.hours.value == null || l.target.dollars.value == null || l.labor.none) return null;
  const hours = Math.round((l.target.hours.value - l.hourlyHours) * 10) / 10;
  const dollars = Math.round(l.target.dollars.value - l.labor.total);
  const sign = (v: number) => (v < 0 ? MINUS : "");
  return {
    hours: `${sign(hours)}${h1(Math.abs(hours))}`,
    dollars: `${sign(dollars)}${usd(Math.abs(dollars))}`,
    negative: hours < 0 || dollars < 0,
  };
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
  const remaining = remainingHourlyLabor(l);
  return (
    <div className="mb-3 text-sm text-slate-600 dark:text-slate-400 space-y-1" data-testid="labor-line">
      {/* Target, Scheduled, Remaining (order by Alina, 2026-10-16): label | hours | $, the numbers right-aligned in tabular figures so the decimal points and $ line up. */}
      <table className="border-collapse" data-testid="labor-week">
        <tbody>
          <tr>
            <th scope="row" className={LABEL}>Target Hourly Labor</th>
            {l.target.hours.value == null || l.target.dollars.value == null ? (
              <>
                <td className={NUM}><Missing title={l.boardEmpty ? MISSING.board : reasons.join("; ")} /></td>
                <td className={NUM}><Missing title={l.boardEmpty ? MISSING.board : reasons.join("; ")} /></td>
              </>
            ) : (
              <>
                <td className={NUM}><Strong>{h1(l.target.hours.value)}</Strong></td>
                <td className={NUM}><Strong>{usd(l.target.dollars.value)}</Strong></td>
              </>
            )}
            <td />
          </tr>
          <tr>
            <th scope="row" className={LABEL}>Scheduled Hourly Labor</th>
            <td className={NUM}><Strong>{h1(l.hourlyHours)}</Strong></td>
            <td className={NUM}>{l.labor.none ? <Missing title={l.labor.notCounted.join("; ")} /> : <Strong>{usd(l.labor.total)}</Strong>}</td>
            <td className="pl-2 text-xs text-rose-600 dark:text-rose-400">{!l.labor.none && l.labor.notCounted.length > 0 ? "(incomplete)" : null}</td>
          </tr>
          {remaining == null ? (
            <tr>
              <th scope="row" className={LABEL}>Remaining Hourly Labor</th>
              <td className={NUM}><Missing /></td>
              <td className={NUM}><Missing /></td>
              <td />
            </tr>
          ) : (
            <tr className={remaining.negative ? "text-rose-600 dark:text-rose-400" : undefined}>
              <th scope="row" className={LABEL}>Remaining Hourly Labor</th>
              <td className={NUM}>{remaining.negative ? <b>{remaining.hours}</b> : <Strong>{remaining.hours}</Strong>}</td>
              <td className={NUM}>{remaining.negative ? <b>{remaining.dollars}</b> : <Strong>{remaining.dollars}</Strong>}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
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
