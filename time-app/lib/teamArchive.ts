// Archive and On schedule on the Team page.
//
// Two separate things (migration 32):
//   active       "on the schedule". The Schedule grid, availability, auto-fill,
//                coverage, reminders and the payroll roster all read it. The
//                owners and office staff are active = false and still on the
//                team. The Team page's On schedule checkbox sets it.
//   archived_at  "left the team". Only the Team page reads it: an archived
//                person is hidden from the table until "Show archived (N)".
//                Archive stamps it and sets active = false; Unarchive clears
//                it and leaves active false, so the manager ticks On schedule
//                if the person is back on the floor.
// Neither is access: an archived person can still sign in. Access ends only by
// banning the login (offboarding). Nothing is deleted.
//
// Until migration 32 is applied the column is absent: select("*") simply
// omits the key, so nobody reads as archived, and Archive/Unarchive are
// refused with ARCHIVE_NEEDS_MIGRATION rather than falling back to active.

import type { Parsed } from "./storeHours.ts";

type Person = { full_name: string | null; archived_at?: string | null };

/** Shown when Archive or Unarchive is tried before migration 32 is applied. */
export const ARCHIVE_NEEDS_MIGRATION =
  "Archive needs migration 32 (profiles.archived_at). Run it in Supabase first.";

/** True when this person has been archived. A missing column reads as not archived. */
export function isArchived(p: Pick<Person, "archived_at">): boolean {
  return typeof p.archived_at === "string" && p.archived_at !== "";
}

/**
 * True when profiles.archived_at exists. PostgREST returns every column for
 * select("*"), null included, so a present column always shows up as a key.
 */
export function archiveColumnReady(people: Pick<Person, "archived_at">[]): boolean {
  return people.some((p) => p.archived_at !== undefined);
}

/** Splits the Team table into the people shown and the archived people. Order is kept. */
export function splitArchived<T extends Person>(people: T[]): { current: T[]; archived: T[] } {
  const current: T[] = [];
  const archived: T[] = [];
  for (const p of people) (isArchived(p) ? archived : current).push(p);
  return { current, archived };
}

/**
 * What the Team page sends to PATCH /api/profiles/:id. Archive sends
 * archived_at: true and the server stamps the time and sets active = false.
 * Unarchive sends null and leaves active alone.
 */
export function archivePatch(archive: boolean): { archived_at: true | null } {
  return { archived_at: archive ? true : null };
}

/**
 * The route's reading of archived_at from the request body: true archives now
 * (the server's clock, not the browser's), null unarchives. Anything else is
 * refused, so a stray value can't archive someone or backdate it.
 */
export function parseArchivedAt(value: unknown, now: Date): Parsed<string | null> {
  if (value === null) return { ok: true, value: null };
  if (value === true) return { ok: true, value: now.toISOString() };
  return { ok: false, error: "archived_at must be true (archive now) or null (unarchive)." };
}

/** The name the confirm and the buttons use: the full name, else the email, else "this person". */
export function archiveName(p: Pick<Person, "full_name">, email: string): string {
  const name = (p.full_name ?? "").trim();
  if (name && !name.includes("@")) return name;
  return email.trim() || "this person";
}

/** The question asked before archiving. */
export function archiveConfirmMessage(name: string): string {
  return `Archive ${name}? They'll be hidden from the team, schedule and availability. You can unarchive any time.`;
}

/** Label for the toggle that reveals archived people. */
export function archivedToggleLabel(count: number, shown: boolean): string {
  return shown ? `Hide archived (${count})` : `Show archived (${count})`;
}
