"use client";

// PROTOTYPE — Email campaigns tab. Throwaway UI on branch
// prototype/email-campaigns. v2 after the owners' review: one layout (the
// owners' sketch: Cold, Warm and Offer tier containers side by side, an
// Everyone card on top of each, category cards beneath, volume at the
// bottom). The v1 "Ledger" table variant was dropped: it existed to show the
// accounting, which the owners asked to hide.
//
// v3 after the owners' review of v2: three states defined by the tier's
// period (its "Reach everyone" cadence): Up next / Emailed / Held.
// One sequence control per card. Category cards show only the three numbers,
// the note icon and the sequence control.
//
// v4: "Emailed this period" is now just "Emailed" (same definition). The
// sequence dots and every "+ Add sequence" open one in-CRM sequence editor
// (SequenceEditor.tsx); no links to GitHub source remain.
//
// v5: never resend the same email. Held = blocked provider OR finished the
// sequence (or no sequence yet, or emailed with no history of what). States
// are worked out per group with the CURRENT sequence (edits included), so
// adding a step moves finished people back to Up next. Plus: lane signature
// and footer editing, a tier connections panel, a "Seasonal menu list" warm
// category (mock, 0) and a prototype "+ Add contacts" form (nothing saved).
//
// v6: the tier connections panel is a plain disclosure row under "How the
// numbers are made", collapsed by default. A "Recipient pages" row in the
// header opens previews of the warm opt-out page (the real markup) and the
// proposed offers opt-in page. "+ Add contacts" gains an "Upload a list" mode:
// the file would become a PR for the AFK Manager to clean and load (nothing
// is uploaded).
//
// Client-only prototype state: the per-tier cadence (useState), card notes and
// sequence edits (localStorage, this browser only). Nothing is written to the
// database, Apollo or warm_sender.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import SequenceEditor, { type EditorTarget } from "./SequenceEditor";
import AddContactForm from "./AddContactForm";
import TierConnections from "./TierConnections";
import {
  SEED_LANE_BLOCKS,
  SEED_SEQUENCES,
  sequenceKey,
  stepKeys,
  type LaneBlocks,
  type SequenceDoc,
} from "@/lib/emailCampaignsPrototype/sequences";
import {
  CADENCES,
  HELD_REASON_LABEL,
  HELD_REASON_SHORT,
  WEEKDAYS_PER_MONTH,
  cadenceOf,
  everyoneOf,
  groupStanding,
  statesAt,
  volumeAt,
  type Cadence,
  type CategoryStat,
  type HeldReason,
  type Payload,
  type Person,
  type StepsFor,
  type Tag,
  type TierKey,
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

function periodPhrase(cadence: Cadence): string {
  const c = cadenceOf(cadence);
  return c.periodDays === 1 ? "today" : `in the last ${c.periodDays} days (${c.label})`;
}

function stateHelp(state: StateKey, cadence: Cadence): string {
  switch (state) {
    case "upNext":
      return `Still have a step of their sequence they have not had, and not emailed ${periodPhrase(cadence)}. People talked to since May are listed last: lowest priority, still emailed.`;
    case "emailed":
      return `Got a step ${periodPhrase(cadence)} and still have steps left. They move back to Up next when the period ends.`;
    case "held":
      return "Not sent to: Yahoo/Microsoft addresses (blocked until warm mailboxes are ready), or they already had every step of their sequence and there is nothing new to send. Nobody gets the same email twice; adding a step they have not had moves them back to Up next.";
    case "unaccounted":
      return "People in no state. This should never happen.";
  }
}

const HELD_ORDER: HeldReason[] = ["blocked", "finished", "noSequence", "moved"];

/** "1,904 blocked provider · 216 finished sequence" (non-zero reasons only). */
function HeldReasons({ heldBy }: { heldBy: Record<HeldReason, number> }) {
  const parts = HELD_ORDER.filter((r) => heldBy[r] > 0);
  if (!parts.length) return null;
  return (
    <div className="text-[11px] text-slate-500">
      <span className="text-slate-400">Held:</span>{" "}
      {parts.map((r, i) => (
        <span key={r} title={HELD_REASON_LABEL[r]}>
          {i ? " · " : ""}
          <span className="tabular-nums text-slate-300">{fmt(heldBy[r])}</span> {HELD_REASON_SHORT[r]}
        </span>
      ))}
    </div>
  );
}

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

type StateKey = "upNext" | "emailed" | "held" | "unaccounted";
const STATE_LABEL: Record<StateKey, string> = {
  upNext: "Up next",
  emailed: "Emailed",
  held: "Held",
  unaccounted: "Unaccounted",
};

type Drill = { kind: "people"; tier: TierPayload; cat: CategoryStat; state: StateKey; cadence: Cadence };
type Row = Person & { reason: string; low: boolean };

const LIST_CAP = 100;

/** People in a state, in list order, from each group's sample. Up next = due
 * again (oldest first), then never emailed, then talked to since May last
 * (`bottom`). Held = by reason. */
function peopleIn(
  cat: CategoryStat,
  state: StateKey,
  cadence: Cadence,
  stepsFor: StepsFor,
): { top: Row[]; bottom: Row[] } {
  const period = cadenceOf(cadence).periodDays;
  const due = (p: Person) => p.age_days === null || p.age_days >= period;
  const top: Row[] = [];
  const bottom: Row[] = [];
  const dueOld: Row[] = [];
  const never: Row[] = [];
  const held: Record<HeldReason, Row[]> = { blocked: [], finished: [], noSequence: [], moved: [] };
  for (const g of cat.groups) {
    const steps = stepsFor(g.cat);
    const standing = groupStanding(g, steps);
    if (standing !== "open") {
      if (state !== "held") continue;
      const seen = new Set<number>();
      for (const p of [...g.sample.never, ...g.sample.oldest])
        if (!seen.has(p.id)) {
          seen.add(p.id);
          held[standing].push({ ...p, reason: HELD_REASON_LABEL[standing], low: false });
        }
      continue;
    }
    const left = steps.filter((keys) => !keys.some((k) => g.received.includes(k))).length;
    const stepsLeft = `${left} ${plural(left, "step")} left`;
    if (state === "upNext") {
      const rows = [
        ...g.sample.oldest.filter(due).map((p) => ({ ...p, reason: `due again, ${stepsLeft}`, low: g.talked })),
        ...g.sample.never.map((p) => ({ ...p, reason: stepsLeft, low: g.talked })),
      ];
      if (g.talked) bottom.push(...rows);
      else
        for (const r of rows) (r.age_days === null ? never : dueOld).push(r);
    } else if (state === "emailed") {
      top.push(...g.sample.newest.filter((p) => !due(p)).map((p) => ({ ...p, reason: stepsLeft, low: false })));
    }
  }
  if (state === "upNext") {
    dueOld.sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0));
    bottom.sort(
      (a, b) =>
        (a.age_days === null ? -1 : 0) - (b.age_days === null ? -1 : 0) || (b.age_days ?? 0) - (a.age_days ?? 0),
    );
    return { top: [...dueOld, ...never], bottom };
  }
  if (state === "emailed") return { top: top.sort((a, b) => (a.age_days ?? 0) - (b.age_days ?? 0)), bottom };
  if (state === "held") return { top: HELD_ORDER.flatMap((r) => held[r]), bottom };
  return { top: [], bottom: [] };
}

