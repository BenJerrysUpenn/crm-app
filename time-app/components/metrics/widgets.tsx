"use client";

// The body of each Metrics widget (bj-finance #671), by metric. Each takes
// the page's data and the widget's own settings and draws the headline
// numbers, a chart, one plain line on what it shows, and the method behind a
// "How this is worked out" disclosure.

import Chart, { formatValue, type Series } from "./Chart";
import { CouldNotLoad, Empty, Method, Note, Tile, Tiles, WaitingOnFeed } from "./parts";
import type { MetricsData } from "@/lib/metrics/load";
import type { WidgetSettings } from "@/lib/metrics/widgets";
import { STREAM_LABEL, type StreamFilter } from "@/lib/metrics/targets";
import { lastN, periodCount, salesByMonth, salesMonthToDate, streamNames, type SalesStream, type StreamDaily } from "@/lib/metrics/series";
import { daysBetween, mondayOf, monthLabel, shortDay } from "@/lib/metrics/dates";
import { conversion, LEAD_SOURCES } from "@/lib/metrics/funnel";
import { feedInStoreByWeek, feedSales } from "@/lib/metrics/feed";
import { labourPct, salesPerHour } from "@/lib/metrics/labour";
import { addDays } from "@/lib/metrics/dates";
import { laborTargetChart } from "@/lib/metrics/laborTargetChart";
import type { LaborTargetWeek } from "@/lib/metrics/laborTarget";
import { rangeLabel, shownRange, type WeekRange } from "@/lib/metrics/weekRange";
import type { PlanningWeek } from "@/lib/metrics/laborPlanning";
import { planningWeekCount } from "@/lib/metrics/planningWeeks";

/** Headline money: whole dollars (tables and tooltips carry the cents). */
const money = (v: number | null | undefined) => (v == null ? "–" : formatValue(Math.round(v), "money").replace(/\.00$/, ""));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STREAM_COLOR: Record<SalesStream, Series["color"]> = { in_store: "in_store", catering: "catering", concessions: "concessions" };

function weekLabel(monday: string, today: string): string {
  return mondayOf(today) === monday ? `${shortDay(monday)} (so far)` : shortDay(monday);
}

/** The index of the week still in progress, drawn lighter. */
function partialWeek(weeks: { week: string }[], today: string): number[] {
  const i = weeks.findIndex((w) => w.week === mondayOf(today));
  return i < 0 ? [] : [i];
}

/** Sales by day per stream that the page has: catering from the CRM; in-store and concessions from the feed once it publishes them. */
function streamDaily(data: MetricsData): StreamDaily {
  const fromFeed = data.feed.status === "ok" && data.feed.daily ? feedSales(data.feed.daily, data.targets ?? []) : {};
  return data.catering ? { ...fromFeed, catering: data.catering.byDay } : fromFeed;
}

// ---- Sales vs target ------------------------------------------------------------------

