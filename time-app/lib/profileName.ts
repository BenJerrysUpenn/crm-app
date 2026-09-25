// One place for the rules about a team member's display name
// (public.profiles.full_name).
//
// full_name is nullable, and before migration_21 the handle_new_user trigger
// filled it with the login email whenever an account was created without a
// name. So every reader has to cope with three cases: a real name, nothing,
// or an email address sitting where the name should be. An email-like value
// is treated exactly like no name: never shown as a name, never used to greet
// someone.
//
// Used by the API routes (validation), the invite email, and the UI.

// Shown wherever a profile has no usable name. Deliberately neutral, and never
// the email address.
export const NO_NAME_LABEL = "No name set";

const NAME_MAX = 100;

function isEmailLike(s: string): boolean {
  return s.includes("@");
}

// The profile's real name, trimmed, or null when it is missing, blank, or
// email-like.
export function usableName(fullName: string | null | undefined): string | null {
  if (typeof fullName !== "string") return null;
  const t = fullName.trim();
  if (!t || isEmailLike(t)) return null;
  return t;
}

// True when the Team page should flag this profile as needing a name.
export function isNameMissing(fullName: string | null | undefined): boolean {
  return usableName(fullName) === null;
}

// What to render for a profile's name. Falls back to a neutral label, never to
// the email. Pass a context-specific fallback where "No name set" reads badly
// (e.g. "An employee" inside a notification sentence).
export function displayName(
  fullName: string | null | undefined,
  fallback: string = NO_NAME_LABEL,
): string {
  return usableName(fullName) ?? fallback;
}

// Like displayName, but unnamed people stay distinguishable from each other in
// lists and exports keyed by person (schedule rows, timesheet totals, CSV).
export function displayNameOrId(fullName: string | null | undefined, id: string): string {
  return usableName(fullName) ?? `${NO_NAME_LABEL} (${id.slice(0, 8)})`;
}

// First word of a usable name, for greetings. Null when there is no usable name.
export function firstName(fullName: string | null | undefined): string | null {
  const n = usableName(fullName);
  return n ? n.split(/\s+/)[0] : null;
}

// Validate a name typed by a manager or employee. Required, trimmed, not an
// email address.
export function validateFullName(
  input: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  const t = typeof input === "string" ? input.trim() : "";
  if (!t) return { ok: false, error: "Full name is required." };
  if (isEmailLike(t))
    return { ok: false, error: "Enter the person's name, not their email address." };
  if (t.length > NAME_MAX)
    return { ok: false, error: `Full name must be ${NAME_MAX} characters or fewer.` };
  return { ok: true, name: t };
}
