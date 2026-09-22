import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findDuplicates } from "@/lib/dealDedupe";

export const dynamic = "force-dynamic";

// POST /api/deals/dedupe   { email?, phone? }
//
// "Have we already got this person?", asked of the deals and of the outreach
// contact base, while the New deal form is being filled in.
//
// POST rather than GET even though it reads and writes nothing: the arguments
// are a customer's email address and phone number, and a query string is the
// one part of a request that ends up in browser history, proxy logs and
// referrer headers. A body does not.
//
// Both fields are optional and either alone is enough; with neither, the
// response is `{ matches: [], skipped: true }` rather than an error, because
// the form calls this the moment a contact field settles and an empty field
// is the normal starting state.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const asText = (v: unknown) => (typeof v === "string" ? v : null);
  const result = await findDuplicates(supabase, {
    email: asText(body.email),
    phone: asText(body.phone),
  });

  return NextResponse.json(result);
}
