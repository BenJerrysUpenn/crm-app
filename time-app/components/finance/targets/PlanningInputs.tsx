"use client";

// The Labor Hours Planning inputs on the Targets tab (bj-finance #742, owner
// ruling 2026-10-19), below the control board and in its idioms: rows with a
// review-by chip, clicked open to see where a value came from and its
// history, and changed with an as-of date and notes.
//
//   Store-hours seasons   the store's hours from a first day on. Owners.
//   Concession events     events at outside venues, with expected net sales.
//                         A change is a new dated revision. Owners.
//   Crew events           dated events with crew hours (Free Cone Day). The
//                         same. Owners.
//   Closed days           store_hours_exceptions, which the Team page edits
//                         too. Managers. Thanksgiving, Christmas Day and New
//                         Year's Day have quick-add buttons.
//
// The rules are lib/controlBoard/planningInputs.ts. On the local preview
// (bj-finance #742) the same editor saves to a local file instead.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { money, shortDate } from "@/lib/controlBoard/format";
import { addMonthsTo } from "@/lib/controlBoard/settings";
import {
  eventList,
  quickHolidays,
  seasonInForce,
  seasonsFrom,
  seasonWords,
  type ConcessionEventRow,
  type CrewEventRow,
  type EventEntry,
  type InputAction,
  type Season,
} from "@/lib/controlBoard/planningInputs";
import type { PlanningInputsData } from "@/lib/controlBoard/planningInputsLoad";
import { WEEKDAY_NAMES, fmtStoreTime, toTimeInput } from "@/lib/storeHours";
import ReviewChip from "./ReviewChip";

const LIVE = "/api/payroll/targets";
/** The local preview's one door: it writes the preview's own file, never the database. */
export const PREVIEW_INPUTS_API = "/api/dev/labor-planning-inputs";

function request(a: InputAction, preview: boolean): [string, RequestInit] {
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (preview) return [PREVIEW_INPUTS_API, json("POST", a)];
  switch (a.kind) {
    case "season": return [`${LIVE}/seasons`, json("POST", a.body)];
    case "season_remove": return [`${LIVE}/seasons?from=${a.from}`, { method: "DELETE" }];
    case "concession": return [`${LIVE}/concession-events`, json("POST", a.body)];
    case "crew": return [`${LIVE}/crew-events`, json("POST", a.body)];
    case "closed_day": return [`${LIVE}/closed-days`, json("POST", { ...a.body, is_closed: true })];
    case "closed_day_remove": return [`${LIVE}/closed-days/${a.date}`, { method: "DELETE" }];
  }
}

/** Send one change; null when it was saved, else why not. */
type Send = (a: InputAction) => Promise<string | null>;

type Props = {
  data: PlanningInputsData;
  today: string;
  viewerIsOwner: boolean;
  /** The local preview: saves go to its file; these live closed days are shown but not changed. */
  preview?: { liveClosedDays: string[] };
};

export default function PlanningInputs({ data, today, viewerIsOwner, preview }: Props) {
  const router = useRouter();
  const send: Send = async (a) => {
    const [url, init] = request(a, !!preview);
    const res = await fetch(url, init);
    if (res.ok) {
      router.refresh();
      return null;
    }
    const body = await res.json().catch(() => ({}));
    return body.error ?? `Save failed (${res.status}).`;
  };

  return (
    <section className="mt-8" aria-labelledby="planning-inputs">
      <h2 id="planning-inputs" className="text-lg font-semibold text-slate-900 dark:text-slate-100">Labor planning inputs</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 max-w-3xl">
        What the Labor Hours Planning card reads besides the board: the store&rsquo;s hours by season, events at outside venues, crew events and closed days. Click a line to see where it came from and its history.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {viewerIsOwner
          ? "Owners change seasons and events. Any manager can close a day."
          : "Seasons and events are view only: owners change them. You can close a day."}
      </p>
      {preview && (
        <p role="note" className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Preview: not saved to the app. Changes here go to the local inputs file, and the chart above reads them from there.
        </p>
      )}
      {data.problems.map((p) => (
        <div key={p} className="mt-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{p}</div>
      ))}

      <div className="mt-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        {data.unavailable ? (
          <Block title="Seasons and events" intro="">
            <p className="px-3 py-3 text-sm text-slate-600 dark:text-slate-400">Not available yet: {data.unavailable}</p>
          </Block>
        ) : (
          <>
            <Seasons rows={data.seasons} today={today} owner={viewerIsOwner} send={send} />
            <Concessions rows={data.concession} today={today} owner={viewerIsOwner} send={send} />
            <Crew rows={data.crew} today={today} owner={viewerIsOwner} send={send} />
          </>
        )}
        <ClosedDays data={data} today={today} send={send} liveOnly={preview?.liveClosedDays ?? null} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const inputCls = "w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-sm text-slate-900 dark:text-slate-100";
