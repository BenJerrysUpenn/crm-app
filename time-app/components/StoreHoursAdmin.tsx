"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { StoreHours, StoreHoursException } from "@/lib/types";
import type { Holiday } from "@/lib/holidays";
import {
  WEEKDAY_NAMES,
  describeDay,
  toTimeInput,
  weekdaysWithoutHours,
} from "@/lib/storeHours";

// A calendar date rendered in the store's timezone. Noon UTC keeps the date
// from sliding backwards in Eastern time, and the explicit timeZone keeps the
// server and the browser rendering the same string.
function dateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type DayDraft = { weekday: number; is_closed: boolean; opens: string; closes: string };

// The store's opening hours: the normal week, plus one-off closures and
// special hours for individual dates. Drives the coverage check on publish.
// Mounted from TeamAdmin; kept in its own file so the Team page's admin
// sections stay separable, the same way ClockinRemindersAdmin is.
export default function StoreHoursAdmin({
  hours,
  exceptions,
  holidays,
  ready,
}: {
  hours: StoreHours[];
  exceptions: StoreHoursException[];
  holidays: Holiday[];
  ready: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const byDate = new Map(exceptions.map((e) => [e.date, e]));
  const holidayDates = new Set(holidays.map((h) => h.date));
  // Dates the manager added by hand rather than picking off the holiday list.
  const otherDates = exceptions.filter((e) => !holidayDates.has(e.date));
  const unsetWeekdays = weekdaysWithoutHours(hours);

  async function call(url: string, init: RequestInit, okMsg: string): Promise<boolean> {
    setBusy(true);
    setErr(null);
    setMsg(null);
    // finally, not a plain call after the await: if the request throws (phone
    // drops off wifi mid-save, which is the normal case here) every button in
    // the section would otherwise stay disabled until the page is reloaded.
    try {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? `Failed (${res.status}).`);
        return false;
      }
      setMsg(okMsg);
      router.refresh();
      return true;
    } catch {
      setErr("Couldn't reach the server. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const json = (payload: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  async function saveWeek(days: DayDraft[]) {
    await call(
      "/api/store-hours",
      {
        ...json({
          days: days.map((d) => ({
            weekday: d.weekday,
            is_closed: d.is_closed,
            opens: d.is_closed ? null : d.opens,
            closes: d.is_closed ? null : d.closes,
          })),
        }),
        method: "PUT",
      },
      "Store hours saved.",
    );
  }

  async function closeDate(date: string, label: string | null) {
    await call(
      "/api/store-hours/exceptions",
      json({ date, label, is_closed: true }),
      `Closed on ${dateLabel(date)}. Nothing else changed.`,
    );
  }

  async function specialHours(date: string, label: string | null, opens: string, closes: string) {
    await call(
      "/api/store-hours/exceptions",
      json({ date, label, is_closed: false, opens, closes }),
      `Special hours set for ${dateLabel(date)}. Nothing else changed.`,
    );
  }

  async function clearDate(date: string) {
    await call(
      `/api/store-hours/exceptions/${date}`,
      { method: "DELETE" },
      `${dateLabel(date)} is back to its normal hours.`,
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Store hours</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
        When the store is open to customers. Publishing a week checks that in-store shifts cover
        every one of these hours, so nobody is left scheduled off the floor while the doors are
        open. A day marked <span className="font-medium">Business closed</span> by a note on the
        schedule board counts as closed too, so it isn&rsquo;t checked.
      </p>

      {!ready ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <div className="text-sm rounded border border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2">
            <span className="font-medium">Run migration 24.</span> The store hours tables
            aren&rsquo;t in the database yet. Apply{" "}
            <code className="font-mono text-xs">supabase/migration_24.sql</code> in the Supabase SQL
            editor, then reload this page.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {(err || msg) && (
            <div className={`text-sm ${err ? "text-rose-500" : "text-emerald-500"}`}>
              {err ?? msg}
            </div>
          )}

          <WeeklyHoursEditor
            hours={hours}
            busy={busy}
            unsetWeekdays={unsetWeekdays}
            onSave={saveWeek}
          />

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Holidays &amp; special days
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 mb-3">
              The store stays open on holidays with its normal hours unless you close one here.
              Closing a date changes that date only — the rest of the week, and every other year,
              are untouched.
            </p>

            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {holidays.map((h) => (
                <StoreDateRow
                  key={h.date}
                  date={h.date}
                  name={h.name}
                  exception={byDate.get(h.date)}
                  status={describeDay(hours, byDate.get(h.date), new Date(`${h.date}T12:00:00Z`).getUTCDay())}
                  busy={busy}
                  onClose={() => closeDate(h.date, h.name)}
                  onSpecial={(o, c) => specialHours(h.date, h.name, o, c)}
                  onClear={() => clearDate(h.date)}
                />
              ))}
              {holidays.length === 0 && (
                <div className="text-xs text-slate-500 py-2">
                  No holidays in the next six months.
                </div>
              )}
            </div>

            {otherDates.length > 0 && (
              <div className="mt-5">
                <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Other dates you&rsquo;ve set
                </h4>
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {otherDates.map((e) => (
                    <StoreDateRow
                      key={e.date}
                      date={e.date}
                      name={e.label || "One-off"}
                      exception={e}
                      status={describeDay(hours, e, new Date(`${e.date}T12:00:00Z`).getUTCDay())}
                      busy={busy}
                      onClose={() => closeDate(e.date, e.label)}
                      onSpecial={(o, c) => specialHours(e.date, e.label, o, c)}
                      onClear={() => clearDate(e.date)}
                    />
                  ))}
                </div>
              </div>
            )}

            <AddDateForm busy={busy} onClose={closeDate} onSpecial={specialHours} />
          </div>
        </div>
      )}
    </section>
  );
}

// Seven rows, Sunday first, to match the schedule board's week. Saved as one
// block so a half-filled week can never reach the database.
function WeeklyHoursEditor({
  hours,
  busy,
  unsetWeekdays,
  onSave,
}: {
  hours: StoreHours[];
  busy: boolean;
  unsetWeekdays: number[];
  onSave: (days: DayDraft[]) => void;
}) {
  const [days, setDays] = useState<DayDraft[]>(() =>
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
      const row = hours.find((h) => h.weekday === weekday);
      return {
        weekday,
        is_closed: row?.is_closed ?? false,
        opens: toTimeInput(row?.opens) || "11:00",
        closes: toTimeInput(row?.closes) || "23:00",
      };
    }),
  );

  function set(weekday: number, patch: Partial<DayDraft>) {
    setDays((prev) => prev.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Normal week
      </h3>
      {unsetWeekdays.length === 7 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">
          No hours set yet. Until you set them and save, publishing a week doesn&rsquo;t check
          store coverage.
        </p>
      ) : unsetWeekdays.length > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">
          Not set yet: {unsetWeekdays.map((d) => WEEKDAY_NAMES[d]).join(", ")}. Coverage
          isn&rsquo;t checked on those days until you save.
        </p>
      ) : (
        <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">
          These hours repeat every week. Use the list below for a one-off.
        </p>
      )}

      <div className="space-y-2">
        {days.map((d) => (
          <div key={d.weekday} className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-sm text-slate-900 dark:text-slate-100">
              {WEEKDAY_NAMES[d.weekday]}
            </span>
            <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 select-none w-20">
              <input
                type="checkbox"
                checked={d.is_closed}
                onChange={(e) => set(d.weekday, { is_closed: e.target.checked })}
              />
              Closed
            </label>
            <input
              type="time"
              value={d.opens}
              disabled={d.is_closed}
              onChange={(e) => set(d.weekday, { opens: e.target.value })}
              className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-slate-900 dark:text-slate-100 text-xs disabled:opacity-40"
            />
            <span className="text-xs text-slate-500">to</span>
            <input
              type="time"
              value={d.closes}
              disabled={d.is_closed}
              onChange={(e) => set(d.weekday, { closes: e.target.value })}
              className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-slate-900 dark:text-slate-100 text-xs disabled:opacity-40"
            />
          </div>
        ))}
      </div>

      <div className="mt-4">
        <button
          onClick={() => onSave(days)}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save store hours"}
        </button>
      </div>
    </div>
  );
}

