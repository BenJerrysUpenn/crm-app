// Undo and Redo on the schedule, driven the way a manager drives them: the
// board rendered into a DOM (happy-dom) inside the app's UndoProvider, the
// buttons clicked, and the board's requests answered by the real routes over
// the stand-in Supabase (lib/testing/fakeSupabase.ts).
//
// 2026-11-12: "Copy last week" was pressed by mistake and there was no way
// back short of deleting each copy by hand. These pin that it now has one.
//
//   npm test

import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

const browser = new Window({ url: "http://time.localhost/schedule" });
for (const key of ["window", "self", "document", "navigator", "Node", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, {
    value: (browser as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("Multiple GoTrueClient instances")) return;
  warn(...args);
};

const require = createRequire(import.meta.url);
const React = require("react") as typeof import("react");
const { act } = React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> };
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime.js") as {
  AppRouterContext: import("react").Context<unknown>;
};

type Handler = (request: Request, ctx: { params: { id: string } }) => Promise<Response>;
const { default: ScheduleBoard } = await loadAppModule<{ default: (props: never) => React.ReactElement }>("components/ScheduleBoard.tsx");
const { default: UndoProvider } = await loadAppModule<{ default: (props: { children?: React.ReactNode }) => React.ReactElement }>("components/UndoProvider.tsx");
const shiftById = await loadAppModule<{ PATCH: Handler; DELETE: Handler }>("app/api/shifts/[id]/route.ts");
const shiftsRoute = await loadAppModule<{ POST: (request: Request) => Promise<Response> }>("app/api/shifts/route.ts");
const copyWeek = await loadAppModule<{ POST: (request: Request) => Promise<Response> }>("app/api/shifts/copy-week/route.ts");

after(async () => {
  await browser.happyDOM.close();
  console.warn = warn;
});

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const WEEK = "2030-09-15"; // a Sunday
const LAST_TUE = "2030-09-10";
const THIS_TUE = "2030-09-17";
const edt = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-04:00`).toISOString();

let db: FakeSupabase;
let refreshes: number;
const realFetch = globalThis.fetch;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager", phone: null, hourly_rate: 20 },
      { id: SAM, role: "employee", active: true, full_name: "Sam Test", phone: null, hourly_rate: 15 },
    ],
    shifts: [
      { id: 1, employee_id: SAM, location_id: 1, starts_at: edt(LAST_TUE, "12:00"), ends_at: edt(LAST_TUE, "17:00"), position: "PENN Opener", notes: null, published: true },
      { id: 2, employee_id: SAM, location_id: 1, starts_at: edt(THIS_TUE, "18:00"), ends_at: edt(THIS_TUE, "22:00"), position: "PENN Closer", notes: null, published: true },
    ],
    locations: [{ id: 1, name: "Store", is_default: true }],
    shift_types: [],
    shift_requests: [],
    shift_notices: [],
    annotations: [],
    availability: [],
    notifications: [],
  });
  db.signIn(MANAGER);
  refreshes = 0;
  const supabase = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("/api/")) return supabase(input, init);
    const method = init?.method ?? "GET";
    const request = new Request(`http://time.localhost${url}`, { method, body: init?.body, headers: init?.headers });
    const byId = url.match(/^\/api\/shifts\/(\d+)$/);
    if (byId && method === "PATCH") return shiftById.PATCH(request, { params: { id: byId[1] } });
    if (byId && method === "DELETE") return shiftById.DELETE(request, { params: { id: byId[1] } });
    if (url === "/api/shifts" && method === "POST") return shiftsRoute.POST(request);
    if (url === "/api/shifts/copy-week" && method === "POST") return copyWeek.POST(request);
    throw new Error(`the board asked for ${method} ${url}, which this test does not answer`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const router = { refresh() { refreshes++; }, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };

/** The board for WEEK, as the page would load it, inside the app's undo history. */
async function onSchedule(fn: (page: HTMLElement) => Promise<void>) {
  const shifts = db.rows("shifts").map((s) => ({ ...s, profiles: { id: SAM, full_name: "Sam Test" } }));
  const board = React.createElement(ScheduleBoard, {
    isManager: true,
    weekStart: WEEK,
    shifts,
    employees: db.rows("profiles"),
    locations: db.rows("locations"),
    dropRequests: [],
    shiftTypes: [],
    today: WEEK,
  } as never) as unknown as React.ReactElement;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(React.createElement(AppRouterContext.Provider, { value: router }, React.createElement(UndoProvider, null, board))),
    );
    await fn(container);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}

