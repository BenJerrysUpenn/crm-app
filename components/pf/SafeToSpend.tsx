"use client";

// Safe to spend — faithful port of the ratified safe_to_spend artifact
// (docs/charts/safe_to_spend.html in the private repo), now live-fed:
// income − standing decisions − committed savings = the pool; the big number
// is what's left of it this month. The habit card gains ACTUALS vs targets
// (the artifact only had targets). Designed phone-first: two 380px cards.

import type { SafeToSpendData } from "@/lib/pf/types";
import "./pf.css";

const CHIP: Record<string, string> = {
  keep: "chip",
  fine: "chip",
  cap: "chip cap",
  trim: "chip cap",
  cut: "chip cut",
};

const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

export default function SafeToSpend({ data }: { data: SafeToSpendData }) {
  const M = data.month;
  const pool = M.expected_take_home - M.standing - M.committed_savings;
  const remaining = pool - M.discretionary_spent;
  const pctMonth = M.today / M.days_in_month;
  const pctSpent = Math.min(M.discretionary_spent / pool, 1);
  const onPace = pctSpent <= pctMonth;
  const daysLeft = M.days_in_month - M.today;
  const perDay = Math.max(remaining, 0) / Math.max(daysLeft, 1);
  const projKeep = Math.round(
    M.committed_savings +
      Math.max(pool - (pctMonth > 0 ? M.discretionary_spent / pctMonth : 0), 0),
  );

  const habits = data.habits;
  const hTot = habits.reduce((a, h) => a + h.target, 0);
  const flex = pool - hTot;
  const scaleRef = Math.max(
    ...habits.map((h) => Math.max(h.target, h.actual)),
    flex,
    1,
  );

  return (
    <div className="pfviz pf-safe">
      <div className="hd">
        <h1>Safe to spend</h1>
        <p>
          Income − standing decisions − committed savings = the pool. The pool
          is <b>habits + one-offs + shocks</b> — and whatever survives the
          month is <b>kept</b>.
        </p>
      </div>

      <div className="phone">
        <div className="row">
          <span className="month">{M.label}</span>
          <span className="day">
            day {M.today} of {M.days_in_month}
          </span>
        </div>
        <div className="big">
          <div
            className="amt"
            style={{ color: remaining >= 0 ? "var(--ink)" : "var(--bad)" }}
          >
            {usd(Math.abs(remaining))}
          </div>
          <div className="lbl">
            {remaining >= 0
              ? "safe to spend this month"
              : "OVER the discretionary pool"}
          </div>
          <div className={`pace ${onPace ? "good" : "bad"}`}>
            {onPace ? "✓ on pace" : "⚠ ahead of the month"} —{" "}
            {Math.round(pctSpent * 100)}% spent,{" "}
            {Math.round(pctMonth * 100)}% of month gone
          </div>
        </div>
        <div>
          <div className="bar">
            <div
              className="fill"
              style={{ width: `${(pctSpent * 100).toFixed(1)}%` }}
            />
            <div
              className="tick"
              style={{ left: `${(pctMonth * 100).toFixed(1)}%` }}
            />
          </div>
          <div className="legend">
            <span>$0</span>
            <span>pool {usd(pool)}</span>
          </div>
        </div>
        <div className="grid">
          <div className="tile">
            <div className="v">{usd(M.standing)}</div>
            <div className="k">
              standing decisions
              <br />
              already handled on autopilot
            </div>
          </div>
          <div className="tile">
            <div className="v good">{usd(projKeep)}</div>
            <div className="k">
              projected keeping
              <br />
              savings + surplus at this pace
            </div>
          </div>
        </div>
        <div className="daily">
          <div>
            <div className="v">{usd(perDay)}/day</div>
            <div className="k">for the {daysLeft} days left</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="v" style={{ fontSize: 15 }}>
              {usd(M.committed_savings)}
            </div>
            <div className="k">already committed to EF</div>
          </div>
        </div>
      </div>

      <div className="phone">
        <div className="row">
          <span className="month">Habits — spent vs target</span>
          <span className="day">pool {usd(pool)}</span>
        </div>
        {habits.map((h) => {
          const over = h.actual > h.target;
          return (
            <div className="hrow" key={h.name}>
              <span className="hname">{h.name}</span>
              <span className={CHIP[h.verdict] ?? "chip"}>
                {h.verdict.toUpperCase()}
              </span>
              <span className="hbar">
                <span
                  className={`afill${over ? " over" : ""}`}
                  style={{
                    width: `${Math.max((h.actual / scaleRef) * 100, h.actual > 0 ? 2 : 0)}%`,
                  }}
                />
                <span
                  className="htick"
                  style={{
                    left: `${Math.min((h.target / scaleRef) * 100, 100)}%`,
                  }}
                />
              </span>
              <span className="hamt">
                <b className={over ? "over" : ""}>{usd(h.actual)}</b> /{" "}
                {h.target === 0 ? "$0" : usd(h.target)}
              </span>
            </div>
          );
        })}
        <div className="hrow flexline">
          <span className="hname">Flex / one-offs / travel buffer</span>
          <span className="chip">UNALLOCATED</span>
          <span className="hbar">
            <span
              className="afill"
              style={{
                width: `${Math.max((flex / scaleRef) * 100, 2)}%`,
                opacity: 0.35,
              }}
            />
          </span>
          <span className="hamt">{usd(flex)}</span>
        </div>
        <div className="hnote">
          Bar = spent so far this month; tick = the month&rsquo;s target.
          Targets sum to the pool. Spend inside a line and it&rsquo;s a
          non-decision; going over one means consciously borrowing from Flex —
          that&rsquo;s the in-store question to ask.
        </div>
      </div>
    </div>
  );
}
