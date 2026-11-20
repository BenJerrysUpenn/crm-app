// Email campaigns tab: the Supabase side of the shared sequence copy
// (supabase/crm/013_email_campaign_sequences.sql). Server only: the route
// handlers and the page call it with the signed-in user's client, so RLS
// (select is_manager()) decides who may read and write.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  createMemoryRepo,
  emptyState,
  isTierKey,
  normalizeLaneBlocks,
  normalizeSequenceDoc,
  type ConflictInfo,
  type SequenceRepo,
  type StoreKind,
} from "./sharedSequences";
import type { LaneBlocks, SequenceDoc } from "./sequences";

const SEQ = "email_campaign_sequences";
const LANE = "email_campaign_lane_blocks";
const CONFLICT = "email_campaign_sequence_conflicts";

const UNIQUE_VIOLATION = "23505";

type PgError = { message: string; code?: string } | null;
function check(error: PgError, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`);
}

function rowFor(kind: StoreKind, key: string, doc: SequenceDoc | LaneBlocks, userId: string | null): Record<string, unknown> {
  const meta = { updated_at: new Date().toISOString(), updated_by: userId };
  if (kind === "sequence") {
    const d = doc as SequenceDoc;
    return { key, name: d.name, steps: d.steps, ...meta };
  }
  const b = doc as LaneBlocks;
  return { tier: key, signature: b.signature, footer: b.footer, ...meta };
}

export function supabaseSequenceRepo(supabase: SupabaseClient): SequenceRepo {
  const table = (kind: StoreKind) => (kind === "sequence" ? SEQ : LANE);
  const keyCol = (kind: StoreKind) => (kind === "sequence" ? "key" : "tier");
  return {
    async load() {
      const [seq, lane, conflicts] = await Promise.all([
        supabase.from(SEQ).select("key,name,steps"),
        supabase.from(LANE).select("tier,signature,footer"),
        supabase.from(CONFLICT).select("kind,key,created_at").is("resolved_at", null).order("created_at"),
      ]);
      check(seq.error, "load sequences");
      check(lane.error, "load lane blocks");
      check(conflicts.error, "load conflicts");
      const s = emptyState();
      for (const r of (seq.data ?? []) as { key: string; name: string; steps: unknown }[]) {
        const doc = normalizeSequenceDoc({ name: r.name, steps: r.steps });
        if (doc) s.sequences[r.key] = doc;
      }
      for (const r of (lane.data ?? []) as { tier: string; signature: string; footer: string }[]) {
        const b = normalizeLaneBlocks(r);
        if (b && isTierKey(r.tier)) s.lanes[r.tier] = b;
      }
      s.conflicts = (conflicts.data ?? []) as ConflictInfo[];
      return s;
    },
    async get(kind, key) {
      const cols = kind === "sequence" ? "name,steps" : "signature,footer";
      const { data, error } = await supabase.from(table(kind)).select(cols).eq(keyCol(kind), key).maybeSingle();
      check(error, `read ${kind} ${key}`);
      return data ?? null;
    },
    async insertIfAbsent(kind, key, doc, userId) {
      const { error } = await supabase.from(table(kind)).insert(rowFor(kind, key, doc, userId));
      if (error?.code === UNIQUE_VIOLATION) return false;
      check(error, `insert ${kind} ${key}`);
      return true;
    },
    async put(kind, key, doc, userId) {
      const { error } = await supabase.from(table(kind)).upsert(rowFor(kind, key, doc, userId), { onConflict: keyCol(kind) });
      check(error, `save ${kind} ${key}`);
    },
    async remove(kind, key) {
      const { error } = await supabase.from(table(kind)).delete().eq(keyCol(kind), key);
      check(error, `reset ${kind} ${key}`);
    },
    async recordConflict(kind, key, doc, sharedDoc, userId) {
      const { error } = await supabase
        .from(CONFLICT)
        .insert({ kind, key, doc, shared_doc: sharedDoc, created_by: userId });
      if (error?.code === UNIQUE_VIOLATION) return; // this copy is already kept
      check(error, `keep conflict ${kind} ${key}`);
    },
  };
}

// Local dev only: with EMAIL_CAMPAIGNS_FIXTURE set the page renders from a
// JSON dump, and the shared copy lives in this process's memory.
const devFixture = () => process.env.NODE_ENV === "development" && !!process.env.EMAIL_CAMPAIGNS_FIXTURE;
const g = globalThis as { __emailCampaignsMemoryRepo?: SequenceRepo };

/** The signed-in user and their repo, or null when nobody is signed in. */
export async function sequenceRepoForRequest(): Promise<{ repo: SequenceRepo; userId: string } | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  if (devFixture()) {
    g.__emailCampaignsMemoryRepo ??= createMemoryRepo();
    return { repo: g.__emailCampaignsMemoryRepo, userId: user.id };
  }
  return { repo: supabaseSequenceRepo(supabase), userId: user.id };
}