const smallBtn = "whitespace-nowrap rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";
const saveBtn = "rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50";

function Block({ title, intro, action, children }: { title: string; intro: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="bg-slate-50 dark:bg-slate-800/40 px-3 pt-3 pb-2 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[11px] uppercase tracking-wide font-semibold text-slate-600 dark:text-slate-300">{title}</h3>
          {intro && <p className="mt-0.5 text-xs text-slate-500">{intro}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One line: what it is, its value in words, its review-by chip. Clicking it opens it below. */
function Line({ label, value, tags, reviewBy, today, open, onToggle }: {
  label: string; value: string; tags?: React.ReactNode; reviewBy: string | null; today: string; open: boolean; onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 py-2 border-b border-slate-100 dark:border-slate-800/70 text-sm cursor-pointer md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_6.5rem] md:items-center ${open ? "bg-sky-50 dark:bg-sky-950/30" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}`}
    >
      <div className="min-w-0 text-slate-800 dark:text-slate-200">
        <button type="button" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle(); }} className="text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded-sm">
          {label}
        </button>
        {tags && <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">{tags}</span>}
      </div>
      <div className="order-3 col-span-2 md:order-none md:col-span-1 min-w-0 text-xs text-slate-600 dark:text-slate-400 break-words">{value}</div>
      <div className="order-2 md:order-none text-right">
        {reviewBy ? <ReviewChip reviewBy={reviewBy} today={today} compact /> : <span className="text-[11px] text-slate-400">No review date</span>}
      </div>
    </div>
  );
}

const Tag = ({ tone, children }: { tone: "green" | "sky" | "amber" | "slate"; children: React.ReactNode }) => {
  const cls = {
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
    sky: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
    slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap ${cls}`}>{children}</span>;
};

/** The panel under an open line. */
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 px-3 py-3 text-xs">{children}</div>;
}

function Notes({ row }: { row: { review_by: string | null; source: string | null; method: string | null } }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2 text-sm">
      <div>
        <dt className="text-[11px] text-slate-500">Where it came from</dt>
        <dd className="text-slate-800 dark:text-slate-200 break-words">{row.source || "Not written down."}</dd>
      </div>
      <div>
        <dt className="text-[11px] text-slate-500">How it was worked out</dt>
        <dd className="text-slate-800 dark:text-slate-200 break-words">{row.method || "Not written down."}</dd>
      </div>
    </dl>
  );
}

type NoteDraft = { review_by: string; source: string; method: string };

const defaultReviewBy = (row: { review_by: string | null } | null, today: string) =>
  row?.review_by && row.review_by > today ? row.review_by : addMonthsTo(today, 12);
const noteDraft = (row: { review_by: string | null; source: string | null; method: string | null } | null, today: string): NoteDraft => ({
  review_by: defaultReviewBy(row, today), source: row?.source ?? "", method: row?.method ?? "",
});

function NoteFields({ v, set }: { v: NoteDraft; set: (v: NoteDraft) => void }) {
  return (
    <>
      <Field label="Review by"><input type="date" value={v.review_by} onChange={(e) => set({ ...v, review_by: e.target.value })} className={inputCls} /></Field>
      <Field label="Where it came from" wide><textarea rows={2} value={v.source} onChange={(e) => set({ ...v, source: e.target.value })} className={inputCls} /></Field>
      <Field label="How it was worked out (so it can be redone next year)" wide><textarea rows={2} value={v.method} onChange={(e) => set({ ...v, method: e.target.value })} className={inputCls} /></Field>
    </>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-0.5 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-slate-500">{label}</span>
      {children}
    </label>
  );
}