// One date: a holiday, or a one-off the manager added. Open on normal hours
// until an exception says otherwise.
function StoreDateRow({
  date,
  name,
  exception,
  status,
  busy,
  onClose,
  onSpecial,
  onClear,
}: {
  date: string;
  name: string;
  exception: StoreHoursException | undefined;
  status: string;
  busy: boolean;
  onClose: () => void;
  onSpecial: (opens: string, closes: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [opens, setOpens] = useState(toTimeInput(exception?.opens) || "12:00");
  const [closes, setCloses] = useState(toTimeInput(exception?.closes) || "17:00");

  const tone = !exception
    ? "text-slate-600 dark:text-slate-400"
    : exception.is_closed
      ? "text-rose-600 dark:text-rose-400"
      : "text-sky-600 dark:text-sky-400";

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-[170px]">
          <div className="text-sm text-slate-900 dark:text-slate-100">{name}</div>
          <div className="text-[11px] text-slate-500">{dateLabel(date)}</div>
        </div>
        <div className={`flex-1 min-w-[170px] text-xs ${tone}`}>{status}</div>
        <div className="flex items-center gap-2">
          {!exception?.is_closed && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-xs text-slate-500 hover:text-rose-500 disabled:opacity-50"
            >
              Close
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            disabled={busy}
            className="text-xs text-slate-500 hover:text-sky-500 disabled:opacity-50"
          >
            {editing ? "Cancel" : exception && !exception.is_closed ? "Change hours" : "Set special hours"}
          </button>
          {exception && (
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="text-xs text-slate-500 hover:text-emerald-500 disabled:opacity-50"
            >
              Reopen / back to normal
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-500">Open this day</span>
          <input
            type="time"
            value={opens}
            onChange={(e) => setOpens(e.target.value)}
            className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-slate-900 dark:text-slate-100 text-xs"
          />
          <span className="text-[11px] text-slate-500">to</span>
          <input
            type="time"
            value={closes}
            onChange={(e) => setCloses(e.target.value)}
            className="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-slate-900 dark:text-slate-100 text-xs"
          />
          <button
            type="button"
            onClick={() => { setEditing(false); onSpecial(opens, closes); }}
            disabled={busy}
            className="px-2.5 py-1 text-xs rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
          >
            Save this day
          </button>
        </div>
      )}
    </div>
  );
}

// Close, or set special hours for, a date that isn't on the holiday list.
function AddDateForm({
  busy,
  onClose,
  onSpecial,
}: {
  busy: boolean;
  onClose: (date: string, label: string | null) => void;
  onSpecial: (date: string, label: string | null, opens: string, closes: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"closed" | "special">("closed");
  const [opens, setOpens] = useState("12:00");
  const [closes, setCloses] = useState("17:00");

  function submit() {
    if (!date) return;
    const l = label.trim() || null;
    if (mode === "closed") onClose(date, l);
    else onSpecial(date, l, opens, closes);
    setOpen(false);
    setDate("");
    setLabel("");
    setMode("closed");
  }

  return (
    <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs rounded-md bg-emerald-500 text-slate-950 font-medium px-3 py-1.5 hover:bg-emerald-400"
      >
        {open ? "Cancel" : "+ Add a date"}
      </button>
      {open && (
        <div className="mt-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-slate-900 dark:text-slate-100"
            />
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="reason (optional), e.g. Deep clean"
              className="flex-1 min-w-[180px] text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 select-none">
              <input
                type="radio"
                name="add-date-mode"
                checked={mode === "closed"}
                onChange={() => setMode("closed")}
              />
              Closed all day
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 select-none">
              <input
                type="radio"
                name="add-date-mode"
                checked={mode === "special"}
                onChange={() => setMode("special")}
              />
              Special hours
            </label>
            {mode === "special" && (
              <>
                <input
                  type="time"
                  value={opens}
                  onChange={(e) => setOpens(e.target.value)}
                  className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1 text-slate-900 dark:text-slate-100 text-xs"
                />
                <span className="text-xs text-slate-500">to</span>
                <input
                  type="time"
                  value={closes}
                  onChange={(e) => setCloses(e.target.value)}
                  className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1 text-slate-900 dark:text-slate-100 text-xs"
                />
              </>
            )}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={submit}
              disabled={busy || !date}
              className="text-xs rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium px-3 py-1.5 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Add this date"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