export function SalesWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.catering) return <CouldNotLoad what="catering deals" />;
  const stream: StreamFilter = settings.stream ?? "all";
  const sales = streamDaily(data);
  // The targets come only from the sales_targets table; when it could not be read the chart draws sales alone and says so.
  const targets = data.targets ?? [];
  const noTargets = data.targets === null && <Note>Sales targets could not be loaded, so no target or pace is shown. Reload the page to try again.</Note>;
  const method = (
    <>
      <p>
        Catering is the pre-tax value of booked deals on their event date. In-store (with delivery) and concessions come from the
        finance feed once it runs.
      </p>
      <p>
        Targets are monthly, per stream, from the seller-era seasonal curve for a $600K year, with December concessions (PAX) set at
        $5,000. Concessions targets are provisional and on Aramark&rsquo;s net basis until gross vs net is settled.
      </p>
      <CateringCaveats data={data} />
    </>
  );

  if (settings.period === "12m") {
    const m = salesByMonth(sales, targets, stream, data.today);
    const future = m.months.map((_, i) => i).filter((i) => i > m.currentIndex);
    if (m.actual.length === 0)
      return <WaitingOnFeed what={`${STREAM_LABEL[stream]} sales come from QBO and Square; the bars appear when the feed runs.`} detail={method} />;
    return (
      <div>
        <Chart
          title={`${STREAM_LABEL[stream]} sales by month against target, ${m.labels[0]} to ${m.labels[m.labels.length - 1]}`}
          labels={m.labels}
          series={[
            ...m.actual.map((a) => ({ label: STREAM_LABEL[a.stream], values: a.values, color: STREAM_COLOR[a.stream], stack: "actual" })),
            { label: m.targetLabel, values: m.target, color: "target" as const, type: "line" as const, dashed: true, stack: "target" },
          ]}
          format="money"
          stacked
          dim={future}
          tableLabel="Month"
        />
        <Note>
          Lighter bars are months to come: catering booked so far.
          {m.waitingOn.length > 0 && ` Waiting on the finance feed for ${streamNames(m.waitingOn)}.`}
          {data.targets !== null && m.target.slice(0, m.currentIndex).some((t) => t == null) && " No targets are set before 2026."}
        </Note>
        {noTargets}
        <Method>{method}</Method>
      </div>
    );
  }

  const feedThrough = data.feed.status === "ok" && data.feed.daily ? data.feed.daily.as_of : undefined;
  const m = salesMonthToDate(sales, targets, stream, data.today, feedThrough ? { in_store: feedThrough, concessions: feedThrough } : {});
  const p = m.progress;
  const day = Number(data.today.slice(8));
  const waitingAll = m.cumulative.length === 0;
  return (
    <div>
      <Tiles>
        <Tile label={`${monthLabel(data.today)} target`} value={money(m.target?.amount)} sub={data.targets === null ? "targets could not be loaded" : m.target?.provisional ? "includes a provisional figure" : STREAM_LABEL[stream]} />
        <Tile label={`Pace to ${shortDay(data.today)}`} value={m.target ? money((m.target.amount * day) / m.days.length) : "–"} sub={`day ${day} of ${m.days.length}, ${STREAM_LABEL[stream].toLowerCase()}`} />
        <Tile
          label="Actual to date"
          value={waitingAll ? "–" : money(m.actualSoFar)}
          sub={waitingAll ? "waiting on the finance feed" : m.waitingOn.length ? `${streamNames(m.cumulative.map((c) => c.stream))} only so far` : p?.pctOfTarget != null ? `${formatValue(p.pctOfTarget, "pct")} of the month's target` : undefined}
        />
        <Tile
          label={p?.vsPace == null ? "Ahead or behind pace" : p.vsPace >= 0 ? "Ahead of pace" : "Behind pace"}
          value={p?.vsPace == null ? "–" : money(Math.abs(p.vsPace))}
          sub={p?.vsPace == null ? (m.waitingOn.length ? `waiting on ${streamNames(m.waitingOn)} from the feed` : data.targets === null ? "targets could not be loaded" : "no target set") : p.pctOfPace != null ? `${formatValue(p.pctOfPace, "pct")} of pace` : undefined}
        />
      </Tiles>
      {waitingAll ? (
        <WaitingOnFeed what={`${STREAM_LABEL[stream]} sales come from QBO and Square; the month-to-date line appears when the feed runs.`} detail={method} />
      ) : (
        <>
          <Chart
            title={`${STREAM_LABEL[stream]} sales this month, running total, against the pace line`}
            labels={m.labels}
            series={[
              ...m.cumulative.map((c) => ({ label: STREAM_LABEL[c.stream], values: c.values, color: STREAM_COLOR[c.stream], stack: "actual", area: true })),
              ...(m.pace ? [{ label: m.paceLabel, values: m.pace, color: "target" as const, type: "line" as const, dashed: true, stack: "pace" }] : []),
            ]}
            format="money"
            stacked
            tableLabel="Day"
          />
          <Note>
            Running total of sales this month against a straight line to the target.
            {m.waitingOn.length > 0 && ` Waiting on the finance feed for ${streamNames(m.waitingOn)}, so the gap to the whole target is not worked out yet.`}
          </Note>
          {noTargets}
          <Method>{method}</Method>
        </>
      )}
    </div>
  );
}

function CateringCaveats({ data }: { data: MetricsData }) {
  const c = data.catering;
  if (!c) return null;
  return (
    <>
      {c.suspect.length > 0 && (
        <p>
          Left out: {plural(c.suspect.length, "deal")} marked Event Complete for an event still to come, with no payment and no booking
          in their history (a known data error, not yet repaired):{" "}
          {c.suspect.map((s) => `#${s.id}${s.company ? ` ${s.company}` : ""}${s.eventDay ? ` (${s.eventDay})` : ""}`).join(", ")}.
        </p>
      )}
      {c.estimatedIds.length > 0 && <p>{plural(c.estimatedIds.length, "deal")} with no pre-tax subtotal: the total less 8% tax is used.</p>}
      {c.missingValueIds.length > 0 && (
        <p>
          {plural(c.missingValueIds.length, "booked deal")} with no quote total, counted as $0: {c.missingValueIds.map((id) => `#${id}`).join(", ")}.
        </p>
      )}
    </>
  );
}

// ---- Catering balances owed --------------------------------------------------------------

export function ArWidget({ data }: { data: MetricsData }) {
  const ar = data.ar;
  if (!ar) return <CouldNotLoad what="catering deals" />;
  const month = data.today.slice(0, 7);
  const thisMonth = ar.rows.filter((r) => r.eventDay.startsWith(month));
  const olderOverdue = ar.rows.filter((r) => r.overdue && !r.eventDay.startsWith(month));
  const shown = [...olderOverdue, ...thisMonth];
  const label = (r: (typeof shown)[number]) =>
    `${shortDay(r.eventDay)} '${r.eventDay.slice(2, 4)}, ${r.company ?? `Deal #${r.id}`}${r.overdue ? `, ${plural(daysBetween(r.eventDay, data.today), "day")} overdue` : ""}`;
  return (
    <div>
      <Tiles>
        <Tile label="Overdue, all months" value={money(ar.overdue)} sub={plural(ar.rows.filter((r) => r.overdue).length, "event")} />
        <Tile label={`Due in ${monthLabel(data.today)}`} value={money(ar.dueThisMonth)} sub={plural(thisMonth.length, "event")} />
        <Tile label="Of which overdue" value={money(ar.overdueThisMonth)} sub="event already held" />
        <Tile label="Not yet due" value={money(ar.notYetDueThisMonth)} sub="event still to come" />
      </Tiles>
      {shown.length === 0 ? (
        <Empty>Nothing owed on past events or on this month&rsquo;s events.</Empty>
      ) : (
        <Chart
          title="Catering balances owed, by event, oldest first"
          labels={shown.map(label)}
          series={[
            { label: "Overdue", values: shown.map((r) => (r.overdue ? r.balance : null)), color: "serious", stack: "b" },
            { label: "Not yet due", values: shown.map((r) => (r.overdue ? null : r.balance)), color: "catering", stack: "b" },
          ]}
          format="money"
          stacked
          horizontal
          tickChars={32}
          height={Math.max(160, 40 + shown.length * 28)}
          tableLabel="Event"
        />
      )}
      {ar.laterMonths > 0 && <Note>A further {money(ar.laterMonths)} is owed on events after this month.</Note>}
      <Method>
        <p>
          Balance = quote total with tax less the amount paid recorded in the CRM; nothing is owed once a deal is Paid in Full. It is
          due by the event date.
        </p>
        <p>Square is the authority on what has been paid: a payment Square has and the CRM has not recorded shows here as owed.</p>
        {ar.missingTotalIds.length > 0 && <p>No quote total, so no balance: {ar.missingTotalIds.map((id) => `#${id}`).join(", ")}.</p>}
      </Method>
    </div>
  );
}

