"use client";

// PROTOTYPE — Email campaigns tab (v5, v6): "+ Add contacts" on the Cold tier.
//
// Two modes (v6):
//   * One contact (v5, unchanged): a working form that SAVES NOTHING. On
//     submit it runs a read-only duplicate and suppression check
//     (POST /api/email-campaigns/check-contact) and shows what WOULD happen:
//     no Apollo call, no database write.
//   * Upload a list: lists arrive in messy, unpredictable shapes, so a person
//     only submits the file with its source. It would become a PR in
//     Catering-Manager for the AFK Manager to map, dedupe, suppression-screen
//     and load. The prototype reads nothing from the file, uploads nothing and
//     opens no PR: it only shows what would happen.

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

type Mode = "one" | "list";

export default function AddContactForm({ categories, sourcedBy }: { categories: Cat[]; sourcedBy: string }) {
  const [mode, setMode] = useState<Mode>("one");
  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={`rounded px-2.5 py-1 text-xs ${
        mode === m ? "bg-slate-700 font-medium text-slate-100" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="How to add" className="inline-flex gap-0.5 rounded-md border border-slate-700 p-0.5">
        {tab("one", "One contact")}
        {tab("list", "Upload a list")}
      </div>
      {mode === "one" ? (
        <OneContactForm categories={categories} sourcedBy={sourcedBy} />
      ) : (
        <UploadListForm categories={categories} sourcedBy={sourcedBy} />
      )}
    </div>
  );
}

function OneContactForm({ categories, sourcedBy }: { categories: Cat[]; sourcedBy: string }) {
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

// --- Upload a list (v6) -----------------------------------------------------------

const IMPORT_REPO = "BenJerrysUpenn/Catering-Manager";

const slug = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "list";

/** YYYY-MM-DD in Philadelphia time. */
const phillyDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

type Submitted = {
  fileName: string;
  path: string;
  meta: Record<string, string | null>;
  categoryLabel: string | null;
};

function UploadListForm({ categories, sourcedBy }: { categories: Cat[]; sourcedBy: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Submitted | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file) return setError("Choose a file.");
    if (!source.trim()) return setError("Say where the list came from.");
    const now = new Date();
    const dot = file.name.lastIndexOf(".");
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "csv";
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const who = slug(sourcedBy.includes("@") ? sourcedBy.split("@")[0] : sourcedBy);
    const path = `outreach/imports/${phillyDate(now)}-${who}-${slug(base)}.${ext}`;
    const catLabel = categories.find((c) => c.key === category)?.label ?? null;
    // Nothing is read from the file and nothing is uploaded: only its name is used.
    setDone({
      fileName: file.name,
      path,
      categoryLabel: catLabel,
      meta: {
        source: source.trim(),
        category: category || null,
        notes: notes.trim() || null,
        sourced_by: sourcedBy,
        uploaded_at: now.toISOString(),
      },
    });
  };

  if (done) {
    const sidecar = done.path.replace(/\.[^.]+$/, ".meta.json");
    return (
      <div className="space-y-3">
        <div className="rounded border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Prototype: nothing was uploaded and no PR was opened. This is what would happen.
        </div>
        <div className="rounded-md border border-slate-700 bg-slate-950/60 p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Submitted for processing: {done.fileName}
          </div>
          <ol className="space-y-2">
            <Step n={1} tone="ok">
              Would open a PR in {IMPORT_REPO}:{" "}
              <span className="font-mono text-[12px] text-slate-100">
                Contact list import: {done.fileName} (sourced by {sourcedBy})
              </span>
              , adding the file at <span className="font-mono text-[12px] text-slate-100">{done.path}</span> with a
              small metadata sidecar (source, category, notes, sourced_by, uploaded_at), labelled for the AFK
              Manager.
              <pre className="mt-1.5 overflow-x-auto rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-[11px] leading-snug text-slate-300">
                {`${sidecar}\n${JSON.stringify(done.meta, null, 2)}`}
              </pre>
            </Step>
            <Step n={2} tone="warn">
              The AFK Manager maps the columns, removes duplicates and suppressed addresses, flags rows that need an
              Apollo lookup (credits need approval), and loads the rest into Cold
              {done.categoryLabel ? ` › ${done.categoryLabel}` : ""} with sourced_by kept for attribution.
            </Step>
          </ol>
          <div className="mt-2 text-[11px] text-slate-500">Prototype: nothing above was saved, uploaded or sent.</div>
        </div>
        <button
          type="button"
          onClick={() => {
            setDone(null);
            setFile(null);
          }}
          className="text-xs text-slate-400 underline decoration-slate-600 hover:text-slate-200"
        >
          Submit another list
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        Prototype: nothing is uploaded and no PR is opened. Submitting only shows what would happen.
      </div>
      <p className="text-xs text-slate-400">
        Any shape of list is fine (CSV or Excel). You don&apos;t need to tidy or map the columns: the AFK Manager
        does that, removes duplicates and suppressed addresses, and asks before spending Apollo credits.
      </p>
      <form onSubmit={submit} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="File" hint="CSV or XLSX">
            <input
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-700 file:px-2.5 file:py-1 file:text-xs file:text-slate-100 hover:file:bg-slate-600"
            />
          </Field>
        </div>
        <Field label="Source">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="LinkedIn export, Chamber of Commerce directory…"
            className={input}
          />
        </Field>
        <Field label="Default category" hint="optional">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
            <option value="">None: the processor decides per row</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes for the processor" hint="optional">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. column C is the contact's title; skip the rows marked 'retired'"
              className={input}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <span className="text-[11px] text-slate-400">
            Sourced by: <span className="text-slate-200">{sourcedBy}</span>
            <span className="ml-1 text-slate-600">(read-only)</span>
          </span>
          <button
            type="submit"
            className="ml-auto rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
          >
            Submit for processing
          </button>
        </div>
        {error ? <div className="text-xs text-rose-300 sm:col-span-2">{error}</div> : null}
      </form>
    </div>
  );
}
