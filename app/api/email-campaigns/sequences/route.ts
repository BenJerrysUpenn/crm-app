import { NextResponse } from "next/server";
import { sequenceRepoForRequest } from "@/lib/emailCampaignsPrototype/sequenceRepo";
import { isStoreKind, isValidKey, normalizeDoc, type StoreKind } from "@/lib/emailCampaignsPrototype/sharedSequences";

export const dynamic = "force-dynamic";

// /api/email-campaigns/sequences: writes to the shared copy of the /email-campaigns
// sequence editor (supabase/crm/013, lib/emailCampaignsPrototype/sharedSequences.ts).
//
//   PUT     {kind, key, doc}  save one sequence ("<tier>:<category>") or one
//           lane's {signature, footer} (key = tier)
//   DELETE  {kind, key}       reset: delete the row, so the seed shows again
//
// The page reads the copy server-side (app/email-campaigns/page.tsx). Runs as
// the signed-in manager (RLS `(select is_manager())`). Nothing here reaches
// Apollo or warm_sender: neither reads these tables.

const err = (error: string, status: number) => NextResponse.json({ error }, { status });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readTarget(request: Request): Promise<{ kind: StoreKind; key: string; doc: unknown } | string> {
  let body: { kind?: unknown; key?: unknown; doc?: unknown };
  try {
    body = await request.json();
  } catch {
    return "Bad JSON";
  }
  const kind = body.kind;
  if (!isStoreKind(kind)) return "kind must be sequence or lane";
  if (!isValidKey(kind, body.key)) return `Bad ${kind} key`;
  return { kind, key: body.key, doc: body.doc };
}

export async function PUT(request: Request) {
  const ctx = await sequenceRepoForRequest();
  if (!ctx) return err("Not signed in", 401);
  const t = await readTarget(request);
  if (typeof t === "string") return err(t, 400);
  const doc = normalizeDoc(t.kind, t.doc);
  if (!doc) return err(`Bad ${t.kind} document`, 400);
  try {
    await ctx.repo.put(t.kind, t.key, doc, ctx.userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return err(message(e), 500);
  }
}

export async function DELETE(request: Request) {
  const ctx = await sequenceRepoForRequest();
  if (!ctx) return err("Not signed in", 401);
  const t = await readTarget(request);
  if (typeof t === "string") return err(t, 400);
  try {
    await ctx.repo.remove(t.kind, t.key);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return err(message(e), 500);
  }
}