function PersonRow({ p }: { p: Row }) {
  return (
    <tr className={`border-t border-slate-800 ${p.low ? "text-slate-400" : "text-slate-300"}`}>
      <td className="whitespace-nowrap py-1 pr-3">{p.name}</td>
      <td className="py-1 pr-3">{p.email ?? <span className="text-slate-600">none yet</span>}</td>
      <td className="whitespace-nowrap py-1 pr-3">
        {p.last_touch
          ? new Date(p.last_touch).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "never"}
      </td>
      <td className="py-1 pr-3 text-slate-400">
        <span className="text-slate-300">{p.reason}</span>
        <span className="text-slate-500"> · {p.why}</span>
      </td>
    </tr>
  );
}

function PeopleModal({
  drill,
  onClose,
  setState,
}: {
  drill: Drill;
  onClose: () => void;
  setState: (s: StateKey) => void;
}) {
  const { tier, cat, state, cadence } = drill;
  const stepsFor = useContext(SeqCtx).stepsFor(tier.key);
  const st = statesAt(cat, cadence, stepsFor);
  const counts: Record<StateKey, number> = {
    upNext: st.upNext,
    emailed: st.emailed,
    held: st.held,
    unaccounted: st.unaccounted,
  };
  const { top, bottom } = peopleIn(cat, state, cadence, stepsFor);
  // The bottom group (talked to since May) is always shown at the end of the
  // list, after a row counting the people skipped in between.
  const bottomTotal = state === "upNext" ? st.lowPriority : 0;
  const topTotal = counts[state] - bottomTotal;
  const topRows = top.slice(0, LIST_CAP);
  const bottomRows = bottom.slice(0, 40);
  const skippedTop = topTotal - topRows.length;
  const skippedBottom = bottomTotal - bottomRows.length;
  const shown = topRows.length + bottomRows.length;
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
        {stateHelp(state, cadence)} Showing {fmt(shown)} of {fmt(counts[state])}.
      </p>
      {state === "held" ? (
        <div className="mb-2">
          <HeldReasons heldBy={st.heldBy} />
        </div>
      ) : null}
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
            {topRows.map((p) => (
              <PersonRow key={p.id} p={p} />
            ))}
            {skippedTop > 0 ? (
              <tr className="border-t border-slate-800">
                <td colSpan={4} className="py-1.5 text-center text-[11px] text-slate-500">
                  … {fmt(skippedTop)} more …
                </td>
              </tr>
            ) : null}
            {bottomRows.map((p) => (
              <PersonRow key={p.id} p={p} />
            ))}
            {skippedBottom > 0 ? (
              <tr className="border-t border-slate-800">
                <td colSpan={4} className="py-1.5 text-center text-[11px] text-slate-500">
                  … {fmt(skippedBottom)} more …
                </td>
              </tr>
            ) : null}
            {shown === 0 ? (
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

// --- sequences (prototype: localStorage, this browser only) ------------------

const SEQ_PREFIX = "email-campaigns-proto:sequence:v1:";

type SeqStore = {
  get: (key: string) => SequenceDoc | null;
  edited: (key: string) => boolean;
  open: (t: EditorTarget) => void;
  /** The steps that apply to a tier's category: its own sequence if it has
   * steps, otherwise the tier's Everyone sequence. */
  stepsFor: (tier: TierKey) => StepsFor;
};
const SeqCtx = createContext<SeqStore>({
  get: () => null,
  edited: () => false,
  open: () => {},
  stepsFor: () => () => [],
});

/** Local edits override the seeds. A key present in `local` has been edited in
 * this browser (an emptied seed is stored as zero steps, so it stays empty). */
function useSequenceStore() {
  const [local, setLocal] = useState<Record<string, SequenceDoc>>({});
  useEffect(() => {
    try {
      const found: Record<string, SequenceDoc> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k || !k.startsWith(SEQ_PREFIX)) continue;
        const raw = window.localStorage.getItem(k);
        if (raw) found[k.slice(SEQ_PREFIX.length)] = JSON.parse(raw) as SequenceDoc;
      }
      setLocal(found);
    } catch {
      /* storage blocked: seeds only */
    }
  }, []);
  const get = useCallback((key: string) => local[key] ?? SEED_SEQUENCES[key] ?? null, [local]);
  const edited = useCallback((key: string) => key in local, [local]);
  const save = useCallback((key: string, doc: SequenceDoc) => {
    setLocal((l) => ({ ...l, [key]: doc }));
    try {
      window.localStorage.setItem(SEQ_PREFIX + key, JSON.stringify(doc));
    } catch {
      /* storage blocked: the edit lives until reload */
    }
  }, []);
  const reset = useCallback((key: string) => {
    setLocal((l) => {
      const next = { ...l };
      delete next[key];
      return next;
    });
    try {
      window.localStorage.removeItem(SEQ_PREFIX + key);
    } catch {
      /* ignore */
    }
  }, []);
  return { get, edited, save, reset };
}

/** The signed-in user's name, for "Sourced by" on the add-contacts form. */
const UserCtx = createContext<string>("you");

const LANE_PREFIX = "email-campaigns-proto:lane:v1:";

/** Each lane's signature and footer: seed, overridden by edits in this browser. */
function useLaneBlocks() {
  const [local, setLocal] = useState<Partial<Record<TierKey, LaneBlocks>>>({});
  useEffect(() => {
    try {
      const found: Partial<Record<TierKey, LaneBlocks>> = {};
      for (const t of ["cold", "warm", "offer"] as TierKey[]) {
        const raw = window.localStorage.getItem(LANE_PREFIX + t);
        if (raw) found[t] = JSON.parse(raw) as LaneBlocks;
      }
      setLocal(found);
    } catch {
      /* storage blocked: seeds only */
    }
  }, []);
  const get = (t: TierKey) => local[t] ?? SEED_LANE_BLOCKS[t];
  const edited = (t: TierKey) => t in local;
  const save = (t: TierKey, b: LaneBlocks) => {
    setLocal((l) => ({ ...l, [t]: b }));
    try {
      window.localStorage.setItem(LANE_PREFIX + t, JSON.stringify(b));
    } catch {
      /* storage blocked: the edit lives until reload */
    }
  };
  const reset = (t: TierKey) => {
    setLocal((l) => {
      const next = { ...l };
      delete next[t];
      return next;
    });
    try {
      window.localStorage.removeItem(LANE_PREFIX + t);
    } catch {
      /* ignore */
    }
  };
  return { get, edited, save, reset };
}

function SequenceDots({ doc, edited, onClick }: { doc: SequenceDoc; edited: boolean; onClick: () => void }) {
  const n = doc.steps.length;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open the sequence editor"
      className="flex min-w-0 items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-800"
    >
      {doc.steps.map((s) => (
        <span key={s.id} className="h-2.5 w-2.5 shrink-0 rounded-full bg-sky-400" />
      ))}
      <span className="ml-1 truncate text-[11px] text-slate-400">
        {n} {plural(n, "email")}
        {doc.name ? ` · ${doc.name}` : ""}
      </span>
      <span className="ml-1 shrink-0">
        {edited ? (
          <span title="Edited in this browser (prototype)" className="text-[9px] lowercase text-amber-400/80">
            edited here
          </span>
        ) : (
          <TagPill tag="static" />
        )}
      </span>
    </button>
  );
}

