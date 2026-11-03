import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwnerRole } from "@/lib/roles";
import { loadPfData, type PfLoadResult } from "./data";
import {
  loadOverrides,
  saveOverride,
  type OverrideInput,
  type PfOverride,
} from "./overrides";

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
// loadPfApiForOwner(). /money's category corrections (crm/011) live in a
// table only the service role may touch, so the admin client is built here
// too — loadMoneyForOwner() reads them, savePfOverride() writes one — behind
// the same owner check. No pf page or route imports ./data or
// @/lib/supabase/admin itself, so none can reach the feed or the corrections
// table around the gate (tests/ownerAccess.test.ts enforces both).
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

// /money, which on top of the feed lays the owners' saved category corrections
// over the rows (bj-finance #223). The corrections come from the service-role
// table (crm/011), read here behind the owner check so the page never reaches
// the admin client itself. None are read when the feed is missing (nothing to
// lay them over), nor before crm/011 is applied (loadOverrides returns []).
export async function loadMoneyForOwner(): Promise<{
  email: string;
  feed: PfLoadResult;
  overrides: PfOverride[];
}> {
  const { email, feed } = await loadPfForOwner();
  const overrides = feed.ok ? await loadOverrides(createAdminClient()) : [];
  return { email, feed, overrides };
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

// The write half of /money's corrections: one save to the service-role table
// (crm/011). The route calls this after loadPfApiForOwner has gated the owner
// and checked the category, so the admin client is built here, never in the
// route. `missing_table` means crm/011 is not applied yet (saveOverride).
export function savePfOverride(
  input: OverrideInput,
  userId: string,
): ReturnType<typeof saveOverride> {
  return saveOverride(createAdminClient(), input, userId);
}
