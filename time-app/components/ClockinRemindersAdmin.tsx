"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { Profile, ClockinReminder } from "@/lib/types";

export type ReminderWithAcks = ClockinReminder & {
  acks: { employee_id: string; full_name: string | null; acknowledged_at: string }[];
};

export default function ClockinRemindersAdmin({
  reminders,
  employees,
  employeeCount,
}: {
  reminders: ReminderWithAcks[];
  employees: Profile[];
  employeeCount: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function publish() {
    setErr(null);
    setOk(null);
    if (!title.trim() || !body.trim()) {
      setErr("Give it a title and a message.");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/clockin-reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), body: body.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setErr(b.error ?? `Failed (${res.status}).`);
      return;
    }
    setTitle("");
    setBody("");
    setOk("Published. It pops up for everyone the next time they open the app.");
    router.refresh();
  }

  async function setActive(id: number, active: boolean) {
    if (!active && !window.confirm("Retire this reminder? It stops popping up for everyone.")) return;
    setErr(null);
    setOk(null);
    const res = await fetch(`/api/clockin-reminders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setErr(b.error ?? `Failed (${res.status}).`);
      return;
    }
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Clock-in reminders</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
        Anything published here pops up for every employee the next time they open
        the app and must be acknowledged before they can clock in. Messages
        can&apos;t be edited once published (acknowledgments are a signed record);
        publish a new one instead. Retire a message when it no longer needs to be
        shown.
      </p>

      <div className="mb-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
        <input
          type="text"
          placeholder="title (e.g. New closing checklist)"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
        />
        <textarea
          placeholder="message"
          value={body}
          maxLength={4000}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
          className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={publish}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md bg-emerald-500 text-slate-950 font-medium hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? "Publishing…" : "Publish reminder"}
          </button>
          {ok && <span className="text-sm text-emerald-400">{ok}</span>}
          {err && <span className="text-sm text-rose-400">{err}</span>}
        </div>
      </div>

      {reminders.length === 0 ? (
        <div className="text-sm text-slate-500">No reminders yet.</div>
      ) : (
        <div className="space-y-3">
          {reminders.map((r) => (
            <ReminderRow
              key={r.id}
              r={r}
              employees={employees}
              employeeCount={employeeCount}
              onSetActive={setActive}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReminderRow({
  r,
  employees,
  employeeCount,
  onSetActive,
}: {
  r: ReminderWithAcks;
  employees: Profile[];
  employeeCount: number;
  onSetActive: (id: number, active: boolean) => void;
}) {
  const acks = [...r.acks].sort(
    (a, b) => new Date(a.acknowledged_at).getTime() - new Date(b.acknowledged_at).getTime(),
  );
  const ackedIds = new Set(acks.map((a) => a.employee_id));
  const outstanding = employees.filter((e) => !ackedIds.has(e.id));

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-slate-900 dark:text-slate-100">{r.title}</div>
          <div className="text-sm text-slate-700 dark:text-slate-300 mt-1 whitespace-pre-wrap">{r.body}</div>
          <div className="text-xs text-slate-500 mt-2">Published {fmtDate(r.created_at)}</div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <span
            className={`text-[11px] rounded-full px-2 py-0.5 ${
              r.active
                ? "bg-emerald-500/15 text-emerald-500"
                : "bg-slate-500/15 text-slate-500"
            }`}
          >
            {r.active ? "Active" : `Retired ${fmtDate(r.retired_at)}`}
          </span>
          <button
            onClick={() => onSetActive(r.id, !r.active)}
            className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
          >
            {r.active ? "Retire" : "Re-activate"}
          </button>
        </div>
      </div>

      <div className="text-xs text-slate-600 dark:text-slate-400 mt-3">
        Acknowledged {acks.length} of {employeeCount}
      </div>
      <details className="mt-1">
        <summary className="text-xs text-slate-500 cursor-pointer">Who acknowledged</summary>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-slate-600 dark:text-slate-400 mb-1">Acknowledged</div>
            {acks.length === 0 ? (
              <div className="text-slate-500">Nobody yet.</div>
            ) : (
              <ul className="space-y-1">
                {acks.map((a) => (
                  <li key={a.employee_id} className="text-slate-700 dark:text-slate-300">
                    {a.full_name ?? a.employee_id} · {fmtDateTime(a.acknowledged_at)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-slate-600 dark:text-slate-400 mb-1">Not yet acknowledged</div>
            {outstanding.length === 0 ? (
              <div className="text-slate-500">Everyone is up to date.</div>
            ) : (
              <ul className="space-y-1">
                {outstanding.map((e) => (
                  <li key={e.id} className="text-slate-700 dark:text-slate-300">
                    {e.full_name ?? e.id}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
