"use client";

// The body of each Metrics widget (bj-finance #671), by metric. Each takes
// the page's data and the widget's own settings and draws a chart, the
// headline numbers above it, and plain notes on what the numbers leave out.

import Chart, { formatValue, type Series } from "./Chart";
import { CouldNotLoad, Empty, Note, Tile, Tiles, WaitingOnFeed } from "./parts";
import type { MetricsData } from "@/lib/metrics/load";
import type { WidgetSettings } from "@/lib/metrics/widgets";
import { STREAM_LABEL, type StreamFilter } from "@/lib/metrics/targets";
import { lastN, periodCount, salesByMonth, salesMonthToDate, type SalesStream, type StreamDaily } from "@/lib/metrics/series";
import { mondayOf, monthLabel, shortDay } from "@/lib/metrics/dates";
import { conversion, LEAD_SOURCES } from "@/lib/metrics/funnel";
import { LER_FLOOR, LER_TARGET, OWNER_COMP_WEEKLY } from "@/lib/metrics/ler";

const money = (v: number | null | undefined, compact = false) => formatValue(v ?? null, "money", compact);

const STREAM_COLOR: Record<SalesStream, Series["color"]> = { in_store: "in_store", catering: "catering", concessions: "concessions" };

function weekLabel(monday: string, today: string): string {
  return mondayOf(today) === monday ? `${shortDay(monday)} (so far)` : shortDay(monday);
}

/** Sales by day per stream that the page has: catering from the CRM; the rest arrive with the feed. */
function streamDaily(data: MetricsData): StreamDaily {
  return data.catering ? { catering: data.catering.byDay } : {};
}

function waitingStreams(streams: SalesStream[]): string {
  return streams.map((s) => STREAM_LABEL[s].toLowerCase()).join(" and ");
}

// ---- W1 Sales vs target ------------------------------------------------------------

