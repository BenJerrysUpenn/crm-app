// The time app's top bar: where a signed-in person finds their account page.
// Account has no tab in the desktop row; from the md breakpoint (768px, where
// that row appears) the name at the right of the bar is the link to /account.
// Below md the hamburger menu holds the nav, Account included.
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

function renderBar(role: "manager" | "employee", pathname = "/schedule", name = "Sam Lee", email = "sam@example.test") {
  return renderToStaticMarkup(
    createElement(
      PathnameContext.Provider,
      { value: pathname },
      createElement(TopBar as never, { email, role, name }),
    ),
  );
}

/** Every <a href="/account"> in the bar, as [attributes, inner HTML]. */
function accountLinks(html: string): { attrs: string; classes: string[]; inner: string }[] {
  return [...html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter((m) => /(^|\s)href="\/account"/.test(m[1]))
    .map((m) => ({ attrs: m[1], classes: (m[1].match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/), inner: m[2] }));
}

/** The desktop tab row: the <nav> shown from the md breakpoint up. */
function desktopTabs(html: string): string {
  const row = html.match(/<nav class="hidden md:flex[^"]*">([\s\S]*?)<\/nav>/);
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

test("from the md breakpoint the name in the bar links to /account", () => {
  const html = renderBar("employee");
  const nameLink = accountLinks(html).find((l) => l.inner.includes("Sam Lee"));
  assert.ok(nameLink, "the name in the bar links to /account");
  const { classes, attrs } = nameLink;
  assert.ok(classes.includes("hidden") && classes.includes("md:flex"), `shown from md: ${attrs}`);
});

test("the hamburger menu covers every width the name link does not", () => {
  const html = renderBar("employee");
  const menu = html.match(/<button class="([^"]*)"[^>]*aria-label="Menu"/);
  assert.ok(menu, "the bar renders the Menu button");
  assert.ok(menu[1].split(/\s+/).includes("md:hidden"), `hamburger hidden from md, where the name appears: ${menu[1]}`);
});

test("a long name is capped and truncated, with the full name as its tooltip", () => {
  const long = "Maximiliana Christodoulopoulou-Washington";
  const nameLink = accountLinks(renderBar("manager", "/schedule", long, long)).find((l) => l.inner.includes(long));
  assert.ok(nameLink, "the long name links to /account");
  assert.ok(nameLink.classes.some((c) => c.startsWith("max-w-")), `width capped: ${nameLink.attrs}`);
  assert.match(nameLink.inner, /class="[^"]*\btruncate\b/);
  assert.match(nameLink.attrs, new RegExp(`title="${long}"`));
});

test("with no name on the profile the link reads Account, never blank", () => {
  const nameLink = accountLinks(renderBar("employee", "/schedule", "", "")).find((l) => l.classes.includes("md:flex"));
  assert.ok(nameLink, "the desktop account link still renders");
  assert.match(nameLink.inner, /<span[^>]*>Account<\/span>/);
});