// ---- Next 14 days -----------------------------------------------------------------------------

export function ForwardWidget({ data }: { data: MetricsData }) {
  const f = data.forward;
  if (!f) return <CouldNotLoad what="deals and shifts" />;
  const fc = data.feed.status === "ok" ? (data.feed.daily?.forward_cash ?? null) : null;
  const feedIn = f.days.map((d) => (fc ? fc.lines.filter((l) => l.date === d.day && l.direction === "in").reduce((s, l) => s + l.amount, 0) : 0));
  const feedOut = f.days.map((d) => (fc ? fc.lines.filter((l) => l.date === d.day && l.direction === "out").reduce((s, l) => s + l.amount, 0) : 0));
  const cateringIn = f.days.reduce((s, d) => s + d.cateringIn, 0);
  const wages = f.days.reduce((s, d) => s + d.scheduledWages, 0);
  // The feed's wage lines already carry pay-date wages; then the scheduled-wage estimate is left off the balance.
  const feedHasWages = Boolean(fc?.lines.some((l) => l.category === "wages"));
  let running = fc ? fc.opening_on_hand : 0;
  const balance = f.days.map((d, i) => {
    running += d.cateringIn + feedIn[i] - feedOut[i] - (feedHasWages ? 0 : d.scheduledWages);
    return Math.round(running * 100) / 100;
  });
  return (
    <div>
      <Tiles>
        <Tile label="Catering due in" value={money(cateringIn)} sub="events in the next 14 days" />
        <Tile label="Hourly wages earned" value={money(wages)} sub="shifts scheduled" />
        <Tile label="Overdue catering" value={money(f.overdue)} sub="events already held; not on a day" />
        <Tile label={fc ? "Cash in 14 days" : "Opening cash"} value={fc ? money(balance[balance.length - 1]) : "–"} sub={fc ? `from ${money(fc.opening_on_hand)} today` : "waiting on the finance feed"} />
      </Tiles>
      <Chart
        title="Known money in and out over the next 14 days"
        labels={f.days.map((d) => shortDay(d.day))}
        series={[
          { label: "Catering due in", values: f.days.map((d) => d.cateringIn), color: "catering", stack: "flow" },
          ...(fc ? [{ label: "Other money in", values: feedIn, color: "in_store" as const, stack: "flow" }] : []),
          ...(feedHasWages
            ? []
            : [{ label: "Hourly wages earned (out)", values: f.days.map((d) => (d.scheduledWages ? -d.scheduledWages : 0)), color: "orange" as const, stack: "flow" }]),
          ...(fc ? [{ label: "Bills, tax and pay (out)", values: feedOut.map((v) => (v ? -v : 0)), color: "other" as const, stack: "flow" }] : []),
          ...(fc ? [{ label: "Cash balance", values: balance, color: "target" as const, type: "line" as const, stack: "balance" }] : []),
        ]}
        format="money"
        stacked
        emptyText="No catering balances or scheduled shifts in the next 14 days."
        tableLabel="Day"
      />
      {!fc && <WaitingOnFeed what="Opening cash, bills, tax and the in-store sales projection turn this into a running cash balance." />}
      <Method>
        <p>Catering due in is the balance on each booked event, on its event date.</p>
        <p>
          Wages are shift hours x hourly rate for hourly staff, on the day earned; they leave the bank on the next pay date. The salaried
          GM and the owners are not costed
          {f.uncostedShifts > 0 && `, nor ${plural(f.uncostedShifts, "unassigned or unrated shift")}`}. Employer tax is not included.
        </p>
        {fc && (
          <p>
            Opening cash, recurring bills, other bills, tax and the in-store projection come from the finance feed.
            {feedHasWages ? " Pay is shown on its pay date from the feed, so the scheduled-wage estimate is only in the tile above." : ""}
          </p>
        )}
      </Method>
    </div>
  );
}

// ---- Labour -----------------------------------------------------------------------------------

