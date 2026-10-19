// The Labor Planning editor on the Targets tab (bj-finance #742), driven the
// way a manager drives it: rendered into a DOM (happy-dom), buttons clicked
// and fields filled. Pins who may change what (owners: seasons and events;
// any manager: closed days), the request each change sends (fetch is the
// boundary, answered here), that a refused save shows the route's reason,
// and that on the local preview every change goes to the preview's own door
// and the live closed days are shown but not changed. Invented dates only.
//
//   npm test

import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type { PlanningInputsData } from "./planningInputsLoad.ts";

// A browser for React to render into. Set before react-dom loads: it decides
// at load time whether there is a DOM.
const browser = new Window({ url: "http://finance.localhost/payroll/targets" });
for (const key of ["window", "self", "document", "navigator", "localStorage", "Node", "HTMLElement", "HTMLInputElement", "HTMLIFrameElement", "Event", "getComputedStyle", "MutationObserver"]) {
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
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime") as {
  AppRouterContext: React.Context<unknown>;
};

const { default: PlanningInputs } = await loadAppModule<{ default: (p: Record<string, unknown>) => React.ReactElement }>(
  "components/finance/targets/PlanningInputs.tsx",
);

after(async () => {
  await browser.happyDOM.close();
});

const TODAY = "2030-10-16";
const NOTE = { review_by: "2031-03-01", source: "invented", method: null };

const DATA: PlanningInputsData = {
  unavailable: null,
  seasons: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ effective_from: "2030-11-01", weekday, name: "Test winter", is_closed: false, opens: "13:00:00", closes: "21:00:00", ...NOTE })),
  concession: [],
  exceptions: [{ date: "2030-12-24", label: "Early close", is_closed: false, opens: "12:00:00", closes: "16:00:00", created_at: null }],
  problems: [],
};

type Sent = { url: string; method: string; body: unknown };
let sent: Sent[] = [];
let refreshed = 0;
let answer: () => Response = () => Response.json({ ok: true });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  sent = [];
  refreshed = 0;
  answer = () => Response.json({ ok: true });
});

async function mount(props: Partial<{ data: PlanningInputsData; viewerIsOwner: boolean; preview: { liveClosedDays: string[] } }> = {}) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return answer();
  }) as typeof fetch;
  const router = { refresh: () => { refreshed++; }, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: router },
        React.createElement(PlanningInputs, { data: DATA, today: TODAY, viewerIsOwner: true, ...props }),
      ),
    ),
  );
  const buttons = () => [...container.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  const button = (name: RegExp) => {
    const b = buttons().find((x) => name.test(x.textContent ?? ""));
    assert.ok(b, `no button ${name}; buttons: ${buttons().map((x) => x.textContent).join(" | ")}`);
    return b;
  };
  return {
    text: () => (container.textContent ?? "").replace(/\s+/g, " "),
    has: (name: RegExp) => buttons().some((x) => name.test(x.textContent ?? "")),
    click: (name: RegExp) => act(async () => { button(name).click(); }),
    /** Fill the input inside the field labelled `name` (Date, Label, Opens, Closes). */
    fill: (name: string, value: string) =>
      act(async () => {
        const field = [...container.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === name);
        const input = field?.querySelector("input") as unknown as HTMLInputElement | undefined;
        assert.ok(input, `no field ${name}`);
        // React tracks the value it set; go through the native setter so it sees a change.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new browser.Event("input", { bubbles: true }) as never);
      }),
    tick: (selector: string) =>
      act(async () => {
        (container.querySelector(selector) as unknown as HTMLInputElement).click();
      }),
    unmount: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

test("an owner may add seasons and events; any manager may close a day", async () => {
  const owner = await mount();
  try {
    assert.ok(owner.has(/^Add a season$/));
    assert.ok(owner.has(/^Add an event$/));
    assert.ok(owner.has(/^Add closed day$/));
  } finally {
    await owner.unmount();
  }
  const manager = await mount({ viewerIsOwner: false });
  try {
    assert.equal(manager.has(/^Add a season$/), false);
    assert.equal(manager.has(/^Add an event$/), false);
    assert.match(manager.text(), /Seasons and events are view only: owners change them\. You can close a day\./);
    assert.ok(manager.has(/^Add closed day$/));
  } finally {
    await manager.unmount();
  }
});

test("before migration 47 the seasons and events say why they are not there; closed days still work", async () => {
  const card = await mount({ data: { ...DATA, unavailable: "The planning inputs need migration 47.", seasons: [] } });
  try {
    assert.match(card.text(), /Not available yet: The planning inputs need migration 47\./);
    assert.equal(card.has(/^Add a season$/), false);
    assert.ok(card.has(/^Add closed day$/));
  } finally {
    await card.unmount();
  }
});

test("a quick-add holiday closes its next date through the Targets tab's door, then the page refreshes", async () => {
  const card = await mount({ viewerIsOwner: false });
  try {
    await card.click(/^\+ Close Thanksgiving, Thu, Nov 28, 2030$/);
    assert.deepEqual(sent, [{ url: "/api/payroll/targets/closed-days", method: "POST", body: { date: "2030-11-28", label: "Thanksgiving", is_closed: true } }]);
    assert.equal(refreshed, 1);
  } finally {
    await card.unmount();
  }
});

test("short hours are sent as an open day with its times; a refused save shows the route's reason", async () => {
  answer = () => Response.json({ error: "The store must close after it opens." }, { status: 400 });
  const card = await mount({ viewerIsOwner: false });
  try {
    await card.fill("Date", "2030-12-31");
    await card.fill("Label", "Test early close");
    await card.tick('input[type="checkbox"]');
    // The times appear once Short hours is ticked.
    await card.fill("Opens", "16:00");
    await card.fill("Closes", "12:00");
    await card.click(/^Add short hours$/);
    assert.deepEqual(sent.at(-1), {
      url: "/api/payroll/targets/closed-days", method: "POST",
      body: { date: "2030-12-31", label: "Test early close", opens: "16:00", closes: "12:00", is_closed: false },
    });
    assert.match(card.text(), /The store must close after it opens\./);
    assert.equal(refreshed, 0, "nothing saved, nothing to refresh");
  } finally {
    await card.unmount();
  }
});

test("on the local preview a change goes to the preview's own door, and a live closed day is shown but not changed", async () => {
  const card = await mount({ preview: { liveClosedDays: ["2030-12-24"] } });
  try {
    assert.match(card.text(), /Preview: not saved to the app\./);
    assert.match(card.text(), /Early close · Short hours 12:00 PM to 4:00 PM/);
    assert.match(card.text(), /live, not changed in the preview/);
    assert.equal(card.has(/^Remove$/), false);
    await card.click(/^\+ Close Christmas Day, Wed, Dec 25, 2030$/);
    assert.deepEqual(sent, [{ url: "/api/dev/labor-planning-inputs", method: "POST", body: { kind: "closed_day", body: { date: "2030-12-25", label: "Christmas Day" } } }]);
  } finally {
    await card.unmount();
  }
});