/** Save and cancel, with the reason a save failed. */
function useSave(send: Send, done: () => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run(a: InputAction) {
    setErr(null);
    setBusy(true);
    const why = await send(a);
    setBusy(false);
    if (why) setErr(why);
    else done();
  }
  return { busy, err, run };
}

function FormButtons({ busy, err, onSave, onCancel, extra }: { busy: boolean; err: string | null; onSave: () => void; onCancel: () => void; extra?: React.ReactNode }) {
  return (
    <>
      {err && <p className="mt-2 text-rose-600 dark:text-rose-400">{err}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onSave} disabled={busy} className={saveBtn}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel} className={smallBtn}>Cancel</button>
        {extra}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Store-hours seasons
// ---------------------------------------------------------------------------

function Seasons({ rows, today, owner, send }: { rows: Parameters<typeof seasonsFrom>[0]; today: string; owner: boolean; send: Send }) {
  const seasons = useMemo(() => seasonsFrom(rows), [rows]);
  const now = seasonInForce(seasons, today);
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  return (
    <Block
      title="Store-hours seasons"
      intro={`From its first day, a season's hours replace the weekly hours on the Team page until the next season starts. ${now ? `In force today: ${now.name}, ${seasonWords(now)}.` : "No season is in force today: the weekly hours apply."}`}
      action={owner && <button type="button" onClick={() => toggle("new")} className={smallBtn}>Add a season</button>}
    >
      {open === "new" && (
        <Panel><SeasonForm season={null} today={today} send={send} onDone={() => setOpen(null)} /></Panel>
      )}
      {seasons.length === 0 && <div className="px-3 py-3 text-sm text-slate-500">No seasons yet.</div>}
      {seasons.map((s) => (
        <div key={s.effective_from}>
          <Line
            label={`${s.name}, from ${shortDate(s.effective_from)}`}
            value={seasonWords(s)}
            tags={s === now ? <Tag tone="green">in force today</Tag> : s.effective_from > today ? <Tag tone="sky">coming</Tag> : <Tag tone="slate">ended</Tag>}
            reviewBy={s.review_by}
            today={today}
            open={open === s.effective_from}
            onToggle={() => toggle(s.effective_from)}
          />
          {open === s.effective_from && (
            <Panel>
              {owner ? <SeasonForm season={s} today={today} send={send} onDone={() => setOpen(null)} /> : <Notes row={s} />}
            </Panel>
          )}
        </div>
      ))}
    </Block>
  );
}

function SeasonForm({ season, today, send, onDone }: { season: Season | null; today: string; send: Send; onDone: () => void }) {
  const [name, setName] = useState(season?.name ?? "");
  const [from, setFrom] = useState(season?.effective_from ?? today);
  const [opens, setOpens] = useState(toTimeInput(season?.opens));
  const [closes, setCloses] = useState(toTimeInput(season?.closes));
  const [closed, setClosed] = useState<number[]>(season?.closedWeekdays ?? []);
  const [note, setNote] = useState(noteDraft(season, today));
  const { busy, err, run } = useSave(send, onDone);
  const allClosed = closed.length === 7;
  return (
    <div>
      {season?.mixed && (
        <p className="mb-2 text-amber-700 dark:text-amber-400">This season&rsquo;s open days do not all keep the same hours. Saving here gives every open day the hours below.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Winter" className={inputCls} /></Field>
        <Field label="Starts on">
          <input type="date" value={from} disabled={!!season} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} disabled:opacity-60`} />
        </Field>
        <Field label="Opens"><input type="time" value={opens} disabled={allClosed} onChange={(e) => setOpens(e.target.value)} className={inputCls} /></Field>
        <Field label="Closes"><input type="time" value={closes} disabled={allClosed} onChange={(e) => setCloses(e.target.value)} className={inputCls} /></Field>
        <fieldset className="sm:col-span-2">
          <legend className="text-slate-500">Closed all day on</legend>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {WEEKDAY_NAMES.map((d, i) => (
              <label key={d} className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300">
                <input type="checkbox" checked={closed.includes(i)} onChange={(e) => setClosed((c) => (e.target.checked ? [...c, i].sort() : c.filter((x) => x !== i)))} />
                {d.slice(0, 3)}
              </label>
            ))}
          </div>
        </fieldset>
        <NoteFields v={note} set={setNote} />
      </div>
      {season && <p className="mt-2 text-slate-500">To move a season to another date, add a season on the new date and remove this one.</p>}
      <FormButtons
        busy={busy}
        err={err}
        onCancel={onDone}
        onSave={() => run({ kind: "season", body: { name, effective_from: from, opens, closes, closed_weekdays: closed, ...note } })}
        extra={season && (
          <button
            type="button"
            disabled={busy}
            onClick={() => window.confirm(`Remove the ${season.name} season from ${shortDate(season.effective_from)}?`) && run({ kind: "season_remove", from: season.effective_from })}
            className={`${smallBtn} ml-auto text-rose-700 dark:text-rose-400`}
          >
            Remove season
          </button>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concession events and crew events
// ---------------------------------------------------------------------------

type Revision = { id: number; effective_from: string; source: string; cancelled: boolean };

function History<T extends Revision>({ entry, today, words }: { entry: EventEntry<T>; today: string; words: (r: T) => string }) {
  return (
    <>
      <div className="mt-3 text-[11px] uppercase tracking-wide text-slate-500 mb-2">History</div>
      <ol className="relative ml-1 space-y-3 border-l-2 border-slate-200 dark:border-slate-700">
        {entry.history.map((h, i) => {
          const now = entry.inForce && h.id === entry.current.id;
          const future = h.effective_from > today;
          const corrected = !now && !future && entry.history.some((o, j) => j < i && o.effective_from === h.effective_from);
          return (
            <li key={h.id} className="relative pl-4">
              <span className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full ${now ? "bg-emerald-500" : future ? "bg-sky-400" : "bg-slate-300 dark:bg-slate-600"}`} />
              <div className="text-xs text-slate-500">
                {shortDate(h.effective_from)}
                {now ? " · in force now" : future ? " · not in force yet" : corrected ? " · corrected the same day" : ""}
              </div>
              <div className={`font-mono text-sm ${now ? "" : "text-slate-600 dark:text-slate-400"}`}>{h.cancelled ? `Taken off. ${words(h)}` : words(h)}</div>
              <div className="text-xs text-slate-500 break-words">{h.source}</div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function eventTags(e: EventEntry<{ cancelled: boolean; effective_from: string }>, extra?: React.ReactNode) {
  return (
    <>
      {e.current.cancelled && <Tag tone="slate">taken off</Tag>}
      {!e.inForce && <Tag tone="sky">from {shortDate(e.current.effective_from)}</Tag>}
      {extra}
    </>
  );
}

function span(start: string, end: string): string {
  return start === end ? shortDate(start) : `${shortDate(start)} to ${shortDate(end)}`;
}
const concessionWords = (e: ConcessionEventRow) =>
  `${span(e.start_date, e.end_date)}, ${money(Number(e.expected_net_sales))} expected net sales${e.provisional ? ", provisional" : ""}`;
const crewWords = (e: CrewEventRow) => `${shortDate(e.day)}, ${Number(e.crew_hours).toLocaleString("en-US")} crew hours`;

function Concessions({ rows, today, owner, send }: { rows: ConcessionEventRow[]; today: string; owner: boolean; send: Send }) {
  const list = useMemo(() => eventList(rows, today), [rows, today]);
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  return (
    <Block
      title="Concession events"
      intro="Events at outside venues. Their expected net sales are spread evenly over the event's days and add affordable hours. A change adds a dated revision; the old one stays in the history."
      action={owner && <button type="button" onClick={() => toggle("new")} className={smallBtn}>Add an event</button>}
    >
      {open === "new" && <Panel><ConcessionForm entry={null} today={today} send={send} onDone={() => setOpen(null)} /></Panel>}
      {list.length === 0 && <div className="px-3 py-3 text-sm text-slate-500">No concession events yet.</div>}
      {list.map((e) => (
        <div key={e.key}>
          <Line
            label={e.current.name}
            value={concessionWords(e.current)}
            tags={eventTags(e, e.current.provisional && !e.current.cancelled ? <Tag tone="amber">provisional</Tag> : null)}
            reviewBy={e.current.review_by}
            today={today}
            open={open === e.key}
            onToggle={() => toggle(e.key)}
          />
          {open === e.key && (
            <Panel>
              {owner ? <ConcessionForm entry={e} today={today} send={send} onDone={() => setOpen(null)} /> : <Notes row={e.current} />}
              <History entry={e} today={today} words={concessionWords} />
            </Panel>
          )}
        </div>
      ))}
    </Block>
  );
}

function RevisionFields({ asOf, setAsOf, cancelled, setCancelled, existing }: {
  asOf: string; setAsOf: (v: string) => void; cancelled: boolean; setCancelled: (v: boolean) => void; existing: boolean;
}) {
  return (
    <>
      <Field label="In force from (as of)"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={inputCls} /></Field>
      {existing && (
        <label className="flex items-center gap-1.5 self-end text-slate-700 dark:text-slate-300">
          <input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} />
          Taken off (not happening)
        </label>
      )}
    </>
  );
}

function ConcessionForm({ entry, today, send, onDone }: { entry: EventEntry<ConcessionEventRow> | null; today: string; send: Send; onDone: () => void }) {
  const c = entry?.current;
  const [name, setName] = useState(c?.name ?? "");
  const [start, setStart] = useState(c?.start_date ?? "");
  const [end, setEnd] = useState(c?.end_date ?? "");
  const [sales, setSales] = useState(c ? String(c.expected_net_sales) : "");
  const [provisional, setProvisional] = useState(c?.provisional ?? false);
  const [cancelled, setCancelled] = useState(c?.cancelled ?? false);
  const [asOf, setAsOf] = useState(today);
  const [note, setNote] = useState(noteDraft(c ?? null, today));
  const { busy, err, run } = useSave(send, onDone);
  return (
    <div>
      <div className="mb-2 text-slate-500">{entry ? "Change it (adds a revision)" : "New event"}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name" wide><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
        <Field label="First day"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} /></Field>
        <Field label="Last day"><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} /></Field>
        <Field label="Expected net sales ($)"><input inputMode="decimal" value={sales} onChange={(e) => setSales(e.target.value)} className={`${inputCls} font-mono`} /></Field>
        <label className="flex items-center gap-1.5 self-end text-slate-700 dark:text-slate-300">
          <input type="checkbox" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} />
          Provisional (still to confirm)
        </label>
        <RevisionFields asOf={asOf} setAsOf={setAsOf} cancelled={cancelled} setCancelled={setCancelled} existing={!!entry} />
        <NoteFields v={note} set={setNote} />
      </div>
      <FormButtons
        busy={busy}
        err={err}
        onCancel={onDone}
        onSave={() => run({
          kind: "concession",
          body: { event_key: entry?.key, name, start_date: start, end_date: end, expected_net_sales: sales, provisional, cancelled, effective_from: asOf, ...note },
        })}
      />
    </div>
  );
}

