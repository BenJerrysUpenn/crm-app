import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { validateFullName } from "@/lib/profileName";
import { NextResponse } from "next/server";

// PATCH /api/account
//
// The signed-in person edits their own profile from the /account page: their
// display name and phone, nothing else. The name rule is the same one POST
// /api/profiles and PATCH /api/profiles/[id] enforce (validateFullName): a
// non-empty, non-email name.
//
// The Account page validates in the browser too, for instant feedback, but the
// rule has to hold on the server as well: a browser Supabase session can write
// profiles.full_name directly, so a signed-in person could store a blank or
// email-like name by going around the form and then show up on the Team page
// as "Name missing". The page saves through here so validateFullName is the one
// source of truth for the name rule on every write path (bj-finance #468).
//
// Scoped to the caller's own row (id = me.id): it can never touch anyone else,
// and it carries none of the manager-only fields (role, pay, active, archive)
// that PATCH /api/profiles/[id] guards. Any id in the body is ignored.
export async function PATCH(request: Request) {
  const me = await getProfile();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { full_name?: unknown; phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if ("full_name" in body) {
    const name = validateFullName(body.full_name);
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
    patch.full_name = name.name;
  }
  if ("phone" in body) {
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    patch.phone = phone || null;
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", me.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ profile: data });
}
