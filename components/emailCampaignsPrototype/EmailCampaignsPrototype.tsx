"use client";

// PROTOTYPE — Email campaigns tab. Throwaway UI on branch
// prototype/email-campaigns. v2 after the owners' review: one layout (the
// owners' sketch: Cold, Warm and Offer tier containers side by side, an
// Everyone card on top of each, category cards beneath, volume at the
// bottom). The v1 "Ledger" table variant was dropped: it existed to show the
// accounting, which the owners asked to hide.
//
// Client-only prototype state: the per-tier cadence (useState) and card notes
// (localStorage, this browser only). Nothing is written to the database.

import { useCallback, useEffect, useState } from "react";
import {
  CADENCES,
  JUST_EMAILED_DAYS,
  WEEKDAYS_PER_MONTH,
  cadenceOf,
  statesAt,
  volumeAt,
  type Cadence,
  type CategoryStat,
  type Payload,
  type Person,
  type Tag,
  type TierPayload,
} from "@/lib/emailCampaignsPrototype/model";

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

// --- small pieces -------------------------------------------------------------

const TAG_DOT: Record<Tag, string> = {
  live: "bg-emerald-500",
  derived: "bg-sky-500",
  static: "bg-violet-500",
  mock: "bg-amber-500",
};
const TAG_HELP: Record<Tag, string> = {
  live: "Read straight from the database.",
  derived: "Worked out by this page from database columns.",
  static: "Hard-coded in the prototype.",
  mock: "Placeholder: nothing real behind it yet.",
};

function TagPill({ tag }: { tag: Tag }) {
  return (
    <span
      title={TAG_HELP[tag]}
      className="inline-flex items-center gap-0.5 align-middle text-[9px] font-normal lowercase leading-none text-slate-500"
    >
      <span className={`h-1 w-1 rounded-full opacity-70 ${TAG_DOT[tag]}`} />
      {tag}
    </span>
  );
}

function Tip({
  text,
  children,
  align = "left",
  className = "",
}: {
  text: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-1 hidden w-max max-w-[280px] rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] font-normal normal-case leading-snug tracking-normal text-slate-200 shadow-lg group-hover/tip:block group-focus-within/tip:block ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {text}
      </span>
    </span>
  );
}

const STATE_HELP = {
  upNext: "Never emailed in this tier, or due again (last emailed longer ago than the tier's cadence).",
  justEmailed: `Emailed in the last ${JUST_EMAILED_DAYS} days: the window for replies and a follow-up call.`,
  resting: "Emailed and not due again yet at this tier's cadence.",
  held: "Part of Resting. Can't be emailed yet, for the reason shown.",
};

function Unaccounted({ n }: { n: number }) {
  if (n <= 0) return null;
  return <div className="text-[11px] text-rose-400">numbers don&apos;t add up: {fmt(n)} unaccounted</div>;
}

// --- notes (prototype: localStorage, this browser only) -----------------------

type Note = { text: string; at: string };
const NOTE_PREFIX = "email-campaigns-proto:note:v1:";
const SEED_NOTES: Record<string, Note> = {
  "offer:tier": {
    text: "Offer lane not built yet. Sending method TBD (mass email / Kit).",
    at: "2026-09-27T12:00:00.000Z",
  },
};

function useNote(id: string): [Note | null, (n: Note | null) => void] {
  const [note, setNote] = useState<Note | null>(SEED_NOTES[id] ?? null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(NOTE_PREFIX + id);
      if (raw !== null) setNote(JSON.parse(raw) as Note | null);
    } catch {
      /* storage blocked: keep the seed */
    }
  }, [id]);
  const save = useCallback(
    (n: Note | null) => {
      setNote(n);
      try {
        // null is stored too, so a deleted seed note stays deleted.
        window.localStorage.setItem(NOTE_PREFIX + id, JSON.stringify(n));
      } catch {
        /* storage blocked: the note lives until reload */
      }
    },
    [id],
  );
  return [note, save];
}

function NoteButton({ onClick, has }: { onClick: () => void; has: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={has ? "Edit note" : "Add a note"}
      className="shrink-0 rounded px-1 text-[11px] leading-5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
    >
      ✎{has ? "" : " note"}
    </button>
  );
}

