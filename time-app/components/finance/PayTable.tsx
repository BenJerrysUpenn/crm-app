"use client";

import { Fragment, useState } from "react";
import { fmtTime } from "@/lib/format";
import {
  QBO_COLUMNS,
  SHEET_VERSION,
  hoursText,
  money,
  payTableBlocker,
  qboCell,
  qboTotal,
  rateCell,
  requestView,
  wagesCell,
  whenText,
  type PaySheetJson,
  type PaySheetState,
  type SheetRow,
} from "@/lib/payroll/paySheet";

// The pay table (bj-finance #519, Alina 2026-10-05): "Who is getting paid
// what? How do I know the hourly rates match hours worked? That solo close was
// calculated correctly? I need a table that matches QBO for each person."
//
// Renders the sheet bj-finance modules/payroll_sheet.py built on the Mac and
// published to payroll_sheets (migration 36). It computes nothing: every
// number below is a field of that JSON, formatted. One row per person, in the
// order the lines are keyed into QBO's Run Payroll grid, then the rate and the
// wages those hours come to; each row opens onto the punches, weeks, tips and
// solo-close nights behind it.

const TONE: Record<string, string> = {
  busy: "text-sky-700 dark:text-sky-400",
  ok: "text-slate-600 dark:text-slate-400",
  error: "text-rose-600 dark:text-rose-400",
  none: "text-slate-500",
};

