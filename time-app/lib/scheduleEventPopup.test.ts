// The shift popup's event dropdown, driven the way a manager drives it: the
// Schedule page run against the stand-in Supabase, its board rendered into a DOM
// (happy-dom), chips, badges and the "Events to choose" list clicked, and Submit
// sent through the real shift routes. Pins that the one event a shift fits is
// chosen for it only when the popup was opened to choose an event (a badge or
// the list) or for a new shift, and that any other opening leaves the dropdown
// on None with a suggestion that writes nothing. The rule itself is
// lib/scheduleEvents.test.ts; the routes' side is lib/shiftEventLink.test.ts.
//
// Invented names and dates.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "happy-dom";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

// A browser for React to render into. Set before react-dom loads: it decides
// at load time whether there is a DOM.
const browser = new Window({ url: "http://time.localhost/schedule" });
for (const key of ["window", "self", "document", "navigator", "Node", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "MouseEvent", "getComputedStyle", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, {
    value: (browser as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// supabase-js opens a BroadcastChannel when it thinks it is in a browser, which
// would hold the process open after the tests.
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });
// With a window present, supabase-js warns on every client the server code makes. Only that line is dropped.
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
const { default: SchedulePage } = await loadAppModule<{
  default: (props: { searchParams: { week?: string } }) => Promise<React.ReactElement>;
}>("app/schedule/page.tsx");
const { default: ScheduleBoard } = await loadAppModule<{ default: (props: never) => React.ReactElement }>("components/ScheduleBoard.tsx");
const shiftById = await loadAppModule<{ PATCH: Handler }>("app/api/shifts/[id]/route.ts");
const shiftsRoute = await loadAppModule<{ POST: (request: Request) => Promise<Response> }>("app/api/shifts/route.ts");
const { fmtTime } = await loadAppModule<typeof import("./format.ts")>("lib/format.ts");

after(async () => {
  await browser.happyDOM.close();
});

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const WEEK = "2030-09-15"; // a Sunday

function edt(date: string, hhmm: string) {
  return new Date(`${date}T${hhmm}:00-04:00`).toISOString();
}
/** A datetime-local value for an instant, in this machine's zone, as the popup writes one. */
function localInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const deal = (id: number, company: string, date: string, start: string, end: string, stage = "Booked Paid") => ({
  id, event_name: null, company, venue_name: null, contact_first_name: null, contact_last_name: null,
  event_date: date, event_start_time: start, event_end_time: end, stage, archived: 0, event_type: null,
});

const MON = "2030-09-16", TUE = "2030-09-17", WED = "2030-09-18", THU = "2030-09-19", FRI = "2030-09-20";

// Each shift ends at its own time, so its chip can be told from the rest.
const shift = (id: number, date: string, end: string, over: Record<string, unknown> = {}) => ({
  id, employee_id: SAM, location_id: 1, starts_at: edt(date, "11:00"), ends_at: edt(date, end), position: "Catering",
  notes: null, published: true, acknowledged_at: null, deal_id: null, deal_slot: null, ...over,
});
const ONE_FITS = shift(1, MON, "15:00"); // covers the one Monday event
const TWO_FIT = shift(2, TUE, "15:15"); // covers both Tuesday events
const NONE_FITS = shift(3, WED, "15:30"); // Wednesday's event is in the evening
const LINKED = shift(4, THU, "15:45", { deal_id: 704, deal_slot: 1 }); // another Thursday event also fits
const OPEN_ONE_FITS = shift(5, MON, "16:00", { employee_id: null }); // open, so no badge
const MARKETING_ONE_FITS = shift(6, FRI, "16:15", { position: "Marketing" });

let db: FakeSupabase;
/** What the board sent to /api, in order. */
let sent: { method: string; path: string; body: Record<string, unknown> | null }[];

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager", phone: null, hourly_rate: 20 },
      { id: SAM, role: "employee", active: true, full_name: "Sam Test", phone: null, hourly_rate: 15 },
    ],
    deals: [
      deal(700, "Monday Co", MON, "12:00", "14:00"),
      deal(701, "Tuesday One", TUE, "12:00", "14:00"),
      deal(702, "Tuesday Two", TUE, "12:30", "14:30", "Booked Unpaid"),
      deal(703, "Evening Co", WED, "18:00", "20:00"),
      deal(704, "Thursday Linked", THU, "12:00", "14:00"),
      deal(705, "Thursday Other", THU, "12:00", "14:00"),
      deal(706, "Friday Marketing", FRI, "12:00", "14:00", "Closed Marketing Event"),
    ],
    shifts: [ONE_FITS, TWO_FIT, NONE_FITS, LINKED, OPEN_ONE_FITS, MARKETING_ONE_FITS].map((s) => ({ ...s })),
    shift_types: [
      { id: 1, name: "Catering", color: "#f59e0b", sort_order: 1, active: true, default_start: null, default_end: null },
      { id: 2, name: "Marketing", color: "#6366f1", sort_order: 2, active: true, default_start: null, default_end: null },
    ],
    locations: [{ id: 1, name: "Store", is_default: true }],
    shift_requests: [],
    shift_notices: [],
    annotations: [],
    availability: [],
    notifications: [],
  });
  db.signIn(MANAGER);
  // The board's own requests go to the real routes; Supabase's go to the fake.
  const supabase = globalThis.fetch;
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("/api/")) return supabase(input, init);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const method = init?.method ?? "GET";
    sent.push({ method, path: url, body });
    const request = new Request(`http://time.localhost${url}`, { method, body: init?.body, headers: init?.headers });
    const byId = url.match(/^\/api\/shifts\/(\d+)$/);
    if (byId && method === "PATCH") return shiftById.PATCH(request, { params: { id: byId[1] } });
    if (url === "/api/shifts" && method === "POST") return shiftsRoute.POST(request);
    throw new Error(`the board asked for ${method} ${url}, which this test does not answer`);
  }) as typeof fetch;
});