function NoteArea({
  note,
  editing,
  setEditing,
  save,
}: {
  note: Note | null;
  editing: boolean;
  setEditing: (b: boolean) => void;
  save: (n: Note | null) => void;
}) {
  const [draft, setDraft] = useState(note?.text ?? "");
  useEffect(() => {
    if (editing) setDraft(note?.text ?? "");
  }, [editing, note]);
  if (editing) {
    return (
      <div className="space-y-1">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          maxLength={280}
          placeholder="Offer lane: mass email, maybe Kit, TBD"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
        />
        <div className="flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => {
              const t = draft.trim();
              save(t ? { text: t, at: new Date().toISOString() } : null);
              setEditing(false);
            }}
            className="rounded bg-slate-700 px-2 py-0.5 text-slate-100 hover:bg-slate-600"
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-200">
            Cancel
          </button>
          {note ? (
            <button
              type="button"
              onClick={() => {
                save(null);
                setEditing(false);
              }}
              className="text-slate-500 hover:text-rose-300"
            >
              Remove
            </button>
          ) : null}
          <span className="ml-auto text-slate-600">saved in this browser only</span>
        </div>
      </div>
    );
  }
  if (!note) return null;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="w-full rounded border-l-2 border-amber-500/60 bg-amber-500/5 px-2 py-1 text-left text-[11px] leading-snug text-amber-100/90 hover:bg-amber-500/10"
    >
      {note.text}
      <span className="ml-1.5 text-amber-200/40">
        {new Date(note.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
      </span>
    </button>
  );
}

// --- drill-downs --------------------------------------------------------------

type StateKey = "upNext" | "justEmailed" | "resting" | "held" | "unaccounted";
const STATE_LABEL: Record<StateKey, string> = {
  upNext: "Up next",
  justEmailed: "Just emailed",
  resting: "Resting",
  held: "Held",
  unaccounted: "Unaccounted",
};

type Drill =
  | { kind: "people"; tier: TierPayload; cat: CategoryStat; state: StateKey; cadence: Cadence }
  | { kind: "sequence"; tier: TierPayload };

function peopleIn(cat: CategoryStat, state: StateKey, cadence: Cadence): Person[] {
  const period = cadenceOf(cadence).periodDays;
  const s = cat.sample;
  switch (state) {
    case "upNext":
      return [...s.dueOldest.filter((p) => (p.age_days ?? 0) >= period), ...s.fresh];
    case "justEmailed":
      return s.just_emailed;
    case "resting":
      return [...s.dueNewest.filter((p) => (p.age_days ?? 0) < period), ...s.resting, ...s.held];
    case "held":
      return s.held;
    case "unaccounted":
      return s.unaccounted;
  }
}

function PeopleModal({
  drill,
  onClose,
  setState,
}: {
  drill: Extract<Drill, { kind: "people" }>;
  onClose: () => void;
  setState: (s: StateKey) => void;
}) {
  const { tier, cat, state, cadence } = drill;
  const st = statesAt(cat, cadence);
  const counts: Record<StateKey, number> = {
    upNext: st.upNext,
    justEmailed: st.justEmailed,
    resting: st.resting,
    held: st.held,
    unaccounted: st.unaccounted,
  };
  const rows = peopleIn(cat, state, cadence).slice(0, 120);
  const tabs = (Object.keys(STATE_LABEL) as StateKey[]).filter((k) => k !== "unaccounted" || counts[k] > 0);
  return (
    <Modal onClose={onClose} title={`${tier.label} · ${cat.label}`}>
      <div className="mb-2 flex flex-wrap gap-1">
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setState(k)}
            className={`rounded-md border px-2 py-1 text-xs ${
              k === state
                ? "border-slate-600 bg-slate-800 text-slate-100"
                : "border-slate-800 text-slate-400 hover:text-slate-200"
            } ${k === "unaccounted" ? "text-rose-300" : ""}`}
          >
            {STATE_LABEL[k]} {fmt(counts[k])}
          </button>
        ))}
      </div>
      <p className="mb-2 text-[11px] text-slate-500">
        {k2help(state)} Showing {fmt(rows.length)} of {fmt(counts[state])}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-medium">Name</th>
              <th className="py-1 pr-3 font-medium">Email</th>
              <th className="py-1 pr-3 font-medium">Last emailed</th>
              <th className="py-1 pr-3 font-medium">Why here</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-slate-800 text-slate-300">
                <td className="whitespace-nowrap py-1 pr-3">{p.name}</td>
                <td className="py-1 pr-3">{p.email ?? <span className="text-slate-600">none yet</span>}</td>
                <td className="whitespace-nowrap py-1 pr-3">
                  {p.last_touch
                    ? new Date(p.last_touch).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    : "never"}
                </td>
                <td className="py-1 pr-3 text-slate-400">{p.why}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-center text-slate-500">
                  Nobody here.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function k2help(s: StateKey): string {
  if (s === "upNext") return STATE_HELP.upNext;
  if (s === "justEmailed") return STATE_HELP.justEmailed;
  if (s === "resting") return STATE_HELP.resting;
  if (s === "held") return STATE_HELP.held;
  return "People in a state this page does not know about.";
}

