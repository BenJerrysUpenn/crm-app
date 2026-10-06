// The staff roster: everyone with profiles.active = true, by name. The same
// list and order the Schedule page (app/schedule/page.tsx) puts down the side
// of its week grid, so the Availability Team view lists the same people.
//
// profiles.active is roster membership, not access.

import type { RosterPerson } from "@/lib/teamAvailability";

// Just the slice of the Supabase client this file uses, so both the cookie
// client and the admin client fit.
type Client = { from: (table: string) => any };

/** `ok: false` means the read failed; callers must not treat that as "nobody on the roster". */
export async function loadRoster(supabase: Client): Promise<{ ok: true; people: RosterPerson[] } | { ok: false }> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name")
      .eq("active", true)
      .order("full_name", { ascending: true });
    if (error) return { ok: false };
    return { ok: true, people: (data ?? []) as RosterPerson[] };
  } catch {
    return { ok: false };
  }
}
