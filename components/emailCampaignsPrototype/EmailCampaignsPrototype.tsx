"use client";

// Email campaigns tab: the Cold, Warm and Offer tiers side by side, an
// Everyone card on top of each, category cards beneath, volume at the bottom.
// States per tier period (its "Reach everyone" cadence): Up next / Emailed /
// Held. Sequence dots and "+ Add sequence" open the in-CRM sequence editor
// (SequenceEditor.tsx). Tier connections and "How the numbers are made" are
// collapsed rows under the header; "Recipient pages" opens previews of the
// warm opt-out page and the offers opt-in page.
//
// Reads the outreach data only. The one database write is the sequence
// editor's shared copy (steps, signature and footer; supabase/crm/013,
// /api/email-campaigns/sequences), which Apollo and warm_sender do not read.
// Client-side state: the per-tier cadence (useState) and card notes
// (localStorage, this browser only). Nothing is sent to Apollo or warm_sender.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import SequenceEditor, { type EditorTarget } from "./SequenceEditor";
import TierConnections from "./TierConnections";
import {
  SEED_SEQUENCES,
  isWrittenStep,
  sequenceKey,
  stepKeys,
  stepSpec,
  type LaneBlocks,
  type SequenceDoc,
} from "@/lib/emailCampaignsPrototype/sequences";
import {
  applyRescue,
  markUploaded,
  pendingLocalCopies,
  rescueMessage,
  resolveLane,
  resolveSequence,
  type ConflictInfo,
  type LocalCopy,
  type RescueOutcome,
  type SharedState,
  type StoreKind,
} from "@/lib/emailCampaignsPrototype/sharedSequences";
import {
  CADENCES,
  HELD_REASON_LABEL,
  HELD_REASON_SHORT,
  WEEKDAYS_PER_MONTH,
  cadenceOf,
  categorySteps,
  everyoneOf,
  groupStanding,
  statesAt,
  unsentSteps,
  stepEngagement,
  volumeAt,
  type Cadence,
  type CategoryStat,
  type HeldReason,
  type Payload,
  type Person,
  type StepsFor,
  type TierKey,
  type TierPayload,
} from "@/lib/emailCampaignsPrototype/model";

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

// --- small pieces -------------------------------------------------------------

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
      return `Got a step ${periodPhrase(cadence)} and still have steps left. They move back to Up next when the period ends, or to Held while their next step's copy is not written yet.`;
    case "held":
      return "Not sent to: Yahoo/Microsoft addresses (blocked until warm mailboxes are ready), or they already had every step of their sequence and there is nothing new to send, or their next step's copy is not written yet. Nobody gets the same email twice; adding a step they have not had moves them back to Up next.";
    case "unaccounted":
      return "People in no state. This should never happen.";
  }
}

const HELD_ORDER: HeldReason[] = ["blocked", "finished", "notWritten", "noSequence", "moved"];

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

// --- notes (localStorage, this browser only) ----------------------------------

