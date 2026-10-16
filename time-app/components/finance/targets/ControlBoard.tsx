"use client";

// The control board (the Targets tab, bj-finance #693; variant D of the
// prototype, accepted 2026-10-14). Categories are sections, each stored line
// has one review-by chip, and an owner changes a value in place. Clicking a
// line opens its detail in a sidebar: beside the table on desktop (the table
// narrows), full screen with a Back button under 768px. The sidebar is where
// a change is saved, with its as-of date, review-by date and notes; a change
// is a new dated value and the old one stays in the history.
//
// What the board shows is lib/controlBoard/board.ts (the categories, as data)
// over lib/controlBoard/math.ts (the derived numbers). Every derived number
// recomputes with unsaved changes, so an owner sees the effect before saving.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { boardSections, NOT_SET, EMPTY_CATEGORY, type BoardData, type Current, type Line, type StoredLine } from "@/lib/controlBoard/board";
import { trendFactor, type DailySalesRow, type MonthlySalesRow } from "@/lib/controlBoard/math";
import { money, pct, shortDate } from "@/lib/controlBoard/format";
import {
  addMonthsTo,
  groupBy,
  historyOf,
  inForce,
  settingSpec,
  settingsInForce,
  type FieldSpec,
  type SalaryRow,
  type SettingRow,
} from "@/lib/controlBoard/settings";
import type { SalariedProfile } from "@/lib/controlBoard/load";
import ReviewChip from "./ReviewChip";

type Props = {
  settings: SettingRow[];
  salaries: SalaryRow[];
  salaried: SalariedProfile[];
  monthly: MonthlySalesRow[];
  daily: DailySalesRow[];
  problems: string[];
  today: string;
  viewerIsOwner: boolean;
  teamHref: string;
};

type FieldValue = number | string | null;
/** Unsaved changes: setting key -> field name -> new value. */
type Drafts = Record<string, Record<string, FieldValue>>;

function savedField(row: SettingRow | undefined, f: FieldSpec): FieldValue {
  if (!row) return null;
  if (f.name === "value") return row.value;
  return row.detail[f.name] ?? null;
}

