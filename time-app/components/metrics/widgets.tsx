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
  const fromFeed = data.feed.status === "ok" && data.feed.daily ? feedSales(data.feed.daily, data.targets) : {};
  return data.catering ? { ...fromFeed, catering: data.catering.byDay } : fromFeed;
}

// ---- Sales vs target ------------------------------------------------------------------

export function SalesWidget({ data, settings }: { data: MetricsData; settings: WidgetSettings }) {
  if (!data.catering) return <CouldNotLoad what="catering deals" />;
  const stream: StreamFilter = settings.stream ?? "all";
  const sales = streamDaily(data);
  const method = (
    <>
      <p>
        Catering is the pre-tax value of booked deals on their event date. In-store (with delivery) and concessions come from the
        finance feed once it runs.
      </p>
      <p>
        Targets are monthly, per stream, from the seller-era seasonal curve for a $600K year, with December concessions (PAX) set at
        $5,000.
        {data.targetsSource === "seed" ? " They are the copy bundled with the page until the targets table is switched on." : ""}{" "}
        Concessions targets are provisional and on Aramark&rsquo;s net basis until gross vs net is settled.
      </p>
      <CateringCaveats data={data} />
    </>
  );

  if (settings.period === "12m") {
    const m = salesByMonth(sales, data.targets, stream, data.today);
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
          {m.target.slice(0, m.currentIndex).some((t) => t == null) && " No targets are set before 2026."}
        </Note>
        <Method>{method}</Method>
      </div>
    );
  }

  const feedThrough = data.feed.status === "ok" && data.feed.daily ? data.feed.daily.as_of : undefined;
  const m = salesMonthToDate(sales, data.targets, stream, data.today, feedThrough ? { in_store: feedThrough, concessions: feedThrough } : {});
  const p = m.progress;
  const day = Number(data.today.slice(8));
  const waitingAll = m.cumulative.length === 0;
  return (
    <div>
      <Tiles>
        <Tile label={`${monthLabel(data.today)} target`} value={money(m.target?.amount)} sub={m.target?.provisional ? "includes a provisional figure" : STREAM_LABEL[stream]} />
        <Tile label={`Pace to ${shortDay(data.today)}`} value={m.target ? money((m.target.amount * day) / m.days.length) : "–"} sub={`day ${day} of ${m.days.length}, ${STREAM_LABEL[stream].toLowerCase()}`} />
        <Tile
          label="Actual to date"
          value={waitingAll ? "–" : money(m.actualSoFar)}
          sub={waitingAll ? "waiting on the finance feed" : m.waitingOn.length ? `${streamNames(m.cumulative.map((c) => c.stream))} only so far` : p?.pctOfTarget != null ? `${formatValue(p.pctOfTarget, "pct")} of the month's target` : undefined}
        />
        <Tile
          label={p?.vsPace == null ? "Ahead or behind pace" : p.vsPace >= 0 ? "Ahead of pace" : "Behind pace"}
          value={p?.vsPace == null ? "–" : money(Math.abs(p.vsPace))}
          sub={p?.vsPace == null ? (m.waitingOn.length ? `waiting on ${streamNames(m.waitingOn)} from the feed` : "no target set") : p.pctOfPace != null ? `${formatValue(p.pctOfPace, "pct")} of pace` : undefined}
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
