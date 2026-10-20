// Email campaigns tab: the shared copy of the sequence editor (crm/013).
//
// Sequences (one per "<tier>:<category>") and lane blocks (one signature +
// footer per tier) live in Supabase, read and written through
// app/api/email-campaigns/sequences/**. No row means the seed in sequences.ts;
// "Reset to original" deletes the row.
//
// Before crm/013 the editor saved to localStorage only. On page load the
// browser uploads any such copies it still holds (rescue), under these rules:
//   * a sequence whose every step has an empty subject and body, or a lane
//     whose signature and footer are both empty, is skipped (blank);
//   * a copy identical to its seed is skipped (nothing to keep);
//   * no row yet: the copy becomes the shared row (saved);
//   * a row with the same content: nothing to do (same);
//   * a row with DIFFERENT content: the row is kept and the browser copy is
//     stored as a conflict record (conflict). Nothing is overwritten.
// The localStorage keys are never deleted. A key is marked as uploaded (a
// separate RESCUED_PREFIX key holding the exact value uploaded) so the same
// copy is not sent again on every load.
//
// Nothing here is read by Apollo or warm_sender.

import type { TierKey } from "./model";
import { SEED_LANE_BLOCKS, SEED_SEQUENCES, type LaneBlocks, type SeqStep, type SequenceDoc } from "./sequences";

export type StoreKind = "sequence" | "lane";

export const TIER_KEYS: TierKey[] = ["cold", "warm", "offer"];

/** The pre-crm/013 localStorage keys. Read for rescue; never deleted. */
export const SEQ_STORAGE_PREFIX = "email-campaigns-proto:sequence:v1:";
export const LANE_STORAGE_PREFIX = "email-campaigns-proto:lane:v1:";
/** `<RESCUED_PREFIX><original key>` = the value of that key last uploaded. */
export const RESCUED_PREFIX = "email-campaigns-proto:rescued:v1:";

export type ConflictInfo = { kind: StoreKind; key: string; created_at: string };

export type SharedState = {
  sequences: Record<string, SequenceDoc>;
  lanes: Partial<Record<TierKey, LaneBlocks>>;
  /** Unresolved conflict records. */
  conflicts: ConflictInfo[];
};

export const emptyState = (): SharedState => ({ sequences: {}, lanes: {}, conflicts: [] });

// --- shape --------------------------------------------------------------------

export function isStoreKind(x: unknown): x is StoreKind {
  return x === "sequence" || x === "lane";
}

export function isTierKey(x: unknown): x is TierKey {
  return typeof x === "string" && (TIER_KEYS as string[]).includes(x);
}

/** "<tier>:<category key>", as the migration's CHECK has it. */
export function isSequenceKey(x: unknown): x is string {
  return typeof x === "string" && x.length <= 200 && /^(cold|warm|offer):.+$/.test(x);
}

export function isValidKey(kind: StoreKind, key: unknown): key is string {
  return kind === "sequence" ? isSequenceKey(key) : isTierKey(key);
}

const str = (x: unknown) => (typeof x === "string" ? x : "");

/** A SequenceDoc with only the fields the editor uses, or null when `x` is not
 * one. Lenient on old copies: a missing subject/body is "", a bad wait is 0. */
export function normalizeSequenceDoc(x: unknown): SequenceDoc | null {
  if (!x || typeof x !== "object") return null;
  const o = x as { name?: unknown; steps?: unknown };
  if (!Array.isArray(o.steps)) return null;
  const steps: SeqStep[] = [];
  for (const [i, raw] of o.steps.entries()) {
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    const wait = Number(s.waitDays);
    const step: SeqStep = {
      id: typeof s.id === "string" && s.id ? s.id : `step-${i + 1}`,
      waitDays: Number.isFinite(wait) ? Math.max(0, Math.min(365, Math.round(wait))) : 0,
      subject: str(s.subject),
      body: str(s.body),
    };
    if (Array.isArray(s.sentAs)) step.sentAs = s.sentAs.filter((k): k is string => typeof k === "string");
    steps.push(step);
  }
  return { name: str(o.name), steps };
}

export function normalizeLaneBlocks(x: unknown): LaneBlocks | null {
  if (!x || typeof x !== "object") return null;
  const o = x as { signature?: unknown; footer?: unknown };
  if (o.signature !== undefined && typeof o.signature !== "string") return null;
  if (o.footer !== undefined && typeof o.footer !== "string") return null;
  return { signature: str(o.signature), footer: str(o.footer) };
}

export function normalizeDoc(kind: StoreKind, x: unknown): SequenceDoc | LaneBlocks | null {
  return kind === "sequence" ? normalizeSequenceDoc(x) : normalizeLaneBlocks(x);
}

