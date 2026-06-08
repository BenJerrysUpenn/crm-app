"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  STAGES,
  STAGE_COLOURS,
  DEFAULT_VISIBLE,
  type Stage,
} from "@/lib/stages";
import type { Deal } from "@/lib/types";
import DealDetailDrawer from "./DealDetailDrawer";
import { buildStagePatch, writeStageChange } from "@/lib/dealUpdate";

// Calendar uses the venue's local interpretation for grouping. event_date
// is a YYYY-MM-DD string; we treat it as an EST date (matching the rest
// of the app).

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseEventDate(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  // Build a Date in local time; we treat it as a date-only value so DST
  // / timezone offsets don't shift the day.
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function isoFor(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Build the 6-week grid for the displayed month, starting on the
// Sunday on/before the first of the month.
function monthGridDays(viewDate: Date): Date[] {
  const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

export default function CalendarView() {
  const supabase = useMemo(() => createClient(), []);

  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  // Stage visibility filter — defaults to the working pipeline + closed
  // stages so a "Closed Lost" deal you scheduled doesn't disappear by
  // default. User can untick anything they don't want.
  const [visibleStages, setVisibleStages] = useState<Set<Stage>>(
    () => new Set([...DEFAULT_VISIBLE, "Event Complete"] as Stage[]),
  );
  const [selectedDealId, setSelectedDealId] = useState<number | null>(null);
  // Mobile: filter rail is hidden by default and opens as an overlay
  // when the user taps the "Filters" button.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Load every deal with an event_date in the visible window (the month
  // plus a small buffer either side to cover the 6-week grid).
  useEffect(() => {
    (async () => {
      setLoading(true);
      const winStart = new Date(view.getFullYear(), view.getMonth(), 1);
      winStart.setDate(winStart.getDate() - 7);
      const winEnd = new Date(view.getFullYear(), view.getMonth() + 1, 0);
      winEnd.setDate(winEnd.getDate() + 14);
      const { data, error } = await supabase
        .from("deals")
        .select("*")
        .eq("archived", 0)
        .gte("event_date", isoFor(winStart))
        .lte("event_date", isoFor(winEnd))
        .order("event_start_time", { ascending: true, nullsFirst: true });
      setLoading(false);
      if (error) {
        setError(error.message);
        return;
      }
      setError(null);
      setDeals((data ?? []) as Deal[]);
    })();
  }, [supabase, view]);

  // Group deals by event_date for fast lookup.
  const dealsByDate = useMemo(() => {
    const m = new Map<string, Deal[]>();
    for (const d of deals) {
      if (!d.event_date) continue;
      if (!visibleStages.has(d.stage as Stage)) continue;
      const key = String(d.event_date).slice(0, 10);
      const list = m.get(key);
      if (list) list.push(d);
      else m.set(key, [d]);
    }
    return m;
  }, [deals, visibleStages]);

  const days = useMemo(() => monthGridDays(view), [view]);
  const today = useMemo(() => new Date(), []);

  const selectedDeal =
    selectedDealId != null
      ? deals.find((d) => d.id === selectedDealId) ?? null
      : null;

  function prevMonth() {
    setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
  }
  function nextMonth() {
    setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));
  }
  function goToday() {
    const n = new Date();
    setView(new Date(n.getFullYear(), n.getMonth(), 1));
  }

  // Same handler shape as KanbanBoard's moveDealToStage so the drawer's
  // stage dropdown works identically here. Optimistic update with
  // rollback on error.
  async function moveDealToStage(deal: Deal, newStage: Stage) {
    if (deal.stage === newStage) return;
    if (!(STAGES as readonly string[]).includes(newStage)) return;
    const prevStage = deal.stage;
    const prevBoomerang = deal.boomerang_reason;
    const prevActive = deal.is_active;
    const prevPayment = deal.payment_status;
    const patch = buildStagePatch(newStage, deal.payment_status);
    setDeals((prev) =>
      prev.map((d) =>
        d.id === deal.id
          ? {
              ...d,
              stage: patch.stage,
              boomerang_reason: patch.boomerang_reason,
              is_active: patch.is_active,
              updated_at: patch.updated_at,
              payment_status: patch.payment_status ?? d.payment_status,
            }
          : d,
      ),
    );
    const { error } = await writeStageChange(supabase, deal.id, patch);
    if (error) {
      setDeals((prev) =>
        prev.map((d) =>
          d.id === deal.id
            ? {
                ...d,
                stage: prevStage,
                boomerang_reason: prevBoomerang,
                is_active: prevActive,
                payment_status: prevPayment,
              }
            : d,
        ),
      );
      setError(`Could not move deal: ${error.message}`);
    }
  }

  function toggleStage(stage: Stage) {
    setVisibleStages((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  function selectAll() {
    setVisibleStages(new Set(STAGES));
  }
  function clearAll() {
    setVisibleStages(new Set());
  }

  return (
    <div className="h-full flex relative">
      {/* Mobile overlay backdrop for the filter sheet. */}
      {filtersOpen && (
        <div
          className="sm:hidden fixed inset-0 bg-black/60 z-40"
          onClick={() => setFiltersOpen(false)}
        />
      )}
      {/* Left rail: stage filters. Desktop: always visible block.
          Mobile: slides in as a fixed overlay when filtersOpen. */}
      <aside
        className={`w-56 flex-shrink-0 border-r border-slate-800 bg-slate-950 px-3 py-4 overflow-y-auto ${
          filtersOpen
            ? "fixed left-0 top-0 bottom-0 z-50 sm:static sm:z-auto"
            : "hidden sm:block"
        }`}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Filter by stage
          </h3>
          <button
            type="button"
            onClick={() => setFiltersOpen(false)}
            className="sm:hidden text-slate-500 hover:text-slate-200 text-lg leading-none"
            aria-label="Close filters"
          >
            ×
          </button>
        </div>
        <div className="flex gap-1 mb-3 text-[11px]">
          <button
            type="button"
            onClick={selectAll}
            className="text-slate-400 hover:text-slate-200"
          >
            All
          </button>
          <span className="text-slate-700">·</span>
          <button
            type="button"
            onClick={clearAll}
            className="text-slate-400 hover:text-slate-200"
          >
            None
          </button>
        </div>
        <ul className="space-y-1">
          {STAGES.map((stage) => {
            const colour = STAGE_COLOURS[stage];
            const checked = visibleStages.has(stage);
            return (
              <li key={stage}>
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer py-1 select-none">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleStage(stage)}
                    className="accent-sky-500"
                  />
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${colour.dot}`}
                  />
                  <span className={checked ? "" : "text-slate-500"}>
                    {stage}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Calendar grid. */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-2 sm:px-4 py-2 flex items-center justify-between border-b border-slate-800 bg-slate-950 gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className="sm:hidden text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md px-2 py-1 flex-shrink-0"
              aria-label="Open filters"
            >
              ☰
            </button>
            <button
              type="button"
              onClick={prevMonth}
              className="text-sm text-slate-300 hover:text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md px-2 py-1"
              aria-label="Previous month"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={nextMonth}
              className="text-sm text-slate-300 hover:text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md px-2 py-1"
              aria-label="Next month"
            >
              ›
            </button>
            <button
              type="button"
              onClick={goToday}
              className="text-xs text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md px-2 py-1 hidden sm:inline-block"
            >
              Today
            </button>
            <h2 className="text-sm sm:text-base font-semibold text-slate-100 ml-1 sm:ml-3 truncate">
              {MONTH_NAMES[view.getMonth()]} {view.getFullYear()}
            </h2>
          </div>
          <div className="text-xs text-slate-500 hidden sm:block">
            {loading ? "Loading…" : `${deals.length} deals in window`}
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 text-sm text-rose-300 bg-rose-950/40 border-b border-rose-900">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto p-3">
          <div className="grid grid-cols-7 gap-px bg-slate-800 border border-slate-800 rounded-md overflow-hidden">
            {DAY_NAMES.map((d) => (
              <div
                key={d}
                className="bg-slate-950 text-[11px] uppercase tracking-wide text-slate-500 px-2 py-1.5 font-semibold"
              >
                {d}
              </div>
            ))}
            {days.map((d) => {
              const key = isoFor(d);
              const list = dealsByDate.get(key) ?? [];
              const inMonth = isSameMonth(d, view);
              const isToday = isSameDay(d, today);
              return (
                <div
                  key={key}
                  className={`min-h-[70px] sm:min-h-[110px] flex flex-col px-1 sm:px-1.5 py-1 sm:py-1.5 ${
                    inMonth ? "bg-slate-900" : "bg-slate-900/40"
                  }`}
                >
                  <div
                    className={`text-[11px] mb-1 flex items-center justify-between ${
                      inMonth ? "text-slate-400" : "text-slate-600"
                    }`}
                  >
                    <span
                      className={
                        isToday
                          ? "bg-sky-500 text-white rounded-full w-5 h-5 inline-flex items-center justify-center font-semibold"
                          : ""
                      }
                    >
                      {d.getDate()}
                    </span>
                    {list.length > 3 && (
                      <span className="text-slate-500">{list.length}</span>
                    )}
                  </div>
                  <div className="flex-1 space-y-1 overflow-hidden">
                    {list.slice(0, 4).map((deal) => {
                      const colour = STAGE_COLOURS[deal.stage as Stage];
                      const contact = [
                        deal.contact_first_name,
                        deal.contact_last_name,
                      ]
                        .filter(Boolean)
                        .join(" ");
                      const label =
                        deal.company || contact || `Deal #${deal.id}`;
                      const time = (deal.event_start_time ?? "").slice(0, 5);
                      return (
                        <button
                          key={deal.id}
                          type="button"
                          onClick={() => setSelectedDealId(deal.id)}
                          className={`w-full text-left text-[11px] px-1.5 py-1 rounded ${colour.chip} border truncate cursor-pointer hover:brightness-125 transition`}
                          title={`${label}${
                            time ? ` · ${time}` : ""
                          } · ${deal.stage}`}
                        >
                          {time && (
                            <span className="font-mono mr-1 opacity-80">
                              {time}
                            </span>
                          )}
                          <span className="font-medium">{label}</span>
                        </button>
                      );
                    })}
                    {list.length > 4 && (
                      <button
                        type="button"
                        onClick={() => {
                          // Click "+N more" opens the first hidden deal;
                          // pragmatic alternative to a popover for now.
                          setSelectedDealId(list[4].id);
                        }}
                        className="text-[11px] text-slate-400 hover:text-slate-200 pl-1.5"
                      >
                        +{list.length - 4} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selectedDeal && (
        <DealDetailDrawer
          key={selectedDeal.id}
          deal={selectedDeal}
          onClose={() => setSelectedDealId(null)}
          onStageChange={moveDealToStage}
          onDealUpdate={(updated) =>
            setDeals((prev) =>
              prev.map((d) => (d.id === updated.id ? updated : d)),
            )
          }
        />
      )}
    </div>
  );
}
