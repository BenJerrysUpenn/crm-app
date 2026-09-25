"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PROFILE_LABELS, type Profile } from "@/lib/funnels/profile";
import { WINDOWS, WINDOW_LABELS, type WindowKey } from "@/lib/funnels/windows";
import type { FunnelPayload } from "@/lib/funnels/types";
import type { ExceptionQueue, LoopStatus } from "@/lib/funnels/queries";
import { ageLabel, ago, gmailLink, money, pctLabel } from "./format";

type ApiResponse = {
  loop: LoopStatus;
  funnel: FunnelPayload;
  exceptions: ExceptionQueue;
};

const DISMISS_KEY = "funnels.dismissed.v1";

export default function Funnels() {
  const [windowKey, setWindowKey] = useState<WindowKey>("30");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; migration: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Per-viewer "mark handled" — client-local only (there is no DB write path
  // for it without a migration), persisted so a refresh does not resurrect a
  // handled item. Wrapped in try/catch: storage can be blocked.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) setDismissed(new Set(JSON.parse(raw)));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const persistDismissed = useCallback((next: Set<string>) => {
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async (w: WindowKey) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/funnels?window=${w}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError({
          message: json.error ?? `Request failed (${res.status})`,
          migration: Boolean(json.migration_missing),
        });
        setData(null);
      } else {
        setData(json as ApiResponse);
      }
    } catch (e: any) {
      setError({ message: e?.message ?? "Network error", migration: false });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(windowKey);
  }, [windowKey, load]);

  const suppress = useCallback(
    async (prospectId: number, itemId: string) => {
      setBusy((b) => new Set(b).add(itemId));
      try {
        const res = await fetch("/api/funnels/suppress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prospect_id: prospectId }),
        });
        if (res.ok) {
          persistDismissed(new Set(dismissed).add(itemId));
        } else {
          const j = await res.json().catch(() => ({}));
          alert(`Could not suppress: ${j.error ?? res.status}`);
        }
      } finally {
        setBusy((b) => {
          const n = new Set(b);
          n.delete(itemId);
          return n;
        });
      }
    },
    [dismissed, persistDismissed],
  );

  const markHandled = useCallback(
    (itemId: string) => persistDismissed(new Set(dismissed).add(itemId)),
    [dismissed, persistDismissed],
  );

  return (
    <div className="mx-auto max-w-5xl px-3 sm:px-6 py-4 space-y-6 text-slate-200">
      <Header
        windowKey={windowKey}
        onWindow={setWindowKey}
        loading={loading}
        generatedAt={data?.funnel.generated_at ?? null}
        onRefresh={() => load(windowKey)}
      />

      {error ? (
        <ErrorCard error={error} />
      ) : !data ? (
        <div className="text-slate-400 text-sm py-12 text-center">Loading…</div>
      ) : (
        <>
          <LoopStatusPanel loop={data.loop} />
          <ExceptionQueuePanel
            queue={data.exceptions}
            dismissed={dismissed}
            busy={busy}
            onSuppress={suppress}
            onHandled={markHandled}
          />
          <FunnelFlowPanel funnel={data.funnel} />
          <HealthStrip loop={data.loop} />
        </>
      )}
    </div>
  );
}

// --- header + window selector -----------------------------------------------

function Header({
  windowKey,
  onWindow,
  loading,
  generatedAt,
  onRefresh,
}: {
  windowKey: WindowKey;
  onWindow: (w: WindowKey) => void;
  loading: boolean;
  generatedAt: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Funnels</h2>
        <p className="text-xs text-slate-500">
          On-the-loop supervision of the automated email sales funnels ·{" "}
          {loading ? "refreshing…" : `as of ${ago(generatedAt)}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex rounded-md border border-slate-700 overflow-hidden">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => onWindow(w)}
              className={`text-xs px-2.5 py-1.5 whitespace-nowrap ${
                w === windowKey
                  ? "bg-slate-700 text-slate-100"
                  : "bg-slate-900 text-slate-400 hover:text-slate-200"
              }`}
            >
              {WINDOW_LABELS[w]}
            </button>
          ))}
        </div>
        <button
          onClick={onRefresh}
          className="text-xs px-2.5 py-1.5 rounded-md border border-slate-700 bg-slate-900 text-slate-300 hover:text-slate-100"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40">
      <div className="px-4 py-2.5 border-b border-slate-800">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        {hint ? <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function ErrorCard({ error }: { error: { message: string; migration: boolean } }) {
  return (
    <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-4 text-sm">
      {error.migration ? (
        <>
          <p className="text-amber-300 font-medium">Outreach tables not reachable.</p>
          <p className="text-amber-200/80 mt-1">
            A manager needs to have run{" "}
            <code className="text-amber-100">supabase/crm/001_call_desk.sql</code>{" "}
            (the call-desk migration grants managers access to the outreach
            tables this tab reads). Until then the funnel panels cannot load.
          </p>
        </>
      ) : (
        <>
          <p className="text-amber-300 font-medium">Could not load funnels.</p>
          <p className="text-amber-200/80 mt-1">{error.message}</p>
        </>
      )}
    </div>
  );
}

// --- panel 1: loop status ----------------------------------------------------

function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : "text-slate-100";
  return (
    <div className="rounded-md bg-slate-950/50 border border-slate-800 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${toneCls}`}>{value}</div>
      {sub ? <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div> : null}
    </div>
  );
}

