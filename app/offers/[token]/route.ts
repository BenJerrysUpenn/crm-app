import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseOffersToken, verifyOffersToken } from "@/lib/outreach/offersToken";
import type { ParsedToken } from "@/lib/outreach/unsubscribeToken";
import {
  OFFERS_CONSENT_TEXT,
  OFFERS_PAGE_VERSION,
  offersConfirmHtml,
  offersSignedUpHtml,
} from "@/lib/outreach/offersPage";

export const dynamic = "force-dynamic";
// node:crypto (the HMAC) and the service-role client both want the Node
// runtime. Stated rather than inherited so an edge default can never move it.
export const runtime = "nodejs";

// "Yes, send me offers" (bj-finance #425, owners' ruling 2026-09-27).
//
// GET   /offers/<token>  the page the warm footer's link lands on: what the
//       person is signing up for and one button. GET NEVER WRITES. Gmail,
//       Outlook and every corporate link scanner open links in mail before a
//       person does, and a GET that opted people in would sign up everyone
//       whose mail a scanner touched — so consent is the button press, which
//       is the owners' ruling.
// POST  /offers/<token>  the button. Verifies the token, then one RPC
//       (outreach_offers_opt_in, supabase/crm/009_offers_opt_in_signup_form.sql;
//       crm/007 creates it) records the consent row, sets the opt-in on the
//       prospect and logs an 'opted_in' event, in one transaction. A yes after
//       an opt-out is a real yes (owners' ruling 2026-09-27): the same
//       transaction lifts the suppression and records what it lifted, and the
//       person sees the same confirmation as anyone else. It writes nothing on
//       a repeat press (a dated explicit_yes or signup_form opt-in, not opted
//       out since; an undated one is re-recorded), and
//       refuses only a 'dead' (test or invalid) row, which is a 404 like any
//       other bad link.
//
// Mirrors app/api/unsubscribe/[token]/route.ts on purpose: the service-role
// client (the person is not a CRM user; the token is the authorisation), a
// 404 that never says whether a prospect exists, a 503 when the signing key
// is missing. The token is signed with the same UNSUBSCRIBE_SECRET under a
// different purpose prefix (lib/outreach/offersToken.ts), so an unsubscribe
// token is a 404 here and the reverse.

const MAX_USER_AGENT = 300;
const MAX_IP = 64;

const HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

function text(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...HEADERS },
  });
}

function html(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...HEADERS },
  });
}

/** Identical for a malformed token, a bad MAC, and an id that does not exist. */
function notFound(): NextResponse {
  return text("Not found.\n", 404);
}

type Verified = { parsed: ParsedToken; email: string };

/** Decode the token, look the prospect up, recompute the MAC over the stored
 *  address. Returns the verified prospect, or the response to send instead. */
async function verify(
  token: string,
): Promise<{ ok: true; value: Verified } | { ok: false; response: NextResponse }> {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) {
    // Loud, like unsubscribe: a 404 here would look like a bad link, and the
    // person's yes would be dropped without anyone finding out why.
    return { ok: false, response: text("Offers sign-up is not configured.\n", 503) };
  }

  const parsed = parseOffersToken(token);
  if (!parsed) return { ok: false, response: notFound() };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("outreach_prospects")
    .select("id, email")
    .eq("id", parsed.prospectId)
    .maybeSingle();

  if (error) return { ok: false, response: text("Offers sign-up failed.\n", 500) };
  const email = typeof data?.email === "string" ? data.email.trim() : "";
  if (!email) return { ok: false, response: notFound() };
  if (!verifyOffersToken(parsed, email, secret)) return { ok: false, response: notFound() };

  return { ok: true, value: { parsed, email } };
}

/** The client address as Vercel reports it: the first x-forwarded-for hop,
 *  else x-real-ip. Kept as proof alongside the consent, never used to decide
 *  anything. */
function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim() || "";
  return ip ? ip.slice(0, MAX_IP) : null;
}

export async function GET(
  _request: Request,
  { params }: { params: { token: string } },
) {
  const result = await verify(params.token);
  if (!result.ok) return result.response;
  return html(offersConfirmHtml(result.value.email));
}

type OptInResult = {
  opted_in?: boolean;
  already?: boolean;
  refused?: string | null;
  email_present?: boolean;
  lifted?: boolean;
  opted_in_at?: string | null;
};

export async function POST(
  request: Request,
  { params }: { params: { token: string } },
) {
  let fields = new URLSearchParams();
  try {
    const raw = await request.text();
    if (raw) fields = new URLSearchParams(raw);
  } catch {
    /* treated as an empty body */
  }

  const result = await verify(params.token);
  if (!result.ok) return result.response;

  // Only the page's own form counts as the button. Anything else posting here
  // (a tool, a scanner that submits forms blind) is not a person saying yes.
  if (fields.get("via") !== "link") return text("Bad request.\n", 400);

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, MAX_USER_AGENT);

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("outreach_offers_opt_in", {
    p_prospect_id: result.value.parsed.prospectId,
    p_consent_text: OFFERS_CONSENT_TEXT,
    p_page_version: OFFERS_PAGE_VERSION,
    p_ip: clientIp(request),
    p_user_agent: userAgent || null,
  });

  if (error) return text("Offers sign-up failed.\n", 500);

  const outcome = (data ?? {}) as OptInResult;
  // 'dead' is the only refusal left: a test or invalid row. Nobody real is
  // behind it, so it answers like any other link that leads nowhere.
  if (outcome.refused || !outcome.email_present) return notFound();

  // Every outcome that reaches here carries a date: the 'already' branch
  // requires opt_in_at IS NOT NULL (crm/009), and the write path sets now().
  // A success with no date is a broken invariant between the RPC and this
  // route, not a person to confirm, so fail loudly rather than fabricate
  // today's date (CODING_STANDARDS.md:10). The date shown is the one the
  // stored proof carries — for a repeat, the date they first said yes.
  if (!outcome.opted_in_at) return text("Offers sign-up failed.\n", 500);
  const at = new Date(outcome.opted_in_at);
  return html(offersSignedUpHtml(at, result.value.email));
}