function findBoard(node: React.ReactNode): React.ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findBoard(child);
      if (found) return found;
    }
    return null;
  }
  const element = node as React.ReactElement<{ children?: React.ReactNode }> | null;
  if (!element || typeof element !== "object" || !("props" in element)) return null;
  if (element.type === ScheduleBoard) return element;
  return findBoard(element.props.children);
}

const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };

/** The manager's Schedule page for the week, mounted; run `fn` against it. */
async function onSchedule(fn: (page: HTMLElement) => Promise<void>) {
  const board = findBoard(await SchedulePage({ searchParams: { week: WEEK } }));
  assert.ok(board, "the page renders the board");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(React.createElement(AppRouterContext.Provider, { value: router }, board)));
    await fn(container);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}

async function click(el: Element) {
  await act(async () => void el.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as never));
}
/** Type into an input or pick from a select, as React hears it. */
async function setValue(el: Element, value: string) {
  await act(async () => {
    const proto = el.tagName === "SELECT" ? browser.HTMLSelectElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new browser.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }) as never);
  });
}

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (root: Element) => [...root.querySelectorAll("button")];
function button(root: Element, label: string | RegExp): HTMLButtonElement {
  const found = buttons(root).find((b) => (typeof label === "string" ? text(b) === label : label.test(text(b))));
  assert.ok(found, `no button ${label}`);
  return found as unknown as HTMLButtonElement;
}
/** The body of a shift's chip: the button that starts with its times. */
function chip(page: Element, s: { starts_at: string; ends_at: string }): HTMLButtonElement {
  const times = `${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}`;
  const found = buttons(page).find((b) => text(b.firstElementChild) === times);
  assert.ok(found, `no chip for ${times}`);
  return found as unknown as HTMLButtonElement;
}
/** A shift's badge on its chip: the element holding exactly the badge's words, next to that chip. */
function chipBadge(page: Element, s: { starts_at: string; ends_at: string }, words: string): Element {
  const holder = chip(page, s).parentElement!;
  const found = [...holder.querySelectorAll("*")].find((el) => text(el) === words && el.children.length === 0);
  assert.ok(found, `no badge "${words}" on that chip`);
  return found;
}
const popup = (page: Element) => {
  const panel = page.querySelector(".modal-panel");
  assert.ok(panel && /Edit shift|New shift/.test(text(panel)), "the shift popup is open");
  return panel;
};
/** The popup's event dropdown and the words around it. */
function eventField(page: Element) {
  const panel = popup(page);
  const label = [...panel.querySelectorAll("label")].find((l) => /^(Catering|Marketing) event/.test(text(l)));
  assert.ok(label, "the popup has an event dropdown");
  const select = label.querySelector("select") as unknown as HTMLSelectElement;
  return {
    select,
    selected: text(select.options[select.selectedIndex] as unknown as Element),
    suggestion: text(panel).match(/Suggested: ([^]*?)(?=More than one|Notes|$)/)?.[1]?.trim() ?? null,
    panelText: text(panel),
  };
}
/** Press Submit, and Save anyway when the route asks about Sam's availability (none is on file here). */
async function submit(page: Element) {
  await click(button(popup(page), "Submit"));
  const again = page.querySelector(".modal-panel") && buttons(popup(page)).find((b) => text(b) === "Save anyway");
  if (again) await click(again);
  assert.equal(page.querySelector(".modal-panel"), null, "the popup closed on a saved shift");
}
async function openFromList(page: Element, words: string) {
  await click(button(page, /^Events to choose \(\d+\)$/));
  const list = page.querySelector(".modal-panel")!;
  await click(buttons(list).find((b) => text(b).includes(words))!);
}
const row = (id: number) => db.rows("shifts").find((s) => s.id === id)!;

