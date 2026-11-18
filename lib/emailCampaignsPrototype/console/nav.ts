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

/** How many console levels deep a history entry is. It rides in
 * history.state, so the browser's own Back and Forward keep it right; a
 * counter held in the component would not follow them, and Esc would leave
 * the console. */
export const depthOf = (state: unknown): number => {
  const d = (state as { consoleDepth?: unknown } | null)?.consoleDepth;
  return typeof d === "number" && d > 0 ? d : 0;
};

/** The state to store when drilling ("push") or switching in place ("replace"). */
export const nextState = (state: unknown, mode: "push" | "replace") => ({ consoleDepth: depthOf(state) + (mode === "push" ? 1 : 0) });

/** Going up one level: step Back while this entry is a console level we
 * pushed, else replace the entry with the parent (a deep link's first
 * level, or after Back has used up our levels). */
export const popAction = (state: unknown): "back" | "replace" => (depthOf(state) > 0 ? "back" : "replace");