export default function ControlBoard({ settings, salaries, salaried, monthly, daily, problems, today, viewerIsOwner, teamHref }: Props) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Drafts>({});
  const [selected, setSelected] = useState<string | null>(null);

  const saved = useMemo(() => settingsInForce(settings, today), [settings, today]);
  const historyByKey = useMemo(() => groupBy(settings, "key"), [settings]);
  const salaryByPerson = useMemo(() => groupBy(salaries, "profile_id"), [salaries]);
  const trend = useMemo(() => trendFactor(today, monthly, daily), [today, monthly, daily]);

  // Is a field's draft different from what is saved?
  const fieldValue = (key: string, f: FieldSpec): FieldValue =>
    key in drafts && f.name in drafts[key] ? drafts[key][f.name] : savedField(saved.get(key), f);
  const isChanged = (key: string | null) => {
    if (!key || !(key in drafts)) return false;
    const spec = settingSpec(key);
    return !!spec?.fields.some((f) => f.name in drafts[key] && drafts[key][f.name] !== savedField(saved.get(key), f));
  };

  const data: BoardData = useMemo(() => {
    const values = new Map<string, Current>();
    for (const [key, row] of saved) values.set(key, { value: row.value, detail: { ...row.detail } });
    for (const [key, fields] of Object.entries(drafts)) {
      const spec = settingSpec(key);
      if (!spec) continue;
      const base = values.get(key) ?? { value: NaN, detail: {} };
      const next: Current = { value: base.value, detail: { ...base.detail } };
      for (const [name, v] of Object.entries(fields)) {
        if (name === "value") next.value = typeof v === "number" ? v : NaN;
        else next.detail[name] = v;
      }
      // A line with no main number yet counts as not set.
      if (Number.isFinite(next.value)) values.set(key, next);
      else values.delete(key);
    }
    return {
      values,
      saved,
      salaried: salaried.map((p) => ({ id: p.id, name: p.name, salary: inForce(salaryByPerson.get(p.id) ?? [], today) })),
      trend,
    };
  }, [saved, drafts, salaried, salaryByPerson, today, trend]);

  const sections = boardSections(data);
  const changedCount = Object.keys(drafts).filter((k) => isChanged(k)).length;

  const setField = (key: string, f: FieldSpec, v: FieldValue) => {
    setDrafts((d) => {
      const n = { ...d, [key]: { ...(d[key] ?? {}), [f.name]: v } };
      if (v === savedField(saved.get(key), f)) delete n[key][f.name];
      if (Object.keys(n[key]).length === 0) delete n[key];
      return n;
    });
  };
  const undoLine = (key: string) =>
    setDrafts((d) => {
      const n = { ...d };
      delete n[key];
      return n;
    });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const found = selected ? sections.flatMap((s) => s.lines.map((l) => ({ cat: s.cat, l }))).find((x) => x.l.id === selected) : undefined;
  const open = found && found.l.kind === "stored" ? { cat: found.cat, line: found.l } : null;
  const L = open ? WIDE.lg : WIDE.md;

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Control board</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 max-w-3xl">
          The targets the business runs to, and the numbers each one is built from. Each line has a review-by date: green is current, yellow is due within a month, red is past due. Click a line to see where its value came from and how it has changed.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {viewerIsOwner
            ? "You can change any value in a box. Save it from the line's panel with its as-of date and where it came from; the old value stays in the history."
            : "View only. Owners change these values."}
        </p>
      </div>

      {problems.map((p) => (
        <div key={p} className="mb-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          {p} The trend factor shows as missing until it can be read.
        </div>
      ))}

      {changedCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <span>
            {changedCount} value{changedCount === 1 ? "" : "s"} changed and not saved yet. Every total below uses the new numbers. Open a line to save it.
          </span>
          <button type="button" onClick={() => setDrafts({})} className="rounded border border-amber-400 px-2 py-0.5 text-xs hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/50">
            Undo all changes
          </button>
        </div>
      )}

      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className={`${L.header} px-3 py-2 text-xs text-slate-500 border-b border-slate-200 dark:border-slate-800`}>
            <div>Line</div>
            <div>Set to</div>
            <div className="text-right">Next 12 months</div>
            <div className="text-right">% of sales</div>
            <div className="text-right">Review by</div>
          </div>
          {sections.map(({ cat, lines }) => (
            <section key={cat.id} aria-labelledby={`cat-${cat.id}`}>
              <div className="bg-slate-50 dark:bg-slate-800/40 px-3 pt-3 pb-2 border-b border-slate-200 dark:border-slate-800">
                <h3 id={`cat-${cat.id}`} className="text-[11px] uppercase tracking-wide font-semibold text-slate-600 dark:text-slate-300">{cat.title}</h3>
                <p className="mt-0.5 text-xs text-slate-500">{cat.intro}</p>
              </div>
              {lines.length === 0 && <div className="px-3 py-3 text-sm text-slate-500">{EMPTY_CATEGORY}</div>}
              {lines.map((l) => (
                <Row
                  key={l.id}
                  line={l}
                  L={L}
                  today={today}
                  owner={viewerIsOwner}
                  fieldValue={fieldValue}
                  isChanged={l.kind === "stored" && isChanged(l.key)}
                  selected={selected === l.id}
                  related={l.kind === "computed" && !!l.opens && l.opens === selected}
                  onSelect={() => {
                    const target = l.kind === "stored" ? l.id : l.opens;
                    if (target) setSelected(target);
                  }}
                  onField={(key, f, v) => {
                    setField(key, f, v);
                    setSelected(key);
                  }}
                />
              ))}
            </section>
          ))}
        </div>

        {open && (
          <Detail
            key={open.line.id}
            category={open.cat.title}
            line={open.line}
            history={open.line.key ? historyOf(historyByKey.get(open.line.key) ?? []) : historyOf(salaryByPerson.get(open.line.id.replace(/^salary:/, "")) ?? [])}
            changed={isChanged(open.line.key)}
            today={today}
            owner={viewerIsOwner}
            teamHref={teamHref}
            fieldValue={fieldValue}
            onField={setField}
            onUndo={() => open.line.key && undoLine(open.line.key)}
            onSaved={() => {
              if (open.line.key) undoLine(open.line.key);
              router.refresh();
            }}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

// Two sets of responsive classes. Phones stack each line (label and chip,
// then the value, then the amounts). The wide five-column grid starts at md,
// or at lg while the sidebar is open beside the table and takes width away.
// Class names are spelled out in full so Tailwind finds them.
const WIDE = {
  md: {
    header: "hidden md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_7rem_5rem_6.5rem] md:gap-x-3",
    row: "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_7rem_5rem_6.5rem] md:items-center",
    order: "md:order-none",
    span: "col-span-2 md:col-span-1",
    empty: "hidden md:block",
    nums: "col-span-2 flex justify-end gap-3 text-xs md:contents md:text-sm",
    numCell: "md:text-right",
  },
  lg: {
    header: "hidden lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_7rem_5rem_6.5rem] lg:gap-x-3",
    row: "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_7rem_5rem_6.5rem] lg:items-center",
    order: "lg:order-none",
    span: "col-span-2 lg:col-span-1",
    empty: "hidden lg:block",
    nums: "col-span-2 flex justify-end gap-3 text-xs lg:contents lg:text-sm",
    numCell: "lg:text-right",
  },
};
type Layout = (typeof WIDE)["md"];

type FieldValueOf = (key: string, f: FieldSpec) => FieldValue;

const Missing = ({ needs }: { needs: string[] }) => (
  <span className="text-amber-700 dark:text-amber-400" title={`Needs: ${needs.join(", ")}`}>
    Missing: needs {needs.join(", ")}
  </span>
);

function Row({
  line: l, L, today, owner, fieldValue, isChanged, selected, related, onSelect, onField,
}: {
  line: Line; L: Layout; today: string; owner: boolean; fieldValue: FieldValueOf; isChanged: boolean;
  selected: boolean; related: boolean; onSelect: () => void; onField: (key: string, f: FieldSpec, v: FieldValue) => void;
}) {
  const clickable = l.kind === "stored" || !!l.opens;
  const tone = selected ? "bg-sky-50 dark:bg-sky-950/30" : related ? "bg-sky-50/50 dark:bg-sky-950/20" : clickable ? "hover:bg-slate-50 dark:hover:bg-slate-800/40" : "";
  const missing = l.kind === "computed" && l.needs.length > 0;
  const hasValue = l.kind === "stored" || !!l.basis || missing;
  const hasNums = l.amount != null || !!l.share;
  const pad = { paddingLeft: (l.indent ?? 0) * 14 };
  return (
    <div
      onClick={clickable ? onSelect : undefined}
      className={`${L.row} px-3 py-2 border-b border-slate-100 dark:border-slate-800/70 text-sm ${clickable ? "cursor-pointer" : ""} ${tone} ${l.total ? "font-semibold border-t border-t-slate-300 dark:border-t-slate-600" : ""}`}
    >
      <div className={`order-1 ${L.order} min-w-0 text-slate-800 dark:text-slate-200`} style={pad}>
        {clickable ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onSelect(); }} className="text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded-sm">
            {l.label}
          </button>
        ) : (
          <span>{l.label}</span>
        )}
        {l.note && <div className="text-[11px] font-normal text-slate-500 break-words">{l.note}</div>}
      </div>

      <div className={`order-3 ${L.order} ${L.span} ${hasValue ? "" : L.empty} min-w-0 text-xs font-normal text-slate-600 dark:text-slate-400`} style={pad}>
        {l.kind === "stored" ? (
          <StoredValue line={l} owner={owner} fieldValue={fieldValue} isChanged={isChanged} onField={onField} />
        ) : missing ? (
          <Missing needs={l.needs} />
        ) : (
          l.basis
        )}
      </div>

      <div className={`order-4 ${L.order} ${L.nums} ${hasNums ? "" : L.empty} font-mono tabular-nums`}>
        <span className={L.numCell}>{l.amount != null ? money(l.amount) : ""}</span>
        <span className={`${L.numCell} text-slate-600 dark:text-slate-400`}>{l.share}</span>
      </div>

      <div className={`order-2 ${L.order} text-right`}>
        {l.kind === "stored" && l.row && <ReviewChip reviewBy={l.row.review_by} today={today} compact />}
        {l.kind === "stored" && !l.row && <span className="text-[11px] text-slate-400">{NOT_SET}</span>}
      </div>
    </div>
  );
}

