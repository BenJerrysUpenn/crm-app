"use client";

// Money explorer — faithful port of the ratified money_explorer artifact
// (docs/charts/explorer_template.html in the private repo): a 3-month
// drill-down Sankey (groups → categories → merchants → transactions) with a
// category lens and a decision lens. The imperative SVG-string renderer is
// kept nearly verbatim; React owns the navigation state.

import { useState } from "react";
import type { ExplorerData, ExplorerRow } from "@/lib/pf/types";
import "./pf.css";

type Lens = "cat" | "dec";

const GCAT: Record<string, { label: string; color: string }> = {
  debt: { label: "Debt service", color: "var(--s1)" },
  child: { label: "Childcare & household", color: "var(--s2)" },
  kept: { label: "Kept → EF pot", color: "var(--good)" },
  food: { label: "Food", color: "var(--s3)" },
  shop: { label: "Shopping", color: "var(--s4)" },
  transport: { label: "Transport", color: "var(--s5)" },
  home: { label: "Home & utilities", color: "var(--s6)" },
  other: { label: "Other & one-offs", color: "var(--gray)" },
  subs: { label: "Subscriptions", color: "var(--s7)" },
  income: { label: "Income", color: "var(--ink)" },
};
const GDEC: Record<string, { label: string; color: string }> = {
  standing: { label: "Standing (past decisions)", color: "var(--s1)" },
  habit: { label: "Habits", color: "var(--s3)" },
  kept: { label: "Kept → EF pot", color: "var(--good)" },
  oneoff: { label: "One-offs (chosen)", color: "var(--s4)" },
  shock: { label: "Shocks (not chosen)", color: "var(--s2)" },
  pass: { label: "Pass-through (business)", color: "var(--gray)" },
  income: { label: "Income", color: "var(--ink)" },
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const mlab = (m: string) => MONTH_NAMES[parseInt(m.slice(5), 10) - 1] ?? m;
const mfull = (m: string) => `${mlab(m)} ${m.slice(0, 4)}`;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const fmt = (n: number) =>
  (n < 0 ? "−" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmt2 = (n: number) =>
  (n < 0 ? "−" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const W = 1080, H = 640, PT = 24, PB = 16, PH = H - PT - PB, NW = 14, GAP = 7;
const XL = 130, XM = 430, XR = 760; // three column left-edges

interface Nav {
  month: string;
  grp: string | null;
  sub: string | null;
  leaf: string | null;
}

const rib = (xa: number, ya: number, ha: number, xb: number, yb: number, hb: number) => {
  const xm = (xa + xb) / 2;
  return `M${xa},${ya} C${xm},${ya} ${xm},${yb} ${xb},${yb} L${xb},${yb + hb} C${xm},${yb + hb} ${xm},${ya + ha} ${xa},${ya + ha} Z`;
};

function nodeSvg(x: number, y: number, h: number, color: string, attrs: string, dim?: boolean) {
  return `<rect class="node${dim ? " dim" : ""}" ${attrs} x="${x}" y="${y}" width="${NW}" height="${Math.max(h, 3)}" rx="4" fill="${color}"/>`;
}
function labelSvg(x: number, y: number, h: number, lab: string, val: string, dim: boolean) {
  const mid = y + h / 2 + 4, cls = dim ? " dim" : "";
  if (h >= 26)
    return `<text class="nlab${cls}" x="${x}" y="${mid - 8}">${lab}</text><text class="nval${cls}" x="${x}" y="${mid + 10}">${val}</text>`;
  return `<text class="nlab${cls}" x="${x}" y="${mid}">${lab} · <tspan class="nval${cls}">${val}</tspan></text>`;
}
type Stacked = { id: string; amt: number; y: number; h: number };
function stackY(items: [string, number][], sc: number, y0: number): Stacked[] {
  let y = y0;
  return items.map(([id, amt]) => {
    const h = Math.abs(amt) * sc, o = { id, amt, y, h };
    y += h + GAP;
    return o;
  });
}

export default function MoneyExplorer({ data }: { data: ExplorerData }) {
  const months = data.months;
  const [lens, setLens] = useState<Lens>("cat");
  const [nav, setNav] = useState<Nav>({
    month: months[months.length - 1] ?? "",
    grp: null,
    sub: null,
    leaf: null,
  });

  const G = lens === "cat" ? GCAT : GDEC;
  const LG = lens === "cat" ? "g" : "g2";
  const LS = lens === "cat" ? "s" : "s2";
  let { month, grp, sub, leaf } = nav;

  const inMonth = (r: ExplorerRow) => r.d.slice(0, 7) === month;
  const rowsOf = (g: string, s?: string | null, m?: string | null) =>
    data.rows.filter(
      (r) =>
        inMonth(r) &&
        r[LG] === g &&
        (s == null || r[LS] === s) &&
        (m == null || r.m === m),
    );
  const sgn = (g: string, a: number) => (g === "income" ? a : -a); // outflow positive

  function groupTotals() {
    const t: Record<string, number> = {};
    let inc = 0;
    for (const r of data.rows.filter(inMonth)) {
      if (r[LG] === "income") { inc += r.a; continue; }
      t[r[LG]] = (t[r[LG]] || 0) - r.a;
    }
    const out = Object.values(t).reduce((a, b) => a + b, 0);
    if (inc - out > 0.5) t.kept = inc - out;
    return { t, inc, out, net: inc - out };
  }
  function subTotals(g: string): [string, number][] {
    const t: Record<string, number> = {};
    for (const r of rowsOf(g)) t[r[LS]] = (t[r[LS]] || 0) + sgn(g, r.a);
    return Object.entries(t).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  }
  function merchTotals(g: string, s: string): [string, number, number][] {
    const t: Record<string, number> = {}, n: Record<string, number> = {};
    for (const r of rowsOf(g, s)) {
      t[r.m] = (t[r.m] || 0) + sgn(g, r.a);
      n[r.m] = (n[r.m] || 0) + 1;
    }
    let e = Object.entries(t).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (e.length > 12) {
      const tail = e.slice(11), rest = tail.reduce((a, [, v]) => a + v, 0);
      e = e.slice(0, 11);
      e.push([`…${tail.length} more merchants`, rest]);
    }
    return e.map(([k, v]) => [k, v, n[k] || 0]);
  }

  // ---- render (port of draw()) ----
  const { t, inc, out, net } = groupTotals();
  {
    const valid = Object.keys(G).filter((g) => g !== "income" && t[g] > 0.5);
    if (grp && grp !== "income" && grp !== "kept" && !valid.includes(grp)) {
      grp = null; sub = null; leaf = null;
    }
    if (grp === "income" && inc <= 0.5) { grp = null; sub = null; leaf = null; }
  }

  const kpis =
    `<div class="kpi"><div class="v">${fmt(inc)}</div><div class="l">TAKE-HOME</div></div>` +
    `<div class="kpi"><div class="v">${fmt(out)}</div><div class="l">SPENT + DEBT SERVICE</div></div>` +
    `<div class="kpi"><div class="v ${net >= 0 ? "good" : ""}">${net >= 0 ? "+" : ""}${fmt(net)}</div><div class="l">${net >= 0 ? "KEPT (→ EF POT)" : "OVERSPENT (FROM BUFFER)"}</div></div>`;

  const cr = [`<a data-nav="m">${mfull(month)}</a>`];
  if (grp)
    cr.push(
      grp === "kept"
        ? `<b>${G.kept.label}</b>`
        : sub
          ? `<a data-nav="g">${G[grp].label}</a>`
          : `<b>${G[grp].label}</b>`,
    );
  if (sub) cr.push(leaf ? `<a data-nav="s">${esc(sub)}</a>` : `<b>${esc(sub)}</b>`);
  if (leaf) cr.push(`<b>${esc(leaf)}</b>`);
  const backBtn =
    grp && (sub || grp === "income")
      ? `<button class="backbtn" data-nav="back">← Back</button>`
      : "";
  const crumb = backBtn + `<span>${cr.join(" › ")}</span>`;

  let s = "";
  const order = Object.keys(G)
    .filter((g) => g !== "income" && t[g] > 0.5)
    .sort((a, b) => t[b] - t[a]);
  const total = order.reduce((a, g) => a + t[g], 0);

  if (total > 0.5 || inc > 0.5) {
    if (!grp || grp === "kept") {
      // DEPTH 0 — Income | Groups (deficit months: red Overspent node hangs below)
      const sc = (PH - GAP * (order.length - 1)) / total;
      const gs = stackY(order.map((g) => [g, t[g]]), sc, PT);
      const colH = total * sc;
      const incH = (net < -0.5 ? inc : total) * sc, incY = PT + (PH - colH) / 2;
      s += `<text class="colhead" x="${XL}" y="14">Income</text><text class="colhead" x="${XM}" y="14">Where it went — click a group to expand it</text>`;
      let ys = incY;
      for (const n of gs) {
        s += `<path class="rib" data-g="${n.id}" fill="${G[n.id].color}" d="${rib(XL + NW, ys, n.h, XM, n.y, n.h)}"><title>${fmt(n.amt)} — ${G[n.id].label}</title></path>`;
        ys += n.h;
      }
      s +=
        nodeSvg(XL, incY, incH, "var(--ink)", 'data-g="income"') +
        `<text class="nlab end" x="${XL - 10}" y="${incY + incH / 2 - 8}">${mlab(month)} take-home</text><text class="nval end" x="${XL - 10}" y="${incY + incH / 2 + 12}">${fmt(inc)}</text>`;
      if (net < -0.5) {
        const oy = incY + incH + GAP, oh = Math.abs(net) * sc;
        s +=
          nodeSvg(XL, oy, oh, "var(--bad)", 'data-g="kept"') +
          `<text class="nlab end" x="${XL - 10}" y="${oy + oh / 2 - 8}" fill="var(--bad)">✕ Overspent</text>` +
          `<text class="nval end" x="${XL - 10}" y="${oy + oh / 2 + 12}">−${fmt(Math.abs(net))} from buffer</text>`;
      }
      for (const n of gs) {
        const lab = (n.id === "kept" ? "✓ " : "") + G[n.id].label;
        s +=
          nodeSvg(XM, n.y, n.h, G[n.id].color, `data-g="${n.id}"`) +
          labelSvg(XM + NW + 10, n.y, n.h, lab, fmt(n.amt), false);
      }
    } else if (grp === "income" && !sub) {
      // INCOME DEPTH 1 — sources (left) → income → groups (right)
      const sc = (PH - GAP * (order.length - 1)) / total;
      const srcs = subTotals("income");
      const incH = inc * sc;
      s += `<text class="colhead" x="${XL}" y="14">Income sources — click one</text><text class="colhead" x="${XM}" y="14">Income</text><text class="colhead" x="${XR}" y="14">Where it went</text>`;
      const iY = PT;
      const scS = (incH - GAP * (srcs.length - 1)) / inc;
      const ss = stackY(srcs, scS, iY);
      let ys = iY;
      for (const n of ss) {
        s += `<path class="rib" data-sub="${esc(n.id)}" fill="var(--ink)" style="opacity:.25" d="${rib(XL + NW, n.y, n.h, XM, ys, n.h)}"><title>${fmt(Math.abs(n.amt))} — ${esc(n.id)}</title></path>`;
        ys += n.h;
      }
      for (const n of ss)
        s +=
          nodeSvg(XL, n.y, n.h, "var(--ink)", `data-sub="${esc(n.id)}"`) +
          labelSvg(XL + NW + 10, n.y, n.h, esc(n.id), fmt(Math.abs(n.amt)), false);
      s += nodeSvg(XM, iY, incH, "var(--ink)", 'data-g="income"');
      // groups to the right
      const gs = stackY(order.map((g) => [g, t[g]]), sc, PT);
      let ys2 = iY;
      for (const n of gs) {
        s += `<path class="rib" data-g="${n.id}" fill="${G[n.id].color}" d="${rib(XM + NW, ys2, Math.min(n.h, Math.max(iY + incH - ys2, 0)), XR, n.y, n.h)}"><title>${fmt(n.amt)} — ${G[n.id].label}</title></path>`;
        ys2 += n.h;
      }
      if (net < -0.5) {
        const oy = iY + incH + GAP, oh = Math.abs(net) * sc;
        s +=
          nodeSvg(XM, oy, oh, "var(--bad)", 'data-g="kept"') +
          `<text class="nval end" x="${XM - 10}" y="${oy + oh / 2 + 4}" fill="var(--bad)">✕ −${fmt(Math.abs(net))}</text>`;
      }
      for (const n of gs) {
        const lab = (n.id === "kept" ? "✓ " : "") + G[n.id].label;
        s +=
          nodeSvg(XR, n.y, n.h, G[n.id].color, `data-g="${n.id}"`) +
          labelSvg(XR + NW + 10, n.y, n.h, lab, fmt(n.amt), false);
      }
    } else if (grp === "income" && sub) {
      // INCOME DEPTH 2 — merchants (far left) → sources → income
      const srcs = subTotals("income");
      const scS = (PH - GAP * (srcs.length - 1)) / inc;
      const ss = stackY(srcs, scS, PT);
      const incH = inc * scS, incY = PT;
      s += `<text class="colhead" x="${XL}" y="14">${esc(sub)} — click for transactions</text><text class="colhead" x="${XM}" y="14">Income sources</text><text class="colhead" x="${XR}" y="14">Income</text>`;
      let focus: Stacked | null = null, ys = incY;
      for (const n of ss) {
        const dim = n.id !== sub;
        if (!dim) focus = n;
        s += `<path class="rib${dim ? " dim" : ""}" data-sub="${esc(n.id)}" fill="var(--ink)" style="opacity:${dim ? 0.12 : 0.25}" d="${rib(XM + NW, n.y, n.h, XR, ys, n.h)}"><title>${fmt(Math.abs(n.amt))} — ${esc(n.id)}</title></path>`;
        ys += n.h;
      }
      for (const n of ss) {
        const dim = n.id !== sub;
        s +=
          nodeSvg(XM, n.y, n.h, "var(--ink)", `data-sub="${esc(n.id)}"`, dim) +
          labelSvg(XM + NW + 10, n.y, n.h, esc(n.id), fmt(Math.abs(n.amt)), dim);
      }
      s +=
        nodeSvg(XR, incY, incH, "var(--ink)", 'data-nav="g"') +
        `<text class="nlab" x="${XR + NW + 10}" y="${incY + incH / 2 - 8}">${mlab(month)} take-home</text><text class="nval" x="${XR + NW + 10}" y="${incY + incH / 2 + 12}">${fmt(inc)}</text>`;
      if (focus) {
        const merch = merchTotals("income", sub);
        const mTot = merch.reduce((a, [, v]) => a + Math.abs(v), 0) || 1;
        const scM = (focus.h - GAP * (merch.length - 1)) / mTot;
        const ms = stackY(merch.map(([k, v]) => [k, v]), Math.max(scM, 0.0001), focus.y);
        let ys2 = focus.y;
        for (const n of ms) {
          s += `<path class="rib" data-leaf="${encodeURIComponent(n.id)}" fill="var(--ink)" style="opacity:.2" d="${rib(XL + NW, n.y, n.h, XM, ys2, n.h)}"><title>${fmt(Math.abs(n.amt))} — ${esc(n.id)}</title></path>`;
          ys2 += n.h;
        }
        for (const n of ms)
          s +=
            nodeSvg(XL, n.y, n.h, "var(--ink)", `data-leaf="${encodeURIComponent(n.id)}"`) +
            labelSvg(XL + NW + 10, n.y, n.h, esc(n.id), fmt(Math.abs(n.amt)), false);
      }
    } else if (grp) {
      // EXPENSE DEPTH 1/2 — sliding window rightward
      const focusColor = G[grp].color;
      const subs = subTotals(grp);
      const gTot = t[grp];
      if (!sub) {
        const sc = (PH - GAP * (order.length - 1)) / total;
        const gs = stackY(order.map((g) => [g, t[g]]), sc, PT);
        const incY = PT + (PH - total * sc) / 2;
        s += `<text class="colhead" x="${XL}" y="14">Income</text><text class="colhead" x="${XM}" y="14">Groups</text><text class="colhead" x="${XR}" y="14">${G[grp].label} — click a category</text>`;
        let ys = incY;
        for (const n of gs) {
          const dim = n.id !== grp;
          s += `<path class="rib${dim ? " dim" : ""}" data-g="${n.id}" fill="${G[n.id].color}" d="${rib(XL + NW, ys, n.h, XM, n.y, n.h)}"><title>${fmt(n.amt)} — ${G[n.id].label}</title></path>`;
          ys += n.h;
        }
        const incH1 = (net < -0.5 ? inc : total) * sc;
        s +=
          nodeSvg(XL, incY, incH1, "var(--ink)", 'data-g="income"', true) +
          `<text class="nlab end dim" x="${XL - 10}" y="${incY + incH1 / 2 - 8}">${mlab(month)} take-home</text><text class="nval end" x="${XL - 10}" y="${incY + incH1 / 2 + 12}">${fmt(inc)}</text>`;
        if (net < -0.5) {
          const oy = incY + incH1 + GAP, oh = Math.abs(net) * sc;
          s +=
            nodeSvg(XL, oy, oh, "var(--bad)", 'data-g="kept"', true) +
            `<text class="nval end dim" x="${XL - 10}" y="${oy + oh / 2 + 4}">✕ −${fmt(Math.abs(net))}</text>`;
        }
        let focus: Stacked | null = null;
        for (const n of gs) {
          const dim = n.id !== grp;
          if (!dim) focus = n;
          s +=
            nodeSvg(XM, n.y, n.h, G[n.id].color, `data-g="${n.id}"`, dim) +
            labelSvg(XM + NW + 10, n.y, n.h, (n.id === "kept" ? "✓ " : "") + G[n.id].label, fmt(n.amt), dim);
        }
        if (focus) {
          const scSub = (focus.h - GAP * (subs.length - 1)) / subs.reduce((a, [, v]) => a + Math.abs(v), 0);
          const ss = stackY(subs, scSub, focus.y);
          let ys2 = focus.y;
          for (const n of ss) {
            s += `<path class="rib" data-sub="${esc(n.id)}" fill="${focusColor}" d="${rib(XM + NW, ys2, n.h, XR, n.y, n.h)}"><title>${fmt(Math.abs(n.amt))} — ${esc(n.id)}</title></path>`;
            ys2 += n.h;
          }
          for (const n of ss)
            s +=
              nodeSvg(XR, n.y, n.h, focusColor, `data-sub="${esc(n.id)}"`) +
              labelSvg(XR + NW + 10, n.y, n.h, esc(n.id), fmt(Math.abs(n.amt)), false);
        }
      } else {
        s += `<text class="colhead" x="${XL}" y="14">${G[grp].label}</text><text class="colhead" x="${XM}" y="14">Categories</text><text class="colhead" x="${XR}" y="14">${esc(sub)} — click a merchant for transactions</text>`;
        const subTot = subs.reduce((a, [, v]) => a + Math.abs(v), 0);
        const scSub = (PH - GAP * (subs.length - 1)) / subTot;
        const ss = stackY(subs, scSub, PT);
        const gH = subTot * scSub, gY = PT + (PH - gH) / 2;
        let ys = gY;
        for (const n of ss) {
          const dim = n.id !== sub;
          s += `<path class="rib${dim ? " dim" : ""}" data-sub="${esc(n.id)}" fill="${focusColor}" d="${rib(XL + NW, ys, n.h, XM, n.y, n.h)}"><title>${fmt(Math.abs(n.amt))} — ${esc(n.id)}</title></path>`;
          ys += n.h;
        }
        s +=
          nodeSvg(XL, gY, gH, focusColor, 'data-nav="g"') +
          `<text class="nlab end" x="${XL - 10}" y="${gY + gH / 2 - 8}">${G[grp].label}</text><text class="nval end" x="${XL - 10}" y="${gY + gH / 2 + 12}">${fmt(Math.abs(gTot))}</text>`;
        let focus: Stacked | null = null;
        for (const n of ss) {
          const dim = n.id !== sub;
          if (!dim) focus = n;
          s +=
            nodeSvg(XM, n.y, n.h, focusColor, `data-sub="${esc(n.id)}"`, dim) +
            labelSvg(XM + NW + 10, n.y, n.h, esc(n.id), fmt(Math.abs(n.amt)), dim);
        }
        if (focus) {
          const merch = merchTotals(grp, sub);
          const mTot = merch.reduce((a, [, v]) => a + Math.abs(v), 0) || 1;
          const scM = (focus.h - GAP * (merch.length - 1)) / mTot;
          const ms = stackY(merch.map(([k, v]) => [k, v]), Math.max(scM, 0.0001), focus.y);
          let ys2 = focus.y;
          for (const n of ms) {
            s += `<path class="rib" data-leaf="${encodeURIComponent(n.id)}" fill="${focusColor}" d="${rib(XM + NW, ys2, n.h, XR, n.y, n.h)}"><title>${fmt(Math.abs(n.amt))} — ${esc(n.id)}</title></path>`;
            ys2 += n.h;
          }
          for (const n of ms)
            s +=
              nodeSvg(XR, n.y, n.h, focusColor, `data-leaf="${encodeURIComponent(n.id)}"`) +
              labelSvg(XR + NW + 10, n.y, n.h, esc(n.id), fmt(Math.abs(n.amt)), false);
        }
      }
    }
  }

  // ---- panel (port of panel()) ----
  let panelHtml = "";
  if (grp === "kept") {
    const legs = data.eft
      .filter((e) => e.d.slice(0, 7) === month)
      .sort((a, b) => (a.d < b.d ? -1 : 1));
    const net2 = legs.reduce((a, e) => a + e.a, 0);
    panelHtml =
      `<div class="card"><div class="hint" style="max-width:74ch">The residual (income − everything spent) is NOT automatically moved anywhere — it sits in checking until swept. Every Emergency Fund transfer this month, both directions:</div>` +
      `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Direction</th><th class="num">Amount</th></tr></thead><tbody>` +
      (legs.length
        ? legs
            .map(
              (e) =>
                `<tr><td>${e.d}</td><td>${e.a > 0 ? "into EF" : "EF → checking"}</td><td class="num${e.a > 0 ? " pos" : ""}">${e.a > 0 ? "+" : ""}${fmt2(e.a)}</td></tr>`,
            )
            .join("")
        : `<tr><td colspan="3">none</td></tr>`) +
      `</tbody><tfoot><tr><th></th><th>net EF change (transfers)</th><th class="num">${net2 >= 0 ? "+" : ""}${fmt2(net2)}</th></tr></tfoot></table></div></div>`;
  } else if (leaf && grp && sub) {
    const isFold = leaf.startsWith("…");
    const shown = rowsOf(grp, sub)
      .filter((r) => (isFold ? true : r.m === leaf))
      .sort((a, b) => Math.abs(b.a) - Math.abs(a.a));
    const tot = shown.reduce((a, r) => a + r.a, 0);
    panelHtml =
      `<div class="card"><div class="tablewrap"><table>` +
      `<thead><tr><th>Date</th><th>Merchant</th><th class="num">Amount</th></tr></thead><tbody>` +
      shown
        .map(
          (r) =>
            `<tr><td>${r.d}</td><td>${esc(r.m)}</td><td class="num${r.a > 0 ? " pos" : ""}">${fmt2(r.a)}</td></tr>`,
        )
        .join("") +
      `</tbody><tfoot><tr><th></th><th>${shown.length} transactions</th><th class="num">${fmt2(tot)}</th></tr></tfoot></table></div></div>`;
  }

  // ---- click handlers (delegation, port of the artifact listeners) ----
  function onSvgClick(e: React.MouseEvent) {
    const el = (e.target as Element).closest<HTMLElement>(
      "[data-g],[data-sub],[data-leaf],[data-nav]",
    );
    if (!el) return;
    const n = { ...nav, grp, sub, leaf };
    if (el.dataset.nav === "g") { n.sub = null; n.leaf = null; }
    else if (el.dataset.g !== undefined) {
      n.grp = el.dataset.g === "kept" ? "kept" : el.dataset.g;
      n.sub = null; n.leaf = null;
    } else if (el.dataset.sub !== undefined) { n.sub = el.dataset.sub; n.leaf = null; }
    else if (el.dataset.leaf !== undefined) { n.leaf = decodeURIComponent(el.dataset.leaf); }
    setNav(n);
  }
  function onCrumbClick(e: React.MouseEvent) {
    const a = (e.target as Element).closest<HTMLElement>("[data-nav]");
    if (!a) return;
    const n = { ...nav, grp, sub, leaf };
    if (a.dataset.nav === "back") {
      if (n.leaf) n.leaf = null;
      else if (n.sub) n.sub = null;
      else n.grp = null;
      setNav(n);
      return;
    }
    if (a.dataset.nav === "m") { n.grp = null; n.sub = null; n.leaf = null; }
    if (a.dataset.nav === "g") { n.sub = null; n.leaf = null; }
    if (a.dataset.nav === "s") { n.leaf = null; }
    setNav(n);
  }

  return (
    <div className="pfviz">
      <h1>Where the money goes — click to dive, breadcrumb to climb back</h1>
      <p className="sub">
        Rebuilt from raw bank rows per the household bookkeeping ruleset
        (transfers &amp; card-payment legs excluded). Each click re-renders the
        Sankey one level deeper: groups → categories → merchants →
        transactions.
      </p>
      <div className="tabs">
        {months.map((m) => (
          <button
            key={m}
            className={m === month ? "on" : ""}
            onClick={() => setNav({ month: m, grp, sub, leaf })}
          >
            {mfull(m)}
          </button>
        ))}
      </div>
      <div className="tabs">
        <button className={lens === "cat" ? "on" : ""} onClick={() => { setLens("cat"); setNav({ ...nav, grp: null, sub: null, leaf: null }); }}>
          By category
        </button>
        <button className={lens === "dec" ? "on" : ""} onClick={() => { setLens("dec"); setNav({ ...nav, grp: null, sub: null, leaf: null }); }}>
          By decision type
        </button>
      </div>
      <div className="kpis" dangerouslySetInnerHTML={{ __html: kpis }} />
      <div className="crumb" onClick={onCrumbClick} dangerouslySetInnerHTML={{ __html: crumb }} />
      <div className="card">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Money flow Sankey; every node is clickable"
          onClick={onSvgClick}
          dangerouslySetInnerHTML={{ __html: s }}
        />
      </div>
      <div style={{ marginTop: 14 }} dangerouslySetInnerHTML={{ __html: panelHtml }} />
    </div>
  );
}
