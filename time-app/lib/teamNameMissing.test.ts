// The Team page's roster row for a person with no usable name (bj-finance #468):
// a "Name missing" badge beside their login email, and an empty Name box with
// an "Enter full name" prompt, never the email sitting in the box as if it were
// the name. A named person gets neither.
//
// Rendered with react-dom/server. The router Next's app router would supply is
// given through its AppRouterContext; Supabase is the fake one (child sections
// may build a client on render, and their effects never run on the server).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadAppModule, startFakeSupabase } from "./testing/fakeSupabase.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import type { Profile } from "./types.ts";

const { AppRouterContext } = createRequire(import.meta.url)(
  "next/dist/shared/lib/app-router-context.shared-runtime.js",
) as { AppRouterContext: import("react").Context<unknown> };

const { default: TeamAdmin } = await loadAppModule<{ default: unknown }>("components/TeamAdmin.tsx");

startFakeSupabase({});

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function person(id: string, full_name: string | null): Profile {
  return {
    id,
    full_name,
    phone: null,
    role: "employee",
    hourly_rate: null,
    active: true,
    archived_at: null,
    notif_prefs: {},
    created_at: "2026-09-01T00:00:00Z",
  };
}

/** The roster row (<tr>) whose email cell holds `email`. */
function rowFor(employees: Profile[], emailById: Record<string, string>, email: string): string {
  const html = renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(TeamAdmin as never, {
        employees,
        locations: [],
        emailById,
        settings: DEFAULT_SETTINGS,
        shiftTypes: [],
        reminders: [],
        employeeCount: employees.length,
        storeHours: [],
        storeExceptions: [],
        storeHoursReady: true,
        holidays: [],
      }),
    ),
  );
  const row = (html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? []).find((r) => r.includes(`>${email}`));
  assert.ok(row, `a roster row for ${email}`);
  return row;
}

const SAM = "00000000-0000-0000-0000-00000000000b";
const OLD = "00000000-0000-0000-0000-00000000000c";
const NONE = "00000000-0000-0000-0000-00000000000d";
const roster = [person(SAM, "Sam Lee"), person(OLD, "staff2@example.com"), person(NONE, null)];
const emails = { [SAM]: "sam.lee@example.test", [OLD]: "staff2@example.com", [NONE]: "none@example.test" };

/** The value of the row's Name box: the first text input in the row. */
function nameBox(row: string): string {
  const input = row.match(/<input(?![^>]*type="(?:checkbox|number|tel)")[^>]*>/);
  assert.ok(input, "the row has a Name box");
  return input[0];
}

test("a person whose name is still their email is marked Name missing, with an empty Name box", () => {
  const row = rowFor(roster, emails, "staff2@example.com");
  assert.match(row, />Name missing</);
  const box = nameBox(row);
  assert.match(box, /value=""/);
  assert.match(box, /placeholder="Enter full name"/);
});

test("a person with no name is marked Name missing, with an empty Name box", () => {
  const row = rowFor(roster, emails, "none@example.test");
  assert.match(row, />Name missing</);
  assert.match(nameBox(row), /placeholder="Enter full name"/);
});

test("a named person is not marked, and their Name box holds their name", () => {
  const row = rowFor(roster, emails, "sam.lee@example.test");
  assert.doesNotMatch(row, /Name missing/);
  const box = nameBox(row);
  assert.match(box, /value="Sam Lee"/);
  assert.doesNotMatch(box, /placeholder=/);
});