// --- opened to choose an event: preselected ---------------------------------------

test("opened from the badge on its chip, the one event the shift fits is preselected, and Submit links it", async () => {
  await onSchedule(async (page) => {
    await click(chipBadge(page, ONE_FITS, "Event: Monday Co?"));
    const field = eventField(page);
    assert.match(field.selected, /^Monday Co/);
    assert.equal(field.suggestion, null);
    await submit(page);
    assert.equal(sent.at(-1)?.body?.deal_id, 700);
    assert.equal(row(1).deal_id, 700);
    assert.equal(row(1).deal_slot, 1);
  });
});

test("opened from the Events to choose list, the one event the shift fits is preselected", async () => {
  await onSchedule(async (page) => {
    await openFromList(page, "Event: Monday Co?");
    assert.match(eventField(page).selected, /^Monday Co/);
  });
});

test("a new shift preselects the one event it fits", async () => {
  await onSchedule(async (page) => {
    // Sam's row, Monday's cell.
    const adds = buttons(page).filter((b) => text(b) === "+ Add");
    await click(adds[7 + 1]);
    const panel = popup(page);
    assert.match(text(panel), /New shift/);
    const [start, end] = [...panel.querySelectorAll('input[type="datetime-local"]')];
    await setValue(start, localInput(edt(MON, "11:00")));
    await setValue(end, localInput(edt(MON, "14:30")));
    const type = [...panel.querySelectorAll("label")].find((l) => text(l).startsWith("Shift type"))!.querySelector("select")!;
    await setValue(type, "Catering");
    const field = eventField(page);
    assert.match(field.selected, /^Monday Co/);
    assert.equal(field.suggestion, null);
    await submit(page);
    assert.equal(sent.at(-1)?.method, "POST");
    assert.equal(sent.at(-1)?.body?.deal_id, 700);
    const made = db.rows("shifts").at(-1)!;
    assert.equal(made.deal_id, 700);
  });
});

// --- opened any other way: None, with a suggestion ----------------------------------

test("opened from its chip, a shift that fits one event stays on None and names it as a suggestion", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, ONE_FITS));
    const field = eventField(page);
    assert.equal(field.selected, "None");
    assert.equal(field.suggestion, "Monday Co");
    assert.doesNotMatch(field.panelText, /Picked because/);
    assert.deepEqual(sent, [], "opening the popup sends nothing");
  });
});

test("an open shift and a Marketing shift opened from their chips also stay on None with the suggestion", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, OPEN_ONE_FITS));
    assert.deepEqual([eventField(page).selected, eventField(page).suggestion], ["None", "Monday Co"]);
    await click(button(popup(page), "Cancel"));
    await click(chip(page, MARKETING_ONE_FITS));
    assert.match(eventField(page).panelText, /Marketing event/);
    assert.deepEqual([eventField(page).selected, eventField(page).suggestion], ["None", "Friday Marketing"]);
  });
});

