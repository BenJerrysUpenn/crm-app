import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwnerRole } from "@/lib/roles";
import { loadPfData, type PfLoadResult } from "./data";

// The one door to the personal-finance feed (/money, /dial, /safe).
//
// The pages carry the owners' household finances. Signing in is not enough,
// and neither is the CRM's manager gate: this Supabase project is shared with
// the time app, and store staff hold the `manager` role too. Only the owner
// role (time-app migration 42) gets in.
//
//  - signed out:           redirect to /login, as every other page does
//  - signed in, not owner: 404, so the page does not admit it exists
//
// The middleware does not refuse these pages itself: a redirect to /no-access
// would admit they exist (bj-finance #667 ruling). So this is the gate, and it
// runs on the page, which a middleware bypass (audit M5) cannot skip.
//
// Every page that serves PF data calls loadPfForOwner(); API routes call
// loadPfApiForOwner(). Nothing else imports ./data (tests/ownerAccess.test.ts
// enforces that).
// The owner test both entry points share: who is signed in, and whether
// their profiles.role is owner (lib/roles.ts).
async function checkOwner(): Promise<
  | { ok: true; user: { id: string; email?: string } }
  | { ok: false; status: 401 | 404 }
> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401 };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!isOwnerRole(profile?.role)) return { ok: false, status: 404 };

  return { ok: true, user };
}

export async function loadPfForOwner(): Promise<{ email: string; feed: PfLoadResult }> {
  const owner = await checkOwner();
  if (!owner.ok) {
    if (owner.status === 401) redirect("/login");
    notFound();
  }

  return { email: owner.user.email ?? "", feed: await loadPfData() };
}

// The same owner gate for API routes, which answer with a status instead of
// redirecting or rendering a 404: 401 signed out, 404 signed in but not an
// owner (bj-finance #223). Allowed callers get the feed too (the overrides
// route checks the posted category against meta.categories).
export async function loadPfApiForOwner(): Promise<
  | { ok: true; userId: string; feed: PfLoadResult }
  | { ok: false; status: 401 | 404 }
> {
  const owner = await checkOwner();
  if (!owner.ok) return owner;

  return { ok: true, userId: owner.user.id, feed: await loadPfData() };
}