export function SalesWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.catering) return <CouldNotLoad what="catering deals" />;
  const stream: StreamFilter = settings.stream ?? "all";
  const sales = streamDaily(data);
  const targetNote = (
    <>
      Targets: monthly targets per stream from the seller-era seasonal table (bj-finance #671), December PAX set at $5,000,
      {data.targetsSource === "seed" ? " from the copy bundled with the page until the targets table is switched on." : " from the targets table."}
      {" "}Concessions targets are provisional and on Aramark&rsquo;s net basis until gross vs net is settled; concessions sales will be
      measured on the same basis as their target.
    </>
  );

  if (settings.period === "12m") {
    const m = salesByMonth(sales, data.targets, stream, data.today);
    const series: Series[] = [
      ...m.actual.map((a) => ({ label: STREAM_LABEL[a.stream], values: a.values, color: STREAM_COLOR[a.stream], stack: "actual" })),
      { label: "Target", values: m.target, color: "target" as const, type: "line" as const, dashed: true, stack: "target" },
    ];
    return (
      <div>
        {m.waitingOn.length > 0 && m.actual.length === 0 ? (
          <WaitingOnFeed what={`${STREAM_LABEL[stream]} sales come from QBO and Square. The bars appear when the feed runs.`} />
        ) : (
          <Chart
            title={`${STREAM_LABEL[stream]} sales by month against target, ${m.labels[0]} to ${m.labels[m.labels.length - 1]}`}
            labels={m.labels.map((l, i) => (i > m.currentIndex ? `${l} (booked)` : m.provisional[i] ? `${l}*` : l))}
            series={series}
            format="money"
            stacked
            tableLabel="Month"
          />
        )}
        {m.waitingOn.length > 0 && m.actual.length > 0 && (
          <Note>
            Waiting on the finance feed for {waitingStreams(m.waitingOn)}: the bars show catering only, against the{" "}
            {stream === "all" ? "whole-business" : STREAM_LABEL[stream].toLowerCase()} target.
          </Note>
        )}
        <Note>
          Catering is counted on the event date; months after this one are events booked so far. * marks a month whose target
          includes a provisional concessions figure. {targetNote}
        </Note>
        <CateringCaveats data={data} />
      </div>
    );
  }

  const m = salesMonthToDate(sales, data.targets, stream, data.today);
  const series: Series[] = [
    ...m.cumulative.map((c) => ({ label: STREAM_LABEL[c.stream], values: c.values, color: STREAM_COLOR[c.stream], stack: "actual", area: true })),
    ...(m.pace ? [{ label: "Pace to target", values: m.pace, color: "target" as const, type: "line" as const, dashed: true, stack: "pace" }] : []),
  ];
  const p = m.progress;
  return (
    <div>
      <Tiles>
        <Tile label={`${monthLabel(data.today)} target`} value={money(m.target?.amount)} sub={m.target?.provisional ? "includes a provisional figure" : STREAM_LABEL[stream]} />
        <Tile label={`Pace to ${shortDay(data.today)}`} value={p ? money(p.paceToDate) : m.target ? money((m.target.amount * Number(data.today.slice(8))) / m.days.length) : "–"} sub={`day ${Number(data.today.slice(8))} of ${m.days.length}`} />
        <Tile
          label="Actual to date"
          value={money(m.actualSoFar)}
          sub={m.waitingOn.length ? `catering only so far` : p?.pctOfTarget != null ? `${formatValue(p.pctOfTarget, "pct")} of the month's target` : undefined}
        />
        {p && p.vsPace != null ? (
          <Tile
            label={p.vsPace >= 0 ? "Ahead of pace" : "Behind pace"}
            value={money(Math.abs(p.vsPace))}
            tone={p.vsPace >= 0 ? "good" : "serious"}
            sub={p.pctOfPace != null ? `${formatValue(p.pctOfPace, "pct")} of pace` : undefined}
          />
        ) : (
          <Tile label="Ahead or behind pace" value="–" sub={m.waitingOn.length ? `waiting on the feed for ${waitingStreams(m.waitingOn)}` : "no target set"} />
        )}
      </Tiles>
      {m.cumulative.length === 0 ? (
        <WaitingOnFeed what={`${STREAM_LABEL[stream]} sales come from QBO and Square, booked daily. The month-to-date line appears when the feed runs.`} />
      ) : (
        <Chart
          title={`${STREAM_LABEL[stream]} sales this month, cumulative, against the pace line`}
          labels={m.labels}
          series={series}
          format="money"
          stacked
          tableLabel="Day"
        />
      )}
      {m.waitingOn.length > 0 && m.cumulative.length > 0 && (
        <Note>
          Waiting on the finance feed for {waitingStreams(m.waitingOn)}. Until then the line is catering only and the gap to pace is
          not worked out, so part of the business is never measured against the whole target.
        </Note>
      )}
      <Note>Catering is counted on the event date (booked deals). {targetNote}</Note>
      <CateringCaveats data={data} />
    </div>
  );
}

function CateringCaveats({ data }: { data: MetricsData }) {
  const c = data.catering;
  if (!c) return null;
  return (
    <>
      {c.suspect.length > 0 && (
        <Note>
          Left out: {c.suspect.length} deal{c.suspect.length === 1 ? "" : "s"} marked Event Complete for an event that has not happened,
          with no payment and no booking in their history (the 10-06 sweep defect, not yet repaired):{" "}
          {c.suspect.map((s) => `#${s.id}${s.company ? ` ${s.company}` : ""}${s.eventDay ? ` (${s.eventDay})` : ""}`).join(", ")}.
        </Note>
      )}
      {c.estimatedIds.length > 0 && (
        <Note>
          {c.estimatedIds.length} deal{c.estimatedIds.length === 1 ? " has" : "s have"} no pre-tax subtotal; the total less 8% tax is used.
        </Note>
      )}
      {c.missingValueIds.length > 0 && (
        <Note>
          {c.missingValueIds.length} booked deal{c.missingValueIds.length === 1 ? " has" : "s have"} no quote total and count as $0:{" "}
          {c.missingValueIds.map((id) => `#${id}`).join(", ")}.
        </Note>
      )}
    </>
  );
}

// ---- D1 Cash on hand -----------------------------------------------------------------

export function CashWidget() {
  return (
    <WaitingOnFeed what="Cash on hand is the Chase balance in QBO less outstanding cheques, with yesterday's money in and out (DAILY-03). It needs the bj-finance feed, which reads QBO after the daily bookkeeping pass. A daily line of cash on hand appears here once it runs." />
  );
}

// ---- W2 Catering AR -------------------------------------------------------------------

