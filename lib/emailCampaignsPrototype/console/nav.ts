// The console's URL state: which query keys exist, how a Nav becomes a
// query string, and what closing the open dialog or form means. One copy,
// used by every navigation in ConsoleScreen and by the reload after a save.

export type Nav = { panel?: string; sel?: string; layer?: string; add?: string; modal?: string; tab?: string; dim?: string };
export const NAV_KEYS: (keyof Nav)[] = ["panel", "sel", "layer", "add", "modal", "tab", "dim"];

export function navFromParams(q: URLSearchParams): Nav {
  const n: Nav = {};
  for (const k of NAV_KEYS) {
    const v = q.get(k);
    if (v) n[k] = v;
  }
  return n;
}

/** `base` with its Nav keys replaced by `n`'s. The add-step form only lives
 * inside Edit lane, so `add` goes whenever `layer` is not editlane. */
export function navQuery(base: URLSearchParams, n: Nav): URLSearchParams {
  const q = new URLSearchParams(base.toString());
  if (n.layer !== "editlane") n = { ...n, add: undefined };
  for (const k of NAV_KEYS) q.delete(k);
  for (const k of NAV_KEYS) if (n[k]) q.set(k, n[k]!);
  return q;
}

/** The same place with the dialog and any form closed. */
export const withFormsClosed = (n: Nav): Nav => ({ ...n, modal: undefined, layer: undefined, add: undefined });