type Note = { text: string; at: string };
const NOTE_PREFIX = "email-campaigns-proto:note:v1:";
function useNote(id: string): [Note | null, (n: Note | null) => void] {
  const [note, setNote] = useState<Note | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(NOTE_PREFIX + id);
      if (raw !== null) setNote(JSON.parse(raw) as Note | null);
    } catch {
      /* storage blocked: no note */
    }
  }, [id]);
  const save = useCallback(
    (n: Note | null) => {
      setNote(n);
      try {
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
          placeholder="Add a note"
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
  const held: Record<HeldReason, Row[]> = { blocked: [], finished: [], noSequence: [], moved: [], notWritten: [] };
  for (const g of cat.groups) {
    const steps = stepsFor(g.cat);
    const standing = groupStanding(g, steps);
    if (standing === "waiting") {
      // Next step has no copy: Emailed this period, else Held; never Up next.
      const reason = HELD_REASON_LABEL.notWritten;
      if (state === "emailed")
        top.push(...g.sample.newest.filter((p) => !due(p)).map((p) => ({ ...p, reason, low: false })));
      else if (state === "held") {
        const seen = new Set<number>();
        for (const p of [...g.sample.never, ...g.sample.oldest])
          if (due(p) && !seen.has(p.id)) {
            seen.add(p.id);
            held.notWritten.push({ ...p, reason, low: false });
          }
      }
      continue;
    }
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
    const left = unsentSteps(g, steps);
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

// --- sequences (the shared copy, supabase/crm/013) -----------------------------

type SeqStore = {
  get: (key: string) => SequenceDoc | null;
  edited: (key: string) => boolean;
  open: (t: EditorTarget) => void;
  /** The steps that apply to a tier's category: its own sequence if it has
   * steps, otherwise the tier's Everyone sequence (never for a held category,
   * see categorySteps). */
  stepsFor: (tier: TierKey) => StepsFor;
};
const SeqCtx = createContext<SeqStore>({
  get: () => null,
  edited: () => false,
  open: () => {},
  stepsFor: () => () => [],
});

const SAVE_DELAY_MS = 600;

/** Sequences and lane blocks: the shared row overrides the seed. A key with a
 * row has been edited (an emptied seed is stored as zero steps, so it stays
 * empty). Edits show at once and are written after a short pause; reset
 * deletes the row. On first load, copies this browser saved before the shared
 * copy existed are uploaded (see rescue in sharedSequences.ts); the
 * localStorage keys are left in place as a backup. */
function useSharedCopy(initial: SharedState, loadError: string | null) {
  const [state, setState] = useState<SharedState>(initial);
  const [saving, setSaving] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const [rescued, setRescued] = useState<string | null>(null);
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; body: string }>());
  const chain = useRef(new Map<string, Promise<void>>());

  // One request at a time per row, in the order the edits were made.
  const send = useCallback((id: string, method: "PUT" | "DELETE", body: string, keepalive = false) => {
    setSaving((n) => n + 1);
    const run = async () => {
      try {
        const res = await fetch("/api/email-campaigns/sequences", {
          method,
          headers: { "Content-Type": "application/json" },
          body,
          keepalive,
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        setSaveError(null);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving((n) => n - 1);
      }
    };
    const next = (chain.current.get(id) ?? Promise.resolve()).then(run);
    chain.current.set(id, next);
  }, []);

  const flush = useCallback(
    (keepalive = false) => {
      for (const [id, p] of pending.current) {
        clearTimeout(p.timer);
        send(id, "PUT", p.body, keepalive);
      }
      pending.current.clear();
      setQueued(0);
    },
    [send],
  );

  useEffect(() => {
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flush]);

  const write = useCallback(
    (kind: StoreKind, key: string, doc: SequenceDoc | LaneBlocks) => {
      const id = `${kind}:${key}`;
      const prev = pending.current.get(id);
      if (prev) clearTimeout(prev.timer);
      const body = JSON.stringify({ kind, key, doc });
      const timer = setTimeout(() => {
        pending.current.delete(id);
        setQueued(pending.current.size);
        send(id, "PUT", body);
      }, SAVE_DELAY_MS);
      pending.current.set(id, { timer, body });
      setQueued(pending.current.size);
    },
    [send],
  );

  const remove = useCallback(
    (kind: StoreKind, key: string) => {
      const id = `${kind}:${key}`;
      const prev = pending.current.get(id);
      if (prev) clearTimeout(prev.timer);
      pending.current.delete(id);
      setQueued(pending.current.size);
      send(id, "DELETE", JSON.stringify({ kind, key }));
    },
    [send],
  );

  // Rescue: upload what this browser saved before the shared copy existed.
  // Once per page load (React may run an effect twice in development); the
  // result is applied even if the effect was cleaned up in between.
  const rescueStarted = useRef(false);
  useEffect(() => {
    if (loadError || rescueStarted.current) return;
    rescueStarted.current = true;
    let copies: LocalCopy[];
    try {
      copies = pendingLocalCopies(window.localStorage);
    } catch {
      return; /* storage blocked: nothing to upload */
    }
    if (!copies.length) return;
    (async () => {
      try {
        const res = await fetch("/api/email-campaigns/sequences/rescue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: copies.map(({ kind, key, doc }) => ({ kind, key, doc })) }),
        });
        const j = (await res.json().catch(() => ({}))) as { outcomes?: RescueOutcome[]; error?: string };
        if (!res.ok || !j.outcomes) throw new Error(j.error ?? `HTTP ${res.status}`);
        const outcomes = j.outcomes;
        try {
          markUploaded(window.localStorage, copies, outcomes);
        } catch {
          /* storage blocked: the copies are sent again next load, which is harmless */
        }
        setState((s) => applyRescue(s, outcomes, new Date().toISOString()));
        setRescued(rescueMessage(outcomes));
      } catch (e) {
        setSaveError(
          `Could not upload this browser's saved sequences (they are still in this browser): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
  }, [loadError]);

  const get = useCallback((key: string) => resolveSequence(state, key), [state]);
  const edited = useCallback((key: string) => key in state.sequences, [state]);
  const save = useCallback(
    (key: string, doc: SequenceDoc) => {
      setState((s) => ({ ...s, sequences: { ...s.sequences, [key]: doc } }));
      write("sequence", key, doc);
    },
    [write],
  );
  const reset = useCallback(
    (key: string) => {
      setState((s) => {
        const sequences = { ...s.sequences };
        delete sequences[key];
        return { ...s, sequences };
      });
      remove("sequence", key);
    },
    [remove],
  );
  const lanes = {
    get: (t: TierKey) => resolveLane(state, t),
    edited: (t: TierKey) => t in state.lanes,
    save: (t: TierKey, b: LaneBlocks) => {
      setState((s) => ({ ...s, lanes: { ...s.lanes, [t]: b } }));
      write("lane", t, b);
    },
    reset: (t: TierKey) => {
      setState((s) => {
        const next = { ...s.lanes };
        delete next[t];
        return { ...s, lanes: next };
      });
      remove("lane", t);
    },
  };
  return {
    seqs: { get, edited, save, reset },
    lanes,
    conflicts: state.conflicts,
    status: { saving: saving > 0 || queued > 0, error: saveError, rescued },
  };
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
      {doc.steps.map((s, i) =>
        isWrittenStep(s) ? (
          <span key={s.id} className="h-2.5 w-2.5 shrink-0 rounded-full bg-sky-400" />
        ) : (
          <span
            key={s.id}
            title={`Step ${i + 1}: copy not written yet`}
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-sky-400"
          />
        ),
      )}
      <span className="ml-1 truncate text-[11px] text-slate-400">
        {n} {plural(n, "email")}
        {doc.name ? ` · ${doc.name}` : ""}
      </span>
      {edited ? (
        <span title="Edited (shared copy)" className="ml-1 shrink-0 text-[9px] lowercase text-amber-400/80">
          edited
        </span>
      ) : null}
    </button>
  );
}

/** One small line per step that has something to say: opens and clicks of
 * its tracked sends on this card, or that its copy is not written yet. */
function StepLines({ doc, cat }: { doc: SequenceDoc; cat: CategoryStat }) {
  const lines = doc.steps.flatMap((s, i): { id: string; i: number; text: string; tracked?: number }[] => {
    if (!isWrittenStep(s)) return [{ id: s.id, i, text: "copy not written yet" }];
    const e = stepEngagement(cat, stepKeys(s));
    return e ? [{ id: s.id, i, text: `opened ${fmt(e.opened)} · clicked ${fmt(e.clicked)}`, tracked: e.tracked }] : [];
  });
  if (!lines.length) return null;
  return (
    <div className="space-y-0.5 px-1.5 text-[10px] leading-tight text-slate-500">
      {lines.map((l) => (
        <div
          key={l.id}
          title={
            l.tracked !== undefined
              ? `Of ${fmt(l.tracked)} tracked sends. Mail privacy proxies open every image, so opens run high (docs/tracking.md).`
              : undefined
          }
        >
          <span className="text-slate-400">Step {l.i + 1}</span> · {l.text}
        </div>
      ))}
    </div>
  );
}

/** One sequence control per card: the clickable dots when the card has a
 * sequence, otherwise a single "+ Add sequence" button. Both open the editor. */
function SequenceControl({
  tier,
  cat,
  catKey,
  catLabel,
  cadence,
}: {
  tier: TierPayload;
  cat: CategoryStat;
  catKey: string;
  catLabel: string;
  cadence: Cadence;
}) {
  const store = useContext(SeqCtx);
  const key = sequenceKey(tier.key, catKey);
  const doc = store.get(key);
  const open = () => store.open({ tier, catKey, catLabel, cadence });
  if (doc && doc.steps.length > 0)
    return (
      <div className="min-w-0">
        <SequenceDots doc={doc} edited={store.edited(key)} onClick={open} />
        <StepLines doc={doc} cat={cat} />
      </div>
    );
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
              {s.label} <span className="tabular-nums text-slate-200">{fmt(s.n)}</span>
            </span>
          ))}
        </div>
      ) : null}

      <Unaccounted n={st.unaccounted} />
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-1.5">
        <SequenceControl tier={tier} cat={e} catKey="everyone" catLabel="Everyone" cadence={cadence} />
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
          {cat.label}
        </div>
        <NoteButton has={!!note} onClick={() => setEditing(true)} />
      </div>
      <div className="grid grid-cols-3 gap-0.5">
        <MiniStat n={st.upNext} label="up next" help={stateHelp("upNext", cadence)} onClick={people("upNext")} />
        <MiniStat n={st.emailed} label="emailed" help={stateHelp("emailed", cadence)} onClick={people("emailed")} />
        <MiniStat n={st.held} label="held" help={stateHelp("held", cadence)} onClick={people("held")} align="right" />
      </div>
      {cat.hold ? <HeldReasons heldBy={st.heldBy} /> : null}
      <Unaccounted n={st.unaccounted} />
      <div className="mt-auto pt-0.5">
        <SequenceControl tier={tier} cat={cat} catKey={cat.key} catLabel={cat.label} cadence={cadence} />
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
    verdict = (
      <span className="text-slate-400">
        {st.heldBy.noSequence > 0 && st.heldBy.finished === 0
          ? "Nothing to send: no sequence yet."
          : "Nothing to send: nobody has a step left."}
      </span>
    );
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
              capacity
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

/** "Warm › Corporate & office" for a sequence, "Warm signature and footer" for a lane. */
function conflictLabel(c: ConflictInfo, tiers: TierPayload[]): string {
  const [tierKey, ...rest] = c.key.split(":");
  const tier = tiers.find((t) => t.key === tierKey);
  const tierLabel = tier?.label ?? tierKey;
  if (c.kind === "lane") return `${tierLabel} signature and footer`;
  const catKey = rest.join(":");
  const cat = catKey === "everyone" ? "Everyone" : (tier?.categories.find((k) => k.key === catKey)?.label ?? catKey);
  return `${tierLabel} › ${cat}`;
}

const EMPTY_SHARED: SharedState = { sequences: {}, lanes: {}, conflicts: [] };

const CONFLICT_NOTE =
  "a different copy saved in a browser was kept aside; the shared copy was not changed. An owner can compare the two (email_campaign_sequence_conflicts).";

export default function EmailCampaignsPrototype({
  payload,
  shared = EMPTY_SHARED,
  sharedError = null,
}: {
  payload: Payload;
  /** The shared copy as the page read it (no rows = every seed). */
  shared?: SharedState;
  sharedError?: string | null;
}) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const close = useCallback(() => setDrill(null), []);
  const { seqs, lanes, conflicts, status } = useSharedCopy(shared, sharedError);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const closeEditor = useCallback(() => setEditor(null), []);
  const stepsFor = (tier: TierKey): StepsFor => {
    const everyone = (seqs.get(sequenceKey(tier, "everyone"))?.steps ?? []).map(stepSpec);
    return (catKey: string) =>
      categorySteps(catKey, (seqs.get(sequenceKey(tier, catKey))?.steps ?? []).map(stepSpec), everyone);
  };
  const store: SeqStore = { get: seqs.get, edited: seqs.edited, open: setEditor, stepsFor };
  const editorKey = editor ? sequenceKey(editor.tier.key, editor.catKey) : null;

  return (
    <SeqCtx.Provider value={store}>
    <div className="space-y-3 px-3 py-4 pb-12 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-slate-100">Email campaigns</h2>
        <div className="text-[11px] text-slate-400">
          <span>
            ✎ Sequence edits are shared and saved for everyone; card notes stay in this browser ·{" "}
            {status.saving ? "saving… · " : ""}as of{" "}
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
      {sharedError ? (
        <div className="rounded-md border border-rose-700 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          Could not load the shared sequences, so the original copy is shown and edits cannot be saved: {sharedError}
        </div>
      ) : null}
      {status.error ? (
        <div className="rounded-md border border-rose-700 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          Not saved: {status.error}
        </div>
      ) : null}
      {status.rescued ? <div className="text-xs text-emerald-300">✓ {status.rescued}</div> : null}
      {conflicts.length ? (
        <div className="rounded-md border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {conflicts.map((c) => (
            <div key={`${c.kind}:${c.key}`}>
              <span className="font-medium">{conflictLabel(c, payload.tiers)}</span>: {CONFLICT_NOTE}
            </div>
          ))}
        </div>
      ) : null}
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
          Opt-in: seasonal menu with offers ↗
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
            send, or their next step&apos;s copy is not written yet. Everyone is in exactly one of the three. Every
            sequence but Offer&apos;s wedding one is a single email today, so anyone who got it is Held until a new
            step is added.
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
          conflicts={conflicts
            .filter(
              (c) =>
                (c.kind === "sequence" && c.key === editorKey) || (c.kind === "lane" && c.key === editor.tier.key),
            )
            .map((c) => `${conflictLabel(c, payload.tiers)}: ${CONFLICT_NOTE}`)}
          onClose={closeEditor}
        />
      ) : null}
    </div>
    </SeqCtx.Provider>
  );
}