function SequenceModal({ tier, onClose }: { tier: TierPayload; onClose: () => void }) {
  const s = tier.sequence;
  return (
    <Modal onClose={onClose} title={`${tier.label} · Everyone · sequence`}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-100">{s.name}</span>
          <TagPill tag={s.tag} />
        </div>
        <ol className="flex flex-wrap items-center gap-2">
          {s.steps === 0 ? (
            <li className="rounded-md border border-dashed border-slate-600 px-3 py-2 text-xs text-slate-400">No steps yet</li>
          ) : (
            Array.from({ length: s.steps }, (_, i) => (
              <li key={i} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300">
                Step {i + 1}: email
              </li>
            ))
          )}
        </ol>
        <p className="text-xs text-slate-400">{s.note}</p>
        {s.url ? (
          <a href={s.url} target="_blank" rel="noreferrer" className="inline-block text-xs text-sky-400 hover:underline">
            Open {tier.key === "cold" ? "in Apollo" : "the template"} ↗
          </a>
        ) : null}
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-slate-100">{title}</h3>
          <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// --- sequences ----------------------------------------------------------------

function SequenceDots({ tier, onClick }: { tier: TierPayload; onClick: () => void }) {
  const s = tier.sequence;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open the sequence"
      className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-800"
    >
      {s.steps === 0 ? (
        <span className="h-2.5 w-2.5 rounded-full border border-dashed border-slate-500" />
      ) : (
        Array.from({ length: s.steps }, (_, i) => <span key={i} className="h-2.5 w-2.5 rounded-full bg-sky-400" />)
      )}
      <span className="ml-1 whitespace-nowrap text-[11px] text-slate-400">
        {s.steps === 0 ? s.name : `${s.steps} ${plural(s.steps, "email")} · ${s.name}`}
      </span>
      <span className="ml-1">
        <TagPill tag={s.tag} />
      </span>
    </button>
  );
}

function NoSequence() {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-slate-500">
      <span className="h-2.5 w-2.5 rounded-full border border-dashed border-slate-600" />
      <span className="whitespace-nowrap">No sequence yet</span>
      <Tip text="Not built yet: per-category sequences are a future step." align="right" className="ml-auto">
        <span
          role="button"
          aria-disabled="true"
          className="cursor-not-allowed whitespace-nowrap rounded border border-dashed border-slate-700 px-1.5 py-px text-slate-600"
        >
          + add sequence
        </span>
      </Tip>
    </div>
  );
}

// --- cards --------------------------------------------------------------------

function StateStat({
  label,
  help,
  n,
  onClick,
  big,
  align,
}: {
  label: string;
  help: string;
  n: number;
  onClick: () => void;
  big?: boolean;
  align?: "left" | "right";
}) {
  return (
    <button type="button" onClick={onClick} className="min-w-0 rounded px-1.5 py-1 text-left hover:bg-slate-800">
      <div className={`${big ? "text-2xl" : "text-lg"} font-semibold tabular-nums text-slate-100`}>{fmt(n)}</div>
      <Tip text={help} align={align}>
        <span className="whitespace-nowrap border-b border-dotted border-slate-600 text-[11px] text-slate-400">{label}</span>
      </Tip>
    </button>
  );
}

