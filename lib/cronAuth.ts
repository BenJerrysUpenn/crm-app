import { timingSafeEqual } from "node:crypto";

// The guard on the CRM's scheduled endpoint (/api/cron/catering-shifts).
//
// That route is exempt from the login redirect in middleware.ts, because a
// scheduler has no session. CRON_SECRET is therefore the ONLY thing between
// the internet and a service-role write to the time-app's shifts table, so the
// guard fails closed: with no secret configured the route refuses everything
// (503) instead of treating "unset" as "open", which is what it used to do
// (crm-app #35).
//
// The secret is accepted as `Authorization: Bearer <secret>` or `?secret=`,
// as before, so an existing scheduler URL keeps working once the secret is
// set on Vercel.
export type CronAuth = "ok" | "unconfigured" | "unauthorized";

// Constant-time comparison, so the response time does not leak how much of a
// guess was right. Unequal lengths are refused without comparing.
function same(given: string | null, secret: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkCronSecret(request: Request, secret: string | undefined): CronAuth {
  // Whitespace-only counts as unset: a blank env var must not become a secret
  // anyone can send.
  if (!secret || secret.trim() === "") return "unconfigured";

  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const query = new URL(request.url).searchParams.get("secret");

  return same(bearer, secret) || same(query, secret) ? "ok" : "unauthorized";
}