function StoredValue({ line: l, owner, fieldValue, isChanged, onField }: {
  line: StoredLine; owner: boolean; fieldValue: FieldValueOf; isChanged: boolean; onField: (key: string, f: FieldSpec, v: FieldValue) => void;
}) {
  const spec = l.key ? settingSpec(l.key) : undefined;
  const inline = spec?.fields.filter((f) => f.inline) ?? [];
  if (!spec || inline.length === 0 || !owner) {
    return (
      <span className="text-slate-700 dark:text-slate-300">
        {l.show ?? <span className="text-slate-400">{NOT_SET}</span>}
        {l.setElsewhere && <span className="ml-1.5 rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500 whitespace-nowrap">{l.setElsewhere}</span>}
      </span>
    );
  }
  const key = l.key as string;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {inline.map((f) =>
        // A wage cap left blank reads "on all wages"; it is added in the sidebar.
        f.name === "wage_cap" && fieldValue(key, f) == null ? (
          <span key={f.name} className="text-slate-500">on all wages</span>
        ) : (
          <FieldBox key={f.name} f={f} value={fieldValue(key, f)} changed={isChanged} onChange={(v) => onField(key, f, v)} />
        ),
      )}
      {isChanged && <span className="rounded bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-200">changed, not saved</span>}
    </span>
  );
}

