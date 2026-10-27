import { createAdminClient } from "@/lib/supabase/admin";
import { parseTrackingToken, verifyOpenToken } from "@/lib/outreach/trackingToken";

export const dynamic = "force-dynamic";
// node:crypto (the HMAC) and the service-role client both want the Node
// runtime. Stated rather than inherited so an edge default can never move it.
export const runtime = "nodejs";

// The open pixel (owners' ruling 2026-10-27). Full contract: docs/tracking.md.
//
// GET  /api/t/o/<token>  ALWAYS 200 with a 1x1 transparent GIF: verified or
//      not, configured or not, database up or not. A mail client showing a
//      broken image tells a recipient (and a filter) more than we want, and
//      nothing a fetcher could do here should change what it sees. Only a
//      verified token writes, and it writes one 'opened' row per fetch.
//      Opens are inflated by Apple Mail Privacy Protection and Gmail's image
//      proxy, which fetch the pixel without anyone reading; the user agent is
//      kept so a reader can filter them. No IP address is stored.
//
// Mirrors app/api/unsubscribe/[token]/route.ts: the service-role client (the
// fetcher is not a CRM user; the token is the authorisation), a lookup that
// never says whether a prospect exists, the MAC recomputed over the STORED
// address.

const MAX_USER_AGENT = 300;

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function pixel(): Response {
  return new Response(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.length),
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
}

async function record(request: Request, token: string): Promise<void> {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) return;

  const parsed = parseTrackingToken(token);
  if (!parsed) return;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("outreach_prospects")
    .select("id, email")
    .eq("id", parsed.prospectId)
    .maybeSingle();
  if (error) {
    console.error("open pixel: prospect lookup failed", error.message);
    return;
  }

  const email = typeof data?.email === "string" ? data.email.trim() : "";
  if (!email || !verifyOpenToken(parsed, email, secret)) return;

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, MAX_USER_AGENT);
  const { error: insertError } = await admin.from("outreach_events").insert({
    prospect_id: parsed.prospectId,
    event: "opened",
    detail: { tracking_id: parsed.trackingId, source: "pixel", user_agent: userAgent || null },
  });
  if (insertError) console.error("open pixel: event insert failed", insertError.message);
}

export async function GET(
  request: Request,
  { params }: { params: { token: string } },
) {
  try {
    await record(request, params.token);
  } catch (err) {
    console.error("open pixel: unexpected failure", err);
  }
  return pixel();
}
