"use client";

// PROTOTYPE (bj-finance #811), throwaway. The console's pieces for
// bj-finance's daily sales lane numbers (metrics_snapshots kind
// 'sales_lanes'): a gray sends-against-target line on each lane row, a sales
// section in the lane and mailbox panels, and the sales numbers panel off the
// This week row. Gray only: colour comes from attentionItems() badges, as
// everywhere on the screen. "not measured" is never drawn as 0.

import { useState, type ReactNode } from "react";
import type { Facts, LaneKey, MailboxFact } from "@/lib/emailCampaignsPrototype/console/facts";
import {
  consoleLaneOf,
  offerName,
  perDay7,
  salesFor,
  salesLaneName,
  salesMailbox,
  type Measure,
  type SalesLane,
  type SalesLanesData,
  type SalesTotals,
} from "@/lib/emailCampaignsPrototype/console/salesLanes";
import { dateEt, timeEt } from "@/lib/emailCampaignsPrototype/console/time";
import { Bullet, NoData, SyntheticTag } from "./bits";

export type SalesWindow = "mtd" | "since";

const n = (v: Measure) => (v == null ? null : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));
const usd = (v: Measure) => (v == null ? null : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** A number, or the gray "not measured" chip. */
function M({ v, fmt = n }: { v: Measure; fmt?: (v: Measure) => string | null }) {
  return v == null ? <NoData>not measured</NoData> : <span className="tabular-nums">{fmt(v)}</span>;
}

function windowTotals(l: SalesLane, w: SalesWindow): SalesTotals {
  return w === "since" ? l.sinceStart : l.monthToDate;
}

/** When the numbers were built, or why there are none. */
export function SalesBuilt({ sales }: { sales: SalesLanesData }) {
  if (sales.status === "empty") return <NoData>sales numbers not built yet</NoData>;
  if (sales.status === "unreadable") return <span className="text-slate-400">cannot read the sales numbers</span>;
  if (sales.status === "unrecognised") return <span className="text-slate-400">cannot read the sales numbers built {dateEt(sales.builtAt)}</span>;
  return (
    <span className="text-slate-500">
      {sales.stale ? `last built ${dateEt(sales.builtAt)}` : `built ${timeEt(sales.builtAt)}`}
      <SyntheticTag what={sales.synthetic} />
    </span>
  );
}

/** The lane row's gray line: emails sent a day over 7 days against the lane's daily target. */
export function SalesSendLine({ sales, lane }: { sales: SalesLanesData; lane: LaneKey }) {
  const l = salesFor(sales, lane);
  if (!l || (l.targetDailySends == null && l.last7d.sent == null)) return null;
  const pd = perDay7(l);
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
      <span>Sent a day, 7 days:</span>
      {pd == null ? (
        <NoData>not measured</NoData>
      ) : (
        <>
          <Bullet value={pd} target={l.targetDailySends} width={72} />
          <span className="tabular-nums text-slate-400">
            {n(pd)}
            {l.targetDailySends != null ? ` of ${l.targetDailySends} target` : " · no target set"}
          </span>
        </>
      )}
      <span>· yesterday {l.yesterday.sent == null ? "not measured" : n(l.yesterday.sent)}</span>
    </span>
  );
}

const STEPS: { key: keyof SalesTotals; label: string }[] = [
  { key: "sent", label: "Emails sent" },
  { key: "opened", label: "Opened" },
  { key: "replied", label: "Replied" },
  { key: "deals", label: "Deals" },
  { key: "booked", label: "Booked" },
];

/** Sent → opened → replied → deals → booked as bars, each with its count. */
function Funnel({ t }: { t: SalesTotals }) {
  const top = Math.max(1, ...STEPS.map((s) => t[s.key] ?? 0));
  return (
    <div className="space-y-0.5">
      {STEPS.map((s) => {
        const v = t[s.key];
        return (
          <div key={s.key} className="grid grid-cols-[84px_1fr_auto] items-center gap-2 text-[11px]">
            <span className="text-slate-500">{s.label}</span>
            <span className="h-2 rounded-sm bg-slate-800">
              {v != null ? <span className="block h-2 rounded-sm bg-slate-300" style={{ width: `${Math.max(v > 0 ? 2 : 0, (v / top) * 100)}%` }} /> : null}
            </span>
            <M v={v} />
          </div>
        );
      })}
    </div>
  );
}