export function LabourWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const l = data.labour;
  if (!l) return <CouldNotLoad what="the time clock" />;
  const weeks = lastN(l.weeks, periodCount(settings.period));
  const full = weeks.filter((w) => w.week !== mondayOf(data.today));
  const last = full[full.length - 1];
  const salaried = weeks.reduce((s, w) => s + w.salariedHours, 0);
  const noRate = weeks.reduce((s, w) => s + w.noRateHours, 0);
  const labels = weeks.map((w) => weekLabel(w.week, data.today));
  const dim = partialWeek(weeks, data.today);
  const daily = data.feed.status === "ok" ? data.feed.daily : null;
  const storeSales = daily ? feedInStoreByWeek(daily, full.map((w) => w.week)) : full.map(() => null);
  const perHour = full.map((w, i) => salesPerHour(storeSales[i], w.inStoreHours));
  const wagesByWeek = new Map((daily?.wages_by_week ?? []).map((w) => [w.week_start, w.wages + w.employer_tax]));
  const pctByWeek = full.map((w, i) => {
    const cost = wagesByWeek.get(w.week) ?? null;
    const catering = Object.entries(data.catering?.byDay ?? {})
      .filter(([d]) => d >= w.week && d <= addDays(w.week, 6))
      .reduce((s, [, v]) => s + v, 0);
    return labourPct(cost, storeSales[i] == null ? null : storeSales[i]! + catering);
  });
  return (
    <div>
      <Tiles>
        <Tile label="In-store hours, last full week" value={formatValue(last?.inStoreHours ?? null, "hours")} sub={last ? `week of ${shortDay(last.week)}` : undefined} />
        <Tile label="Catering hours, last full week" value={formatValue(last?.cateringHours ?? null, "hours")} />
        <Tile label="Hourly labour $, last full week" value={money(last ? last.inStoreHourlyCost + last.cateringHourlyCost : null)} sub="hourly staff only" />
        <Tile
          label="Sales per scooper-hour"
          value={perHour[perHour.length - 1] == null ? "–" : money(perHour[perHour.length - 1])}
          sub={daily ? "last full week, in-store" : "waiting on the finance feed"}
        />
      </Tiles>
      <div className="space-y-4">
        <Chart
          heading="Hours clocked per week"
          title="Clocked hours by week, in-store and catering"
          labels={labels}
          series={[
            { label: "In-store", values: weeks.map((w) => w.inStoreHours), color: "in_store" },
            { label: "Catering", values: weeks.map((w) => w.cateringHours), color: "catering" },
          ]}
          format="hours"
          stacked
          dim={dim}
          emptyText="No hours clocked in this period."
          tableLabel="Week of"
        />
        <Chart
          heading="Hourly labour $ per week (hourly staff only)"
          title="Hourly labour cost by week, hourly staff only"
          labels={labels}
          series={[
            { label: "In-store", values: weeks.map((w) => w.inStoreHourlyCost), color: "in_store" },
            { label: "Catering", values: weeks.map((w) => w.cateringHourlyCost), color: "catering" },
          ]}
          format="money"
          stacked
          dim={dim}
          height={200}
          emptyText="No hourly labour cost in this period."
          tableLabel="Week of"
        />
      </div>
      {daily && perHour.some((v) => v != null) ? (
        <div className="grid gap-4 md:grid-cols-2 mt-4">
          <Chart
            heading="Sales per scooper-hour (in-store)"
            title="In-store sales per clocked in-store hour, by week"
            labels={full.map((w) => shortDay(w.week))}
            series={[{ label: "Sales per scooper-hour", values: perHour, color: "in_store" }]}
            format="money"
            height={200}
            tableLabel="Week of"
          />
          <Chart
            heading="Labour % of sales"
            title="Wages and employer tax as a share of sales, by week"
            labels={full.map((w) => shortDay(w.week))}
            series={[{ label: "Labour %", values: pctByWeek, color: "orange" }]}
            format="pct"
            height={200}
            emptyText="Labour % appears when the feed publishes weekly wages."
            tableLabel="Week of"
          />
        </div>
      ) : (
        <WaitingOnFeed what="Sales per scooper-hour (B&J benchmark $200-250 with one scooper) and labour % need in-store sales from the feed." />
      )}
      <Method>
        <p>
          Labour $ from the time clock is a floor, not total labour. It leaves out the salaried GM ({formatValue(salaried, "hours")} in
          this period, paid by salary), anyone with no hourly rate such as the owners ({formatValue(noRate, "hours")}), and employer tax.
        </p>
        <p>A punch counts as catering when its shift belongs to a catering deal. The lighter bar is the week in progress.</p>
        <p>
          Sales per scooper-hour = in-store sales (with delivery) from the feed / in-store hours clocked; B&amp;J benchmark $200-250 with one
          scooper, $400-500 with two. Labour % = the week&rsquo;s wages and employer tax from the feed, salaried GM included / the week&rsquo;s
          sales, catering by event date.
        </p>
        {l.openPunches > 0 && <p>{plural(l.openPunches, "punch", "punches")} still open and not counted.</p>}
      </Method>
    </div>
  );
}

// ---- New enquiries --------------------------------------------------------------------------------

const SOURCE_LABEL = { form: "Web form", email: "Email", phone: "Phone", other: "Other" } as const;
const SOURCE_COLOR = { form: "in_store", email: "orange", phone: "catering", other: "other" } as const;

