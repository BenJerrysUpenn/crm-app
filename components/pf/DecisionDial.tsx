"use client";

// Decision dial — faithful port of the ratified recurring_dial artifact
// (docs/charts/dial_template.html in the private repo): everything currently
// on autopilot in the center, the last 12 months of start/stop decisions
// around the ring, brightest = now.

import { useState } from "react";
import type { DialData, DialStream } from "@/lib/pf/types";
import "./pf.css";

const MSH = (m: string) =>
  ({
    "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun",
    "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
  })[m.slice(5)] + " ’" + m.slice(2, 4);

const fmt = (n: number) =>
  (n < 0 ? "−" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const CX = 500, CY = 430, R0 = 205, R1 = 290, RLAB = 305;
const RMID = (R0 + R1) / 2;
const CATS: Record<string, string> = {
  debt: "Debt payments",
  cash: "Standing cash (manual)",
  payroll: "Payroll deductions",
  transfer: "Scheduled transfers (savings)",
  bills: "Bills & utilities",
  foodsub: "Food & household subscriptions",
  subs: "Subscriptions",
  other: "Verify these",
};

const pol = (r: number, aDeg: number): [number, number] => {
  const a = (aDeg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};
function arc(a0: number, a1: number, r: number) {
  const [x0, y0] = pol(r, a0), [x1, y1] = pol(r, a1);
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`;
}

type Ev = { sgn: 1 | -1; s: DialStream };

export default function DecisionDial({ data }: { data: DialData }) {
  const MONTHS = data.months;
  const STREAMS = data.streams;
  const [sel, setSel] = useState<string | null>(null); // "center" | month

  const active = STREAMS.filter((s) => s.active);
  const totMo = active.reduce((a, s) => a + s.permo, 0);
  const catTot: Record<string, number> = {};
  for (const s of active) catTot[s.cat] = (catTot[s.cat] || 0) + s.permo;
  const events: Record<string, Ev[]> = {};
  for (const m of MONTHS) events[m] = [];
  for (const s of STREAMS) {
    if (s.start_ev && events[s.start_ev]) events[s.start_ev].push({ sgn: 1, s });
    if (s.end_ev && events[s.end_ev]) events[s.end_ev].push({ sgn: -1, s });
  }
  for (const m of MONTHS)
    events[m].sort((a, b) => Math.abs(b.s.permo) - Math.abs(a.s.permo));
  const netWindow = MONTHS.reduce(
    (a, m) => a + events[m].reduce((x, e) => x + e.sgn * e.s.permo, 0),
    0,
  );
  const last = MONTHS.length - 1;

  // ---- svg (port of draw()) ----
  let s = "";
  s += `<circle class="track" cx="${CX}" cy="${CY}" r="${RMID}"/>`;
  MONTHS.forEach((m, i) => {
    const aMid = -90 + (i - last) * 30, a0 = aMid - 7.5, a1 = aMid + 7.5;
    const bright = 0.14 + 0.86 * Math.pow(i / Math.max(last, 1), 1.4);
    const ev = events[m];
    const net = ev.reduce((a, e) => a + e.sgn * e.s.permo, 0);
    s += `<path class="wedge${i === last ? " now" : ""}" data-m="${m}" d="${arc(a0, a1, RMID)}" stroke-opacity="${bright.toFixed(3)}"><title>${MSH(m)} — ${ev.length} decision${ev.length === 1 ? "" : "s"}, net ${fmt(net)}/mo</title></path>`;
    if (sel === m) s += `<path class="selring" d="${arc(a0 - 3, a1 + 3, RMID + 37)}"/>`;
    const [lx, ly] = pol(RMID, aMid);
    const dimTxt = i < 5;
    s += `<text class="mlab" x="${lx}" y="${ly - 2}" text-anchor="middle"${dimTxt ? ' opacity=".55"' : ""}>${MSH(m)}</text>`;
    if (ev.length)
      s += `<text class="mnet" x="${lx}" y="${ly + 14}" text-anchor="middle" fill="var(--${net > 0 ? "bad" : "good"})"${dimTxt ? ' opacity=".65"' : ""}>${net > 0 ? "+" : ""}${fmt(net)}</text>`;
    // decisions listed just outside the wedge
    const [ox, oy] = pol(RLAB + 12, aMid);
    const right = Math.cos((aMid * Math.PI) / 180) > 0.05,
      leftS = Math.cos((aMid * Math.PI) / 180) < -0.05;
    const anchor = right ? "start" : leftS ? "end" : "middle";
    const show = ev.slice(0, 3);
    show.forEach((e, j) => {
      const yy = oy + (j - (show.length - 1) / 2) * 15;
      s += `<text class="dline" x="${ox}" y="${yy}" text-anchor="${anchor}"${dimTxt ? ' opacity=".55"' : ""}><tspan class="${e.sgn > 0 ? "plus" : "minus"}">${e.sgn > 0 ? (e.s.resumed ? "↻" : "+") : "−"}</tspan> ${esc(e.s.name.slice(0, 16))} ${fmt(e.s.permo)}</text>`;
    });
    if (ev.length > 3)
      s += `<text class="dline" x="${ox}" y="${oy + (show.length - (show.length - 1) / 2) * 15}" text-anchor="${anchor}" opacity=".7">…${ev.length - 3} more</text>`;
  });
  // center
  s += `<circle class="center" data-c="1" cx="${CX}" cy="${CY}" r="${R0 - 28}" fill="var(--wash)" stroke="var(--hair)"/>`;
  s += `<text class="cbig" x="${CX}" y="${CY - 30}" text-anchor="middle">${fmt(totMo)}/mo</text>`;
  s += `<text class="csml" x="${CX}" y="${CY - 6}" text-anchor="middle">${active.length} standing decisions</text>`;
  s += `<text class="csml" x="${CX}" y="${CY + 16}" text-anchor="middle">debt ${fmt(catTot.debt || 0)} · cash ${fmt(catTot.cash || 0)} · payroll ${fmt(catTot.payroll || 0)}</text>`;
  s += `<text class="csml" x="${CX}" y="${CY + 34}" text-anchor="middle">savings ${fmt(catTot.transfer || 0)} · bills+subs ${fmt((catTot.bills || 0) + (catTot.subs || 0) + (catTot.foodsub || 0))}</text>`;
  s += `<text class="cnet" x="${CX}" y="${CY + 58}" text-anchor="middle" fill="var(--${netWindow > 0 ? "bad" : "good"})">12-mo net ${netWindow > 0 ? "+" : ""}${fmt(netWindow)}/mo</text>`;

  // ---- panel (port of panel()) ----
  let panelHtml = `<div class="hint">Click the center for the full standing list, or a month for its decisions.</div>`;
  if (sel === "center") {
    let rows = "";
    for (const cat of ["debt", "cash", "payroll", "transfer", "bills", "foodsub", "subs", "other"]) {
      const lab = CATS[cat];
      const list = active.filter((x) => x.cat === cat).sort((a, b) => b.permo - a.permo);
      if (!list.length) continue;
      rows += `<tr class="grp"><td colspan="4">${lab} — ${fmt(list.reduce((a, x) => a + x.permo, 0))}/mo</td></tr>`;
      rows += list
        .map(
          (x) =>
            `<tr><td>${esc(x.name)}</td><td>${x.cadence}${x.first ? ` · since ${x.first.slice(0, 7)}` : ""}</td><td class="note">${esc(x.note || "")}</td><td class="num">${fmt(x.permo)}/mo</td></tr>`,
        )
        .join("");
    }
    panelHtml = `<div class="card"><table><thead><tr><th>Standing decision</th><th>Cadence</th><th>Note</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } else if (sel) {
    const ev = events[sel] || [];
    if (!ev.length) {
      panelHtml = `<div class="card"><div class="hint">${MSH(sel)} — no recurring-payment decisions.</div></div>`;
    } else {
      const net = ev.reduce((a, e) => a + e.sgn * e.s.permo, 0);
      panelHtml =
        `<div class="card"><table><thead><tr><th>${MSH(sel)} decision</th><th>Cadence</th><th>Note</th><th class="num">Δ autopilot</th></tr></thead><tbody>` +
        ev
          .map(
            (e) =>
              `<tr><td><span class="${e.sgn > 0 ? "add" : "rem"}">${e.sgn > 0 ? (e.s.resumed ? "↻ resumed" : "+ started") : "− ended"}</span> &nbsp;${esc(e.s.name)}</td><td>${e.s.cadence}${e.s.first ? ` · first ${e.s.first.slice(0, 10)}` : ""}${e.s.last ? ` · last ${e.s.last.slice(0, 10)}` : ""}</td><td class="note">${esc(e.s.note || "")}</td><td class="num ${e.sgn > 0 ? "add" : "rem"}">${e.sgn > 0 ? "+" : "−"}${fmt(e.s.permo)}/mo</td></tr>`,
          )
          .join("") +
        `</tbody><tfoot><tr><th colspan="3">net change to autopilot</th><th class="num ${net > 0 ? "add" : "rem"}">${net > 0 ? "+" : ""}${fmt(net)}/mo</th></tr></tfoot></table></div>`;
    }
  }

  function onClick(e: React.MouseEvent) {
    const w = (e.target as Element).closest<HTMLElement>("[data-m]");
    const c = (e.target as Element).closest<HTMLElement>("[data-c]");
    if (w) setSel(sel === w.dataset.m ? null : (w.dataset.m as string));
    else if (c) setSel(sel === "center" ? null : "center");
  }

  return (
    <div className="pfviz">
      <h1>Autopilot — the decisions you&rsquo;re not re-making</h1>
      <p className="sub">
        Only money that leaves automatically counts here — no store or phone
        purchases. The center is everything currently on autopilot; the dial is
        the last 12 months of start/stop decisions, brightest = now. Click a
        month or the center.
      </p>
      <div className="card">
        <svg
          viewBox="0 0 1000 840"
          role="img"
          aria-label="Radial dial of recurring-payment decisions by month"
          onClick={onClick}
          dangerouslySetInnerHTML={{ __html: s }}
        />
      </div>
      <div style={{ marginTop: 14 }} dangerouslySetInnerHTML={{ __html: panelHtml }} />
    </div>
  );
}
