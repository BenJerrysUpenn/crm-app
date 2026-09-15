"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  LifecycleKind,
  LifecycleStep,
  LifecycleWithSteps,
  Profile,
  ShiftType,
} from "@/lib/types";
import {
  COMP_TYPES,
  COMP_TYPES_DEFAULT,
  FINAL_PAY_NOTE_DEFAULT,
  OFFBOARD_REASONS,
  PAY_SCHEDULE_DEFAULT,
} from "@/lib/staffing/catalogue";

const KIND_LABEL: Record<LifecycleKind, string> = {
  onboarding: "Onboarding",
  payroll_setup: "Payroll setup",
  offboarding: "Offboarding",
};

const input =
  "text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-slate-900 dark:text-slate-100 w-full";
const label = "block text-xs text-slate-600 dark:text-slate-400";
const primaryBtn =
  "text-xs rounded-md bg-emerald-500 text-slate-950 font-medium px-3 py-1.5 hover:bg-emerald-400 disabled:opacity-50";
const quietBtn =
  "text-xs rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";

function displayName(p: Profile, email: string) {
  const n = p.full_name && !p.full_name.includes("@") ? p.full_name : null;
  return n ?? email ?? p.id;
}

async function post(url: string, method: string, body: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Failed (${res.status}).`);
  return data;
}

export default function StaffingAdmin({
  me,
  employees,
  emailById,
  shiftTypes,
  records,
}: {
  me: Profile;
  employees: Profile[];
  emailById: Record<string, string>;
  shiftTypes: ShiftType[];
  records: LifecycleWithSteps[];
}) {
  const [tab, setTab] = useState<LifecycleKind>("onboarding");
  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of employees) m[p.id] = displayName(p, emailById[p.id] ?? "");
    return m;
  }, [employees, emailById]);

  const open = records.filter((r) => r.status === "open");
  const closed = records.filter((r) => r.status !== "open");

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Staffing</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          One form per event. The app does what it can itself (Withers-time, the fob, access
          removal) and turns the rest into a checklist with the link and the exact fields to type.
          Nothing here ever deletes a person or their hours.
        </p>
        <div className="flex gap-1 mb-4">
          {(Object.keys(KIND_LABEL) as LifecycleKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-md text-sm ${
                tab === k
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-medium"
                  : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          {tab === "onboarding" && <OnboardingForm shiftTypes={shiftTypes} />}
          {tab === "payroll_setup" && (
            <PayrollForm employees={employees} emailById={emailById} nameById={nameById} />
          )}
          {tab === "offboarding" && (
            <OffboardingForm me={me} employees={employees} nameById={nameById} />
          )}
        </div>
      </section>

      <PayableSection employees={employees} nameById={nameById} />

      <section>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">
          In progress ({open.length})
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          Tick manual steps off as you do them. A record closes itself when every step is done or
          skipped.
        </p>
        <div className="space-y-4">
          {open.length === 0 && (
            <div className="text-sm text-slate-500">Nothing in progress.</div>
          )}
          {open.map((r) => (
            <RecordCard key={r.id} rec={r} nameById={nameById} />
          ))}
        </div>
      </section>

      {closed.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Finished ({closed.length})
          </h2>
          <div className="space-y-4">
            {closed.map((r) => (
              <RecordCard key={r.id} rec={r} nameById={nameById} collapsed />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function OnboardingForm({ shiftTypes }: { shiftTypes: ShiftType[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [f, setF] = useState({
    legal_name: "",
    preferred_name: "",
    email: "",
    phone: "",
    role: "employee" as "employee" | "manager",
    start_date: "",
    pay_rate: "",
    position_types: [] as string[],
    fob_card_id: "",
  });
  const set = (k: keyof typeof f, v: string | string[]) => setF((s) => ({ ...s, [k]: v }));

  async function submit() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const data = await post("/api/staffing", "POST", {
        kind: "onboarding",
        ...f,
        pay_rate: f.pay_rate ? Number(f.pay_rate) : null,
      });
      const rec = data.record as LifecycleWithSteps;
      const invite = rec.steps.find((s) => s.key === "withers_time_invite");
      setOk(
        invite?.status === "done"
          ? `Invite emailed to ${f.email}. The checklist for the other systems is below.`
          : `Record created but the Withers-time invite failed: ${invite?.result ?? "unknown"}. Fix and press Run on the record.`,
      );
      setF({
        legal_name: "",
        preferred_name: "",
        email: "",
        phone: "",
        role: "employee",
        start_date: "",
        pay_rate: "",
        position_types: [],
        fob_card_id: "",
      });
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Creates the Withers-time account and emails the invite straight away, then lists
        Square, Slack, QuickBooks Workforce, Google and the fob as steps to tick off.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={label}>Legal name (as on payroll)
          <input className={input} value={f.legal_name} onChange={(e) => set("legal_name", e.target.value)} required />
        </label>
        <label className={label}>Preferred name
          <input className={input} value={f.preferred_name} onChange={(e) => set("preferred_name", e.target.value)} placeholder="what people call them" />
        </label>
        <label className={label}>Email (their login and where every invite goes)
          <input className={input} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} required />
        </label>
        <label className={label}>Phone (for SMS)
          <input className={input} type="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+1215..." />
        </label>
        <label className={label}>Role
          <select className={input} value={f.role} onChange={(e) => set("role", e.target.value)}>
            <option value="employee">Employee</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        <label className={label}>Start date
          <input className={input} type="date" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} required />
        </label>
        <label className={label}>Pay rate ($/hr)
          <input className={input} type="number" step="0.01" min="0" value={f.pay_rate} onChange={(e) => set("pay_rate", e.target.value)} />
        </label>
        <label className={label}>Fob card id (if already tapped; otherwise a step)
          <input className={input} value={f.fob_card_id} onChange={(e) => set("fob_card_id", e.target.value)} placeholder="raw id from the Pi log" />
        </label>
      </div>
      <div>
        <div className={label}>Position types</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {shiftTypes.map((t) => {
            const on = f.position_types.includes(t.name);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  set(
                    "position_types",
                    on ? f.position_types.filter((n) => n !== t.name) : [...f.position_types, t.name],
                  )
                }
                className={`text-xs rounded-full px-2.5 py-1 border ${
                  on
                    ? "border-transparent text-slate-950 font-medium"
                    : "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                }`}
                style={on ? { backgroundColor: t.color } : undefined}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      </div>
      {err && <div className="text-xs text-rose-500">{err}</div>}
      {ok && <div className="text-xs text-emerald-500">{ok}</div>}
      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={busy} className={primaryBtn}>
          {busy ? "Working…" : "Create account and start checklist"}
        </button>
      </div>
    </div>
  );
}

