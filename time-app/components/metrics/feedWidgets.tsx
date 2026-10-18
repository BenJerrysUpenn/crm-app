"use client";

// The Metrics widgets whose numbers come from the bj-finance finance feed
// (bj-finance #671 phase 2; public.metrics_snapshots, migration 40): cash on
// hand, weekly LER and the last closed month. Each says plainly what it is
// waiting for until the feed has published it.

import Chart, { formatValue } from "./Chart";
import { Method, Note, Tile, Tiles, WaitingOnFeed } from "./parts";
import type { MetricsData } from "@/lib/metrics/load";
import type { WidgetSettings } from "@/lib/metrics/widgets";
import { closedMonthTiles, weeklyLer } from "@/lib/metrics/feed";
import { addDays, lastWeeks, mondayOf, monthLabel, shortDay } from "@/lib/metrics/dates";
import { lastN, periodCount } from "@/lib/metrics/series";
import { LER_FLOOR, LER_TARGET, OWNER_COMP_MONTHLY, OWNER_COMP_WEEKLY } from "@/lib/metrics/ler";

const money = (v: number | null | undefined) => (v == null ? "–" : formatValue(Math.round(v), "money").replace(/\.00$/, ""));
const ratio = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));
const pct = (v: number | null | undefined) => (v == null ? "–" : formatValue(v, "pct"));

/** Why a feed widget has nothing to show, in one line, or null when the feed has published. */
export function feedGap(data: MetricsData): string | null {
  switch (data.feed.status) {
    case "ok":
      return null;
    case "not_enabled":
      return "The finance feed is not switched on yet.";
    case "empty":
      return "The feed has not published anything yet.";
    case "unrecognised":
      return "The feed's latest publish is in a format this page does not recognise, so nothing from it is shown.";
    case "unreadable":
      return "The feed could not be read just now; reload to try again.";
  }
}

function builtNote(data: MetricsData) {
  if (data.feed.status !== "ok" || !data.feed.daily) return null;
  return <Note>Finance feed through {shortDay(data.feed.daily.as_of)}.</Note>;
}

// ---- Cash on hand ----------------------------------------------------------------------

export function CashWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const detail = <p>Cash on hand is the Chase balance in QBO less outstanding cheques, read by the feed after the daily bookkeeping pass.</p>;
  const gap = feedGap(data);
  if (gap || data.feed.status !== "ok") return <WaitingOnFeed what={`${gap ?? ""} Cash on hand appears here as a daily line.`} detail={detail} />;
  const cash = data.feed.daily?.cash ?? null;
  const days = periodCount(settings.period);
  const from = addDays(data.today, -days);
  // The latest publish's figure for its own day, so the line ends where the tile says.
  const history = [...data.feed.cashHistory.filter((h) => h.day >= from && h.day !== cash?.as_of), ...(cash ? [{ day: cash.as_of, onHand: cash.on_hand }] : [])].sort((a, b) =>
    a.day < b.day ? -1 : 1,
  );
  if (!cash || history.length === 0)
    return <WaitingOnFeed what="The feed is publishing, but not cash yet: it needs the Chase balance and outstanding cheques from QBO." detail={detail} />;
  return (
    <div>
      <Tiles>
        <Tile label="Cash on hand" value={money(cash.on_hand)} sub={`end of ${shortDay(cash.as_of)}`} />
        <Tile label="Chase balance" value={money(cash.bank_balance)} sub={`less ${money(cash.outstanding_cheques)} in cheques`} />
        <Tile label="Money in that day" value={money(cash.day_in)} />
        <Tile label="Money out that day" value={money(cash.day_out)} />
      </Tiles>
      <Chart
        title={`Cash on hand at the end of each day, last ${days} days`}
        labels={history.map((h) => shortDay(h.day))}
        series={[{ label: "Cash on hand", values: history.map((h) => h.onHand), color: "in_store", type: "line" }]}
        format="money"
        beginAtZero={false}
        tableLabel="Day"
      />
      <Method>{detail}</Method>
    </div>
  );
}

// ---- Weekly LER --------------------------------------------------------------------------

