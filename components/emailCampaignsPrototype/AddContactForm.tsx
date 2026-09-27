"use client";

// PROTOTYPE — Email campaigns tab (v5): "+ Add contacts" on the Cold tier.
//
// A working form that SAVES NOTHING. On submit it runs a read-only duplicate
// and suppression check (POST /api/email-campaigns/check-contact) and shows
// what WOULD happen: no Apollo call, no database write.

import { useState } from "react";
import type { CheckResult } from "@/app/api/email-campaigns/check-contact/route";

type Cat = { key: string; label: string };
type Draft = {
  name: string;
  company: string;
  title: string;
  linkedin: string;
  email: string;
  category: string;
  notes: string;
};

const input =
  "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-slate-400">
        {label}
        {hint ? <span className="ml-1 text-slate-600">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function Step({ n, tone, children }: { n: number; tone: "ok" | "warn" | "stop"; children: React.ReactNode }) {
  const dot = tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-rose-500";
  return (
    <li className="flex gap-2">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-slate-950 ${dot}`}
      >
        {n}
      </span>
      <div className="min-w-0 text-[13px] leading-snug text-slate-200">{children}</div>
    </li>
  );
}

export default function AddContactForm({ categories, sourcedBy }: { categories: Cat[]; sourcedBy: string }) {
  const [d, setD] = useState<Draft>({
    name: "",
    company: "",
    title: "",
    linkedin: "",
    email: "",
    category: categories[0]?.key ?? "",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ draft: Draft; check: CheckResult } | null>(null);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setD({ ...d, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!d.email.trim() && !d.linkedin.trim()) {
      setError("Give an email or a LinkedIn URL.");
      return;
    }
    if (d.linkedin.trim() && !/linkedin\.com\/(in|pub)\//i.test(d.linkedin)) {
      setError("That does not look like a LinkedIn profile URL (linkedin.com/in/…).");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/email-campaigns/check-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: d.email, linkedin: d.linkedin }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setResult({ draft: d, check: j as CheckResult });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const catLabel = (k: string) => categories.find((c) => c.key === k)?.label ?? k;

  return (
    <div className="space-y-3">
      <div className="rounded border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        Prototype: nothing is saved and Apollo is not called. Submitting only runs a read-only duplicate check and
        shows what would happen.
      </div>

      <form onSubmit={submit} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Name">
          <input required value={d.name} onChange={set("name")} placeholder="First Last" className={input} />
        </Field>
        <Field label="Company">
          <input value={d.company} onChange={set("company")} className={input} />
        </Field>
        <Field label="Title">
          <input value={d.title} onChange={set("title")} placeholder="Office Manager" className={input} />
        </Field>
        <Field label="Category">
          <select value={d.category} onChange={set("category")} className={input}>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="LinkedIn URL">
          <input
            value={d.linkedin}
            onChange={set("linkedin")}
            placeholder="https://www.linkedin.com/in/…"
            className={input}
          />
        </Field>
        <Field label="Email" hint="optional">
          <input type="email" value={d.email} onChange={set("email")} className={input} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes">
            <textarea value={d.notes} onChange={set("notes")} rows={2} className={input} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <span className="text-[11px] text-slate-400">
            Sourced by: <span className="text-slate-200">{sourcedBy}</span>
            <span className="ml-1 text-slate-600">(read-only)</span>
          </span>
          <button
            type="submit"
            disabled={busy}
            className="ml-auto rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Add contact (prototype)"}
          </button>
        </div>
        {error ? <div className="text-xs text-rose-300 sm:col-span-2">{error}</div> : null}
      </form>

      {result ? <Outcome r={result} catLabel={catLabel} sourcedBy={sourcedBy} /> : null}
    </div>
  );
}

function Outcome({
  r,
  catLabel,
  sourcedBy,
}: {
  r: { draft: Draft; check: CheckResult };
  catLabel: (k: string) => string;
  sourcedBy: string;
}) {
  const { draft, check } = r;
  const dup = check.matches.length > 0;
  const blocked = dup || !!check.suppressed;
  const hasEmail = !!draft.email.trim();
  let n = 0;
  return (
    <div className="rounded-md border border-slate-700 bg-slate-950/60 p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        What would happen for {draft.name || "this contact"}
      </div>
      <ol className="space-y-2">
        <Step n={++n} tone={dup ? "stop" : "ok"}>
          {dup ? (
            <>
              Already a prospect:{" "}
              {check.matches.map((m, i) => (
                <span key={m.id}>
                  {i ? "; " : ""}#{m.id} {m.name ?? "(no name)"} ({m.engine ?? "no tier"}, {m.status}), matched on {m.on}
                </span>
              ))}
              . Would not be added again.
            </>
          ) : (
            <>
              Duplicate check: no existing prospect with this {hasEmail ? "email" : ""}
              {hasEmail && check.linkedinKey ? " or " : ""}
              {check.linkedinKey ? "LinkedIn URL" : ""}.
            </>
          )}
          <div className="text-[11px] text-slate-500">
            Read-only lookup in outreach_prospects
            {check.linkedinKey
              ? `; there is no LinkedIn column yet, so ${check.linkedinKey} was looked for in website, notes and source`
              : ""}
            .
          </div>
        </Step>
        <Step n={++n} tone={check.suppressed ? "stop" : "ok"}>
          {check.suppressed ? (
            <>
              On the suppression list{check.suppressed.reason ? ` (${check.suppressed.reason})` : ""}. Would not be
              added.
            </>
          ) : hasEmail ? (
            <>Suppression check: not on the suppression list.</>
          ) : (
            <>Suppression check: runs on the email once Apollo finds it.</>
          )}
        </Step>
        {!blocked ? (
          hasEmail ? (
            <Step n={++n} tone="ok">
              Email given, so no Apollo credit is needed.
            </Step>
          ) : (
            <Step n={++n} tone="warn">
              No email: Apollo can find the email from the LinkedIn URL (1 credit), queued for approval.
            </Step>
          )
        ) : null}
        <Step n={++n} tone={blocked ? "stop" : "ok"}>
          {blocked ? (
            <>Not added.</>
          ) : (
            <>
              {!hasEmail ? <span className="text-slate-400">Once Apollo finds the email: </span> : null}
              added to <span className="font-medium">Cold › {catLabel(draft.category)}</span> · Up next · sourced by{" "}
              {sourcedBy} (kept until they book, for attribution)
            </>
          )}
        </Step>
      </ol>
      <div className="mt-2 text-[11px] text-slate-500">Prototype: nothing above was saved or sent.</div>
    </div>
  );
}