export function ArWidget({ data }: { data: MetricsData }) {
  const ar = data.ar;
  if (!ar) return <CouldNotLoad what="catering deals" />;
  const month = data.today.slice(0, 7);
  const thisMonth = ar.rows.filter((r) => r.eventDay.startsWith(month));
  const olderOverdue = ar.rows.filter((r) => r.overdue && !r.eventDay.startsWith(month));
  const shown = [...olderOverdue, ...thisMonth];
  return (
    <div>
      <Tiles>
        <Tile label={`Due in ${monthLabel(data.today)}`} value={money(ar.dueThisMonth)} sub={`${thisMonth.length} event${thisMonth.length === 1 ? "" : "s"}`} />
        <Tile label="Overdue this month" value={money(ar.overdueThisMonth)} tone={ar.overdueThisMonth > 0 ? "serious" : "plain"} sub="event already held" />
        <Tile label="Not yet due" value={money(ar.notYetDueThisMonth)} sub="event still to come" />
        <Tile label="Overdue from earlier months" value={money(ar.overdue - ar.overdueThisMonth)} tone={ar.overdue - ar.overdueThisMonth > 0 ? "serious" : "plain"} />
      </Tiles>
      {shown.length === 0 ? (
        <Empty>No balances owed on this month&rsquo;s events.</Empty>
      ) : (
        <>
          <Chart
            title="Catering balances owed, by event"
            labels={shown.map((r) => `${shortDay(r.eventDay)} ${r.company ?? `#${r.id}`}`.slice(0, 28))}
            series={[
              { label: "Overdue", values: shown.map((r) => (r.overdue ? r.balance : null)), color: "serious", stack: "b" },
              { label: "Not yet due", values: shown.map((r) => (r.overdue ? null : r.balance)), color: "catering", stack: "b" },
            ]}
            format="money"
            stacked
            height={Math.max(200, Math.min(360, 60 + shown.length * 18))}
            tableLabel="Event"
          />
        </>
      )}
      <Note>
        Balance = quote total with tax less the amount paid recorded in the CRM; nothing is owed once a deal is Paid in Full. Due by the
        event date. Square is the authority on what has been paid (bj-finance square_ar.py); a payment Square has and the CRM has not
        recorded shows here as owed.
        {ar.laterMonths > 0 && ` Later months: ${money(ar.laterMonths)} more is owed on events after this month.`}
      </Note>
      {ar.missingTotalIds.length > 0 && <Note>No quote total, so no balance: {ar.missingTotalIds.map((id) => `#${id}`).join(", ")}.</Note>}
    </div>
  );
}

// ---- W3 Weekly LER ----------------------------------------------------------------------

export function LerWidget() {
  return (
    <WaitingOnFeed
      what={`Weekly LER is gross profit / (wages + employer tax + owner comp), shown two ways: paid (owner comp $${OWNER_COMP_WEEKLY.toLocaleString()} a week) and unpaid (owner comp $0). Target ${LER_TARGET.toFixed(1)}; under ${LER_FLOOR.toFixed(1)} the business is not viable. It needs weekly sales, wages and the trailing COGS % from the bj-finance feed; weekly gross profit will be labelled an estimate.`}
    />
  );
}

// ---- W4 Next 14 days ------------------------------------------------------------------------

export function ForwardWidget({ data }: { data: MetricsData }) {
  const f = data.forward;
  if (!f) return <CouldNotLoad what="deals and shifts" />;
  const cateringIn = f.days.reduce((s, d) => s + d.cateringIn, 0);
  const wages = f.days.reduce((s, d) => s + d.scheduledWages, 0);
  return (
    <div>
      <Tiles>
        <Tile label="Catering balances due" value={money(cateringIn)} sub="events in the next 14 days" />
        <Tile label="Overdue catering" value={money(f.overdue)} tone={f.overdue > 0 ? "serious" : "plain"} sub="past events, not on a day" />
        <Tile label="Scheduled hourly wages" value={money(wages)} sub="earned in the next 14 days" />
        <Tile label="Opening cash" value="–" sub="waiting on the finance feed" />
      </Tiles>
      <Chart
        title="Known money in and out over the next 14 days"
        labels={f.days.map((d) => shortDay(d.day))}
        series={[
          { label: "Catering due in", values: f.days.map((d) => d.cateringIn), color: "catering" },
          { label: "Hourly wages earned", values: f.days.map((d) => d.scheduledWages), color: "orange" },
        ]}
        format="money"
        tableLabel="Day"
      />
      <WaitingOnFeed what="Opening cash, recurring bills, other bills, tax and the in-store sales projection come from QBO and Square through the finance feed. With them this becomes a running cash balance." />
      <Note>
        Wages are shift hours x hourly rate for hourly staff, placed on the day earned (they leave the bank on the next pay date). The
        salaried GM, owners and {f.uncostedShifts} unassigned or unrated shift{f.uncostedShifts === 1 ? "" : "s"} are not costed. Employer tax not included.
      </Note>
    </div>
  );
}

// ---- W5 Labour -----------------------------------------------------------------------------

export function LabourWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const l = data.labour;
  if (!l) return <CouldNotLoad what="the time clock" />;
  const weeks = lastN(l.weeks, periodCount(settings.period));
  const full = weeks.filter((w) => w.week !== mondayOf(data.today));
  const last = full[full.length - 1];
  const salaried = weeks.reduce((s, w) => s + w.salariedHours, 0);
  const noRate = weeks.reduce((s, w) => s + w.noRateHours, 0);
  return (
    <div>
      <Tiles>
        <Tile label="In-store hours, last full week" value={formatValue(last?.inStoreHours ?? null, "hours")} sub={last ? `week of ${shortDay(last.week)}` : undefined} />
        <Tile label="Catering hours, last full week" value={formatValue(last?.cateringHours ?? null, "hours")} />
        <Tile label="Hourly labour $, last full week" value={money(last ? last.inStoreHourlyCost + last.cateringHourlyCost : null)} sub="hourly staff only" />
        <Tile label="Sales per scooper-hour" value="–" sub="waiting on the finance feed" />
      </Tiles>
      <Chart
        title="Clocked hours by week, in-store and catering"
        labels={weeks.map((w) => weekLabel(w.week, data.today))}
        series={[
          { label: "In-store hours", values: weeks.map((w) => w.inStoreHours), color: "in_store" },
          { label: "Catering hours", values: weeks.map((w) => w.cateringHours), color: "catering" },
        ]}
        format="hours"
        stacked
        tableLabel="Week of"
      />
      <Chart
        title="Hourly labour cost by week, hourly staff only"
        labels={weeks.map((w) => weekLabel(w.week, data.today))}
        series={[
          { label: "In-store hourly $", values: weeks.map((w) => w.inStoreHourlyCost), color: "in_store" },
          { label: "Catering hourly $", values: weeks.map((w) => w.cateringHourlyCost), color: "catering" },
        ]}
        format="money"
        stacked
        height={200}
        tableLabel="Week of"
      />
      <WaitingOnFeed what="Sales per scooper-hour (in-store sales / in-store hours; B&J benchmark $200-250 with one scooper, $400-500 with two) and labour % need in-store sales from the finance feed." />
      <Note>
        Labour $ from the time clock is a floor, not total labour: it leaves out the salaried GM ({formatValue(salaried, "hours")} in
        this period, paid by salary), anyone with no hourly rate on file such as the owners ({formatValue(noRate, "hours")}), and
        employer tax. A punch counts as catering when its shift belongs to a catering deal.
        {l.openPunches > 0 && ` ${l.openPunches} punch${l.openPunches === 1 ? " is" : "es are"} still open and not counted.`}
      </Note>
    </div>
  );
}

// ---- Last closed month --------------------------------------------------------------------

export function ClosedMonthWidget() {
  return (
    <WaitingOnFeed what="Pre-tax profit (month and rolling 12, against 5/10/15% of revenue), monthly LER paid and unpaid, and actual COGS % come from the month close in QBO. They appear once the finance feed publishes the closed months (September 2026 is final)." />
  );
}

// ---- Funnel: leads --------------------------------------------------------------------------

const SOURCE_LABEL = { form: "Web form", email: "Email", phone: "Phone", other: "Other" } as const;
const SOURCE_COLOR = { form: "in_store", email: "orange", phone: "catering", other: "concessions" } as const;

export function LeadsWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.leads) return <CouldNotLoad what="catering deals" />;
  const weeks = lastN(data.leads, periodCount(settings.period));
  const total = weeks.reduce((s, w) => s + w.total, 0);
  const full = weeks.filter((w) => w.week !== mondayOf(data.today));
  return (
    <div>
      <Tiles>
        <Tile label="New enquiries" value={formatValue(total, "count")} sub={`in the last ${weeks.length} weeks`} />
        <Tile label="Per full week" value={full.length ? (full.reduce((s, w) => s + w.total, 0) / full.length).toFixed(1) : "–"} />
        <Tile label="This week so far" value={formatValue(weeks[weeks.length - 1]?.total ?? 0, "count")} />
      </Tiles>
      {total === 0 ? (
        <Empty>No new enquiries in this period.</Empty>
      ) : (
        <Chart
          title="New catering enquiries by week and source"
          labels={weeks.map((w) => weekLabel(w.week, data.today))}
          series={LEAD_SOURCES.map((s) => ({ label: SOURCE_LABEL[s], values: weeks.map((w) => w[s]), color: SOURCE_COLOR[s] }))}
          format="count"
          stacked
          tableLabel="Week of"
        />
      )}
      <Note>A new enquiry is a deal created in the CRM that week (any stage). Other covers walk-ins, hand-entered and unknown sources.</Note>
    </div>
  );
}