export function LeadsWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.leads) return <CouldNotLoad what="catering deals" />;
  const weeks = lastN(data.leads, periodCount(settings.period));
  const total = weeks.reduce((s, w) => s + w.total, 0);
  const full = weeks.filter((w) => w.week !== mondayOf(data.today));
  return (
    <div>
      <Tiles>
        <Tile label="New enquiries" value={formatValue(total, "count")} sub={`last ${weeks.length} weeks`} />
        <Tile label="Per full week" value={full.length ? (full.reduce((s, w) => s + w.total, 0) / full.length).toFixed(1) : "–"} />
        <Tile label="This week so far" value={formatValue(weeks[weeks.length - 1]?.total ?? 0, "count")} />
      </Tiles>
      <Chart
        title="New catering enquiries by week and source"
        labels={weeks.map((w) => weekLabel(w.week, data.today))}
        series={LEAD_SOURCES.map((s) => ({ label: SOURCE_LABEL[s], values: weeks.map((w) => w[s]), color: SOURCE_COLOR[s] }))}
        format="count"
        stacked
        dim={partialWeek(weeks, data.today)}
        emptyText="No new enquiries in this period."
        tableLabel="Week of"
      />
      <Method>
        <p>A new enquiry is a deal created in the CRM that week, whatever its stage now. Other covers walk-ins, hand-entered and unknown sources.</p>
      </Method>
    </div>
  );
}

// ---- Outreach -----------------------------------------------------------------------------------------

export function OutreachWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.outreach) return <CouldNotLoad what="outreach events" />;
  const weeks = lastN(data.outreach, periodCount(settings.period));
  const sent = weeks.reduce((s, w) => s + w.sent, 0);
  const replied = weeks.reduce((s, w) => s + w.replied, 0);
  const labels = weeks.map((w) => weekLabel(w.week, data.today));
  const dim = partialWeek(weeks, data.today);
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
          <Chart heading="Emails sent per week" title="Outreach emails sent by week" labels={labels} series={[{ label: "Emails sent", values: weeks.map((w) => w.sent), color: "in_store" }]} format="count" height={200} dim={dim} tableLabel="Week of" />
          <Chart heading="Replies per week" title="Replies to outreach by week" labels={labels} series={[{ label: "Replies", values: weeks.map((w) => w.replied), color: "orange" }]} format="count" height={200} dim={dim} tableLabel="Week of" />
        </div>
      )}
      <Method>
        <p>
          From the outreach event log: an email sent by the warm or cold engine, and a reply in the week it arrived. Replies per 100
          compares the same weeks, not the same people; the Funnels tab attributes each reply to the email that drew it.
        </p>
      </Method>
    </div>
  );
}

// ---- Quote to booking -------------------------------------------------------------------------------------

export function QuotesWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.quotes) return <CouldNotLoad what="catering deals" />;
  const months = lastN(data.quotes, periodCount(settings.period));
  const rate = conversion(months);
  const decided = conversion(months.slice(0, -2));
  return (
    <div>
      <Tiles>
        <Tile label="Quoted" value={formatValue(months.reduce((s, m) => s + m.quoted, 0), "count")} sub={`enquiries, last ${months.length} months`} />
        <Tile label="Booked" value={formatValue(months.reduce((s, m) => s + m.booked, 0), "count")} />
        <Tile label="Quote to booking" value={rate == null ? "–" : formatValue(rate, "pct")} sub="all months shown" />
        <Tile label="Leaving out the last 2 months" value={decided == null ? "–" : formatValue(decided, "pct")} sub="quotes mostly decided" />
      </Tiles>
      <Chart
        title="Enquiries quoted and booked, by the month the enquiry came in"
        labels={months.map((m) => monthLabel(m.month))}
        series={[
          { label: "Quoted", values: months.map((m) => m.quoted), color: "in_store" },
          { label: "Booked", values: months.map((m) => m.booked), color: "catering" },
        ]}
        format="count"
        emptyText="No quotes in this period."
        tableLabel="Month"
      />
      <Note>Recent months are still open, so their rate rises as quotes are decided.</Note>
      <Method>
        <p>Each enquiry is counted in the month it came in. Quoted = reached Sent Quote or beyond, now or in its stage history.</p>
        <p>
          Booked = Booked Unpaid or Paid, a payment, or Event Complete for an event already held. Event Complete on an event still to come,
          with no payment, is not taken as booked (a known data error).
        </p>
      </Method>
    </div>
  );
}

// ---- Labor vs target ------------------------------------------------------------------------------

/** "Sep 6–12", or "Sep 27–Oct 3" across a month end. */
function sunSatLabel(start: string, end: string): string {
  return start.slice(5, 7) === end.slice(5, 7) ? `${shortDay(start)}–${Number(end.slice(8, 10))}` : `${shortDay(start)}–${shortDay(end)}`;
}

/** A variance with its sign: "+$175", "−$40", "+8.8 h". A real minus sign, as the schedule's Remaining line uses. */
function signed(v: number, format: "money" | "hours"): string {
  const text = format === "money" ? money(Math.abs(v)) : formatValue(Math.abs(v), "hours");
  if (text === "$0" || text === "0 h") return text;
  return `${v > 0 ? "+" : "−"}${text}`;
}

