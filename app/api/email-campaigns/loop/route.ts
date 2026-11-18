import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rpcFor } from "@/lib/emailCampaignsPrototype/console/loopActions";

export const dynamic = "force-dynamic";

// /api/email-campaigns/loop: the console's five writes to the weekly email
// loop (approve an approach, hold or release one email, pause or resume).
// Each is a SECURITY DEFINER function from supabase/crm/014 that checks
// is_manager() and stamps the signed-in email. Runs as the signed-in user;
// no service-role client. Nothing here sends an email.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const call = rpcFor(body);
  if (!call) return NextResponse.json({ error: "Unknown or malformed action" }, { status: 400 });
  const { error } = await supabase.rpc(call.fn, call.args);
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "42501" ? 403 : 409 });
  return NextResponse.json({ ok: true });
}
