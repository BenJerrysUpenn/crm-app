"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Toast from "@/components/Toast";
import DispositionSheet from "./DispositionSheet";
import NoteSheet from "./NoteSheet";
import { ProspectCard, ProspectTableRow, type RowHandlers } from "./QueueRow";
import type { CallDeskRow } from "@/lib/callDesk/types";
import { digitsOnly, fmtClock } from "@/lib/callDesk/format";

const POLL_MS = 30_000;
const PENDING_KEY = "callDesk.pendingCalls.v1";

type Filter = "all" | "pending" | "uncalled" | "called";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Needs disposition" },
  { value: "uncalled", label: "Not yet called" },
  { value: "called", label: "Called" },
];

type LoadError = { message: string; migrationMissing: boolean };

/** Calls tapped in this browser that have no outcome yet, by prospect id. */
function readPending(): Record<number, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Record<number, number>) : {};
  } catch {
    return {};
  }
}

function writePending(v: Record<number, number>) {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(v));
  } catch {
    // Private mode / storage full — the view's pending_disposition_event_id
    // is the durable copy, so losing this cache costs nothing.
  }
}

export default function CallDesk({ callerEmail }: { callerEmail: string }) {
  const [rows, setRows] = useState<CallDeskRow[] | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<number | null>(null);

  const [localPending, setLocalPending] = useState<Record<number, number>>({});
  const [dispositionTarget, setDispositionTarget] = useState<{
    row: CallDeskRow;
    eventId: number;
  } | null>(null);
  const [noteTarget, setNoteTarget] = useState<CallDeskRow | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    kind: "error" | "info";
  } | null>(null);

  // Read the persisted pending map once, on the client, to keep the first
  // server render and the hydration pass identical.
  useEffect(() => setLocalPending(readPending()), []);

  // When the last "Call now" was logged. A queue response that was already
  // in flight when a call landed is stale by definition, so it must not
  // prune that brand-new pending call back out of the map.
  const lastCallLoggedAtRef = useRef(0);

  const load = useCallback(async () => {
    const startedAt = Date.now();
    try {
      const res = await fetch("/api/call-desk/queue", { cache: "no-store" });

      // An expired session is redirected to /login by the middleware, so a
      // "successful" response can still be a login page. Treat anything
      // that isn't JSON as a sign-in problem rather than parse noise.
      const isJson = (res.headers.get("content-type") ?? "").includes(
        "application/json",
      );
      if (!isJson) {
        setError({
          message:
            "Your sign-in has expired. Reload the page to sign in again.",
          migrationMissing: false,
        });
        setLoading(false);
        return;
      }

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError({
          message: payload.error || `Queue request failed (${res.status})`,
          migrationMissing: Boolean(payload.migration_missing),
        });
        setLoading(false);
        return;
      }
      const payload = (await res.json()) as { rows: CallDeskRow[] };
      const next = payload.rows ?? [];
      setRows(next);
      setError(null);
      setUpdatedAt(new Date());

      // Reconcile the local pending map against the truth in the view: a
      // call dispositioned anywhere (another device, the disposition sheet)
      // clears here too, and prospects that dropped out of the queue —
      // do-not-call, suppression — stop nagging.
      if (lastCallLoggedAtRef.current > startedAt) return;
      setLocalPending((prev) => {
        const byId = new Map(next.map((r) => [r.prospect_id, r]));
        const cleaned: Record<number, number> = {};
        for (const [pidRaw, eventId] of Object.entries(prev)) {
          const pid = Number(pidRaw);
          const row = byId.get(pid);
          if (!row) continue;
          if (row.pending_disposition_event_id === null) continue;
          cleaned[pid] = eventId;
        }
        writePending(cleaned);
        return cleaned;
      });
    } catch (e) {
      setError({
        message:
          e instanceof Error
            ? `Could not reach the CRM: ${e.message}`
            : "Could not reach the CRM.",
        migrationMissing: false,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Auto-updating on return: refresh when the tab comes back, and — this is
  // the point of the whole screen — re-offer the disposition sheet for a
  // call that was started and never resolved. `leftPage` makes sure we only
  // do that after an actual trip away (to the Phone app), not on first paint.
  const leftPageRef = useRef(false);
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = Boolean(dispositionTarget || noteTarget);

  const rowsRef = useRef<CallDeskRow[] | null>(null);
  rowsRef.current = rows;
  const pendingRef = useRef<Record<number, number>>({});
  pendingRef.current = localPending;

  useEffect(() => {
    function offerPending() {
      if (sheetOpenRef.current) return;
      const pending = pendingRef.current;
      const entries = Object.entries(pending);
      if (!entries.length) return;
      const current = rowsRef.current ?? [];
      for (const [pidRaw, eventId] of entries) {
        const row = current.find((r) => r.prospect_id === Number(pidRaw));
        if (row) {
          setDispositionTarget({ row, eventId });
          return;
        }
      }
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        leftPageRef.current = true;
        return;
      }
      load();
      if (leftPageRef.current) {
        leftPageRef.current = false;
        offerPending();
      }
    }
    function onBlur() {
      leftPageRef.current = true;
    }
    function onFocus() {
      load();
      if (leftPageRef.current) {
        leftPageRef.current = false;
        offerPending();
      }
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [load]);

  const pendingFor = useCallback(
    (row: CallDeskRow): number | null =>
      localPending[row.prospect_id] ?? row.pending_disposition_event_id ?? null,
    [localPending],
  );

  // "Call now" was tapped. The tel: link navigates on its own; this just
  // records that a call happened, before the caller leaves the page.
  const onCall = useCallback(
    async (row: CallDeskRow) => {
      leftPageRef.current = true;
      try {
        const res = await fetch(
          `/api/call-desk/prospects/${row.prospect_id}/calls`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          setToast({
            message: payload.error || `Could not log the call (${res.status})`,
            kind: "error",
          });
          return;
        }
        const { event_id: eventId } = (await res.json()) as {
          event_id: number;
        };
        lastCallLoggedAtRef.current = Date.now();
        setLocalPending((prev) => {
          const next = { ...prev, [row.prospect_id]: eventId };
          writePending(next);
          return next;
        });
      } catch {
        setToast({
          message:
            "Call started, but logging it failed — log the outcome manually.",
          kind: "error",
        });
      }
    },
    [],
  );

  const clearPending = useCallback((prospectId: number) => {
    setLocalPending((prev) => {
      const next = { ...prev };
      delete next[prospectId];
      writePending(next);
      return next;
    });
  }, []);

  const handlers: RowHandlers = useMemo(
    () => ({
      callerEmail,
      onCall,
      onLogOutcome: (row, eventId) => setDispositionTarget({ row, eventId }),
      onNote: (row) => setNoteTarget(row),
      onRefresh: () => load(),
    }),
    [callerEmail, onCall, load],
  );

  // Filter, search, then float anything awaiting an outcome to the top. The
  // view's own order (newest mail first) survives underneath.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = digitsOnly(search);
    const list = (rows ?? []).filter((r) => {
      const pending = pendingFor(r);
      if (filter === "pending" && !pending) return false;
      if (filter === "uncalled" && ((r.calls_count ?? 0) > 0 || pending))
        return false;
      if (filter === "called" && (r.calls_count ?? 0) === 0 && !pending)
        return false;
      if (!q) return true;
      const haystack = [r.name, r.company].filter(Boolean).join(" ").toLowerCase();
      if (haystack.includes(q)) return true;
      return Boolean(
        qDigits && digitsOnly(r.phone).includes(qDigits),
      );
    });
    return list
      .map((r, i) => ({ r, i, pending: pendingFor(r) ? 0 : 1 }))
      .sort((a, b) => a.pending - b.pending || a.i - b.i)
      .map((x) => x.r);
  }, [rows, search, filter, pendingFor]);

  const pendingCount = useMemo(
    () => (rows ?? []).filter((r) => pendingFor(r)).length,
    [rows, pendingFor],
  );

  return (
    <div className="px-3 sm:px-6 py-4 max-w-full">
      {/* header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Call desk</h1>
          <p className="text-xs text-slate-500">
            Recently contacted by the warm outreach engine.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            {updatedAt
              ? `updated ${fmtClock(updatedAt)}`
              : error
                ? "not updated"
                : "loading…"}
          </span>
          <button
            type="button"
            onClick={() => load()}
            className="min-h-[36px] text-xs px-3 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="mt-3 rounded-md border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">
          {pendingCount === 1
            ? "1 call is waiting on an outcome."
            : `${pendingCount} calls are waiting on an outcome.`}{" "}
          A call with no outcome is a call that never happened.
        </div>
      )}

      {/* search + filters ------------------------------------------------ */}
      <div className="mt-3 space-y-2">
        <input
          type="search"
          inputMode="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, company or phone"
          aria-label="Search the queue"
          className="w-full min-h-[44px] text-sm bg-slate-900 border border-slate-700 text-slate-100 rounded-md px-3 focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <div className="flex gap-2 overflow-x-auto -mx-3 px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`min-h-[36px] whitespace-nowrap text-xs px-3 rounded-full border transition ${
                filter === f.value
                  ? "bg-slate-700 text-slate-100 border-slate-500"
                  : "bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* body ------------------------------------------------------------ */}
      <div className="mt-4">
        {loading && !rows && !error && (
          <p className="text-sm text-slate-500">Loading the queue…</p>
        )}

        {error && (
          <div className="rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-4 text-sm">
            {error.migrationMissing ? (
              <>
                <p className="text-amber-200 font-medium">
                  The call desk isn&apos;t switched on yet.
                </p>
                <p className="mt-1 text-amber-100/80">
                  The call-desk migration hasn&apos;t been applied to the
                  database, so the queue, the call log and the recording bucket
                  don&apos;t exist yet. Someone with database access needs to
                  run{" "}
                  <code className="text-amber-200">
                    supabase/crm/001_call_desk.sql
                  </code>{" "}
                  once. Everything on this page works the moment they do.
                </p>
              </>
            ) : (
              <>
                <p className="text-amber-200 font-medium">
                  Could not load the queue.
                </p>
                <p className="mt-1 text-amber-100/80">{error.message}</p>
              </>
            )}
            <button
              type="button"
              onClick={() => load()}
              className="mt-3 min-h-[44px] text-sm px-4 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              Try again
            </button>
          </div>
        )}

        {!error && rows && rows.length === 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-8 text-center">
            <p className="text-slate-300">Nothing in the queue</p>
            <p className="mt-1 text-sm text-slate-500">
              The warm engine hasn&apos;t mailed anyone new.
            </p>
          </div>
        )}

        {!error && rows && rows.length > 0 && visible.length === 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-8 text-center">
            <p className="text-slate-300">No one matches this view</p>
            <p className="mt-1 text-sm text-slate-500">
              {rows.length} in the queue. Clear the search or pick “All”.
            </p>
          </div>
        )}

        {!error && visible.length > 0 && (
          <>
            {/* mobile: cards */}
            <ul className="md:hidden space-y-3">
              {visible.map((row) => (
                <ProspectCard
                  key={row.prospect_id}
                  row={row}
                  pendingEventId={pendingFor(row)}
                  recordingEventId={pendingFor(row) ?? row.last_call_event_id}
                  expanded={expanded === row.prospect_id}
                  onToggle={() =>
                    setExpanded((v) =>
                      v === row.prospect_id ? null : row.prospect_id,
                    )
                  }
                  handlers={handlers}
                />
              ))}
            </ul>

            {/* desktop: table */}
            <div className="hidden md:block overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-left">
                <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Prospect</th>
                    <th className="px-3 py-2 font-medium">Last contact</th>
                    <th className="px-3 py-2 font-medium">Phone</th>
                    <th className="px-3 py-2 font-medium">Party type</th>
                    <th className="px-3 py-2 font-medium text-center">Calls</th>
                    <th className="px-3 py-2 font-medium">Outcome</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <ProspectTableRow
                      key={row.prospect_id}
                      row={row}
                      pendingEventId={pendingFor(row)}
                      recordingEventId={
                        pendingFor(row) ?? row.last_call_event_id
                      }
                      expanded={expanded === row.prospect_id}
                      onToggle={() =>
                        setExpanded((v) =>
                          v === row.prospect_id ? null : row.prospect_id,
                        )
                      }
                      handlers={handlers}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* sheets ----------------------------------------------------------- */}
      {dispositionTarget && (
        <DispositionSheet
          row={dispositionTarget.row}
          eventId={dispositionTarget.eventId}
          onClose={() => setDispositionTarget(null)}
          onSaved={(message) => {
            clearPending(dispositionTarget.row.prospect_id);
            setDispositionTarget(null);
            setToast({ message, kind: "info" });
            load();
          }}
        />
      )}

      {noteTarget && (
        <NoteSheet
          row={noteTarget}
          onClose={() => setNoteTarget(null)}
          onAppended={(notes) => {
            setRows((prev) =>
              (prev ?? []).map((r) =>
                r.prospect_id === noteTarget.prospect_id ? { ...r, notes } : r,
              ),
            );
            setToast({ message: "Note added.", kind: "info" });
          }}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          kind={toast.kind}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