/** JSON with object keys sorted, so two copies compare equal whatever order
 * their keys came back in (jsonb reorders them). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const sameDoc = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Every step has an empty subject and an empty body (or there are no steps). */
export function isBlankSequence(doc: SequenceDoc): boolean {
  return doc.steps.every((s) => !s.subject.trim() && !s.body.trim());
}

export function isBlankLane(b: LaneBlocks): boolean {
  return !b.signature.trim() && !b.footer.trim();
}

export function seedOf(kind: StoreKind, key: string): SequenceDoc | LaneBlocks | null {
  if (kind === "sequence") return SEED_SEQUENCES[key] ?? null;
  return isTierKey(key) ? SEED_LANE_BLOCKS[key] : null;
}

// --- reading --------------------------------------------------------------------

/** The shared row, else the seed, else nothing ("+ Add sequence"). */
export function resolveSequence(state: SharedState, key: string): SequenceDoc | null {
  return state.sequences[key] ?? SEED_SEQUENCES[key] ?? null;
}

export function resolveLane(state: SharedState, tier: TierKey): LaneBlocks {
  return state.lanes[tier] ?? SEED_LANE_BLOCKS[tier];
}

// --- storage --------------------------------------------------------------------

/** What the route handlers need from the database. Two implementations:
 * Supabase (sequenceRepo.ts) and in-memory (tests, local fixture dev). */
export interface SequenceRepo {
  load(): Promise<SharedState>;
  get(kind: StoreKind, key: string): Promise<unknown | null>;
  /** Insert the row only if none exists. True when this call inserted it. */
  insertIfAbsent(kind: StoreKind, key: string, doc: SequenceDoc | LaneBlocks, userId: string | null): Promise<boolean>;
  put(kind: StoreKind, key: string, doc: SequenceDoc | LaneBlocks, userId: string | null): Promise<void>;
  remove(kind: StoreKind, key: string): Promise<void>;
  /** Store a browser copy beside the shared row. Storing the same copy again
   * is a no-op. */
  recordConflict(
    kind: StoreKind,
    key: string,
    doc: SequenceDoc | LaneBlocks,
    sharedDoc: unknown,
    userId: string | null,
  ): Promise<void>;
}

// --- rescue ---------------------------------------------------------------------

export type RescueItem = { kind: StoreKind; key: string; doc: unknown };

export type RescueResult = "saved" | "same" | "conflict" | "blank" | "seed" | "invalid";

export type RescueOutcome = {
  kind: StoreKind;
  key: string;
  result: RescueResult;
  /** The normalized copy, for "saved" (the client shows it as the shared row). */
  doc?: SequenceDoc | LaneBlocks;
};

/** Upload browser copies without ever overwriting a shared row. */
export async function rescue(items: RescueItem[], repo: SequenceRepo, userId: string | null): Promise<RescueOutcome[]> {
  const out: RescueOutcome[] = [];
  for (const it of items) {
    const { kind, key } = it;
    const doc = isValidKey(kind, key) ? normalizeDoc(kind, it.doc) : null;
    if (!doc) {
      out.push({ kind, key, result: "invalid" });
      continue;
    }
    const blank = kind === "sequence" ? isBlankSequence(doc as SequenceDoc) : isBlankLane(doc as LaneBlocks);
    if (blank) {
      out.push({ kind, key, result: "blank" });
      continue;
    }
    const seed = seedOf(kind, key);
    if (seed && sameDoc(doc, seed)) {
      out.push({ kind, key, result: "seed" });
      continue;
    }
    let existing = await repo.get(kind, key);
    if (existing === null) {
      if (await repo.insertIfAbsent(kind, key, doc, userId)) {
        out.push({ kind, key, result: "saved", doc });
        continue;
      }
      existing = await repo.get(kind, key); // someone else's insert won the race
    }
    if (sameDoc(normalizeDoc(kind, existing), doc)) {
      out.push({ kind, key, result: "same" });
      continue;
    }
    await repo.recordConflict(kind, key, doc, existing, userId);
    out.push({ kind, key, result: "conflict" });
  }
  return out;
}

/** Fold rescue outcomes into the page's state: saved copies become the shared
 * row, conflicts get a notice. A row the page already holds is left alone. */