function LoopStatusPanel({ loop }: { loop: LoopStatus }) {
  const capTone =
    loop.warm.sent_today >= loop.warm.daily_cap ? "warn" : "good";
  return (
    <Panel
      title="Loop status"
      hint="The engines' heartbeat. Sweep run-log telemetry is not yet persisted (proposed sweep_runs table); last-activity is derived from the newest DB event."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-slate-400 mb-2">Warm engine · live</div>
          <div className="grid grid-cols-2 gap-2">
            <Stat
              label="Sent today"
              value={`${loop.warm.sent_today} / ${loop.warm.daily_cap}`}
              sub="daily cap (droplet OUTREACH_DAILY_CAP)"
              tone={capTone}
            />
            <Stat
              label="In sequence"
              value={loop.warm.sequenced_active}
              sub="active warm prospects"
            />
          </div>
          <div className="text-[11px] text-slate-500 mt-2">
            Last engine activity {ago(loop.warm.last_activity_at)}
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-400 mb-2">Cold engine · gated</div>
          <div className="grid grid-cols-2 gap-2">
            <Stat
              label="Domain-age gate"
              value={loop.cold.gate_passed ? "Passed" : "Waiting"}
              sub={`gate date ${loop.cold.gate_date}`}
              tone={loop.cold.gate_passed ? "good" : "warn"}
            />
            <Stat label="Queued" value={loop.cold.queued} sub="cold prospects staged" />
          </div>
          <div className="text-[11px] text-slate-500 mt-2">
            All three sending domains verified 2026-09-08 (static note).
          </div>
        </div>
      </div>
    </Panel>
  );
}

// --- panel 2: exception queue ------------------------------------------------

