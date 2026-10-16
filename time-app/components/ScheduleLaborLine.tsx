// The manager Schedule page's week line against the labor target, and the
// panel that shows how each day's target is worked out (bj-finance #695).
// The numbers come from lib/controlBoard/schedule.ts; this only draws them.

import type { ReactNode } from "react";

import type { Derived } from "@/lib/controlBoard/math";
import type { DayLabor, ScheduleLabor } from "@/lib/controlBoard/schedule";
import { MISSING, longDay } from "@/lib/controlBoard/schedule";
import { monthName, pct } from "@/lib/controlBoard/format";
import type { ScheduleLaborLoad } from "@/lib/controlBoard/scheduleLoad";

/** The Targets tab. On the time host the middleware sends it on to the finance site. */
export const TARGETS_HREF = "/payroll/targets";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const usd2 = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

const cell = (x: Derived, show: (v: number) => string) => (x.value == null ? <span className="text-rose-600 dark:text-rose-400" title={x.needs.join("; ")}>{MISSING_MARK}</span> : show(x.value));

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
        <span>Total hours: <Strong>{l.totalHours.toFixed(1)}</Strong></span>
        <span> / Hourly labor: <Strong>{h1(l.hourlyHours)} · </Strong>{l.labor.none ? <Missing title={l.labor.notCounted.join("; ")} /> : <Strong>{usd(l.labor.total)}</Strong>}
          {!l.labor.none && l.labor.notCounted.length > 0 && <span className="text-rose-600 dark:text-rose-400"> (incomplete)</span>}
        </span>
        <span> / Target: {l.target.hours.value == null || l.target.dollars.value == null
          ? <Missing title={l.boardEmpty ? MISSING.board : reasons.join("; ")} />
          : <Strong>{h1(l.target.hours.value)} · {usd(l.target.dollars.value)}</Strong>}
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
      <WorkedOut l={l} />
    </div>
  );
}

function WorkedOut({ l }: { l: ScheduleLabor }) {
  const goals = [...new Set(l.days.map((d) => (d.hourlyGoal.value == null ? null : pct(d.hourlyGoal.value, 2))))];
  const t = l.trend;
  const side = (m: ScheduleLabor["trend"]["lastMonth"]) => `${monthName(m.month)} ${m.value == null ? `(${m.note})` : `${usd(m.value)} (${m.note})`}`;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">How the target is worked out</summary>
      <div className="mt-2 space-y-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 overflow-x-auto">
        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div>
            Hourly goal (control board):{" "}
            {goals.length === 1 && goals[0] != null ? <Strong>{goals[0]}</Strong> : goals.every((g) => g == null) ? <span className="text-rose-600 dark:text-rose-400">{MISSING_MARK}</span> : <Strong>changes during the week, see each day</Strong>}
          </div>
          <div>
            Trend factor: {t.factor.value == null ? <span className="text-rose-600 dark:text-rose-400">{MISSING_MARK} ({t.factor.needs.join("; ")})</span> : <Strong>{t.factor.value.toFixed(3)}</Strong>}
            <span className="text-slate-500"> = {side(t.lastMonth)} ÷ {side(t.sameMonthLastYear)}</span>
          </div>
          <div>
            Average rate, active hourly staff:{" "}
            {l.avgRate.value == null ? <span className="text-rose-600 dark:text-rose-400">{MISSING_MARK} ({l.avgRate.needs.join("; ")})</span> : <><Strong>{usd2(l.avgRate.value)}</Strong> over {l.avgRateOver} {l.avgRateOver === 1 ? "person" : "people"}</>}
          </div>
          <div>
            Projected hourly labor: wages {usd(l.labor.wages)} + catering premium {usd(l.labor.premium)} + solo close {usd(l.labor.solo)} + open shifts {usd(l.labor.open)}
          </div>
          {l.notes.map((n) => (
            <div key={n} className="sm:col-span-2 text-amber-700 dark:text-amber-400">{n}</div>
          ))}
        </div>
        <table className="w-full min-w-[760px]">
          <thead className="text-slate-500">
            <tr>
              <th className="text-left font-normal">Day</th>
              <th className="text-left font-normal">Last year, same weekday</th>
              <th className="text-right font-normal">In-store</th>
              <th className="text-right font-normal">× trend</th>
              <th className="text-right font-normal">+ catering booked</th>
              <th className="text-right font-normal">= projected sales</th>
              <th className="text-right font-normal">Target $</th>
              <th className="text-right font-normal">Target hours</th>
              <th className="text-right font-normal">Scheduled</th>
            </tr>
          </thead>
          <tbody>
            {l.days.map((d: DayLabor) => (
              <tr key={d.date} className="border-t border-slate-200 dark:border-slate-800">
                <td>{longDay(d.date).replace(/, \d{4}$/, "")}</td>
                <td>{longDay(d.lastYearDay)}</td>
                <td className="text-right font-mono">{cell(d.lastYearInStore, usd)}</td>
                <td className="text-right font-mono">{cell(d.trendedInStore, usd)}</td>
                <td className="text-right font-mono">{cell(d.catering, usd)}</td>
                <td className="text-right font-mono">{cell(d.projectedSales, usd)}</td>
                <td className="text-right font-mono">{cell(d.targetDollars, usd)}</td>
                <td className="text-right font-mono">{cell(d.targetHours, h1)}</td>
                <td className="text-right font-mono">{h1(d.scheduledHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-slate-500">
          Target $ = projected sales × the hourly goal. Target hours = target $ ÷ the average rate, so swapping people does not move them; the hourly labor $ shows the cost of who is picked. Last year&apos;s catering is never counted.
        </div>
      </div>
    </details>
  );
}

/** The day header's target part: " / 9.0h", or " / –" and a short reason. */
export function DayTarget({ day }: { day: DayLabor | undefined }) {
  if (!day) return null;
  const hours = day.scheduledHours;
  const t = day.targetHours.value;
  if (t == null) {
    return (
      <span title={`Target missing: ${day.targetHours.needs.join("; ")}`}>
        {" · "}{h1(hours)} / <span className="text-rose-600 dark:text-rose-400">–</span>
        <span className="block text-[10px] font-normal text-rose-600 dark:text-rose-400">{day.short}</span>
      </span>
    );
  }
  return (
    <span title={`Target ${h1(t)} = ${day.targetDollars.value == null ? "" : usd2(day.targetDollars.value)} of hourly labor on ${day.projectedSales.value == null ? "" : usd(day.projectedSales.value)} projected sales`}>
      {" · "}<span className={hours > t ? "text-amber-600 dark:text-amber-400" : ""}>{h1(hours)}</span> / {h1(t)}
    </span>
  );
}