const text = (page: HTMLElement) => (page.textContent ?? "").replace(/\s+/g, " ");
function button(page: HTMLElement, label: string): HTMLButtonElement {
  const b = [...page.querySelectorAll("button")].find((x) => x.textContent?.trim() === label);
  assert.ok(b, `no "${label}" button`);
  return b as unknown as HTMLButtonElement;
}
async function click(el: Element) {
  await act(async () => void el.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as never));
}
async function key(k: string, opts: { shift?: boolean; target?: Element } = {}) {
  await act(async () =>
    void (opts.target ?? document.body).dispatchEvent(
      new browser.KeyboardEvent("keydown", { key: k, ctrlKey: true, shiftKey: opts.shift ?? false, bubbles: true, cancelable: true }) as never,
    ),
  );
}
const copiesOnTuesday = () => db.rows("shifts").filter((s) => s.starts_at === edt(THIS_TUE, "12:00")).length;

test("Copy last week can be undone and redone from the bar", async () => {
  await onSchedule(async (page) => {
    assert.doesNotMatch(text(page), /Undo/, "no bar before anything is done");

    await click(button(page, "Copy last week"));
    assert.equal(copiesOnTuesday(), 1);
    assert.match(text(page), /Copied 1 shift from last week/);

    await click(button(page, "Undo"));
    assert.equal(copiesOnTuesday(), 0, "the copy is gone");
    assert.equal(db.rows("shifts").length, 2, "nothing else is touched");
    assert.match(text(page), /Undone: Copied 1 shift from last week/);

    await click(button(page, "Redo"));
    assert.equal(copiesOnTuesday(), 1);
    assert.match(text(page), /Redone: Copied 1 shift from last week/);
    assert.ok(refreshes >= 3, "the page reloads its data after each step");
  });
});

test("Ctrl+Z undoes and Ctrl+Shift+Z redoes, but not while typing in a field", async () => {
  await onSchedule(async (page) => {
    await click(button(page, "Copy last week"));
    assert.equal(copiesOnTuesday(), 1);

    const field = document.createElement("input");
    page.appendChild(field);
    await key("z", { target: field });
    assert.equal(copiesOnTuesday(), 1, "a field keeps its own undo");

    await key("z");
    assert.equal(copiesOnTuesday(), 0);
    await key("z", { shift: true });
    assert.equal(copiesOnTuesday(), 1);
  });
});

test("a deleted shift comes back with Undo, and goes again with Redo", async () => {
  await onSchedule(async (page) => {
    const closer = [...page.querySelectorAll("*")].find((el) => el.children.length === 0 && /PENN Closer/.test(el.textContent ?? ""));
    assert.ok(closer, "the closer shift is on the board");
    await click(closer!);
    await click(button(page, "Delete"));
    assert.equal(db.rows("shifts").some((s) => s.position === "PENN Closer"), false);
    assert.match(text(page), /Deleted Sam's shift, Tue, Sep 17/);

    await click(button(page, "Undo"));
    const back = db.rows("shifts").find((s) => s.position === "PENN Closer");
    assert.ok(back, "the shift is back");
    assert.equal(back!.employee_id, SAM);
    assert.equal(back!.starts_at, edt(THIS_TUE, "18:00"));

    await click(button(page, "Redo"));
    assert.equal(db.rows("shifts").some((s) => s.position === "PENN Closer"), false);
  });
});
