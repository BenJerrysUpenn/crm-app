import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_NOTE = 4000;

// POST /api/call-desk/prospects/:id/notes   body: { text }
//
// Append-only prospect note. All the work happens in the RPC
// call_desk_append_note, which date-prefixes the line, stamps the caller
// from the JWT and never overwrites what is already there. Returns the
// whole notes column so the UI can re-render the running log.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const prospectId = Number(params.id);
  if (!Number.isInteger(prospectId) || prospectId <= 0)
    return NextResponse.json({ error: "Bad prospect id" }, { status: 400 });

  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  if (typeof body.text !== "string")
    return NextResponse.json({ error: "text must be a string" }, { status: 400 });

  const text = body.text.trim();
  if (!text)
    return NextResponse.json({ error: "text required" }, { status: 400 });
  if (text.length > MAX_NOTE)
    return NextResponse.json(
      { error: `text must be ${MAX_NOTE} characters or fewer` },
      { status: 400 },
    );

  const { data, error } = await supabase.rpc("call_desk_append_note", {
    p_prospect_id: prospectId,
    p_text: text,
  });

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ notes: (data as string | null) ?? "" });
}