// ---- Funnel: outreach -----------------------------------------------------------------------

export function OutreachWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.outreach) return <CouldNotLoad what="outreach events" />;
  const weeks = lastN(data.outreach, periodCount(settings.period));
  const sent = weeks.reduce((s, w) => s + w.sent, 0);
  const replied = weeks.reduce((s, w) => s + w.replied, 0);
  const labels = weeks.map((w) => weekLabel(w.week, data.today));
  return (
    <div>
      <Tiles>
        <Tile label="Emails sent" value={formatValue(sent, "count")} sub={`last ${weeks.length} weeks`} />
        <Tile label="Replies" value={formatValue(replied, "count")} />
        <Tile label="Replies per 100 sent" value={sent ? ((replied / sent) * 100).toFixed(1) : "–"} />
      </Tiles>
      {sent === 0 && replied === 0 ? (
        <Empty>No outreach emails or replies in this period.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Chart title="Outreach emails sent by week" labels={labels} series={[{ label: "Emails sent", values: weeks.map((w) => w.sent), color: "in_store" }]} format="count" height={200} tableLabel="Week of" />
          <Chart title="Replies by week" labels={labels} series={[{ label: "Replies", values: weeks.map((w) => w.replied), color: "orange" }]} format="count" height={200} tableLabel="Week of" />
        </div>
      )}
      <Note>
        From the outreach event log: one email sent is a &lsquo;sequenced&rsquo; event (warm and cold engines), a reply is a &lsquo;replied&rsquo; event in the week it
        arrived. Replies per 100 compares the same weeks, not the same people; the Funnels tab (#422) attributes replies to the email that drew them.
      </Note>
    </div>
  );
}