function Crew({ rows, today, owner, send }: { rows: CrewEventRow[]; today: string; owner: boolean; send: Send }) {
  const list = useMemo(() => eventList(rows, today), [rows, today]);
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  return (
    <Block
      title="Crew events"
      intro="Dated events with crew hours, like Free Cone Day. Their hours count in the estimated catering band. A change adds a dated revision."
      action={owner && <button type="button" onClick={() => toggle("new")} className={smallBtn}>Add an event</button>}
    >
      {open === "new" && <Panel><CrewForm entry={null} today={today} send={send} onDone={() => setOpen(null)} /></Panel>}
      {list.length === 0 && <div className="px-3 py-3 text-sm text-slate-500">No crew events yet.</div>}
      {list.map((e) => (
        <div key={e.key}>
          <Line
            label={e.current.name}
            value={crewWords(e.current)}
            tags={eventTags(e)}
            reviewBy={e.current.review_by}
            today={today}
            open={open === e.key}
            onToggle={() => toggle(e.key)}
          />
          {open === e.key && (
            <Panel>
              {owner ? <CrewForm entry={e} today={today} send={send} onDone={() => setOpen(null)} /> : <Notes row={e.current} />}
              <History entry={e} today={today} words={crewWords} />
            </Panel>
          )}
        </div>
      ))}
    </Block>
  );
}

