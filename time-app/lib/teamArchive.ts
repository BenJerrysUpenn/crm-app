// Archive on the Team page.
//
// Archived means profiles.active = false: the same flag the Schedule grid, the
// Availability grid, the staff pickers and the payroll roster already read, so
// an archived person drops off all of them exactly as "off roster" did. It is
// not access: an archived person can still sign in. Access ends only by
// banning the login (offboarding). Nothing is deleted, so unarchiving puts the
// person back as they were.

type Person = { full_name: string | null; active: boolean };

/** Splits the Team table into the people shown and the archived people. Order is kept. */
export function splitArchived<T extends Person>(people: T[]): { current: T[]; archived: T[] } {
  const current: T[] = [];
  const archived: T[] = [];
  for (const p of people) (p.active ? current : archived).push(p);
  return { current, archived };
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