export function applyRescue(state: SharedState, outcomes: RescueOutcome[], now: string): SharedState {
  const next: SharedState = {
    sequences: { ...state.sequences },
    lanes: { ...state.lanes },
    conflicts: [...state.conflicts],
  };
  for (const o of outcomes) {
    if (o.result === "saved" && o.doc) {
      if (o.kind === "sequence" && !(o.key in next.sequences)) next.sequences[o.key] = o.doc as SequenceDoc;
      if (o.kind === "lane" && isTierKey(o.key) && !(o.key in next.lanes)) next.lanes[o.key] = o.doc as LaneBlocks;
    }
    if (o.result === "conflict" && !next.conflicts.some((c) => c.kind === o.kind && c.key === o.key))
      next.conflicts.push({ kind: o.kind, key: o.key, created_at: now });
  }
  return next;
}

/** The one-line confirmation after an upload, or null when nothing was saved. */
export function rescueMessage(outcomes: RescueOutcome[]): string | null {
  const seq = outcomes.filter((o) => o.result === "saved" && o.kind === "sequence").length;
  const lanes = outcomes.filter((o) => o.result === "saved" && o.kind === "lane").length;
  if (!seq && !lanes) return null;
  const parts: string[] = [];
  if (seq) parts.push(`${seq} ${seq === 1 ? "sequence" : "sequences"}`);
  if (lanes) parts.push(`${lanes === 1 ? "1 lane's" : `${lanes} lanes'`} signature and footer`);
  return `Saved ${parts.join(" and ")} from this browser to the shared copy`;
}

/** The subset of Storage the rescue reads and writes. */
export type StorageLike = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

export type LocalCopy = RescueItem & { storageKey: string; raw: string };

/** Browser copies not yet uploaded in their current form. Unparseable values
 * are left where they are and not sent. */
export function pendingLocalCopies(storage: StorageLike): LocalCopy[] {
  const out: LocalCopy[] = [];
  for (let i = 0; i < storage.length; i++) {
    const storageKey = storage.key(i);
    if (!storageKey) continue;
    let kind: StoreKind;
    let key: string;
    if (storageKey.startsWith(SEQ_STORAGE_PREFIX)) {
      kind = "sequence";
      key = storageKey.slice(SEQ_STORAGE_PREFIX.length);
    } else if (storageKey.startsWith(LANE_STORAGE_PREFIX)) {
      kind = "lane";
      key = storageKey.slice(LANE_STORAGE_PREFIX.length);
    } else continue;
    const raw = storage.getItem(storageKey);
    if (raw === null || storage.getItem(RESCUED_PREFIX + storageKey) === raw) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    out.push({ kind, key, doc, storageKey, raw });
  }
  return out;
}

/** Mark copies the server has dealt with, so they are not sent again. The
 * copies themselves stay in storage as a backup. */
export function markUploaded(storage: StorageLike, copies: LocalCopy[], outcomes: RescueOutcome[]): void {
  for (const c of copies) {
    if (outcomes.some((o) => o.kind === c.kind && o.key === c.key)) storage.setItem(RESCUED_PREFIX + c.storageKey, c.raw);
  }
}

// --- in-memory repo -------------------------------------------------------------

export type MemoryRepo = SequenceRepo & {
  rows: { sequence: Map<string, unknown>; lane: Map<string, unknown> };
  conflictRows: { kind: StoreKind; key: string; doc: unknown; shared_doc: unknown; created_at: string }[];
};

/** For tests and local fixture dev (EMAIL_CAMPAIGNS_FIXTURE). Stores copies the
 * way jsonb does: a round trip through JSON. */
export function createMemoryRepo(): MemoryRepo {
  const rows = { sequence: new Map<string, unknown>(), lane: new Map<string, unknown>() };
  const conflictRows: MemoryRepo["conflictRows"] = [];
  const clone = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;
  return {
    rows,
    conflictRows,
    async load() {
      const s = emptyState();
      for (const [k, v] of rows.sequence) s.sequences[k] = normalizeSequenceDoc(v)!;
      for (const [k, v] of rows.lane) if (isTierKey(k)) s.lanes[k] = normalizeLaneBlocks(v)!;
      s.conflicts = conflictRows.map((c) => ({ kind: c.kind, key: c.key, created_at: c.created_at }));
      return s;
    },
    async get(kind, key) {
      return rows[kind].has(key) ? clone(rows[kind].get(key)) : null;
    },
    async insertIfAbsent(kind, key, doc) {
      if (rows[kind].has(key)) return false;
      rows[kind].set(key, clone(doc));
      return true;
    },
    async put(kind, key, doc) {
      rows[kind].set(key, clone(doc));
    },
    async remove(kind, key) {
      rows[kind].delete(key);
    },
    async recordConflict(kind, key, doc, sharedDoc) {
      if (conflictRows.some((c) => c.kind === kind && c.key === key && sameDoc(c.doc, doc))) return;
      conflictRows.push({ kind, key, doc: clone(doc), shared_doc: clone(sharedDoc), created_at: new Date().toISOString() });
    },
  };
}
