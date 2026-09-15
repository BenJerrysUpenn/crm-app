import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseUnsubscribeToken,
  verifyUnsubscribeToken,
  type ParsedToken,
} from "@/lib/outreach/unsubscribeToken";

export const dynamic = "force-dynamic";
// node:crypto (the HMAC) and the service-role client both want the Node
// runtime. Stated rather than inherited so an edge default can never move it.
export const runtime = "nodejs";

// One-click unsubscribe (bj-finance #440). Full contract: docs/unsubscribe.md.
//
// POST  /api/unsubscribe/<token>  RFC 8058. Mail providers post
//       `List-Unsubscribe=One-Click` as application/x-www-form-urlencoded (a
//       few post nothing at all). 200, tiny text/plain body, and NO redirect —
//       RFC 8058 §3.2 forbids one, which is also why middleware.ts lets this
//       path past the auth gate untouched.
// GET   /api/unsubscribe/<token>  the human-clicked link: a one-button page
//       that posts to the same URL. GET never writes, because Gmail, Outlook
//       and every corporate link scanner fetch URLs in mail before a person
//       ever sees them.
//
// There is no user session here — the recipient is not a CRM user — so the
// service-role client is the right one and this is one of its few justified
// uses. The token, not a cookie, is the authorisation.

const MAX_USER_AGENT = 300;

/** Identical for a malformed token, a bad MAC, and an id that does not exist.
 *  Never leak whether a prospect exists. */
function notFound(): NextResponse {
  return text("Not found.\n", 404);
}

function text(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
}

function html(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
}

/** YYYY-MM-DD in Philadelphia time — the date that goes in the `source`
 *  string, matching how outreach/bounce_reader.py dates its own sources. */
function sourceDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

type Verified = { parsed: ParsedToken; email: string };

/** Decode the token, look the prospect up, recompute the MAC over the stored
 *  address. Returns the verified prospect, or a response to send instead. */
async function verify(
  token: string,
): Promise<{ ok: true; value: Verified } | { ok: false; response: NextResponse }> {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) {
    // Fail loud, not closed. A 404 here would look to a mail provider like a
    // working endpoint that simply refused the request, and every genuine
    // opt-out would be dropped in silence — the one outcome this endpoint
    // exists to prevent.
    return {
      ok: false,
      response: text("Unsubscribe is not configured.\n", 503),
    };
  }

  const parsed = parseUnsubscribeToken(token);
  if (!parsed) return { ok: false, response: notFound() };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("outreach_prospects")
    .select("id, email")
    .eq("id", parsed.prospectId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: text("Unsubscribe failed.\n", 500) };
  }
  const email = typeof data?.email === "string" ? data.email.trim() : "";
  if (!email) return { ok: false, response: notFound() };
  if (!verifyUnsubscribeToken(parsed, email, secret)) {
    return { ok: false, response: notFound() };
  }

  return { ok: true, value: { parsed, email } };
}

export async function GET(
  _request: Request,
  { params }: { params: { token: string } },
) {
  const result = await verify(params.token);
  if (!result.ok) return result.response;

  // No framework, no JS, no cookies: a single form that posts to this same
  // URL. `via=link` is what separates this from the RFC 8058 post, and so
  // what separates a `link-` source row from a `one-click-` one.
  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unsubscribe</title>
<style>
  body { margin: 0; padding: 48px 20px; background: #0f172a; color: #e2e8f0;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.5rem; color: #94a3b8; }
  button { font: inherit; font-weight: 600; cursor: pointer; border: 0;
           border-radius: 0.5rem; padding: 0.75rem 1.5rem;
           background: #e2e8f0; color: #0f172a; }
</style>
</head>
<body>
<main>
<h1>Unsubscribe</h1>
<p>Press the button and we will stop emailing this address. Nothing is sent
until you do.</p>
<form method="post">
<input type="hidden" name="via" value="link">
<button type="submit">Unsubscribe</button>
</form>
</main>
</body>
</html>
`);
}

export async function POST(
  request: Request,
  { params }: { params: { token: string } },
) {
  // Read the body before verifying so `via` is known either way, and so a
  // body we cannot parse is simply an empty one rather than a 400. Some
  // clients post nothing at all; RFC 8058 §3.1 senders post
  // `List-Unsubscribe=One-Click`.
  let fields = new URLSearchParams();
  try {
    const raw = await request.text();
    if (raw) fields = new URLSearchParams(raw);
  } catch {
    /* treated as a bare post */
  }

  const fromLink =
    fields.get("via") === "link" &&
    fields.get("List-Unsubscribe") !== "One-Click";
  const via = fromLink ? "link" : "rfc8058";
  const source = `${fromLink ? "link" : "one-click"}-${sourceDate()}`;

  const result = await verify(params.token);
  if (!result.ok) return result.response;

  const userAgent = (request.headers.get("user-agent") ?? "").slice(
    0,
    MAX_USER_AGENT,
  );

  const admin = createAdminClient();
  const { error } = await admin.rpc("outreach_one_click_unsubscribe", {
    p_prospect_id: result.value.parsed.prospectId,
    p_source: source,
    p_via: via,
    p_user_agent: userAgent || null,
  });

  if (error) {
    // 500, not 200: a provider that retries is exactly what we want here.
    return text("Unsubscribe failed.\n", 500);
  }

  // Repeats land here too. The RPC wrote nothing the second time; the answer
  // to the person is the same either way.
  if (fromLink) {
    return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unsubscribed</title>
<style>
  body { margin: 0; padding: 48px 20px; background: #0f172a; color: #e2e8f0;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0; color: #94a3b8; }
</style>
</head>
<body>
<main>
<h1>Unsubscribed</h1>
<p>You are off the list. We will not email this address again.</p>
</main>
</body>
</html>
`);
  }

  return text("Unsubscribed.\n");
}
