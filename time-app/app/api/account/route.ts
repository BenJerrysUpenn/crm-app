import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { validateFullName } from "@/lib/profileName";
import { NextResponse } from "next/server";

// PATCH /api/account
//
// The signed-in person edits their own display name and phone, nothing else,
// and only their own row (id = me.id; any id in the body is ignored). The name
// goes through validateFullName, the same rule POST /api/profiles and PATCH
// /api/profiles/[id] enforce, so the /account page cannot save a blank or
// email-like name (bj-finance #468). A direct browser write to profiles still
// could; this route is the checked path. It carries none of the
// manager-only fields (role, pay, active, archive) that PATCH
// /api/profiles/[id] guards.
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
