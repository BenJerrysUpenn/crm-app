// The "Check week" button on the schedule board (bj-finance #742 follow-up),
// driven the way a manager drives it: rendered into a DOM (happy-dom), the
// button clicked, and the route's answer (fetch is the boundary, answered
// here) read back as the dialog shows it. Pins that cover is reported against
// staffed hours, and that the days checked against open hours only, because
// the open-up and close-down minutes were not set, are named. Invented dates.
//
//   npm test

import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule } from "./testing/fakeSupabase.ts";

// A browser for React to render into. Set before react-dom loads: it decides
// at load time whether there is a DOM.
const browser = new Window({ url: "http://time.localhost/schedule" });
for (const key of ["window", "self", "document", "navigator", "localStorage", "Node", "HTMLElement", "Event", "getComputedStyle", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, {
    value: (browser as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { act } = React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> };
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

const { default: CheckWeekButton } = await loadAppModule<{ default: (p: { isManager: boolean; weekStart: string }) => React.ReactElement }>(
  "components/CheckWeekButton.tsx",
);

after(async () => {
  await browser.happyDOM.close();
});

const WEEK = "2030-09-15";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mount the button, answer its request with `body`, click it, and return the dialog's text. */
async function checkWeek(body: unknown): Promise<string> {
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(React.createElement(CheckWeekButton, { isManager: true, weekStart: WEEK })));
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Check week") as unknown as HTMLButtonElement;
    assert.ok(button, "no Check week button");
    await act(async () => {
      button.click();
    });
    return (container.textContent ?? "").replace(/\s+/g, " ");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}

test("a week covered for every staffed hour says so, and names nothing checked on open hours", async () => {
  const t = await checkWeek({ gaps: [], hoursNotSet: [], staffingNotSet: [] });
  assert.match(t, /All staffed hours covered/);
  assert.match(t, /every staffed hour this week: the open hours plus the time to open up and close down/);
  assert.doesNotMatch(t, /checked against open hours only/);
});

test("a gap in staffed hours is listed as a time the store needs someone in", async () => {
  const t = await checkWeek({ gaps: [{ date: "2030-09-17", from: "11:15", to: "12:00" }], hoursNotSet: [], staffingNotSet: [] });
  assert.match(t, /Nobody is in the store/);
  assert.match(t, /The store needs someone in at these times this week/);
  assert.match(t, /Tue Sep 17: nobody in store 11:15 AM to 12:00 PM/);
});

test("the days checked against open hours only, because the minutes are not set, are named", async () => {
  const t = await checkWeek({ gaps: [], hoursNotSet: [], staffingNotSet: ["2030-09-17", "2030-09-18"] });
  assert.match(
    t,
    /Open-up and close-down minutes aren't set on the Targets tab for Tue Sep 17, Wed Sep 18, so those days were checked against open hours only\./,
  );
});

test("an answer without the staffed-hours list still reads as a check", async () => {
  const t = await checkWeek({ gaps: [], hoursNotSet: [] });
  assert.match(t, /All staffed hours covered/);
  assert.doesNotMatch(t, /checked against open hours only/);
});
