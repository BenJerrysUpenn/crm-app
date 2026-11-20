import { createAdminClient } from "@/lib/supabase/admin";
import {
  isTrackableUrl,
  parseTrackingToken,
  verifyClickToken,
} from "@/lib/outreach/trackingToken";

export const dynamic = "force-dynamic";
// node:crypto (the HMAC) and the service-role client both want the Node
// runtime. Stated rather than inherited so an edge default can never move it.
export const runtime = "nodejs";

// The click redirect (owners' ruling 2026-10-27). Full contract: docs/tracking.md.
//
// GET  /api/t/c/<token>?u=<encoded url>  Verifies the token (prospect exists,
//      MAC over the STORED address AND the exact `u` matches, `u` is an
//      absolute http(s) URL), writes one 'clicked' row, then 302s to `u`. The
//      redirect happens even if the insert fails: a person clicked a link and
//      gets where it goes. Clicks are inflated by corporate link scanners,
//      which follow every link in a message; the user agent is kept so a
//      reader can filter them. No IP address is stored.
//
//      NEVER AN OPEN REDIRECT. Anything that does not verify is the same 404,
//      with no Location header. Because the MAC covers `u`, a genuine token
//      for one link cannot be re-aimed at another.
//
// Mirrors app/api/unsubscribe/[token]/route.ts: the service-role client, a 404
// that never says whether a prospect exists, a 503 when the key is missing.

const MAX_USER_AGENT = 300;

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Identical for a malformed token, a bad MAC, a bad `u` and an unknown id. */
function notFound(): Response {
  return text("Not found.\n", 404);
}

export async function GET(
  request: Request,
  { params }: { params: { token: string } },
) {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) return text("Tracking is not configured.\n", 503);

  const parsed = parseTrackingToken(params.token);
  if (!parsed) return notFound();

  const url = new URL(request.url).searchParams.get("u");
  if (!isTrackableUrl(url)) return notFound();

  const admin = createAdminClient();
  let email = "";
  try {
    const { data, error } = await admin
      .from("outreach_prospects")
      .select("id, email")
      .eq("id", parsed.prospectId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    email = typeof data?.email === "string" ? data.email.trim() : "";
  } catch (err) {
    // Nothing is verified, so nothing is redirected to.
    console.error("click redirect: prospect lookup failed", err);
    return text("Link unavailable.\n", 500);
  }

  if (!email || !verifyClickToken(parsed, email, url, secret)) return notFound();

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, MAX_USER_AGENT);
  try {
    const { error } = await admin.from("outreach_events").insert({
      prospect_id: parsed.prospectId,
      event: "clicked",
      detail: {
        tracking_id: parsed.trackingId,
        url,
        source: "redirect",
        user_agent: userAgent || null,
      },
    });
    if (error) console.error("click redirect: event insert failed", error.message);
  } catch (err) {
    console.error("click redirect: event insert failed", err);
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