/** One sequence control per card: the clickable dots when the card has a
 * sequence, otherwise a single "+ Add sequence" button. Both open the editor. */
function SequenceControl({
  tier,
  catKey,
  catLabel,
  cadence,
}: {
  tier: TierPayload;
  catKey: string;
  catLabel: string;
  cadence: Cadence;
}) {
  const store = useContext(SeqCtx);
  const key = sequenceKey(tier.key, catKey);
  const doc = store.get(key);
  const open = () => store.open({ tier, catKey, catLabel, cadence });
  if (doc && doc.steps.length > 0) return <SequenceDots doc={doc} edited={store.edited(key)} onClick={open} />;
  return (
    <button
      type="button"
      onClick={open}
      className="whitespace-nowrap rounded border border-dashed border-slate-600 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-slate-400 hover:text-slate-200"
    >
      + Add sequence
    </button>
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
  const e = everyoneOf(tier);
  const st = statesAt(e, cadence, useContext(SeqCtx).stepsFor(tier.key));
  const [note, saveNote] = useNote(`${tier.key}:everyone`);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const sourcedBy = useContext(UserCtx);
  const people = (state: StateKey) => () => open({ kind: "people", tier, cat: e, state, cadence });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/80 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold leading-tight text-slate-100">
          Everyone <span className="text-sm font-normal text-slate-400">· {fmt(e.total)} people</span>
        </div>
        <NoteButton has={!!note} onClick={() => setEditing(true)} />
      </div>

      <div className="grid grid-cols-3 gap-1">
        <StateStat label={STATE_LABEL.upNext} help={stateHelp("upNext", cadence)} n={st.upNext} onClick={people("upNext")} big />
        <StateStat label={STATE_LABEL.emailed} help={stateHelp("emailed", cadence)} n={st.emailed} onClick={people("emailed")} big />
        <StateStat label={STATE_LABEL.held} help={stateHelp("held", cadence)} n={st.held} onClick={people("held")} big align="right" />
      </div>

      <HeldReasons heldBy={st.heldBy} />

      {tier.key === "cold" && st.upNext > 0 ? (
        <div className="text-[11px] text-slate-500">
          Up next: {fmt(st.upNext - st.upNextNeedsReveal)} have an email · {fmt(st.upNextNeedsReveal)} need an Apollo
          email reveal
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
          <button
            type="button"
            onClick={() => setAdding(true)}
            title="Prototype form: shows what would happen, saves nothing"
            className="ml-auto whitespace-nowrap rounded border border-dashed border-slate-600 px-1.5 py-px text-slate-300 hover:border-slate-400 hover:text-slate-100"
          >
            + Add contacts
          </button>
        </div>
      ) : null}
      {adding ? (
        <Modal title="Add cold contacts" onClose={() => setAdding(false)}>
          <AddContactForm
            categories={tier.categories.map((c) => ({ key: c.key, label: c.label }))}
            sourcedBy={sourcedBy}
          />
        </Modal>
      ) : null}

      <Unaccounted n={st.unaccounted} />
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-1.5">
        <SequenceControl tier={tier} catKey="everyone" catLabel="Everyone" cadence={cadence} />
      </div>
      <NoteArea note={note} editing={editing} setEditing={setEditing} save={saveNote} />
    </div>
  );
}