function EveryoneCard({
  tier,
  cadence,
  open,
}: {
  tier: TierPayload;
  cadence: Cadence;
  open: (d: Drill) => void;
}) {
  const e = tier.everyone;
  const st = statesAt(e, cadence);
  const [note, saveNote] = useNote(`${tier.key}:everyone`);
  const [editing, setEditing] = useState(false);
  const people = (state: StateKey) => () => open({ kind: "people", tier, cat: e, state, cadence });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/80 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold leading-tight text-slate-100">
          Everyone <span className="text-sm font-normal text-slate-400">· {fmt(e.total)} people</span>{" "}
          <TagPill tag={e.tag} />
        </div>
        <NoteButton has={!!note} onClick={() => setEditing(true)} />
      </div>

      <div className="grid grid-cols-3 gap-1">
        <StateStat label="Up next" help={STATE_HELP.upNext} n={st.upNext} onClick={people("upNext")} big />
        <StateStat label="Just emailed" help={STATE_HELP.justEmailed} n={st.justEmailed} onClick={people("justEmailed")} big />
        <StateStat label="Resting" help={STATE_HELP.resting} n={st.resting} onClick={people("resting")} big align="right" />
      </div>

      {e.heldReasons.length ? (
        <div className="space-y-0.5 border-l border-slate-700 pl-2">
          {e.heldReasons.map((r) => (
            <button
              key={r.why}
              type="button"
              onClick={people("held")}
              className="block text-left text-[11px] leading-snug text-slate-400 hover:text-slate-200"
            >
              <span className="font-medium tabular-nums text-slate-200">{fmt(r.n)} held</span>: {r.label}
            </button>
          ))}
        </div>
      ) : null}

      {e.upNextSplit ? (
        <div className="text-[11px] text-slate-500">
          Up next: {e.upNextSplit.map((q) => `${fmt(q.n)} ${q.label}`).join(" · ")}
        </div>
      ) : null}

      {e.sources ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
          <span className="text-slate-500">From</span>
          {e.sources.map((s, i) => (
            <span key={s.label} className="whitespace-nowrap">
              {i ? <span className="mr-2 text-slate-600">·</span> : null}
              {s.label} <span className="tabular-nums text-slate-200">{fmt(s.n)}</span>{" "}
              {s.tag === "mock" ? <TagPill tag="mock" /> : null}
            </span>
          ))}
          <Tip
            text="Future: a teammate adds LinkedIn contacts; Apollo can find the email from the LinkedIn URL."
            align="right"
            className="ml-auto"
          >
            <span
              role="button"
              aria-disabled="true"
              className="cursor-not-allowed whitespace-nowrap rounded border border-dashed border-slate-700 px-1.5 py-px text-slate-500"
            >
              + Add contacts (LinkedIn, lists)
            </span>
          </Tip>
        </div>
      ) : null}

      <Unaccounted n={st.unaccounted} />
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-1.5">
        <SequenceDots tier={tier} onClick={() => open({ kind: "sequence", tier })} />
      </div>
      <NoteArea note={note} editing={editing} setEditing={setEditing} save={saveNote} />
    </div>
  );
}

