// The time app's hamburger menu, driven the way a person drives it: rendered
// into a DOM (happy-dom), clicked, tapped outside, closed with Escape. Also
// pins the list of tabs each role sees, so the menu never drifts from it.
//
// The pathname and the app router that Next would supply come through their
// React contexts; Supabase is the fake one (the bell loads notifications).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule, startFakeSupabase } from "./testing/fakeSupabase.ts";

// A browser for React to render into. Set before react-dom loads: it decides
// at load time whether there is a DOM.
const browser = new Window({ url: "http://time.localhost/" });
for (const key of ["window", "self", "document", "navigator", "Node", "HTMLElement", "HTMLIFrameElement", "Event", "KeyboardEvent", "MouseEvent"]) {
  // Node has its own navigator, as a getter: define over it.
  Object.defineProperty(globalThis, key, {
    value: (browser as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// In a browser, supabase-js opens a BroadcastChannel to share the session
// across tabs. Node's BroadcastChannel holds the process open after the tests;
// one tab needs no channel.
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { act } = React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> };
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
const { PathnameContext } = require("next/dist/shared/lib/hooks-client-context.shared-runtime.js") as {
  PathnameContext: import("react").Context<string | null>;
};
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime.js") as {
  AppRouterContext: import("react").Context<unknown>;
};

startFakeSupabase({ notifications: [] });

const { default: TopBar } = await loadAppModule<{
  default: (props: { email: string; role: string; name: string }) => unknown;
}>("components/TopBar.tsx");

const pushed: string[] = [];
const router = {
  push: (href: string) => void pushed.push(href),
  replace: (href: string) => void pushed.push(href),
  prefetch: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
};

type Mounted = { container: HTMLElement; unmount: () => Promise<void> };

async function mount(role: string, pathname = "/schedule"): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => {
    root.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: router },
        React.createElement(
          PathnameContext.Provider,
          { value: pathname },
          React.createElement(TopBar as never, { email: "sam@example.test", role, name: "Sam Lee" }),
        ),
      ),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

const hamburger = (c: HTMLElement) => c.querySelector('button[aria-label="Menu"]') as HTMLButtonElement;
const menu = (c: HTMLElement) => c.querySelector('nav[aria-label="Menu"]') as HTMLElement | null;
const tabRow = (c: HTMLElement) => c.querySelector('nav[aria-label="Main"]') as HTMLElement;
const items = (nav: HTMLElement) =>
  [...nav.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), label: a.textContent, current: a.getAttribute("aria-current") }));

async function click(el: Element) {
  await act(() => void el.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as never));
}
async function pointerDown(el: Element) {
  await act(() => void el.dispatchEvent(new browser.Event("pointerdown", { bubbles: true }) as never));
}
async function press(key: string) {
  await act(() => void document.dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true }) as never));
}

after(async () => {
  await browser.happyDOM.close();
});

// What each role sees, in order: the tab row, then the menu (Account is the
// menu's alone; the name link is the route to /account beside the tab row).
const EMPLOYEE_TABS = ["/ Clock", "/schedule Schedule", "/availability Availability", "/timesheets Timesheets", "/reimbursements Reimbursements"];
const MANAGER_TABS = [...EMPLOYEE_TABS, "/attendance Attendance", "/team Team"];
const EXPECTED: Record<string, string[]> = { employee: EMPLOYEE_TABS, manager: MANAGER_TABS, owner: MANAGER_TABS };

for (const role of ["employee", "manager", "owner"]) {
  test(`${role}: the tab row and the menu list the same tabs, in the same order`, async () => {
    const bar = await mount(role);
    try {
      assert.deepEqual(items(tabRow(bar.container)).map((i) => `${i.href} ${i.label}`), EXPECTED[role]);
      await click(hamburger(bar.container));
      const open = menu(bar.container);
      assert.ok(open, "the menu opens");
      assert.deepEqual(items(open).map((i) => `${i.href} ${i.label}`), [...EXPECTED[role], "/account Account"]);
    } finally {
      await bar.unmount();
    }
  });
}