function MiniStat({
  n,
  label,
  help,
  onClick,
  align,
}: {
  n: number;
  label: string;
  help: string;
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 flex-col items-start justify-start rounded px-1 py-0.5 text-left hover:bg-slate-800"
    >
      <div className="text-base font-semibold tabular-nums leading-tight text-slate-100">{fmt(n)}</div>
      <Tip text={help} align={align}>
        <span className="border-b border-dotted border-slate-600 text-[10px] leading-tight text-slate-400">{label}</span>
      </Tip>
    </button>
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
  const st = statesAt(cat, cadence, useContext(SeqCtx).stepsFor(tier.key));
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
        <div className="min-w-0 text-sm font-medium leading-tight text-slate-100">
          {cat.hint ? (
            <Tip text={cat.hint}>
              <span className="border-b border-dotted border-slate-600">{cat.label}</span>
            </Tip>
          ) : (
            cat.label
          )}{" "}
          {cat.tag ? <TagPill tag={cat.tag} /> : null}
        </div>
        <NoteButton has={!!note} onClick={() => setEditing(true)} />
      </div>
      <div className="grid grid-cols-3 gap-0.5">
        <MiniStat n={st.upNext} label="up next" help={stateHelp("upNext", cadence)} onClick={people("upNext")} />
        <MiniStat n={st.emailed} label="emailed" help={stateHelp("emailed", cadence)} onClick={people("emailed")} />
        <MiniStat n={st.held} label="held" help={stateHelp("held", cadence)} onClick={people("held")} align="right" />
      </div>
      <Unaccounted n={st.unaccounted} />
      <div className="mt-auto pt-0.5">
        <SequenceControl tier={tier} catKey={cat.key} catLabel={cat.label} cadence={cadence} />
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
  const st = statesAt(everyoneOf(tier), cadence, useContext(SeqCtx).stepsFor(tier.key));
  const v = volumeAt(tier, cadence, st.withStepsLeft);
  const cap = tier.capacity;
  const cad = cadenceOf(cadence);
  const unit = cap.unit === "weekday" ? "weekday" : "month";
  const people = v.people;
  const max = Math.max(v.needed, v.capacity, 1);

  const neededFormula =
    cadence === "daily"
      ? `Daily (capped): send at capacity every weekday, so needed = capacity.`
      : cap.unit === "weekday"
        ? `Needed = ${fmt(people)} people with a step left to send ÷ ${cad.weekdays} sending ${plural(cad.weekdays, "weekday")} per period = ${fmt(v.needed)} a weekday. Held people are not counted.`
        : `Needed = ${fmt(people)} people with a step left to send ÷ ${cad.weekdays} sending ${plural(cad.weekdays, "weekday")} per period × ${WEEKDAYS_PER_MONTH} weekdays a month = ${fmt(v.needed)} a month. Held people are not counted.`;
  const capFormula = `Capacity = ${cap.mailboxes} ${plural(cap.mailboxes, "mailbox", "mailboxes")} × ${cap.perMailboxDay}/day${
    cap.capDay !== null ? `, capped at ${cap.capDay}/day` : ""
  }${cap.unit === "month" ? ` × ${WEEKDAYS_PER_MONTH} weekdays` : ""} = ${fmt(v.capacity)}. ${cap.source}`;

  let verdict: React.ReactNode = null;
  if (people === 0) {
    verdict = <span className="text-slate-400">Nothing to send: nobody has a step left.</span>;
  } else if (cadence === "daily") {
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

export default function EmailCampaignsPrototype({ payload, sourcedBy }: { payload: Payload; sourcedBy: string }) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const close = useCallback(() => setDrill(null), []);
  const seqs = useSequenceStore();
  const lanes = useLaneBlocks();
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const closeEditor = useCallback(() => setEditor(null), []);
  const stepsFor = (tier: TierKey): StepsFor => {
    const everyone = (seqs.get(sequenceKey(tier, "everyone"))?.steps ?? []).map(stepKeys);
    return (catKey: string) => {
      const own = seqs.get(sequenceKey(tier, catKey));
      return own && own.steps.length ? own.steps.map(stepKeys) : everyone;
    };
  };
  const store: SeqStore = { get: seqs.get, edited: seqs.edited, open: setEditor, stepsFor };
  const editorKey = editor ? sequenceKey(editor.tier.key, editor.catKey) : null;

  return (
    <UserCtx.Provider value={sourcedBy}>
    <SeqCtx.Provider value={store}>
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
          <span>✎ notes and sequence edits are saved in this browser only (prototype)</span>
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
        <span>Recipient pages</span>
        <a
          href="/email-campaigns/preview/unsubscribe"
          target="_blank"
          rel="noreferrer"
          className="text-slate-300 underline decoration-slate-600 hover:text-slate-100"
        >
          Opt-out (warm) ↗
        </a>
        <span className="text-slate-600">·</span>
        <a
          href="/email-campaigns/preview/offers-signup"
          target="_blank"
          rel="noreferrer"
          className="text-slate-300 underline decoration-slate-600 hover:text-slate-100"
        >
          Opt-in: seasonal menu with offers (proposed) ↗
        </a>
        <span className="text-slate-600">· previews, nothing is written</span>
      </div>
      <div className="space-y-1">
      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">How the numbers are made</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {payload.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>
            A tier&apos;s period is its &ldquo;Reach everyone&rdquo; cadence. Up next: still has a step they have not
            had, and not emailed this period. Emailed: got a step inside the period and still has steps left. Held:
            Yahoo/Microsoft addresses (until warm mailboxes are ready), or finished the sequence with nothing new to
            send. Everyone is in exactly one of the three. Every sequence is a single email today, so anyone who got
            it is Held until a new step is added.
          </li>
          <li>
            People talked to since May are in Up next, at the bottom of the list: lowest priority, still emailed.
          </li>
          <li>Changing a tier&apos;s cadence moves people between Up next and Emailed and changes what is needed.</li>
        </ul>
      </details>

      <TierConnections flows={payload.flows} tiers={payload.tiers} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {payload.tiers.map((t) => (
          <TierColumn key={t.key} tier={t} open={setDrill} />
        ))}
      </div>

      {drill ? (
        <PeopleModal drill={drill} onClose={close} setState={(s) => setDrill({ ...drill, state: s })} />
      ) : null}
      {editor && editorKey ? (
        <SequenceEditor
          key={editorKey}
          target={editor}
          doc={seqs.get(editorKey)}
          seed={SEED_SEQUENCES[editorKey] ?? null}
          edited={seqs.edited(editorKey)}
          onChange={(d) => seqs.save(editorKey, d)}
          onReset={() => seqs.reset(editorKey)}
          blocks={lanes.get(editor.tier.key)}
          blocksEdited={lanes.edited(editor.tier.key)}
          onBlocksChange={(b) => lanes.save(editor.tier.key, b)}
          onBlocksReset={() => lanes.reset(editor.tier.key)}
          onClose={closeEditor}
        />
      ) : null}
    </div>
    </SeqCtx.Provider>
    </UserCtx.Provider>
  );
}