/** Behind "Show numbers": every figure of the window, in words. */
function Figures({ t }: { t: SalesTotals }) {
  const rows: [string, ReactNode][] = [
    ["Emails sent", <M key="s" v={t.sent} />],
    ["Delivered", <M key="d" v={t.delivered} />],
    ["Opened", <M key="o" v={t.opened} />],
    ["Opened by a person", <M key="h" v={t.openedByPerson} />],
    ["Replied", <M key="r" v={t.replied} />],
    ["Deals", <M key="de" v={t.deals} />],
    ["Booked", <M key="b" v={t.booked} />],
    ["New customers", <M key="n" v={t.newCustomers} />],
    ["Repeat customers", <M key="re" v={t.repeatCustomers} />],
    ["Sales before tax", <M key="rev" v={t.revenuePretax} fmt={usd} />],
    ["Spent", <M key="sp" v={t.spend} fmt={usd} />],
    ["Cost per new customer", <M key="c" v={t.costPerNew} fmt={usd} />],
  ];
  return (
    <div className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 text-[11px] text-slate-300">
      {rows.map(([k, v]) => (
        <span key={k} className="contents">
          <span className="text-slate-500">{k}</span>
          <span className="text-right">{v}</span>
        </span>
      ))}
    </div>
  );
}

function WindowSwitch({ since, w, onWindow }: { since: string; w: SalesWindow; onWindow: (w: SalesWindow) => void }) {
  return (
    <span className="inline-flex rounded border border-slate-700 text-[11px]" role="group" aria-label="Which period">
      {(["mtd", "since"] as SalesWindow[]).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={w === k}
          onClick={() => onWindow(k)}
          className={`px-1.5 py-0.5 ${w === k ? "bg-slate-200 text-slate-900" : "text-slate-300 hover:bg-slate-800"}`}
        >
          {k === "mtd" ? "This month" : `Since ${dateEt(`${since}T12:00:00Z`)}`}
        </button>
      ))}
    </span>
  );
}

function LaneFigures({ l, w }: { l: SalesLane; w: SalesWindow }) {
  const [nums, setNums] = useState(false);
  const t = windowTotals(l, w);
  const customers = (t.newCustomers ?? 0) + (t.repeatCustomers ?? 0);
  return (
    <div className="space-y-1">
      <Funnel t={t} />
      <p className="text-[11px] text-slate-400">
        {customers > 0 || t.newCustomers != null || t.repeatCustomers != null ? (
          <>
            Customers: <M v={t.newCustomers} /> new · <M v={t.repeatCustomers} /> repeat
          </>
        ) : null}
        {t.spend != null && t.spend > 0 ? (
          <>
            {" "}
            · spent {usd(t.spend)} · <M v={t.costPerNew} fmt={usd} /> per new customer
          </>
        ) : null}
      </p>
      <button type="button" onClick={() => setNums((x) => !x)} className="rounded border border-slate-700 px-1.5 text-[11px] text-slate-300">
        {nums ? "Hide numbers" : "Show numbers"}
      </button>
      {nums ? <Figures t={t} /> : null}
    </div>
  );
}

/** The lane panel's sales section. */
export function SalesLaneSection({ f, lane, w, onWindow }: { f: Facts; lane: LaneKey; w: SalesWindow; onWindow: (w: SalesWindow) => void }) {
  const sales = f.sales;
  const l = salesFor(sales, lane);
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-2 text-slate-500">
        Sales numbers <SalesBuilt sales={sales} />
      </p>
      {sales.status !== "ok" ? null : !l ? (
        <NoData>this lane is not in the sales numbers</NoData>
      ) : (
        <>
          <SalesSendLine sales={sales} lane={lane} />
          <WindowSwitch since={sales.snapshot.since} w={w} onWindow={onWindow} />
          <LaneFigures l={l} w={w} />
          {lane === "offer" ? <Offers sales={sales} /> : null}
        </>
      )}
    </div>
  );
}