function CategoryCard({
  tier,
  cat,
  cadence,
  open,
}: {
  tier: TierPayload;
  cat: CategoryStat;
  cadence: Cadence;
  open: (d: Drill) => void;
}) {
  const st = statesAt(cat, cadence);
  const [note, saveNote] = useNote(`${tier.key}:${cat.key}`);
  const [editing, setEditing] = useState(false);
  const people = (state: StateKey) => () => open({ kind: "people", tier, cat, state, cadence });
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-md border ${
        st.unaccounted ? "border-rose-800" : "border-slate-800"
      } bg-slate-900/60 p-2.5`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 text-sm font-medium leading-tight text-slate-100">{cat.label}</div>
        <NoteButton has={!!note} onClick={() => setEditing(true)} />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <button type="button" onClick={people("upNext")} className="rounded px-0.5 text-left hover:bg-slate-800">
          <span className="text-xl font-semibold tabular-nums text-slate-100">{fmt(st.upNext)}</span>
        </button>
        <Tip text={STATE_HELP.upNext}>
          <span className="whitespace-nowrap border-b border-dotted border-slate-600 text-[11px] text-slate-400">up next</span>
        </Tip>
        <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-slate-500">
          of {fmt(cat.total)} <TagPill tag={cat.tag} />
        </span>
      </div>
      <div className="flex flex-wrap gap-x-2 text-[11px] text-slate-400">
        <button type="button" onClick={people("justEmailed")} className="hover:text-slate-200">
          <span className="tabular-nums text-slate-300">{fmt(st.justEmailed)}</span> just emailed
        </button>
        <button type="button" onClick={people("resting")} className="hover:text-slate-200">
          <span className="tabular-nums text-slate-300">{fmt(st.resting)}</span> resting
          {st.held ? <span className="text-slate-500"> ({fmt(st.held)} held)</span> : null}
        </button>
      </div>
      <Unaccounted n={st.unaccounted} />
      <div className="mt-auto pt-0.5">
        <NoSequence />
      </div>
      <NoteArea note={note} editing={editing} setEditing={setEditing} save={saveNote} />
    </div>
  );
}

// --- volume -------------------------------------------------------------------

function Volume({
  tier,
  cadence,
  setCadence,
}: {
  tier: TierPayload;
  cadence: Cadence;
  setCadence: (c: Cadence) => void;
}) {
  const v = volumeAt(tier, cadence);
  const cap = tier.capacity;
  const cad = cadenceOf(cadence);
  const unit = cap.unit === "weekday" ? "weekday" : "month";
  const people = tier.everyone.total;
  const max = Math.max(v.needed, v.capacity, 1);

  const neededFormula =
    cadence === "daily"
      ? `Daily (capped): send at capacity every weekday, so needed = capacity.`
      : cap.unit === "weekday"
        ? `Needed = ${fmt(people)} people ÷ ${cad.weekdays} sending ${plural(cad.weekdays, "weekday")} per period = ${fmt(v.needed)} a weekday.`
        : `Needed = ${fmt(people)} people ÷ ${cad.weekdays} sending ${plural(cad.weekdays, "weekday")} per period × ${WEEKDAYS_PER_MONTH} weekdays a month = ${fmt(v.needed)} a month.`;
  const capFormula = `Capacity = ${cap.mailboxes} ${plural(cap.mailboxes, "mailbox", "mailboxes")} × ${cap.perMailboxDay}/day${
    cap.capDay !== null ? `, capped at ${cap.capDay}/day` : ""
  }${cap.unit === "month" ? ` × ${WEEKDAYS_PER_MONTH} weekdays` : ""} = ${fmt(v.capacity)}. ${cap.source}`;

  let verdict: React.ReactNode = null;
  if (cadence === "daily") {
    verdict =
      v.capDay > 0 ? (
        <span className="text-slate-300">
          Sends {fmt(v.capDay)} a weekday: reaches everyone once every {fmt(v.cycleWeekdays)} weekdays.
        </span>
      ) : (
        <span className="text-rose-300">No mailboxes: nothing sends.</span>
      );
  } else if (v.short) {
    verdict = (
      <span className="text-rose-300">
        {v.capBinds ? `Lift the ${cap.capDay}/day warm cap first, then build ` : "Build "}
        {fmt(v.buildMore)} more {plural(v.buildMore, "mailbox", "mailboxes")}
        {v.buildMore > 0 ? ` (${fmt(v.mailboxesNeeded)} needed at ${cap.perMailboxDay}/day each).` : "."}
      </span>
    );
  } else {
    verdict = <span className="text-emerald-300">Enough capacity at this cadence.</span>;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-300">
        <span className="font-medium">Reach everyone</span>
        <select
          value={cadence}
          onChange={(e) => setCadence(e.target.value as Cadence)}
          className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-xs text-slate-200 focus:border-slate-500 focus:outline-none"
        >
          {CADENCES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tip text={neededFormula}>
          <div>
            <div className={`text-lg font-semibold tabular-nums ${v.short ? "text-rose-300" : "text-slate-100"}`}>
              {fmt(v.needed)}
              <span className="ml-1 text-[11px] font-normal text-slate-400">/{unit}</span>
            </div>
            <div className="border-b border-dotted border-slate-600 text-[11px] text-slate-400">needed</div>
          </div>
        </Tip>
        <Tip text={capFormula} align="right">
          <div>
            <div className="text-lg font-semibold tabular-nums text-slate-100">
              {fmt(v.capacity)}
              <span className="ml-1 text-[11px] font-normal text-slate-400">/{unit}</span>
            </div>
            <div className="border-b border-dotted border-slate-600 text-[11px] text-slate-400">
              capacity <TagPill tag={cap.tag} />
            </div>
          </div>
        </Tip>
      </div>
      <div className="space-y-1">
        <div className="h-1.5 overflow-hidden rounded bg-slate-800">
          <div className={`h-full ${v.short ? "bg-rose-500" : "bg-sky-500"}`} style={{ width: `${(v.needed / max) * 100}%` }} />
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-slate-800">
          <div className="h-full bg-slate-400" style={{ width: `${(v.capacity / max) * 100}%` }} />
        </div>
      </div>
      <div className="text-[11px]">{verdict}</div>
    </div>
  );
}

// --- tier ---------------------------------------------------------------------

function TierColumn({ tier, open }: { tier: TierPayload; open: (d: Drill) => void }) {
  const [cadence, setCadence] = useState<Cadence>(tier.defaultCadence);
  const [note, saveNote] = useNote(`${tier.key}:tier`);
  const [editing, setEditing] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-100">
            {tier.label} <span className="text-sm font-normal text-slate-500">{tier.blurb}</span>
          </h2>
          <NoteButton has={!!note} onClick={() => setEditing(true)} />
        </div>
        <p className="text-[11px] text-slate-500">{tier.definition}</p>
        {tier.check.ok ? null : <Unaccounted n={tier.check.unaccounted} />}
        <NoteArea note={note} editing={editing} setEditing={setEditing} save={saveNote} />
      </header>

      <EveryoneCard tier={tier} cadence={cadence} open={open} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {tier.categories.map((c) => (
          <CategoryCard key={c.key} tier={tier} cat={c} cadence={cadence} open={open} />
        ))}
      </div>

      <div className="mt-auto border-t border-slate-800 pt-3">
        <Volume tier={tier} cadence={cadence} setCadence={setCadence} />
      </div>
    </section>
  );
}

// --- shell --------------------------------------------------------------------

export default function EmailCampaignsPrototype({ payload }: { payload: Payload }) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const close = useCallback(() => setDrill(null), []);

  return (
    <div className="space-y-3 px-3 py-4 pb-12 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold text-slate-100">Email campaigns</h2>
          <span className="rounded border border-fuchsia-600 bg-fuchsia-600/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-300">
            Prototype
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
          {(["live", "derived", "static", "mock"] as Tag[]).map((t) => (
            <span key={t} title={TAG_HELP[t]}>
              <TagPill tag={t} />
            </span>
          ))}
          <span>✎ notes are saved in this browser only (prototype)</span>
          <span>
            as of{" "}
            {new Date(payload.generated_at).toLocaleString("en-US", {
              timeZone: "America/New_York",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            ET
          </span>
        </div>
      </div>
      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">How the numbers are made</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {payload.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>
            Up next: never emailed in this tier, or due again at the tier&apos;s cadence. Just emailed: emailed in the
            last {JUST_EMAILED_DAYS} days. Resting: emailed and not due yet. Held people are part of Resting.
            Everything is a single email today.
          </li>
          <li>Changing a tier&apos;s cadence moves people between Up next and Resting and changes what is needed.</li>
        </ul>
      </details>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {payload.tiers.map((t) => (
          <TierColumn key={t.key} tier={t} open={setDrill} />
        ))}
      </div>

      {drill?.kind === "people" ? (
        <PeopleModal drill={drill} onClose={close} setState={(s) => setDrill({ ...drill, state: s })} />
      ) : null}
      {drill?.kind === "sequence" ? <SequenceModal tier={drill.tier} onClose={close} /> : null}
    </div>
  );
}