function CrewForm({ entry, today, send, onDone }: { entry: EventEntry<CrewEventRow> | null; today: string; send: Send; onDone: () => void }) {
  const c = entry?.current;
  const [name, setName] = useState(c?.name ?? "");
  const [day, setDay] = useState(c?.day ?? "");
  const [hours, setHours] = useState(c ? String(c.crew_hours) : "");
  const [cancelled, setCancelled] = useState(c?.cancelled ?? false);
  const [asOf, setAsOf] = useState(today);
  const [note, setNote] = useState(noteDraft(c ?? null, today));
  const { busy, err, run } = useSave(send, onDone);
  return (
    <div>
      <div className="mb-2 text-slate-500">{entry ? "Change it (adds a revision)" : "New event"}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name" wide><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Free Cone Day" className={inputCls} /></Field>
        <Field label="Day"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={inputCls} /></Field>
        <Field label="Crew hours"><input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} className={`${inputCls} font-mono`} /></Field>
        <RevisionFields asOf={asOf} setAsOf={setAsOf} cancelled={cancelled} setCancelled={setCancelled} existing={!!entry} />
        <NoteFields v={note} set={setNote} />
      </div>
      <FormButtons
        busy={busy}
        err={err}
        onCancel={onDone}
        onSave={() => run({ kind: "crew", body: { event_key: entry?.key, name, day, crew_hours: hours, cancelled, effective_from: asOf, ...note } })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Closed days
// ---------------------------------------------------------------------------

function dayWords(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function ClosedDays({ data, today, send, liveOnly }: { data: PlanningInputsData; today: string; send: Send; liveOnly: string[] | null }) {
  const holidays = quickHolidays(today, data.exceptions);
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(key: string, a: InputAction) {
    setErr(null);
    setBusy(key);
    const why = await send(a);
    setBusy(null);
    if (why) setErr(why);
    else if (key === "add") { setDate(""); setLabel(""); }
  }
  return (
    <Block
      title="Closed days"
      intro="Days the store is closed: the card projects no sales and no coverage on them. The same list as Holidays and special days on the Team page, where special hours are set too."
    >
      <div className="px-3 py-3 border-b border-slate-100 dark:border-slate-800/70 flex flex-wrap gap-2">
        {holidays.map((h) =>
          h.added ? (
            <span key={h.name} className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              <span aria-hidden>✓</span> {h.name}, {dayWords(h.date)}: added
            </span>
          ) : (
            <button
              key={h.name}
              type="button"
              disabled={busy != null}
              onClick={() => go(h.name, { kind: "closed_day", body: { date: h.date, label: h.name } })}
              className="rounded-full border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {busy === h.name ? "Adding…" : `+ Close ${h.name}, ${dayWords(h.date)}`}
            </button>
          ),
        )}
      </div>
      {data.exceptions.length === 0 && <div className="px-3 py-3 text-sm text-slate-500">No closed days or special hours from today on.</div>}
      <ul>
        {data.exceptions.map((e) => {
          const live = liveOnly?.includes(e.date) ?? false;
          return (
            <li key={e.date} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-b border-slate-100 dark:border-slate-800/70 text-sm">
              <span className="w-32 shrink-0 text-slate-800 dark:text-slate-200">{dayWords(e.date)}</span>
              <span className="min-w-0 flex-1 text-slate-600 dark:text-slate-400">
                {e.label || "No label"}
                {" · "}
                {e.is_closed ? "Closed" : `Special hours ${fmtStoreTime(e.opens)} to ${fmtStoreTime(e.closes)}`}
              </span>
              {live ? (
                <Tag tone="slate">live, not changed in the preview</Tag>
              ) : (
                <button
                  type="button"
                  disabled={busy != null}
                  onClick={() => window.confirm(`Open ${dayWords(e.date)} again with its normal hours?`) && go(e.date, { kind: "closed_day_remove", date: e.date })}
                  className={smallBtn}
                >
                  {busy === e.date ? "Removing…" : "Remove"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="px-3 py-3 flex flex-wrap items-end gap-2 text-xs">
        <Field label="Date"><input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Field>
        <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Snow day" className={inputCls} /></Field>
        <button type="button" disabled={!date || busy != null} onClick={() => go("add", { kind: "closed_day", body: { date, label } })} className={saveBtn}>
          {busy === "add" ? "Adding…" : "Close this day"}
        </button>
      </div>
      {err && <p className="px-3 pb-3 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
    </Block>
  );
}