test("the hamburger is a labelled button that says whether the menu is open, and points at it", async () => {
  const bar = await mount("employee");
  try {
    const button = hamburger(bar.container);
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(menu(bar.container), null, "closed at first");

    await click(button);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    const open = menu(bar.container);
    assert.ok(open);
    assert.equal(button.getAttribute("aria-controls"), open.id);

    await click(button);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(menu(bar.container), null, "a second press closes it");
  } finally {
    await bar.unmount();
  }
});

test("the current tab is highlighted in the menu", async () => {
  const bar = await mount("manager", "/team");
  try {
    await click(hamburger(bar.container));
    const current = items(menu(bar.container)!).filter((i) => i.current === "page");
    assert.deepEqual(current.map((i) => i.label), ["Team"]);
    const link = menu(bar.container)!.querySelector('a[href="/team"]')!;
    assert.match(link.getAttribute("class") ?? "", /\bbg-slate-900\b/);
  } finally {
    await bar.unmount();
  }
});

test("the menu follows the hamburger in the keyboard order", async () => {
  const bar = await mount("employee");
  try {
    await click(hamburger(bar.container));
    assert.equal(hamburger(bar.container).nextElementSibling, menu(bar.container));
  } finally {
    await bar.unmount();
  }
});

test("the hamburger comes before the brand, and the menu opens from the left edge under it", async () => {
  const bar = await mount("employee");
  try {
    const button = hamburger(bar.container);
    const row = button.parentElement!;
    assert.equal(row.firstElementChild, button, "the hamburger is the first thing in the bar");
    const brand = [...row.children].find((el) => el.textContent === "Withers Time")!;
    assert.ok(brand, "the bar shows the brand");
    assert.ok(button.compareDocumentPosition(brand) & 4, "the brand follows the hamburger");

    await click(button);
    const classes = (menu(bar.container)!.getAttribute("class") ?? "").split(/\s+/);
    assert.ok(classes.includes("absolute") && classes.includes("left-0") && classes.includes("top-full"), classes.join(" "));
  } finally {
    await bar.unmount();
  }
});

test("choosing a tab closes the menu and goes there", async () => {
  const bar = await mount("employee");
  try {
    await click(hamburger(bar.container));
    await click(menu(bar.container)!.querySelector('a[href="/timesheets"]')!);
    assert.equal(menu(bar.container), null);
    assert.equal(hamburger(bar.container).getAttribute("aria-expanded"), "false");
    assert.equal(pushed.at(-1), "/timesheets");
  } finally {
    await bar.unmount();
  }
});

test("Escape closes the menu and puts focus back on the hamburger", async () => {
  const bar = await mount("employee");
  try {
    await click(hamburger(bar.container));
    (menu(bar.container)!.querySelector("a") as HTMLElement).focus();
    await press("Escape");
    assert.equal(menu(bar.container), null);
    assert.equal(document.activeElement, hamburger(bar.container));
  } finally {
    await bar.unmount();
  }
});

test("other keys leave the menu open", async () => {
  const bar = await mount("employee");
  try {
    await click(hamburger(bar.container));
    await press("Tab");
    assert.ok(menu(bar.container));
  } finally {
    await bar.unmount();
  }
});

test("a tap outside the menu closes it; a tap inside does not", async () => {
  const bar = await mount("employee");
  try {
    await click(hamburger(bar.container));
    await pointerDown(menu(bar.container)!.querySelector("a")!);
    assert.ok(menu(bar.container), "a tap on a menu item is not outside");

    const page = document.createElement("main");
    document.body.appendChild(page);
    await pointerDown(page);
    assert.equal(menu(bar.container), null, "a tap on the page closes it");
    page.remove();
  } finally {
    await bar.unmount();
  }
});