test("fixing the hours from the chip and saving writes no deal_id: the shift stays unlinked", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, ONE_FITS));
    const [, end] = [...popup(page).querySelectorAll('input[type="datetime-local"]')];
    await setValue(end, localInput(edt(MON, "15:30")));
    assert.equal(eventField(page).selected, "None");
    await submit(page);
    const save = sent.find((r) => r.method === "PATCH");
    assert.ok(save, "the save went out");
    assert.equal("deal_id" in save.body!, false);
    assert.equal(row(1).ends_at, edt(MON, "15:30"));
    assert.equal(row(1).deal_id, null);
    assert.equal(row(1).deal_slot, null);
  });
});

test("choosing the suggested event is one change of the dropdown, and that save links it", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, ONE_FITS));
    await setValue(eventField(page).select, "700");
    assert.match(eventField(page).selected, /^Monday Co/);
    assert.equal(eventField(page).suggestion, null);
    await submit(page);
    assert.equal(row(1).deal_id, 700);
  });
});

test("a popup opened from the list, cancelled, then opened from the chip is back to None", async () => {
  await onSchedule(async (page) => {
    await openFromList(page, "Event: Monday Co?");
    await click(button(popup(page), "Cancel"));
    await click(chip(page, ONE_FITS));
    assert.equal(eventField(page).selected, "None");
  });
});

// --- no suggestion, and no preselect, when nothing or two things fit -----------------

test("no event fits: None and no suggestion", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, NONE_FITS));
    const field = eventField(page);
    assert.equal(field.selected, "None");
    assert.equal(field.suggestion, null);
    assert.match(field.panelText, /Evening Co/, "the day's event can still be picked by hand");
  });
});

test("two events fit: None and no suggestion, from the chip and from its badge alike", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, TWO_FIT));
    assert.deepEqual([eventField(page).selected, eventField(page).suggestion], ["None", null]);
    assert.match(eventField(page).panelText, /More than one event fits/);
    await click(button(popup(page), "Cancel"));
    await click(chipBadge(page, TWO_FIT, "Choose an event"));
    assert.deepEqual([eventField(page).selected, eventField(page).suggestion], ["None", null]);
  });
});

// --- a linked shift --------------------------------------------------------------------

test("a linked shift shows its link and suggests nothing, and an unrelated save leaves the link", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, LINKED));
    const field = eventField(page);
    assert.match(field.selected, /^Thursday Linked/);
    assert.equal(field.suggestion, null);
    await setValue([...popup(page).querySelectorAll("input")].find((i) => i.type !== "datetime-local" && i.type !== "number")!, "bring the cart");
    await submit(page);
    assert.equal("deal_id" in sent.at(-1)!.body!, false);
    assert.equal(row(4).deal_id, 704);
    assert.equal(row(4).deal_slot, 1);
    assert.equal(row(4).notes, "bring the cart");
  });
});

test("None still clears a link", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, LINKED));
    await setValue(eventField(page).select, "none");
    await submit(page);
    assert.equal(sent.at(-1)?.body?.deal_id, null);
    assert.equal(row(4).deal_id, null);
  });
});

test("a linked shift moved to a day with one event that fits warns and clears, and is not linked to that event", async () => {
  await onSchedule(async (page) => {
    await click(chip(page, LINKED));
    const [start, end] = [...popup(page).querySelectorAll('input[type="datetime-local"]')];
    await setValue(start, localInput(edt(MON, "11:00")));
    await setValue(end, localInput(edt(MON, "15:00")));
    const field = eventField(page);
    assert.match(field.panelText, /This shift was on Thursday Linked, which is on another day\. Saving takes it off that event\./);
    assert.equal(field.selected, "None");
    await submit(page);
    assert.equal(sent.at(-1)?.body?.deal_id, null);
    assert.equal(row(4).deal_id, null);
    assert.equal(row(4).deal_slot, null);
  });
});