// ---- Funnel: quote to booking -----------------------------------------------------------------

export function QuotesWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.quotes) return <CouldNotLoad what="catering deals" />;
  const months = lastN(data.quotes, periodCount(settings.period));
  const rate = conversion(months);
  const decided = months.slice(0, -2);
  return (
    <div>
      <Tiles>
        <Tile label="Quoted" value={formatValue(months.reduce((s, m) => s + m.quoted, 0), "count")} sub={`enquiries from the last ${months.length} months`} />
        <Tile label="Booked" value={formatValue(months.reduce((s, m) => s + m.booked, 0), "count")} />
        <Tile label="Quote to booking" value={rate == null ? "–" : formatValue(rate, "pct")} sub="all months shown" />
        <Tile label="Excluding the last 2 months" value={conversion(decided) == null ? "–" : formatValue(conversion(decided), "pct")} sub="quotes mostly decided" />
      </Tiles>
      <Chart
        title="Enquiries quoted and booked, by the month the enquiry came in"
        labels={months.map((m) => monthLabel(m.month))}
        series={[
          { label: "Quoted", values: months.map((m) => m.quoted), color: "in_store" },
          { label: "Booked", values: months.map((m) => m.booked), color: "catering" },
        ]}
        format="count"
        tableLabel="Month"
      />
      <Note>
        Each enquiry is counted in the month it came in. Quoted = reached Sent Quote or beyond (now or in its stage history). Booked =
        Booked Unpaid or Paid, a payment, or Event Complete for an event already held; Event Complete on a future event with no payment
        is not taken as booked (the 10-06 sweep defect). Recent months are still open, so their rate rises as quotes are decided.
      </Note>
    </div>
  );
}
