import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadPfData, type PfLoadResult } from "./data";

// The one door to the personal-finance feed (bj-finance #673).
//
// The pages carry the household's personal finances. Signing in is not enough,
// and neither is the CRM's manager gate: this Supabase project is shared with
// the time app, and store staff hold the `manager` role too. Only the auth user
// IDs listed in PF_ALLOWED_USER_IDS (server-only, set in Vercel; never in this
// public repo) get in.
//
//  - signed out:            redirect to /login, as every other page does
//  - signed in, not listed: 404, so the page does not admit it exists
//  - list unset or empty:   nobody is listed, so everybody gets the 404
//
// Every page or route that serves pf data calls loadPfForViewer(). Nothing
// else imports ./data (tests/pfAccess.test.ts enforces that).

export function isPfViewerAllowed(
  userId: string,
  raw: string | undefined = process.env.PF_ALLOWED_USER_IDS,
): boolean {
  if (!userId || !raw) return false;
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(userId);
}

export async function loadPfForViewer(): Promise<{
  email: string;
  feed: PfLoadResult;
}> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!isPfViewerAllowed(user.id)) notFound();

  return { email: user.email ?? "", feed: await loadPfData() };
}

// The same door for API routes, which answer with a status instead of
// redirecting: 401 signed out, 404 signed in but not listed. Allowed callers
// get the feed too (the overrides route checks categories against it).
export async function pfApiViewer(): Promise<
  | { ok: true; userId: string; feed: PfLoadResult }
  | { ok: false; status: 401 | 404 }
> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401 };
  if (!isPfViewerAllowed(user.id)) return { ok: false, status: 404 };
  return { ok: true, userId: user.id, feed: await loadPfData() };
}