/** "2026-09-21" → "Mon, Sep 21", read as a calendar day, never shifted by a zone. */
function dayText(day: string): string {
  return new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function PayTable({
  state,
  busy,
  onRebuild,
}: {
  state: PaySheetState | null;
  busy: boolean;
  onRebuild: () => void;
}) {
  const view = state ? requestView(state) : { tone: "none", text: "Loading the pay table…" };
  const blocker = state ? payTableBlocker(state) : null;
  const building = !!state && state.available && (state.latest?.status === "queued" || state.latest?.status === "building");
  const built = state?.available ? state.built : null;
  // The build being shown already says when it was built, below.
  const showView = !(built && state?.available && state.latest?.id === built.id);

  return (
    <section
      id="pay-table"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden"
    >
      <header className="px-4 py-3 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Pay table</div>
            <div className="text-xs text-slate-500 mt-0.5 max-w-prose">
              What each person is paid, line by line as QBO&rsquo;s Run Payroll grid takes it. Built on the Mac from
              the timesheets, tips and solo closes; this page only shows it.
            </div>
          </div>
          <button
            type="button"
            onClick={onRebuild}
            disabled={busy || building || !state?.available}
            className="ml-auto rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 text-sm font-medium px-3 py-1.5 disabled:opacity-50"
          >
            {building ? "Building…" : "Rebuild pay table"}
          </button>
        </div>
        {showView && view.text && <div className={`text-xs mt-2 ${TONE[view.tone]}`}>{view.text}</div>}
        {state && !state.available && (
          <div className="text-xs text-amber-700 dark:text-amber-500 mt-2">
            Pay table not available yet: {state.reason}
          </div>
        )}
      </header>

      {built && <BuiltTable state={state as Extract<PaySheetState, { available: true }>} />}

      {state?.available && (
        <div
          className={`px-4 py-2 text-xs border-t border-slate-200 dark:border-slate-800 ${
            blocker ? "text-amber-700 dark:text-amber-500" : "text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {blocker ?? "The pay table is current: built after the last change to this period's punches, shifts and choices, with no open items."}
        </div>
      )}
    </section>
  );
}

function BuiltTable({ state }: { state: Extract<PaySheetState, { available: true }> }) {
  const built = state.built!;
  const sheet = built.sheet;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (person: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(person)) next.delete(person);
      else next.add(person);
      return next;
    });
  const unpriced = sheet.totals.wages_unpriced ?? [];
  const columns = QBO_COLUMNS.length + 3;

  return (
    <div>
      <div className="px-4 py-2 text-[11px] text-slate-500 break-words">
        Built {whenText(built.built_at ?? built.started_at)} from the data as of {whenText(built.started_at)} ·{" "}
        {sheet.window.start} → {sheet.window.end}, pay date {sheet.window.pay_date} · {built.built_by ?? "built on the Mac"} ·{" "}
        {state.builds} build{state.builds === 1 ? "" : "s"} kept · fingerprint {(built.source_fingerprint ?? "").slice(0, 10)}
      </div>
      {(sheet.sheet_version ?? 1) < SHEET_VERSION && (
        <div className="px-4 pb-2 text-xs text-amber-700 dark:text-amber-500">
          This build is from an older version of the sheet, without punches or wages. Rebuild it.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm tabular-nums">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-y border-slate-200 dark:border-slate-800">
              <th className="sticky left-0 z-10 bg-white dark:bg-slate-900 text-left font-medium px-3 py-2">Employee</th>
              {QBO_COLUMNS.map((c) => (
                <th key={c.key} className="text-right font-medium px-3 py-2 whitespace-nowrap">
                  {c.label}
                </th>
              ))}
              <th className="text-right font-medium px-3 py-2 whitespace-nowrap">Rate</th>
              <th className="text-right font-medium px-3 py-2 whitespace-nowrap">Wages</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {sheet.rows.map((row) => {
              const isOpen = open.has(row.person);
              return (
                <Fragment key={row.person}>
                  <tr className={isOpen ? "bg-slate-50 dark:bg-slate-800/40" : undefined}>
                    <td
                      className={`sticky left-0 z-10 px-3 py-2 ${
                        isOpen ? "bg-slate-50 dark:bg-slate-800" : "bg-white dark:bg-slate-900"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggle(row.person)}
                        aria-expanded={isOpen}
                        className="flex items-center gap-1.5 text-left text-slate-900 dark:text-slate-100 font-medium whitespace-nowrap"
                      >
                        <span className="text-slate-400 text-xs w-3">{isOpen ? "▾" : "▸"}</span>
                        {row.display}
                      </button>
                      {!row.qbo_employee_id && <div className="text-[11px] text-rose-600 ml-4">no QBO id</div>}
                    </td>
                    {QBO_COLUMNS.map((c) => (
                      <td key={c.key} className="text-right px-3 py-2 whitespace-nowrap text-slate-800 dark:text-slate-200">
                        {qboCell(row, c.key)}
                      </td>
                    ))}
                    <td className="text-right px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-400">{rateCell(row)}</td>
                    <td className="text-right px-3 py-2 whitespace-nowrap text-slate-900 dark:text-slate-100">{wagesCell(row)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50 dark:bg-slate-800/40">
                      <td colSpan={columns} className="px-3 pb-3 pt-0">
                        <RowEvidence row={row} sheet={sheet} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 dark:border-slate-700 font-semibold text-slate-900 dark:text-slate-100">
              <td className="sticky left-0 z-10 bg-white dark:bg-slate-900 px-3 py-2">Total</td>
              {QBO_COLUMNS.map((c) => (
                <td key={c.key} className="text-right px-3 py-2 whitespace-nowrap">
                  {qboTotal(sheet.totals, c.key)}
                </td>
              ))}
              <td />
              <td className="text-right px-3 py-2 whitespace-nowrap">{money(sheet.totals.wages_cents ?? null)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {unpriced.length > 0 && (
        <div className="px-4 pt-2 text-xs text-amber-700 dark:text-amber-500">
          Wages leave out {unpriced.join(", ")}: no hourly rate in Withers-time. Set it on the Team page, then rebuild.
        </div>
      )}

      <SoloNights sheet={sheet} />
      <Items sheet={sheet} />
    </div>
  );
}

/** Everything behind one row: punches, the two weeks, tips, solo closes. */
function RowEvidence({ row, sheet }: { row: SheetRow; sheet: PaySheetJson }) {
  const e = row.evidence;
  const weeks = sheet.window.weeks;
  return (
    <div className="sticky left-3 max-w-[calc(100vw-4rem)] sm:max-w-3xl space-y-3 text-xs text-slate-700 dark:text-slate-300 pt-2">
      <div>
        <div className="font-semibold text-slate-900 dark:text-slate-100">Hours</div>
        <div className="mt-0.5">
          {weeks.map(([from, to], i) => (
            <span key={from}>
              {i > 0 && " · "}
              Week {i + 1} ({dayText(from)}–{dayText(to)}): {hoursText(e.week_hours[i] ?? 0)}h
            </span>
          ))}
          . Overtime is hours over 40 in either Mon–Sun week, never across the two.
        </div>
        {!row.salaried && (
          <div className="mt-0.5">
            {rateCell(row)} · Regular {hoursText(row.regular_hours ?? row.hours_owed)}h + Overtime{" "}
            {hoursText(row.overtime_hours)}h at 1.5× = <span className="font-medium">{wagesCell(row)}</span>
          </div>
        )}
        {row.offcycle_hours > 0 && (
          <div className="mt-0.5">{hoursText(row.offcycle_hours)}h already paid off-cycle and not owed again.</div>
        )}
        {e.owner && <div className="mt-0.5">An owner: no wages, catering tips only.</div>}
      </div>

      <Punches row={row} />

      <div>
        <div className="font-semibold text-slate-900 dark:text-slate-100">Tips · {money(row.tips_cents)}</div>
        <ul className="mt-0.5 space-y-0.5">
          <li>
            In-store pool {money(row.pool_cents)} <span className="text-slate-500">({e.pool_rule})</span>
          </li>
          {e.catering_events.map((ev, i) => (
            <li key={`${ev.deal_id}-${i}`}>
              {ev.late ? "Late catering tip" : "Catering"} {money(ev.cents)} — {dayText(ev.event_date)} {ev.company ?? ""}
              {ev.deal_id != null && ` (deal ${ev.deal_id})`}
              {ev.late && ev.paid_on && `, paid ${ev.paid_on}`}
              {ev.crew_evidence && <span className="text-slate-500"> · {ev.crew_evidence}</span>}
            </li>
          ))}
          {e.catering_events.length === 0 && <li>Catering $0.00 — no event tips this period</li>}
          <li>
            Olo {money(row.olo_cents)}
            {row.olo_cents > 0 && ` over ${e.pastry_shifts_covered} Pastry Opener shift${e.pastry_shifts_covered === 1 ? "" : "s"}`}
          </li>
        </ul>
      </div>

      <div>
        <div className="font-semibold text-slate-900 dark:text-slate-100">Solo close · {money(row.solo_close_cents)}</div>
        <div className="mt-0.5">
          {e.solo_close_nights.length + e.solo_close_by_choice.length === 0
            ? "No solo-close nights earned."
            : [
                ...e.solo_close_nights.map(dayText),
                ...e.solo_close_by_choice.map((n) => `${dayText(n)} (by choice)`),
              ].join(", ")}
        </div>
      </div>

      {row.catering_hours > 0 && (
        <div>
          <div className="font-semibold text-slate-900 dark:text-slate-100">Catering hours · {hoursText(row.catering_hours)}h</div>
          <div className="mt-0.5">
            Premium hours {hoursText(row.premium_hours)}h → {money(row.premium_cents)}
            {row.premium_ot.map((l) => (
              <span key={l.week_start}>
                {" "}
                · premium OT {l.week_start}–{l.week_end}: {money(l.cents)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Punches({ row }: { row: SheetRow }) {
  const punches = row.evidence.punches;
  if (!punches)
    return <div className="text-slate-500">Punches {row.evidence.punch_ids.join(", ") || "none"} (rebuild for details).</div>;
  return (
    <div>
      <div className="font-semibold text-slate-900 dark:text-slate-100">Punches · {punches.length}</div>
      {punches.length === 0 ? (
        <div className="mt-0.5 text-slate-500">No punches in the period.</div>
      ) : (
        <div className="overflow-x-auto mt-1">
          <table className="text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                <th className="text-left font-medium pr-3 py-0.5">Date</th>
                <th className="text-left font-medium pr-3 py-0.5">In</th>
                <th className="text-left font-medium pr-3 py-0.5">Out</th>
                <th className="text-right font-medium pr-3 py-0.5">Hours</th>
                <th className="text-left font-medium py-0.5">Shift</th>
              </tr>
            </thead>
            <tbody>
              {punches.map((p) => {
                const cut = p.clock_out == null || p.paid_to !== p.clock_out;
                return (
                  <tr key={p.id} className="align-top">
                    <td className="pr-3 py-0.5 whitespace-nowrap">{dayText(p.date)}</td>
                    <td className="pr-3 py-0.5 whitespace-nowrap">{fmtTime(p.clock_in)}</td>
                    <td className="pr-3 py-0.5 whitespace-nowrap">
                      {p.clock_out ? fmtTime(p.clock_out) : <span className="text-rose-600">open</span>}
                      {cut && <span className="text-amber-700 dark:text-amber-500"> · paid to {fmtTime(p.paid_to)}</span>}
                    </td>
                    <td className="text-right pr-3 py-0.5">{hoursText(p.hours)}</td>
                    <td className="py-0.5 whitespace-nowrap">
                      {p.shift ? `${p.shift.position} ${fmtTime(p.shift.starts_at)}–${fmtTime(p.shift.ends_at)}` : "no shift"}
                      <span className="text-slate-400"> · punch {p.id}{p.manual ? ", manual" : ""}</span>
                      {p.anomalies.length > 0 && (
                        <div className="text-amber-700 dark:text-amber-500 whitespace-normal">{p.anomalies.join("; ")}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SoloNights({ sheet }: { sheet: PaySheetJson }) {
  return (
    <div className="px-4 pt-4">
      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Solo-close nights</div>
      <div className="text-xs text-slate-500 mt-0.5 max-w-prose">
        Every night with an in-store close: who closed, when they clocked out, how long they were alone, and whether the
        $30 was paid.
      </div>
      {sheet.solo_close_nights.length === 0 ? (
        <div className="text-xs text-slate-500 mt-2">No in-store close inside the period.</div>
      ) : (
        <div className="overflow-x-auto mt-2">
          <table className="min-w-full text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left font-medium pr-3 py-1">Night</th>
                <th className="text-left font-medium pr-3 py-1">Closer</th>
                <th className="text-left font-medium pr-3 py-1">Out</th>
                <th className="text-right font-medium pr-3 py-1">Solo tail</th>
                <th className="text-right font-medium pr-3 py-1">Paid</th>
                <th className="text-left font-medium py-1">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {sheet.solo_close_nights.map((n) => (
                <tr key={n.night} className="align-top text-slate-700 dark:text-slate-300">
                  <td className="pr-3 py-1 whitespace-nowrap">{dayText(n.night)}</td>
                  <td className="pr-3 py-1 whitespace-nowrap">{n.display ?? n.person}</td>
                  <td className="pr-3 py-1 whitespace-nowrap">{fmtTime(n.closed_at)}</td>
                  <td className="text-right pr-3 py-1">{hoursText(n.tail_hours)}h</td>
                  <td className="text-right pr-3 py-1">{n.awarded ? money(n.cents) : "—"}</td>
                  <td className="py-1 min-w-[12rem]">{n.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Items({ sheet }: { sheet: PaySheetJson }) {
  return (
    <div className="px-4 py-4 grid gap-3 sm:grid-cols-2 text-xs">
      <div>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Open items · {sheet.open_items.length}
        </div>
        {sheet.open_items.length === 0 ? (
          <div className="text-slate-500 mt-1">None. Every cell is computed by rule or by a recorded choice.</div>
        ) : (
          <ul className="mt-1 space-y-1">
            {sheet.open_items.map((item, i) => (
              <li key={i} className="text-rose-600 dark:text-rose-400">
                <span className="font-medium">{item.clause}</span> {item.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Flags · {sheet.flags.length}</div>
        {sheet.flags.length === 0 ? (
          <div className="text-slate-500 mt-1">None. No manager is paid by a choice they made.</div>
        ) : (
          <ul className="mt-1 space-y-1">
            {sheet.flags.map((item, i) => (
              <li key={i} className="text-amber-700 dark:text-amber-500">
                ⚑ <span className="font-medium">{item.clause}</span> {item.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