export function LerWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const detail = (
    <>
      <p>
        LER = gross profit / (wages + employer tax + owner comp). Paid uses owner comp at ${OWNER_COMP_WEEKLY.toLocaleString()} a week (Alex
        $630 + Alina $846); unpaid uses $0, since the owners are not paid yet. Target {LER_TARGET.toFixed(1)}; under {LER_FLOOR.toFixed(1)} the
        business is not viable.
      </p>
      <p>
        Weekly gross profit is an estimate: the week&rsquo;s sales (in-store, delivery and concessions from the feed, catering by event
        date) times one less the COGS % of the last three closed months. Wages include the salaried GM.
      </p>
    </>
  );
  const gap = feedGap(data);
  const daily = data.feed.status === "ok" ? data.feed.daily : null;
  if (gap || !daily) return <WaitingOnFeed what={`${gap ?? "No daily publish yet."} Weekly LER appears here, paid and unpaid.`} detail={detail} />;
  const missing = [daily.wages_by_week.length === 0 && "weekly wages", daily.cogs_pct_trailing == null && "the trailing COGS %"].filter(Boolean);
  if (missing.length)
    return <WaitingOnFeed what={`The feed is publishing, but not ${missing.join(" or ")} yet, so weekly LER cannot be worked out.`} detail={detail} />;
  // Complete weeks only: the week in progress has no wages yet.
  const weeks = lastN(lastWeeks(data.today, 14).filter((w) => w !== mondayOf(data.today)), periodCount(settings.period));
  const rows = weeklyLer(daily, data.catering?.byDay ?? {}, weeks);
  const last = [...rows].reverse().find((r) => r.paid != null);
  return (
    <div>
      <Tiles>
        <Tile label="LER paid, last week with wages" value={ratio(last?.paid)} sub={last ? `week of ${shortDay(last.week)}` : undefined} />
        <Tile label="LER unpaid" value={ratio(last?.unpaid)} sub="owner comp $0" />
        <Tile label="Sales that week" value={money(last?.sales)} />
        <Tile label="Gross profit (estimate)" value={money(last?.grossProfit)} sub={`COGS ${pct(daily.cogs_pct_trailing)}`} />
      </Tiles>
      <Chart
        title="Weekly LER, paid and unpaid owner comp, against the 2.0 target"
        labels={rows.map((r) => shortDay(r.week))}
        series={[
          { label: "LER paid", values: rows.map((r) => r.paid), color: "in_store", type: "line" },
          { label: "LER unpaid", values: rows.map((r) => r.unpaid), color: "orange", type: "line" },
          { label: "Target 2.0", values: rows.map(() => LER_TARGET), color: "target", type: "line", dashed: true },
        ]}
        format="ratio"
        tableLabel="Week of"
      />
      {builtNote(data)}
      <Method>{detail}</Method>
    </div>
  );
}

// ---- Last closed month ----------------------------------------------------------------------

export function ClosedMonthWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const detail = (
    <p>
      From the month close in QBO. Pre-tax profit is set against 5, 10 and 15% of revenue. Monthly LER uses owner comp at $
      {OWNER_COMP_MONTHLY.toLocaleString()} a month for paid and $0 for unpaid. COGS % = cost of goods / revenue.
    </p>
  );
  const gap = feedGap(data);
  const months = data.feed.status === "ok" ? data.feed.closedMonths : [];
  if (gap || months.length === 0)
    return <WaitingOnFeed what={`${gap ?? "No closed month published yet."} Pre-tax profit, monthly LER and COGS % appear here.`} detail={detail} />;
  const shown = lastN(months, periodCount(settings.period));
  const m = shown[shown.length - 1];
  const t = closedMonthTiles(m);
  const tiles = shown.map(closedMonthTiles);
  return (
    <div>
      <Tiles>
        <Tile label={`Pre-tax profit, ${monthLabel(m.month)}`} value={money(m.pre_tax_profit)} sub={`${pct(t.preTaxPct)} of revenue`} />
        <Tile label="LER paid / unpaid" value={`${ratio(t.lerPaid)} / ${ratio(t.lerUnpaid)}`} sub={`target ${LER_TARGET.toFixed(1)}`} />
        <Tile label="COGS %" value={pct(t.cogsPct)} sub={`${money(m.cogs)} of ${money(m.revenue)}`} />
        <Tile
          label="Rolling 12 months"
          value={m.rolling_12 ? money(m.rolling_12.pre_tax_profit) : "–"}
          sub={m.rolling_12 ? `${pct(t.rollingPct)} of revenue${m.rolling_12.seller_months ? `, ${m.rolling_12.seller_months} seller months` : ""}` : "not published yet"}
        />
      </Tiles>
      <div className="space-y-4">
        <Chart
          heading="Pre-tax profit by closed month"
          title="Pre-tax profit by closed month"
          labels={shown.map((x) => monthLabel(x.month))}
          series={[{ label: "Pre-tax profit", values: shown.map((x) => x.pre_tax_profit), color: "in_store" }]}
          format="money"
          height={200}
          tableLabel="Month"
        />
        <Chart
          heading="Monthly LER"
          title="Monthly LER, paid and unpaid owner comp"
          labels={shown.map((x) => monthLabel(x.month))}
          series={[
            { label: "LER paid", values: tiles.map((x) => x.lerPaid), color: "in_store", type: "line" },
            { label: "LER unpaid", values: tiles.map((x) => x.lerUnpaid), color: "orange", type: "line" },
            { label: "Target 2.0", values: tiles.map(() => LER_TARGET), color: "target", type: "line", dashed: true },
          ]}
          format="ratio"
          height={200}
          tableLabel="Month"
        />
      </div>
      <Method>{detail}</Method>
    </div>
  );
}