const NA = <span className="text-slate-400 dark:text-slate-500">n/a</span>;

/** The week column stays in view while a phone scrolls the table sideways. */
const STICKY = "sticky left-0 bg-white dark:bg-slate-900";

/** The catering crew billed to clients and taken off a week's labor: "10 h, $313 all-in"; blank when none. */
function cateringTakenOff(w: LaborTargetWeek): string {
  if (w.cateringHours == null || w.cateringHours <= 0 || w.cateringOffset == null) return "";
  return `${formatValue(w.cateringHours, "hours")}, ${money(w.cateringOffset)} all-in`;
}

/** The card's numbers, one row per week: behind "Show numbers" under the chart. */
export function LaborTargetTable({ weeks, range }: { weeks: LaborTargetWeek[]; range: WeekRange }) {
  const cell = "py-1.5 pl-3 text-right whitespace-nowrap";
  return (
    <div className="overflow-x-auto max-w-full">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">Labor vs target, weeks of {rangeLabel(range)}, Sunday to Saturday</caption>
        <thead>
          <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
            <th scope="col" className={`${STICKY} py-1 pr-3 font-medium`}>Week</th>
            <th scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">Sales</th>
            <th scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">Hourly labor, all-in</th>
            <th scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">Actual %</th>
            <th scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">Target %, all-in</th>
            <th scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">Variance $</th>
            <th scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">Variance hours</th>
            <th scope="col" className="py-1 pl-3 font-medium text-right whitespace-nowrap">Catering crew taken off</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const over = w.varianceDollars != null && w.varianceDollars > 0;
            const tone = over ? "text-red-700 dark:text-red-300 font-medium" : "text-slate-900 dark:text-slate-100";
            return (
              <tr key={w.start} className="border-t border-slate-100 dark:border-slate-800">
                <th scope="row" className={`${STICKY} py-1.5 pr-3 text-left font-normal text-slate-600 dark:text-slate-300 whitespace-nowrap`}>
                  {sunSatLabel(w.start, w.end)}
                </th>
                <td className={`${cell} text-slate-900 dark:text-slate-100`}>{w.sales == null ? NA : money(w.sales)}</td>
                <td className={`${cell} text-slate-900 dark:text-slate-100`}>{w.actual == null ? NA : money(w.actual)}</td>
                <td className={`${cell} text-slate-900 dark:text-slate-100`}>{w.actualPct == null ? NA : formatValue(w.actualPct, "pct")}</td>
                <td className={`${cell} text-slate-900 dark:text-slate-100`}>{w.targetPct.value == null ? NA : formatValue(w.targetPct.value, "pct")}</td>
                <td className={`${cell} ${tone}`}>{w.varianceDollars == null ? NA : signed(w.varianceDollars, "money")}</td>
                <td className={`${cell} ${tone}`}>{w.varianceHours == null ? NA : signed(w.varianceHours, "hours")}</td>
                <td className={`${cell} text-slate-900 dark:text-slate-100`}>{cateringTakenOff(w)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LaborTargetWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const lt = data.laborTarget;
  if (!lt) return <CouldNotLoad what="hourly payroll, daily sales or the control board" />;
  const range = shownRange(settings, lt);
  const weeks = lt.weeks.filter((w) => w.start >= range.from && w.start <= range.to);
  const goals = [...new Set(weeks.map((w) => w.allInGoalPct.value).filter((v): v is number => v != null).map((v) => formatValue(v, "pct")))];
  const unavailable = weeks.filter((w) => !w.available);
  const c = laborTargetChart(weeks);
  const t = c.totals;
  const counted = `${t.complete} of ${plural(t.weeks, "week")} complete`;
  const span = rangeLabel(range);
  return (
    <div>
      {t.complete > 0 && (
        <Tiles>
          <Tile label="Actual %, complete weeks" value={formatValue(t.actualPct, "pct")} sub={counted} />
          <Tile label="Target %, all-in" value={formatValue(t.targetPct, "pct")} sub="same weeks, by sales" />
          <Tile
            label={t.varianceDollars! > 0 ? "Over target" : t.varianceDollars! < 0 ? "Under target" : "Variance $"}
            value={signed(t.varianceDollars!, "money")}
            sub="hourly labor vs target $"
          />
          <Tile label="Variance hours" value={t.varianceHours == null ? "–" : signed(t.varianceHours, "hours")} sub="at each week's cost per hour" />
        </Tiles>
      )}
      <Chart
        title={`Hourly labor all-in as a share of in-store sales, weeks of ${span} by their Sunday, against the all-in target`}
        labels={c.labels}
        series={[
          { label: "Actual %", values: c.actualPct, color: "in_store", highlight: { indexes: c.over, color: "serious", label: "Over target" } },
          { label: "Target %, all-in", values: c.targetPct, color: "target", type: "line", dashed: true },
        ]}
        format="pct"
        gaps={c.gaps}
        tableLabel="Week of"
        emptyText={`No week of ${span} has its numbers yet (${counted}).`}
        table={<LaborTargetTable weeks={weeks} range={range} />}
      />
      {unavailable.length > 0 && (
        <ul aria-label="Weeks not available (n/a), never counted as zero" className="mt-2 text-xs text-slate-600 dark:text-slate-400 max-w-prose">
          {unavailable.map((w) => {
            const reasons = [...w.why, ...(w.targetPct.value == null ? [`target needs ${w.targetPct.needs.join(", ")}`] : [])];
            return (
              <li key={w.start}>
                {shortDay(w.start)}: {reasons.length ? reasons.join("; ") : "nothing to compare"}
              </li>
            );
          })}
        </ul>
      )}
      <Method>
        <p>
          Weeks run Sunday to Saturday and are named by their Sunday; the card covers every week from the first chosen to the last
          (until a range is chosen, the last 8 weeks that are over). Choosing a month sets the range to the weeks whose Sunday is in
          that month. Sales are in-store sales for all seven days. A week
          shows only once it is over and every one of its seven days has hourly payroll on file; a day missing from the payroll or the
          sales makes that week not available. Nothing is estimated from punches or the schedule.
        </p>
        <p>
          Both sides are all-in: payroll cost with employer taxes and workers&rsquo; comp, not just wages.
        </p>
        <p>
          Hourly labor, all-in = wages, catering premium and solo-close bonuses as QBO Payroll paid them to hourly staff (salaried and
          overhead staff are left out), each pay period spread over its days by hours worked, less the catering crew the client paid
          for, plus employer taxes and workers&rsquo; comp on the rest at the Targets tab&rsquo;s rates in force on each day (FICA, FUTA,
          PA UC and workers&rsquo; comp, full rates, no wage caps).
        </p>
        <p>
          Catering crew the client paid for = each booked deal&rsquo;s billed crew hours (labor hours x staff count) at crew cost plus
          the catering premium, worked out exactly as the Schedule page&rsquo;s labor line does, so the two agree. Sales are in-store
          only, so catering comes out of both sides. A deal billed zero crew hours (a pickup) takes nothing off; a booked deal with
          no billed crew hours on file makes its week not available. Before the catering premium was first set it was zero.
          &ldquo;Show numbers&rdquo; lists each week&rsquo;s catering crew taken off, hours and all-in $.
        </p>
        <p>
          Target %, all-in = the Targets tab&rsquo;s all-in hourly goal in force on each day (the payroll target less fixed payroll,
          as a share of sales{goals.length ? `: ${goals.join(", ")} of sales in these weeks` : ""}). Each day&rsquo;s sales are held to
          that day&rsquo;s target, and fixed payroll on a day counts the people who were salaried that day.
        </p>
        <p>
          Variance $ = hourly labor less target % x sales; above zero (red) is over target. Variance hours = variance $ at the
          week&rsquo;s own in-store cost per hour (hourly labor / hours paid less the catering crew&rsquo;s billed hours).
        </p>
        <p>
          On the chart each bar is a week&rsquo;s actual % (hourly labor, all-in / sales), red when the week is over target, and the
          dashed line is its target %. A week marked n/a has no bar. The figures above the chart add up the complete weeks only: actual
          % and target % are their summed dollars over their summed sales.
        </p>
      </Method>
    </div>
  );
}

// ---- Labor Hours Planning (bj-finance #742) ------------------------------------------

const hrs = (v: number | null | undefined) => (v == null ? "–" : formatValue(v, "hours"));
const totalTarget = (w: PlanningWeek) =>
  w.affordableHours.value == null || w.estimatedHours.value == null ? null : w.affordableHours.value + w.bookedHours + w.estimatedHours.value;

/** What to know about a week, in words: filled last-year days, closed days, events, deals without hours. */
function planningNotes(w: PlanningWeek): string[] {
  const out: string[] = [];
  if (w.events.length) out.push(w.events.join(", "));
  if (w.closedDays.length) out.push(`closed ${w.closedDays.map(shortDay).join(", ")}`);
  if (w.filledDays.length) out.push(`filled: no sales on file for ${w.filledDays.map((d) => `${shortDay(d)}, ${d.slice(0, 4)}`).join("; ")}`);
  return [...out, ...w.notes];
}

/** The card's numbers, one row per week: behind "Show numbers" under the chart. */
export function LaborPlanningTable({ weeks }: { weeks: PlanningWeek[] }) {
  const cell = "py-1.5 pl-3 text-right whitespace-nowrap text-slate-900 dark:text-slate-100";
  const head = "py-1 pl-3 font-medium text-right whitespace-nowrap";
  return (
    <div className="overflow-x-auto max-w-full">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">Labor Hours Planning, weeks ahead, Sunday to Saturday</caption>
        <thead>
          <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
            <th scope="col" className={`${STICKY} py-1 pr-3 font-medium`}>Week</th>
            <th scope="col" className={head}>Affordable</th>
            <th scope="col" className={head}>Catering booked</th>
            <th scope="col" className={head}>Catering estimated</th>
            <th scope="col" className={head}>Target hours</th>
            <th scope="col" className={head}>Coverage</th>
            <th scope="col" className={head}>Projected in-store</th>
            <th scope="col" className={head}>Concession sales</th>
            <th scope="col" className={head}>Catering last year</th>
            <th scope="col" className="py-1 pl-3 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const notes = planningNotes(w);
            return (
              <tr key={w.start} className="border-t border-slate-100 dark:border-slate-800 align-top">
                <th scope="row" className={`${STICKY} py-1.5 pr-3 text-left font-normal text-slate-600 dark:text-slate-300 whitespace-nowrap`}>
                  {sunSatLabel(w.start, w.end)}
                </th>
                <td className={cell}>{w.affordableHours.value == null ? NA : hrs(w.affordableHours.value)}</td>
                <td className={cell}>{hrs(w.bookedHours)}</td>
                <td className={cell}>{w.estimatedHours.value == null ? NA : hrs(w.estimatedHours.value)}</td>
                <td className={`${cell} font-medium`}>{totalTarget(w) == null ? NA : hrs(totalTarget(w))}</td>
                <td className={cell}>{w.coverageHours.value == null ? NA : hrs(w.coverageHours.value)}</td>
                <td className={cell}>{w.projectedInStore == null ? NA : money(w.projectedInStore)}</td>
                <td className={cell}>{w.concessionSales ? money(w.concessionSales) : ""}</td>
                <td className={cell}>{w.lastYearCatering == null ? NA : hrs(w.lastYearCatering)}</td>
                <td className="py-1.5 pl-3 text-xs text-slate-600 dark:text-slate-400 min-w-[14rem]">{notes.join("; ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LaborPlanningWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  const lp = data.laborPlanning;
  if (!lp) return <CouldNotLoad what="the sales history, the control board, store hours or catering bookings" />;
  const weeks = lp.weeks.slice(0, planningWeekCount(settings.weeks));
  const goals = [...new Set(weeks.map((w) => w.hourlyGoal.value).filter((v): v is number => v != null).map((v) => formatValue(v, "pct")))];
  const unavailable = weeks.filter((w) => w.affordableHours.value == null || w.estimatedHours.value == null || w.coverageHours.value == null);
  const trend = lp.trend.factor.value;
  return (
    <div>
      <Chart
        title={`Target labor hours for the next ${weeks.length} weeks by their Sunday: affordable from sales, catering booked and catering still estimated, against the hours the store is open`}
        labels={weeks.map((w) => shortDay(w.start))}
        series={[
          { label: "Affordable (in-store and concession sales)", values: weeks.map((w) => w.affordableHours.value), color: "in_store", stack: "target" },
          { label: "Catering booked", values: weeks.map((w) => w.bookedHours), color: "catering", stack: "target" },
          { label: "Catering estimated, not yet booked", values: weeks.map((w) => w.estimatedHours.value), color: "orange", stack: "target" },
          { label: "Coverage (store hours, one person)", values: weeks.map((w) => w.coverageHours.value), color: "target", type: "line", dashed: true, stack: "coverage" },
        ]}
        format="hours"
        stacked
        height={280}
        gaps={weeks.flatMap((w, i) => (w.affordableHours.value == null ? [i] : []))}
        tableLabel="Week of"
        emptyText="No week ahead has its numbers yet."
        table={<LaborPlanningTable weeks={weeks} />}
      />
      {unavailable.length > 0 && (
        <ul aria-label="Weeks with a number not available (n/a), never counted as zero" className="mt-2 text-xs text-slate-600 dark:text-slate-400 max-w-prose">
          {unavailable.map((w) => {
            const needs = [...new Set([...w.affordableHours.needs, ...w.estimatedHours.needs, ...w.coverageHours.needs])];
            return (
              <li key={w.start}>
                {shortDay(w.start)}: needs {needs.join("; ")}
              </li>
            );
          })}
        </ul>
      )}
      <Method>
        <p>
          Weeks run Sunday to Saturday, named by their Sunday, from this week on; the slider shows 4 to 52 of them. Each bar is
          the hours the week needs, in three parts.
        </p>
        <p>
          Affordable = (projected in-store sales + concession event sales) x the hourly goal / the average hourly rate of active
          hourly staff ({lp.avgRate.value == null ? "not available" : `${money(lp.avgRate.value)} an hour over ${plural(lp.avgRateOver, "person", "people")}`}).
          Projected in-store sales for a day are the in-store sales on the same weekday 52 weeks earlier x the trend factor
          ({trend == null ? "not available" : trend.toFixed(3)}), the one the schedule uses. A concession event&rsquo;s expected net
          sales are spread evenly over its days. The hourly goal is the Targets tab&rsquo;s in force on each day
          {goals.length ? ` (${goals.join(", ")} in these weeks)` : ""}, so a value set to start on a later date takes over from it.
        </p>
        <p>
          Catering booked = the Catering shifts on each booked deal of the week; a booked deal with no shifts yet counts its billed
          crew hours (labor hours x staff count). Catering estimated = last year&rsquo;s Catering shift hours in the same week, less
          what is booked, never below zero, plus the crew hours of a dated crew event such as Free Cone Day. Booking catering moves
          hours from the estimate into booked; the bar only grows once booked passes last year&rsquo;s. Concession show days and Free
          Cone Day are left out of last year&rsquo;s catering hours.
        </p>
        <p>
          Coverage (the dashed line) = the store&rsquo;s hours in force each day, from its season, for one person, summed over the
          week. A closed date (a closed special day, or a &ldquo;Business closed&rdquo; note on the schedule) projects no sales and
          needs no cover. A day last year with no sales on file is the average of the same weekday in the nearest weeks either
          side that have sales; &ldquo;Show numbers&rdquo; names those days.
        </p>
      </Method>
    </div>
  );
}
