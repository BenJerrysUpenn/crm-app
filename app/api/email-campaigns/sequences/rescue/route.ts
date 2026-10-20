import { NextResponse } from "next/server";
import { sequenceRepoForRequest } from "@/lib/emailCampaignsPrototype/sequenceRepo";
import { isStoreKind, rescue, type RescueItem } from "@/lib/emailCampaignsPrototype/sharedSequences";

export const dynamic = "force-dynamic";

// POST /api/email-campaigns/sequences/rescue: upload the copies a browser
// still holds from before the shared copy existed (the editor used to save to
// localStorage only). Body {items: [{kind, key, doc}]}; answers
// {outcomes: [{kind, key, result, doc?}]}.
//
// It never overwrites a shared row: a blank copy or one identical to its seed
// is skipped, a new key is inserted, and a copy that differs from an existing
// row is kept as a conflict record beside it. The rules and their tests are
// rescue() in lib/emailCampaignsPrototype/sharedSequences.ts.

const MAX_ITEMS = 500;

export async function POST(request: Request) {
  const ctx = await sequenceRepoForRequest();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { items?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS)
    return NextResponse.json({ error: `items must be an array of at most ${MAX_ITEMS}` }, { status: 400 });
  const items: RescueItem[] = body.items
    .filter((i): i is RescueItem => !!i && typeof i === "object" && isStoreKind(i.kind))
    .map((i) => ({ kind: i.kind, key: String(i.key ?? ""), doc: i.doc }));

  try {
    return NextResponse.json({ outcomes: await rescue(items, ctx.repo, ctx.userId) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