function ExceptionQueuePanel({
  queue,
  dismissed,
  busy,
  onSuppress,
  onHandled,
}: {
  queue: ExceptionQueue;
  dismissed: Set<string>;
  busy: Set<string>;
  onSuppress: (prospectId: number, itemId: string) => void;
  onHandled: (itemId: string) => void;
}) {
  const drafts = queue.drafts_awaiting_send.filter((i) => !dismissed.has(i.id));
  const replies = queue.replies_awaiting_handling.filter((i) => !dismissed.has(i.id));
  const total = drafts.length + replies.length;

  return (
    <Panel
      title={`Exception queue${total ? ` · ${total}` : ""}`}
      hint="The only interactive panel — items the automation parked for a human. Actions are exception-shaped, not row-by-row work."
    >
      {total === 0 ? (
        <p className="text-sm text-slate-400">
          Nothing waiting on a human. The loop is flowing.
        </p>
      ) : (
        <div className="space-y-4">
          {drafts.length > 0 && (
            <div>
              <div className="text-xs font-medium text-slate-400 mb-1.5">
                Drafts awaiting send · {drafts.length}
              </div>
              <ul className="space-y-1.5">
                {drafts.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md bg-slate-950/50 border border-slate-800 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-slate-200 truncate">{item.title}</div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {item.subtitle ?? "Quote Review"} · waiting {ageLabel(item.age_hours)}
                      </div>
                    </div>
                    <a
                      href={gmailLink(item.gmail_thread_id, item.email)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs px-2 py-1 rounded border border-slate-700 text-sky-300 hover:bg-slate-800 whitespace-nowrap"
                    >
                      Open in Gmail
                    </a>
                    <button
                      onClick={() => onHandled(item.id)}
                      className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                    >
                      Mark handled
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {replies.length > 0 && (
            <div>
              <div className="text-xs font-medium text-slate-400 mb-1.5">
                Replies awaiting handling · {replies.length}
              </div>
              <ul className="space-y-1.5">
                {replies.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md bg-slate-950/50 border border-slate-800 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-slate-200 truncate">{item.title}</div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {item.subtitle ? `${item.subtitle} · ` : ""}replied {ageLabel(item.age_hours)} ago
                      </div>
                    </div>
                    <a
                      href={gmailLink(null, item.email)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs px-2 py-1 rounded border border-slate-700 text-sky-300 hover:bg-slate-800 whitespace-nowrap"
                    >
                      Open in Gmail
                    </a>
                    <button
                      onClick={() => onHandled(item.id)}
                      className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 whitespace-nowrap"
                    >
                      Mark handled
                    </button>
                    {item.prospect_id != null && (
                      <button
                        disabled={busy.has(item.id)}
                        onClick={() => {
                          if (
                            confirm(
                              `Suppress ${item.title}? This adds a do-not-contact suppression row (same as an opt-out) and cannot be undone here.`,
                            )
                          ) {
                            onSuppress(item.prospect_id!, item.id);
                          }
                        }}
                        className="text-xs px-2 py-1 rounded border border-rose-800 text-rose-300 hover:bg-rose-950/40 whitespace-nowrap disabled:opacity-50"
                      >
                        {busy.has(item.id) ? "…" : "Suppress"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <ul className="mt-3 space-y-0.5">
        {queue.notes.map((n) => (
          <li key={n} className="text-[11px] text-slate-600">
            · {n}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// --- panel 3: funnel flow ----------------------------------------------------

function FunnelFlowPanel({ funnel }: { funnel: FunnelPayload }) {
  const dealAll = funnel.deal_funnel.find((r) => r.profile === "__all__");
  const dealProfiles = funnel.deal_funnel.filter(
    (r) => r.profile !== "__all__" && r.created > 0,
  );

  return (
    <Panel
      title="Funnel flow"
      hint="Attribution is the activity join — a prospect mailed, then a deal on the same email touched after the mail date. Never deals.created_at."
    >
      {/* Left-of-pipeline, per engine */}
      <div className="mb-5">
        <div className="text-xs font-medium text-slate-400 mb-2">
          Left of pipeline, per engine (window: {WINDOW_LABELS[funnel.window]})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-500 text-right">
                <th className="text-left font-normal py-1">Engine</th>
                <th className="font-normal">Sent</th>
                <th className="font-normal">Replied</th>
                <th className="font-normal">Handed off</th>
                <th className="font-normal">Deal</th>
                <th className="font-normal">Quoted</th>
                <th className="font-normal">Booked</th>
              </tr>
            </thead>
            <tbody>
              {funnel.outreach.map((row) => (
                <tr key={row.engine} className="text-right border-t border-slate-800">
                  <td className="text-left py-1.5 capitalize text-slate-300">{row.engine}</td>
                  <td className="text-slate-100">{row.sent}</td>
                  <td>{convCell(row.replied, row.sent)}</td>
                  <td>{convCell(row.handed_off, row.replied)}</td>
                  <td>{convCell(row.deal, row.sent)}</td>
                  <td>{convCell(row.quoted, row.deal)}</td>
                  <td>{convCell(row.booked, row.quoted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-600 mt-1">
          Small % under a count = conversion from the previous stage.
        </p>
      </div>

      {/* Deal funnel per profile */}
      <div className="mb-5">
        <div className="text-xs font-medium text-slate-400 mb-2">
          Deal funnel, per derived profile
        </div>
        {dealAll && dealAll.created === 0 ? (
          <p className="text-sm text-slate-500">No deals created in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-500 text-right">
                  <th className="text-left font-normal py-1">Profile</th>
                  <th className="font-normal">Created</th>
                  <th className="font-normal">Quoted</th>
                  <th className="font-normal">Booked</th>
                  <th className="font-normal">Complete</th>
                  <th className="font-normal">Booked $</th>
                </tr>
              </thead>
              <tbody>
                {dealProfiles.map((row) => (
                  <tr key={row.profile} className="text-right border-t border-slate-800">
                    <td className="text-left py-1.5 text-slate-300">
                      {PROFILE_LABELS[row.profile as Profile]}
                    </td>
                    <td className="text-slate-100">{row.created}</td>
                    <td>{convCell(row.quoted, row.created)}</td>
                    <td>{convCell(row.booked, row.created)}</td>
                    <td className="text-slate-300">{row.complete}</td>
                    <td className="text-emerald-300">{money(row.booked_value)}</td>
                  </tr>
                ))}
                {dealAll && (
                  <tr className="text-right border-t-2 border-slate-700 font-medium">
                    <td className="text-left py-1.5 text-slate-200">All</td>
                    <td className="text-slate-100">{dealAll.created}</td>
                    <td>{convCell(dealAll.quoted, dealAll.created)}</td>
                    <td>{convCell(dealAll.booked, dealAll.created)}</td>
                    <td className="text-slate-300">{dealAll.complete}</td>
                    <td className="text-emerald-300">{money(dealAll.booked_value)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Below-min + quote latency */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-slate-400 mb-2">Below-min counter</div>
          <div className="rounded-md bg-slate-950/50 border border-slate-800 px-3 py-2.5">
            <div className="text-xl font-semibold text-pink-300">
              {pctLabel(funnel.below_min.overall.share)}
            </div>
            <div className="text-[11px] text-slate-500">
              {funnel.below_min.overall.below_min} of {funnel.below_min.overall.total} enquiries
              closed Below Min · #393 wants this falling (Aug baseline 73%)
            </div>
          </div>
          <ul className="mt-2 space-y-0.5">
            {funnel.below_min.by_profile
              .filter((p) => p.total > 0)
              .map((p) => (
                <li key={p.profile} className="flex justify-between text-[11px] text-slate-500">
                  <span>{PROFILE_LABELS[p.profile]}</span>
                  <span>
                    {p.below_min}/{p.total} ({pctLabel(p.share)})
                  </span>
                </li>
              ))}
          </ul>
        </div>
        <div>
          <div className="text-xs font-medium text-slate-400 mb-2">
            Quote latency (created → quote produced)
          </div>
          <div className="rounded-md bg-slate-950/50 border border-slate-800 px-3 py-2.5">
            <div className="text-xl font-semibold text-slate-100">
              {funnel.quote_latency.median_hours == null
                ? "—"
                : `${funnel.quote_latency.median_hours}h median`}
            </div>
            <div className="text-[11px] text-slate-500">
              over {funnel.quote_latency.count} quotes · proxy for send (quote_jobs done)
            </div>
          </div>
          {funnel.quote_latency.trend.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {funnel.quote_latency.trend.slice(-6).map((t) => (
                <li key={t.week_start} className="flex justify-between text-[11px] text-slate-500">
                  <span>wk {t.week_start.slice(5, 10)}</span>
                  <span>
                    {t.median_hours == null ? "—" : `${t.median_hours}h`} ({t.count})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function convCell(value: number, denom: number) {
  return (
    <span>
      <span className="text-slate-100">{value}</span>
      {denom > 0 && value <= denom ? (
        <span className="text-[10px] text-slate-500 ml-1">
          {Math.round((value / denom) * 100)}%
        </span>
      ) : null}
    </span>
  );
}

// --- panel 4: health strip ---------------------------------------------------

function HealthStrip({ loop }: { loop: LoopStatus }) {
  const suppressionRate =
    loop.suppression.prospects_total > 0
      ? Math.round(
          (loop.suppression.total / loop.suppression.prospects_total) * 1000,
        ) / 10
      : 0;
  return (
    <Panel title="Health strip" hint="Deliverability and backlog at a glance.">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat
          label="Suppression"
          value={loop.suppression.total}
          sub={`${suppressionRate}% of ${loop.suppression.prospects_total}`}
        />
        <Stat label="Opt-out events" value={loop.suppression.opt_out_events} sub="unsub + complaint" />
        <Stat
          label="Quote backlog"
          value={loop.quote_jobs.pending + loop.quote_jobs.running}
          sub={`${loop.quote_jobs.pending} pending · ${loop.quote_jobs.running} running`}
          tone={loop.quote_jobs.pending + loop.quote_jobs.running > 5 ? "warn" : "default"}
        />
        <Stat
          label="Quote errors"
          value={loop.quote_jobs.error}
          sub="failed quote_jobs (sweep-failure proxy)"
          tone={loop.quote_jobs.error > 0 ? "bad" : "good"}
        />
      </div>
      <p className="text-[11px] text-slate-600 mt-3">
        Seed / DMARC: all three sending domains verified at Postmaster 2026-09-08; SPF
        alignment fails on Gmail send-as (bj-finance outreach-deliverability note) — static,
        not live-polled this pass.
      </p>
    </Panel>
  );
}
