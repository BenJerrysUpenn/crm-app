// The Schedule page's whole answer for a linked shift: the page run as Next would
// run it, then the board rendered from the props the browser would be sent. What a
// chip shows, and what a staff response carries, are read from there.
//
// The app router that Next would supply comes through its React context. Stand-in
// Supabase: lib/testing/fakeSupabase.ts.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

const { AppRouterContext } = createRequire(import.meta.url)(
  "next/dist/shared/lib/app-router-context.shared-runtime.js",
) as { AppRouterContext: import("react").Context<unknown> };

const { default: SchedulePage } = await loadAppModule<{
  default: (props: { searchParams: { week?: string } }) => Promise<ReactElement>;
}>("app/schedule/page.tsx");
const { default: ScheduleBoard } = await loadAppModule<{ default: (props: never) => ReactElement }>("components/ScheduleBoard.tsx");

const MANAGER = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const PAT = "00000000-0000-0000-0000-00000000000c";

const LONG_NAME = "A Very Long Company Name That Will Not Fit On A Schedule Chip";
const DEAL = {
  event_date: "2026-11-04",
  event_start_time: "12:00",
  event_end_time: "14:00",
  stage: "Booked Paid",
  archived: 0,
  venue_name: "Secret Venue",
  contact_email: "contact@example.test",
  contact_phone: "555-0100",
  total_price: 1234.5,
};

function shift(id: number, employee_id: string | null, deal_id: number | null, position = "Catering") {
  return {
    id,
    employee_id,
    location_id: 1,
    starts_at: "2026-11-04T16:00:00.000Z",
    ends_at: "2026-11-04T20:00:00.000Z",
    position,
    notes: null,
    published: true,
    acknowledged_at: null,
    deal_id,
    deal_slot: deal_id === null ? null : id,
  };
}

let db: FakeSupabase;

beforeEach(() => {
  db = startFakeSupabase({
    profiles: [
      { id: MANAGER, role: "manager", active: true, full_name: "Test Manager" },
      { id: SAM, role: "employee", active: true, full_name: "Sam Test" },
      { id: PAT, role: "employee", active: true, full_name: "Pat Test" },
    ],
    deals: [
      { ...DEAL, id: 700, company: "Sam Company", contact_first_name: "Con", contact_last_name: "Tact" },
      { ...DEAL, id: 701, company: null, contact_first_name: "Only", contact_last_name: "Contact" },
      { ...DEAL, id: 702, company: LONG_NAME },
      { ...DEAL, id: 703, company: "Pat Company" },
      { ...DEAL, id: 704, company: "Marketing Company", stage: "Closed Marketing Event" },
    ],
    shifts: [
      shift(1, SAM, 700),
      shift(2, null, 701),
      shift(3, null, 702),
      shift(4, PAT, 703),
      shift(5, SAM, 999),
      shift(6, SAM, null),
      shift(7, SAM, 704, "Marketing"),
    ],
    shift_requests: [],
    shift_types: [],
    annotations: [],
    availability: [],
    locations: [{ id: 1, name: "Store", is_default: true }],
  });
});

function findBoard(node: ReactNode): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findBoard(child);
      if (found) return found;
    }
    return null;
  }
  const element = node as ReactElement<{ children?: ReactNode }> | null;
  if (!element || typeof element !== "object" || !("props" in element)) return null;
  if (element.type === ScheduleBoard) return element as ReactElement<Record<string, unknown>>;
  return findBoard(element.props.children);
}

async function boardFor(userId: string) {
  db.signIn(userId);
  const board = findBoard(await SchedulePage({ searchParams: { week: "2026-11-01" } }));
  assert.ok(board, "the page renders the board");
  return board;
}

function html(board: ReactElement) {
  const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, board));
}

/** The name line on a chip: `title` and text are both the name. */
function nameLine(name: string) {
  return new RegExp(`<div title="${name}" class="[^"]*\\btruncate\\b[^"]*">${name}</div>`);
}

test("a manager's chips show the name on assigned, open and system-made shifts, whatever the position", async () => {
  const page = html(await boardFor(MANAGER));
  assert.match(page, nameLine("Sam Company"));
  assert.match(page, nameLine("Pat Company"));
  assert.match(page, nameLine("Marketing Company"));
});

test("the name falls back to the contact", async () => {
  assert.match(html(await boardFor(MANAGER)), nameLine("Only Contact"));
});

test("a long name is kept whole for the tooltip and truncated on the chip", async () => {
  assert.match(html(await boardFor(MANAGER)), nameLine(LONG_NAME));
});

test("a shift with no link, or a deal that is gone, has a chip and no name line, and the page renders", async () => {
  const board = await boardFor(MANAGER);
  assert.deepEqual(
    Object.keys(board.props.eventNames as object).sort(),
    ["700", "701", "702", "703", "704"],
  );
  const page = html(board);
  // Seven chips, each with its time line, including the ones with no name.
  assert.equal(page.match(/whitespace-nowrap truncate/g)?.length, 7);
});

test("the deals can't be read: chips go without names and the page still renders", async () => {
  db.missingTables = ["deals"];
  const board = await boardFor(MANAGER);
  assert.deepEqual(board.props.eventNames, {});
  assert.doesNotMatch(html(board), /Sam Company/);
});

test("a staff member's cards show the name on their own shift and on open ones", async () => {
  const page = html(await boardFor(SAM));
  assert.match(page, nameLine("Sam Company"));
  assert.match(page, nameLine("Only Contact"));
  assert.match(page, nameLine(LONG_NAME));
  assert.match(page, nameLine("Marketing Company"));
});

// --- the badge count on a manager's schedule ----------------------------------------

/** The "Events to choose (n)" button; React marks the text joins with empty comments. */
function chooseButton(count: number) {
  return new RegExp(`Events to choose \\((?:<!-- -->)?${count}(?:<!-- -->)?\\)`);
}

test("a manager sees one shift to choose an event for: the unlinked Catering shift with a person that covers the day's events", async () => {
  // Shift 6 (Sam, no link, 11:00-15:00) covers the four 12:00-14:00 booked events.
  // Linked shifts, open shifts and the Marketing shift with its link are not counted.
  assert.match(html(await boardFor(MANAGER)), chooseButton(1));
});

test("the events can't be read: a manager sees no events-to-choose button and the page still renders", async () => {
  db.missingTables = ["deals"];
  const page = html(await boardFor(MANAGER));
  assert.doesNotMatch(page, /Events to choose/);
  assert.match(page, /whitespace-nowrap truncate/);
});

test("a staff response carries the names of the shifts they can see and nothing else of a deal", async () => {
  const board = await boardFor(SAM);
  assert.deepEqual(board.props.eventNames, { 700: "Sam Company", 701: "Only Contact", 702: LONG_NAME, 704: "Marketing Company" });
  assert.deepEqual(board.props.weekEvents, []);
  assert.deepEqual(board.props.linkedEvents, []);
  const sent = JSON.stringify(board.props);
  assert.doesNotMatch(sent, /Pat Company/, "not the name on a colleague's shift");
  assert.doesNotMatch(sent, /Secret Venue|contact@example\.test|555-0100|1234\.5|Con Tact/);
  assert.doesNotMatch(html(board), /Secret Venue|contact@example\.test|555-0100|1234\.5|Con Tact|Pat Company/);
});
