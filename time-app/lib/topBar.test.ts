// The time app's top bar: where a signed-in person finds their account page.
// Account has no tab in the desktop row; from the sm breakpoint (640px, where
// that row appears) the name at the right of the bar is the link to /account.
//
// Rendered with react-dom/server. The pathname Next's app router would supply
// is given through its PathnameContext; Supabase is the fake one (the bell
// builds a client on render, and its effects never run on the server).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadAppModule, startFakeSupabase } from "./testing/fakeSupabase.ts";

const { PathnameContext } = createRequire(import.meta.url)(
  "next/dist/shared/lib/hooks-client-context.shared-runtime.js",
) as { PathnameContext: import("react").Context<string | null> };

const { default: TopBar } = await loadAppModule<{
  default: (props: { email: string; role: "manager" | "employee"; name: string }) => unknown;
}>("components/TopBar.tsx");

startFakeSupabase({ notifications: [] });

function renderBar(role: "manager" | "employee", pathname = "/schedule") {
  return renderToStaticMarkup(
    createElement(
      PathnameContext.Provider,
      { value: pathname },
      createElement(TopBar as never, { email: "sam@example.test", role, name: "Sam Lee" }),
    ),
  );
}

/** The desktop tab row: the <nav> shown from the sm breakpoint up. */
function desktopTabs(html: string): string {
  const row = html.match(/<nav class="hidden sm:flex[^"]*">([\s\S]*?)<\/nav>/);
  assert.ok(row, "the bar renders a desktop tab row");
  return row[1];
}

for (const [role, who] of [["employee", "an employee"], ["manager", "a manager"]] as const) {
  test(`the desktop tab row has no Account tab for ${who}`, () => {
    const tabs = desktopTabs(renderBar(role));
    assert.match(tabs, />Schedule<\/a>/);
    assert.doesNotMatch(tabs, /href="\/account"/);
    assert.doesNotMatch(tabs, />Account</);
  });
}

test("from the sm breakpoint the name in the bar links to /account", () => {
  const html = renderBar("employee");
  const nameLink = [...html.matchAll(/<a class="([^"]*)" href="\/account">([\s\S]*?)<\/a>/g)].find((m) =>
    m[2].includes("Sam Lee"),
  );
  assert.ok(nameLink, "the name in the bar links to /account");
  const classes = nameLink[1].split(/\s+/);
  assert.ok(classes.includes("hidden") && classes.includes("sm:flex"), `shown from sm: ${nameLink[1]}`);
  assert.ok(!classes.includes("md:flex"), `not held back to md: ${nameLink[1]}`);
});