/** Offers (Holiday Gift, the $100-off quotes) and their deals. */
function Offers({ sales }: { sales: Extract<SalesLanesData, { status: "ok" }> }) {
  if (!sales.snapshot.offers.length) return null;
  return (
    <div className="space-y-2 pt-1">
      {sales.snapshot.offers.map((o) => (
        <div key={o.offer} className="rounded border border-slate-800 p-2 text-[11px]">
          <p className="font-semibold text-slate-200">{offerName(o.offer)}</p>
          <p className="text-slate-300">
            <M v={o.sent} /> sent · <M v={o.opened} /> opened (<M v={o.openedByPerson} /> by a person) · <M v={o.clicked} /> clicked ·{" "}
            <M v={o.replied} /> replied
          </p>
          <p className="text-slate-400">
            Open deals: {o.openDealIds.length ? o.openDealIds.map((d) => `#${d}`).join(", ") : "none"} · Booked:{" "}
            {o.bookedDealIds.length ? o.bookedDealIds.map((d) => `#${d}`).join(", ") : "none"}
          </p>
        </div>
      ))}
      <p className="text-[10px] text-slate-600">Deal numbers are the CRM&rsquo;s; the board has no link that opens one deal yet.</p>
    </div>
  );
}

/** The mailbox panel's row: yesterday and the 7-day average against its allowance, and the freeze in the publisher's words. */
export function SalesMailboxRows({ f, m, Row }: { f: Facts; m: MailboxFact; Row: (p: { k: string; children: ReactNode }) => ReactNode }) {
  const sm = salesMailbox(f.sales, m.address);
  if (!sm) return null;
  const sl = salesFor(f.sales, m.lane);
  return (
    <>
      <Row k="Sales numbers">
        Sent yesterday <M v={sm.sentYesterday} /> · 7-day average <M v={sm.sent7dAvg} /> · allowance <M v={sm.dailyAllowance} /> a day
        {sl?.targetDailySends != null ? <span className="block text-slate-500">{salesLaneName(sl.lane)} lane target: {sl.targetDailySends} a day</span> : null}
        <SyntheticTag what={f.sales.status === "ok" ? f.sales.synthetic : undefined} />
      </Row>
      {sm.frozen ? (
        <Row k="Frozen">
          since {sm.frozenSince ? dateEt(sm.frozenSince.length === 10 ? `${sm.frozenSince}T12:00:00Z` : sm.frozenSince) : "not recorded"}
          {sm.frozenReason ? `: ${sm.frozenReason}` : ""}
        </Row>
      ) : null}
    </>
  );
}

/** The sales numbers panel: every lane and channel, spend, the alerts that name no lane, and what could not be read. */
export function SalesPanelBody({ f, w, onWindow, alerts }: { f: Facts; w: SalesWindow; onWindow: (w: SalesWindow) => void; alerts: ReactNode }) {
  const sales = f.sales;
  return (
    <div className="space-y-3 text-xs">
      {alerts}
      <p className="flex flex-wrap items-center gap-2 text-slate-400">
        <SalesBuilt sales={sales} />
      </p>
      {sales.status === "empty" ? (
        <p className="text-slate-400">
          bj-finance has not published any sales numbers yet (metrics_snapshots kind &lsquo;sales_lanes&rsquo;). Until it does, Apollo&rsquo;s cold
          numbers, bookings by lane, spend and offer deals read No data here.
        </p>
      ) : null}
      {sales.status === "unreadable" ? <p className="text-slate-400">Reading them failed: {sales.message}</p> : null}
      {sales.status === "unrecognised" ? <p className="text-slate-400">The newest snapshot is not in a shape this screen reads (schema 1).</p> : null}
      {sales.status === "ok" ? (
        <>
          {sales.stale ? (
            <p className="text-slate-300">
              Sales numbers were last built {dateEt(sales.builtAt)}. These are that day&rsquo;s.
            </p>
          ) : null}
          <WindowSwitch since={sales.snapshot.since} w={w} onWindow={onWindow} />
          {sales.snapshot.lanes.map((l) => (
            <div key={l.lane} className="border-t border-slate-800 pt-2">
              <p className="mb-1 font-semibold text-slate-200">
                {salesLaneName(l.lane)}
                {consoleLaneOf(l.lane) ? <span className="ml-1 font-normal text-slate-500">email lane</span> : null}
              </p>
              <LaneFigures l={l} w={w} />
            </div>
          ))}
          {sales.snapshot.sourceProblems.length ? (
            <div className="border-t border-slate-800 pt-2 text-slate-400">
              <p className="text-slate-500">Not read when these were built, so some numbers may be short:</p>
              {sales.snapshot.sourceProblems.map((s) => (
                <p key={s.source}>
                  {s.source}: {s.detail}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
