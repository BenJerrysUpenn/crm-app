"use client";

// The bookkeeping passes card (bj-finance #937, migration 56). Each run of the
// morning bookkeeping pass (DAILY-02), the cash total (DAILY-03) and the sales
// report (WEEKLY-02) writes one row; this card draws what the bookkeeping pass
// booked in QBO and how many bank lines it left waiting for review, with every
// run of every pass behind "Show numbers".

import Chart, { formatValue } from "./Chart";
import { CouldNotLoad, Empty, Method, Tile, Tiles } from "./parts";
import type { MetricsData } from "@/lib/metrics/load";
import type { WidgetSettings } from "@/lib/metrics/widgets";
import { shortDay } from "@/lib/metrics/dates";
import { periodCount } from "@/lib/metrics/series";
import { BOOKKEEPING_PASS, passDays, runsInPeriod, whoRan, type PassRun } from "@/lib/metrics/passHistory";

const money = (v: number | null) => (v == null ? "–" : formatValue(v, "money"));
const count = (v: number | null) => (v == null ? "–" : formatValue(v, "count"));

const PASS_NAME: Record<string, string> = {
  "DAILY-02": "Bookkeeping",
  "DAILY-03": "Cash total",
  "WEEKLY-02": "Sales report",
};

function passName(code: string): string {
  return PASS_NAME[code] ?? code;
}

function waitingText(r: PassRun): string {
  if (r.queueBefore == null && r.queueAfter == null) return "–";
  return `${count(r.queueBefore)} → ${count(r.queueAfter)}`;
}

export function RunsTable({ runs, title }: { runs: PassRun[]; title: string }) {
  return (
    <div className="overflow-x-auto max-w-full">
      <table className="w-full text-sm mb-2">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
            <th scope="col" className="py-1 pr-3 font-medium">Day</th>
            <th scope="col" className="py-1 pr-3 font-medium">Pass</th>
            <th scope="col" className="py-1 pr-3 font-medium text-right whitespace-nowrap">Booked</th>
            <th scope="col" className="py-1 pr-3 font-medium text-right whitespace-nowrap">Waiting, before → after</th>
            <th scope="col" className="py-1 pr-3 font-medium text-right">Cash</th>
            <th scope="col" className="py-1 pr-3 font-medium">Issues</th>
            <th scope="col" className="py-1 font-medium">Note</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={`${r.runDate}-${r.passCode}-${r.runLabel}`} className="border-t border-slate-100 dark:border-slate-800 align-top">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-slate-600 dark:text-slate-300 whitespace-nowrap">{shortDay(r.runDate)}</th>
              <td className="py-1 pr-3 text-slate-900 dark:text-slate-100">
                {passName(r.passCode)}
                <span className="block text-xs text-slate-500 dark:text-slate-400">{whoRan(r)}</span>
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-slate-900 dark:text-slate-100 whitespace-nowrap">
                {r.postedCount == null && r.postedDollars == null ? "–" : `${count(r.postedCount)} · ${money(r.postedDollars)}`}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-slate-900 dark:text-slate-100 whitespace-nowrap">{waitingText(r)}</td>
              <td className="py-1 pr-3 text-right tabular-nums text-slate-900 dark:text-slate-100 whitespace-nowrap">{money(r.cash)}</td>
              <td className="py-1 pr-3 text-slate-700 dark:text-slate-200 whitespace-nowrap">{r.issuesFiled.length ? r.issuesFiled.map((n) => `#${n}`).join(", ") : "–"}</td>
              <td className="py-1 text-slate-700 dark:text-slate-200 min-w-[16rem]">{r.note || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PassHistoryWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const detail = (
    <>
      <p>
        Each run of a pass writes one line here when it finishes: the morning bookkeeping pass, the cash total and the Monday and Friday
        sales report. Booked is what the bookkeeping pass entered in QBO that day. Waiting is how many bank lines sat in QBO&rsquo;s For
        Review list before and after it.
      </p>
      <p>Runs before 2026-11-13 were copied in from the old run logs; where an old log did not give a figure it shows as a dash.</p>
    </>
  );
  const pr = data.passRuns;
  if (pr.status === "not_enabled")
    return (
      <div>
        <Empty>The pass history is not set up yet.</Empty>
        <Method>{detail}</Method>
      </div>
    );
  if (pr.status === "unreadable") return <CouldNotLoad what="the pass history" />;

  const days = periodCount(settings.period);
  const shown = runsInPeriod(pr.runs, data.today, days);
  const chartDays = passDays(pr.runs, data.today, days);
  const lastBookkeeping = shown.find((r) => r.passCode === BOOKKEEPING_PASS) ?? null;
  const bookedTotal = chartDays.reduce((s, d) => s + (d.booked ?? 0), 0);
  const issues = new Set(shown.flatMap((r) => r.issuesFiled));
  const runsTable = <RunsTable runs={shown} title={`Every pass run, last ${days} days, newest first`} />;

  if (shown.length === 0)
    return (
      <div>
        <Empty>No pass has run in the last {days} days.</Empty>
        <Method>{detail}</Method>
      </div>
    );

  return (
    <div>
      <Tiles>
        <Tile
          label="Last bookkeeping pass"
          value={lastBookkeeping ? shortDay(lastBookkeeping.runDate) : "–"}
          sub={lastBookkeeping ? whoRan(lastBookkeeping) : "none in this period"}
        />
        <Tile
          label="Booked that day"
          value={lastBookkeeping ? money(lastBookkeeping.postedDollars) : "–"}
          sub={lastBookkeeping?.postedCount != null ? `${count(lastBookkeeping.postedCount)} bank lines` : undefined}
        />
        <Tile label="Bank lines waiting now" value={lastBookkeeping ? count(lastBookkeeping.queueAfter) : "–"} sub="in QBO's For Review list" />
        <Tile label={`Booked, last ${days} days`} value={money(Math.round(bookedTotal * 100) / 100)} sub={`${issues.size} issues filed`} />
      </Tiles>
      <div className="space-y-4">
        <Chart
          heading="Dollars booked each day"
          title={`Dollars the bookkeeping pass booked in QBO each day it ran, last ${days} days`}
          labels={chartDays.map((d) => shortDay(d.day))}
          series={[{ label: "Booked", values: chartDays.map((d) => d.booked), color: "in_store" }]}
          format="money"
          height={200}
          tableLabel="Day"
          emptyText="No dollar figures in this period."
          table={runsTable}
        />
        <Chart
          heading="Bank lines waiting for review"
          title={`Bank lines left in QBO's For Review list after each bookkeeping pass, last ${days} days`}
          labels={chartDays.map((d) => shortDay(d.day))}
          series={[{ label: "Waiting after the pass", values: chartDays.map((d) => d.waiting), color: "orange", type: "line" }]}
          format="count"
          height={200}
          tableLabel="Day"
          table={runsTable}
        />
      </div>
      <Method>{detail}</Method>
    </div>
  );
}