const toShown = (f: FieldSpec, v: number) => (f.kind === "pct" ? v * 100 : v);
const fromShown = (f: FieldSpec, v: number) => (f.kind === "pct" ? Number((v / 100).toPrecision(12)) : v);
const showText = (f: FieldSpec, v: number) => Number(toShown(f, v).toFixed(f.digits)).toLocaleString("en-US", { maximumFractionDigits: f.digits });
const rawText = (f: FieldSpec, v: number) => String(Number(toShown(f, v).toFixed(f.digits)));

/** One box: a number (with $ or %), a time, or a short text. Blank is "not set" (a wage cap: "on all wages"). */
function FieldBox({ f, value, changed, onChange, big = false }: { f: FieldSpec; value: FieldValue; changed: boolean; onChange: (v: FieldValue) => void; big?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const skip = useRef(false);
  const numeric = f.kind !== "text" && f.kind !== "time";
  const prefix = f.kind === "money" || f.kind === "per100" ? "$" : "";
  const suffix = f.kind === "pct" ? "%" : "";
  const n = typeof value === "number" ? value : null;
  const width = !numeric ? "w-[8ch]" : f.kind === "money" && f.digits === 2 && (n ?? 0) >= 1000 ? "w-[11ch]" : f.kind === "money" && (n ?? 0) >= 1000 ? "w-[8ch]" : "w-[6ch]";
  const shown = numeric ? (n == null ? "" : showText(f, n)) : (value as string | null) ?? "";

  function commit() {
    if (skip.current) { skip.current = false; setDraft(null); return; }
    if (draft == null) return;
    const t = draft.trim();
    if (t === "") onChange(null);
    else if (!numeric) onChange(t);
    else {
      const x = Number(t.replace(/[$,%\s]/g, ""));
      if (Number.isFinite(x)) onChange(fromShown(f, x));
    }
    setDraft(null);
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {f.before && <span className="text-slate-500">{f.before}</span>}
      <span
        className={`inline-flex items-center rounded border px-1.5 ${big ? "py-1" : "py-0.5"} focus-within:ring-2 focus-within:ring-sky-400 ${
          changed ? "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40" : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-950"
        }`}
      >
        {prefix && <span className="text-slate-400">{prefix}</span>}
        <input
          aria-label={f.label}
          inputMode={numeric ? "decimal" : "text"}
          placeholder={f.kind === "time" ? "HH:MM" : f.optional ? "blank" : ""}
          value={draft ?? shown}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => { setDraft(numeric ? (n == null ? "" : rawText(f, n)) : shown); const t = e.currentTarget; requestAnimationFrame(() => t.select()); }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { skip.current = true; e.currentTarget.blur(); }
          }}
          className={`${big ? "w-[12ch] text-base" : `${width} text-sm`} bg-transparent text-right font-mono tabular-nums text-slate-900 dark:text-slate-100 outline-none placeholder:text-slate-300 dark:placeholder:text-slate-600`}
        />
        {suffix && <span className="text-slate-400">{suffix}</span>}
      </span>
      {f.after && <span className="text-slate-500">{f.after}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The sidebar (desktop) / full-screen panel (phones)
// ---------------------------------------------------------------------------

type HistoryRow = SettingRow | SalaryRow;

function historyText(line: StoredLine, h: HistoryRow): string {
  if ("annual_salary" in h) return `${money(h.annual_salary)} a year`;
  const spec = settingSpec(h.key);
  const main = spec?.fields.find((f) => f.name === "value");
  const parts = (spec?.fields ?? []).map((f) => {
    const v = f.name === "value" ? h.value : h.detail[f.name];
    if (v == null || v === "") return f.name === "wage_cap" ? "on all wages" : null;
    if (typeof v === "string") return `${f.label.toLowerCase()} ${v}`;
    const t = f.kind === "pct" ? pct(v, f.digits) : f.kind === "money" ? money(v, f.digits > 0) : f.kind === "per100" ? `$${v.toFixed(3)}` : String(v);
    return `${f.before ? `${f.before} ` : ""}${t}${f.after ? ` ${f.after}` : ""}`;
  });
  return parts.filter(Boolean).join(" ") || (main ? String(h.value) : line.label);
}

function Detail({
  category, line: l, history, changed, today, owner, teamHref, fieldValue, onField, onUndo, onSaved, onClose,
}: {
  category: string; line: StoredLine; history: HistoryRow[]; changed: boolean; today: string; owner: boolean; teamHref: string;
  fieldValue: FieldValueOf; onField: (key: string, f: FieldSpec, v: FieldValue) => void; onUndo: () => void; onSaved: () => void; onClose: () => void;
}) {
  const spec = l.key ? settingSpec(l.key) : undefined;
  const editable = owner && !!spec;
  const row = l.row;
  const inForceId = row?.id ?? null;
  return (
    <aside
      role="dialog"
      aria-label={`${l.label} detail`}
      className="fixed inset-0 z-[60] overflow-y-auto bg-white dark:bg-slate-950 md:z-auto md:sticky md:top-20 md:w-72 lg:w-80 md:shrink-0 md:max-h-[calc(100vh-6rem)] md:rounded-lg md:border md:border-slate-200 md:dark:border-slate-800 md:bg-white md:dark:bg-slate-900"
    >
      {/* Phones: a back bar across the top */}
      <div className="md:hidden sticky top-0 z-10 flex items-center border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-950/95 backdrop-blur px-2 py-2">
        <button type="button" onClick={onClose} className="flex items-center gap-1 rounded px-2 py-1 text-sm text-sky-700 dark:text-sky-400 hover:bg-slate-100 dark:hover:bg-slate-800">
          <span aria-hidden className="text-lg leading-none">‹</span> Back
        </button>
      </div>

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">{category}</div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 break-words">{l.label}</h3>
          </div>
          <button type="button" onClick={onClose} className="hidden md:block text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100" aria-label="Close detail">
            Close
          </button>
        </div>

        <div className="mt-3 text-lg font-mono text-slate-900 dark:text-slate-100 break-words">{l.show ?? NOT_SET}</div>
        {l.note && <div className="mt-0.5 text-xs text-slate-500 break-words">{l.note}</div>}

        {editable && spec && l.key && (
          <SaveForm
            settingKey={l.key}
            fields={spec.fields}
            row={row as SettingRow | null}
            changed={changed}
            today={today}
            fieldValue={fieldValue}
            onField={onField}
            onUndo={onUndo}
            onSaved={onSaved}
          />
        )}
        {!editable && (
          <p className="mt-3 text-xs text-slate-500">
            {l.setElsewhere ? (
              <>
                {l.setElsewhere}, so it is read only here.{" "}
                <a href={teamHref} className="underline">Open the Team page</a>
              </>
            ) : (
              "View only. Owners change this value."
            )}
          </p>
        )}

        {row && (
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-[11px] text-slate-500">Review by</dt>
              <dd className="mt-0.5"><ReviewChip reviewBy={row.review_by} today={today} /></dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">In force since</dt>
              <dd className="text-slate-800 dark:text-slate-200">{shortDate(row.effective_from)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">Where it came from</dt>
              <dd className="text-slate-800 dark:text-slate-200 break-words">{row.source}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">How it was worked out</dt>
              <dd className="text-slate-800 dark:text-slate-200 break-words">{row.method || "Not written down."}</dd>
            </div>
            {l.extra && <div className="text-xs text-slate-500 break-words">{l.extra}</div>}
          </dl>
        )}
        {!row && <p className="mt-4 text-xs text-slate-500">Nothing is in force today.{l.extra ? ` ${l.extra}` : ""}</p>}

        <div className="mt-5 text-[11px] uppercase tracking-wide text-slate-500 mb-2">History</div>
        <ol className="relative ml-1 space-y-3 border-l-2 border-slate-200 dark:border-slate-700">
          {history.map((h, i) => {
            const now = h.id === inForceId;
            const future = h.effective_from > today;
            const corrected = !now && !future && history.some((o, j) => j < i && o.effective_from === h.effective_from);
            return (
              <li key={h.id} className="relative pl-4">
                <span className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full ${now ? "bg-emerald-500" : future ? "bg-sky-400" : "bg-slate-300 dark:bg-slate-600"}`} />
                <div className="text-xs text-slate-500">
                  {shortDate(h.effective_from)}
                  {now ? " · in force now" : future ? " · not in force yet" : corrected ? " · corrected the same day" : ""}
                </div>
                <div className={`font-mono text-sm ${now ? "" : "text-slate-600 dark:text-slate-400"}`}>{historyText(l, h)}</div>
                <div className="text-xs text-slate-500 break-words">{h.source}</div>
              </li>
            );
          })}
          {history.length === 0 && <li className="pl-4 text-xs text-slate-500">No values on file.</li>}
        </ol>
      </div>
    </aside>
  );
}

const inputCls = "w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-sm text-slate-900 dark:text-slate-100";

function SaveForm({
  settingKey, fields, row, changed, today, fieldValue, onField, onUndo, onSaved,
}: {
  settingKey: string; fields: FieldSpec[]; row: SettingRow | null; changed: boolean; today: string;
  fieldValue: FieldValueOf; onField: (key: string, f: FieldSpec, v: FieldValue) => void; onUndo: () => void; onSaved: () => void;
}) {
  // A new value starts today unless the owner says otherwise; saving the same
  // value again (a review, or a better note) keeps the date it took effect.
  const [asOf, setAsOf] = useState<string | null>(null);
  const [reviewBy, setReviewBy] = useState(row && row.review_by > today ? row.review_by : addMonthsTo(today, 12));
  const [source, setSource] = useState(row?.source ?? "");
  const [method, setMethod] = useState(row?.method ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const effective = asOf ?? (changed || !row ? today : row.effective_from);

  async function save() {
    setErr(null);
    const values: Record<string, FieldValue> = {};
    for (const f of fields) values[f.name] = fieldValue(settingKey, f);
    const { value, ...detail } = values;
    setBusy(true);
    const res = await fetch("/api/payroll/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: settingKey, value, detail, effective_from: effective, review_by: reviewBy, source, method }),
    });
    setBusy(false);
    if (res.ok) {
      setAsOf(null);
      onSaved();
      return;
    }
    const body = await res.json().catch(() => ({}));
    setErr(body.error ?? `Save failed (${res.status}).`);
  }

  return (
    <div className="mt-3 rounded-md border border-slate-200 dark:border-slate-800 p-3 text-xs">
      <div className="mb-2 text-slate-500">{row ? "Change it" : "Set it"}</div>
      <div className="flex flex-col gap-2">
        {fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-0.5">
            <span className="text-slate-500">{f.label}{f.optional ? " (optional)" : ""}</span>
            <FieldBox f={f} value={fieldValue(settingKey, f)} changed={changed} onChange={(v) => onField(settingKey, f, v)} big />
          </label>
        ))}
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">In force from (as of)</span>
          <input type="date" value={effective} onChange={(e) => setAsOf(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">Review by</span>
          <input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">Where it came from</span>
          <textarea value={source} onChange={(e) => setSource(e.target.value)} rows={2} className={inputCls} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-500">How it was worked out (so it can be redone next year)</span>
          <textarea value={method} onChange={(e) => setMethod(e.target.value)} rows={2} className={inputCls} />
        </label>
      </div>
      <p className="mt-2 text-slate-500">Saving adds a new dated value. The old value stays in the history, and past months keep the value that was in force then.</p>
      {err && <p className="mt-2 text-rose-600 dark:text-rose-400">{err}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className="rounded-md bg-emerald-500 px-3 py-1 font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
        {changed && (
          <button type="button" onClick={onUndo} className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
            Undo this change
          </button>
        )}
      </div>
    </div>
  );
}