function PayrollForm({
  employees,
  emailById,
  nameById,
}: {
  employees: Profile[];
  emailById: Record<string, string>;
  nameById: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [f, setF] = useState({
    employee_id: "",
    legal_name: "",
    email: "",
    hire_date: "",
    pay_type: "hourly" as "hourly" | "salary",
    pay_rate: "",
    pay_schedule: PAY_SCHEDULE_DEFAULT,
    job_title: "",
    comp_types: COMP_TYPES_DEFAULT,
    qbo_employee_id: "",
  });
  const set = (k: keyof typeof f, v: string | string[]) => setF((s) => ({ ...s, [k]: v }));

  function pick(id: string) {
    const p = employees.find((e) => e.id === id);
    setF((s) => ({
      ...s,
      employee_id: id,
      legal_name: p && p.full_name && !p.full_name.includes("@") ? p.full_name : s.legal_name,
      email: p ? emailById[p.id] ?? s.email : s.email,
      hire_date: p?.start_date ?? s.hire_date,
      pay_rate: p?.hourly_rate != null ? String(p.hourly_rate) : s.pay_rate,
      qbo_employee_id: p?.qbo_employee_id ?? s.qbo_employee_id,
    }));
  }

  async function submit() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      await post("/api/staffing", "POST", { kind: "payroll_setup", ...f, pay_rate: Number(f.pay_rate) });
      setOk("Payroll checklist created below.");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600 dark:text-slate-400">
        What QuickBooks Payroll needs for a payable employee. SSN, date of birth, home address
        and bank details are never typed here; the person enters them in Workforce from the
        invite, and the last step records when that is done.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={label}>Person
          <select className={input} value={f.employee_id} onChange={(e) => pick(e.target.value)}>
            <option value="">Choose…</option>
            {employees.map((p) => (
              <option key={p.id} value={p.id}>
                {nameById[p.id]}{p.active ? "" : " (inactive)"}{p.has_workforce ? " · payable" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>Legal name
          <input className={input} value={f.legal_name} onChange={(e) => set("legal_name", e.target.value)} />
        </label>
        <label className={label}>Email on the payroll record
          <input className={input} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
        </label>
        <label className={label}>Hire date
          <input className={input} type="date" value={f.hire_date} onChange={(e) => set("hire_date", e.target.value)} />
        </label>
        <label className={label}>Pay type
          <select className={input} value={f.pay_type} onChange={(e) => set("pay_type", e.target.value)}>
            <option value="hourly">Hourly</option>
            <option value="salary">Salary</option>
          </select>
        </label>
        <label className={label}>{f.pay_type === "hourly" ? "Rate ($/hr)" : "Salary ($/yr)"}
          <input className={input} type="number" step="0.01" min="0" value={f.pay_rate} onChange={(e) => set("pay_rate", e.target.value)} />
        </label>
        <label className={label}>Pay schedule
          <input className={input} value={f.pay_schedule} onChange={(e) => set("pay_schedule", e.target.value)} />
        </label>
        <label className={label}>Job title
          <input className={input} value={f.job_title} onChange={(e) => set("job_title", e.target.value)} placeholder="Scooper, Shift lead, Sales…" />
        </label>
        <label className={label}>QBO employee id (eeid), if it already exists
          <input className={input} value={f.qbo_employee_id} onChange={(e) => set("qbo_employee_id", e.target.value)} />
        </label>
      </div>
      <div>
        <div className={label}>Pay types to add before the first run</div>
        <div className="mt-1 flex flex-wrap gap-3">
          {COMP_TYPES.map((c) => (
            <label key={c} className="text-xs text-slate-700 dark:text-slate-300 flex items-center gap-1">
              <input
                type="checkbox"
                checked={f.comp_types.includes(c)}
                onChange={(e) =>
                  set("comp_types", e.target.checked ? [...f.comp_types, c] : f.comp_types.filter((x) => x !== c))
                }
              />
              {c}
            </label>
          ))}
        </div>
      </div>
      {err && <div className="text-xs text-rose-500">{err}</div>}
      {ok && <div className="text-xs text-emerald-500">{ok}</div>}
      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={busy || !f.employee_id} className={primaryBtn}>
          {busy ? "Working…" : "Start payroll checklist"}
        </button>
      </div>
    </div>
  );
}

function OffboardingForm({
  me,
  employees,
  nameById,
}: {
  me: Profile;
  employees: Profile[];
  nameById: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [f, setF] = useState({
    employee_id: "",
    last_day: "",
    reason: OFFBOARD_REASONS[0] as string,
    reason_note: "",
    final_pay_note: FINAL_PAY_NOTE_DEFAULT,
    run_now: false,
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  async function submit() {
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const data = await post("/api/staffing", "POST", { kind: "offboarding", ...f });
      setOk(
        data.ran
          ? "Access removed. Finish the manual steps below."
          : "Recorded. Access removal waits for the last day; press Run on the record that day (or now).",
      );
      setConfirm(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const who = f.employee_id ? nameById[f.employee_id] : "";

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600 dark:text-slate-400">
        Bans the login, signs them out everywhere, drops manager access, marks them inactive
        and frees the fob, in that order. Then QuickBooks, Slack, Square, Google and final pay
        are steps to tick off. The account and every time entry are kept.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={label}>Person
          <select className={input} value={f.employee_id} onChange={(e) => set("employee_id", e.target.value)}>
            <option value="">Choose…</option>
            {employees
              .filter((p) => p.id !== me.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {nameById[p.id]}{p.active ? "" : " (inactive)"}
                </option>
              ))}
          </select>
        </label>
        <label className={label}>Last day
          <input className={input} type="date" value={f.last_day} onChange={(e) => set("last_day", e.target.value)} />
        </label>
        <label className={label}>Reason
          <select className={input} value={f.reason} onChange={(e) => set("reason", e.target.value)}>
            {OFFBOARD_REASONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className={label}>Note
          <input className={input} value={f.reason_note} onChange={(e) => set("reason_note", e.target.value)} placeholder="optional" />
        </label>
      </div>
      <label className={label}>Final-pay note (goes on the checklist)
        <textarea className={input} rows={3} value={f.final_pay_note} onChange={(e) => set("final_pay_note", e.target.value)} />
      </label>
      <label className="text-xs text-slate-700 dark:text-slate-300 flex items-center gap-2">
        <input type="checkbox" checked={f.run_now} onChange={(e) => set("run_now", e.target.checked)} />
        Remove access now even if the last day is still ahead
      </label>
      {err && <div className="text-xs text-rose-500">{err}</div>}
      {ok && <div className="text-xs text-emerald-500">{ok}</div>}
      <div className="flex justify-end items-center gap-3">
        {confirm && who && (
          <span className="text-xs text-rose-500">Offboard {who}? This bans their login.</span>
        )}
        {!confirm ? (
          <button type="button" onClick={() => setConfirm(true)} disabled={!f.employee_id || !f.last_day} className={primaryBtn}>
            Offboard
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setConfirm(false)} className={quietBtn}>Cancel</button>
            <button type="button" onClick={submit} disabled={busy} className="text-xs rounded-md bg-rose-600 text-white font-medium px-3 py-1.5 hover:bg-rose-500 disabled:opacity-50">
              {busy ? "Working…" : "Yes, offboard"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payable list
// ---------------------------------------------------------------------------

function PayableSection({ employees, nameById }: { employees: Profile[]; nameById: Record<string, string> }) {
  const active = employees.filter((p) => p.active);
  const notPayable = active.filter((p) => !p.has_workforce);
  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Payroll readiness</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
        Active people who have not finished QuickBooks Workforce self-setup are not payable.
        The Payroll setup form&apos;s last step marks it done.
      </p>
      {notPayable.length === 0 ? (
        <div className="text-sm text-emerald-500">Everyone active is marked payable.</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {notPayable.map((p) => (
            <span key={p.id} className="text-xs rounded-full border border-amber-400 text-amber-600 dark:text-amber-400 px-2.5 py-1">
              {nameById[p.id]}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function RecordCard({
  rec,
  nameById,
  collapsed = false,
}: {
  rec: LifecycleWithSteps;
  nameById: Record<string, string>;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(!collapsed);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const form = rec.form as Record<string, unknown>;
  const who =
    (rec.employee_id && nameById[rec.employee_id]) ||
    (form.legal_name as string) ||
    (form.employee_name as string) ||
    "—";
  const done = rec.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const pendingAuto = rec.steps.some((s) => s.mode === "auto" && (s.status === "pending" || s.status === "failed"));
  const failed = rec.steps.some((s) => s.status === "failed");

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/staffing/${rec.id}/run`, "POST", {});
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function setStatus(status: "open" | "cancelled") {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/staffing/${rec.id}`, "PATCH", { status });
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const when = (form.start_date ?? form.hire_date ?? form.last_day) as string | undefined;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span className="text-xs uppercase tracking-wide text-slate-500">{KIND_LABEL[rec.kind]}</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">{who}</span>
        {when && <span className="text-xs text-slate-500">{when}</span>}
        <span className="ml-auto text-xs text-slate-500">
          {done}/{rec.steps.length} steps
          {rec.status !== "open" && <span className="ml-2 capitalize">· {rec.status}</span>}
          {failed && <span className="ml-2 text-rose-500">· a step failed</span>}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2 border-t border-slate-200 dark:border-slate-800 pt-3">
          {rec.steps.map((s) => (
            <StepRow key={s.id} rec={rec} step={s} nameById={nameById} />
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {rec.status === "open" && pendingAuto && (
              <button type="button" onClick={run} disabled={busy} className={primaryBtn}>
                {busy ? "Running…" : failed ? "Retry automatic steps" : "Run automatic steps"}
              </button>
            )}
            {rec.status === "open" && (
              <button type="button" onClick={() => setStatus("cancelled")} disabled={busy} className={quietBtn}>
                Cancel record
              </button>
            )}
            {rec.status === "cancelled" && (
              <button type="button" onClick={() => setStatus("open")} disabled={busy} className={quietBtn}>
                Reopen
              </button>
            )}
            {msg && <span className="text-xs text-rose-500">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({
  rec,
  step,
  nameById,
}: {
  rec: LifecycleWithSteps;
  step: LifecycleStep;
  nameById: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [extra, setExtra] = useState("");
  const [expanded, setExpanded] = useState(step.status === "pending" || step.status === "failed");

  const needsExtra =
    step.key === "fob_assign" ? "fob_card_id" : step.key === "qbo_employee_record" ? "qbo_employee_id" : null;

  async function mark(skipped: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/staffing/${rec.id}/steps/${step.key}`, "PATCH", {
        note,
        skipped,
        fob_card_id: needsExtra === "fob_card_id" ? extra : undefined,
        qbo_employee_id: needsExtra === "qbo_employee_id" ? extra : undefined,
      });
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function reopen() {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/staffing/${rec.id}/steps/${step.key}`, "PATCH", { reopen: true });
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const badge =
    step.status === "done"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : step.status === "failed"
        ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
        : step.status === "skipped"
          ? "bg-slate-500/15 text-slate-500"
          : "bg-amber-500/15 text-amber-600 dark:text-amber-400";

  const d = step.detail ?? {};

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full text-left flex items-start gap-2">
        <span className={`shrink-0 text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 mt-0.5 ${badge}`}>
          {step.status}
        </span>
        <span className="text-sm text-slate-900 dark:text-slate-100 flex-1">
          <span className="text-slate-400 mr-1">{step.seq}.</span>
          {step.label}
          <span className="ml-2 text-[10px] uppercase text-slate-400">{step.mode}</span>
        </span>
      </button>
      {expanded && (
        <div className="mt-2 pl-1 space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
          {d.link && (
            <div>
              <a href={d.link} target="_blank" rel="noreferrer" className="text-emerald-600 dark:text-emerald-400 underline break-all">
                {d.link}
              </a>
              {d.recipient && <span className="ml-2 text-slate-500">→ {d.recipient}</span>}
            </div>
          )}
          {(d.lines ?? []).map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">{l}</div>
          ))}
          {d.reason && <div className="italic text-slate-500">Manual because {d.reason}.</div>}
          {step.result && (
            <div className={step.status === "failed" ? "text-rose-500" : "text-slate-700 dark:text-slate-300"}>
              {step.status === "failed" ? "Failed: " : "Result: "}
              {step.result}
            </div>
          )}
          {step.completed_at && (
            <div className="text-slate-500">
              {step.status} {new Date(step.completed_at).toLocaleString()}
              {step.completed_by && nameById[step.completed_by] ? ` by ${nameById[step.completed_by]}` : ""}
            </div>
          )}
          {step.mode === "manual" && rec.status === "open" && step.status === "pending" && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {needsExtra && (
                <input
                  className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 w-44"
                  placeholder={needsExtra === "fob_card_id" ? "fob card id" : "QBO employee id"}
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
              )}
              <input
                className="text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 flex-1 min-w-[160px]"
                placeholder="note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button type="button" onClick={() => mark(false)} disabled={busy} className={primaryBtn}>
                Mark done
              </button>
              <button type="button" onClick={() => mark(true)} disabled={busy} className={quietBtn}>
                Skip
              </button>
            </div>
          )}
          {step.mode === "manual" && rec.status !== "cancelled" && (step.status === "done" || step.status === "skipped") && (
            <button type="button" onClick={reopen} disabled={busy} className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline">
              Reopen
            </button>
          )}
          {err && <div className="text-rose-500">{err}</div>}
        </div>
      )}
    </div>
  );
}
