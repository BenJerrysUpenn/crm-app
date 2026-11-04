// The time app's top bar: where a signed-in person finds their account page,
// and which widths get the tab row and which the hamburger.
// Account has no tab in the tab row; from the md breakpoint (768px) the name at
// the right of the bar is the link to /account. The tab row shows from xl
// (1280px); below xl the hamburger menu holds the nav, Account included.
// The menu itself is driven in topBarMenu.test.ts.
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
  default: (props: { role: "manager" | "employee"; name: string | null }) => unknown;
}>("components/TopBar.tsx");

startFakeSupabase({ notifications: [] });

function renderBar(role: "manager" | "employee", pathname = "/schedule", name: string | null = "Sam Lee") {
  return renderToStaticMarkup(
    createElement(
      PathnameContext.Provider,
      { value: pathname },
      createElement(TopBar as never, { role, name }),
    ),
  );
}

/** Every <a href="/account"> in the bar, as [attributes, inner HTML]. */
function accountLinks(html: string): { attrs: string; classes: string[]; inner: string }[] {
  return [...html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter((m) => /(^|\s)href="\/account"/.test(m[1]))
    .map((m) => ({ attrs: m[1], classes: (m[1].match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/), inner: m[2] }));
}

/** The tab row: the <nav> shown from the xl breakpoint up. */
function desktopTabs(html: string): string {
  const row = html.match(/<nav aria-label="Main" class="hidden xl:flex[^"]*">([\s\S]*?)<\/nav>/);
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
  const menu = html.match(/<button [^>]*class="([^"]*)"[^>]*aria-label="Menu"/);
  assert.ok(menu, "the bar renders the Menu button");
  // Shown below xl, so every width below md (where the name is hidden) has it.
  assert.ok(menu[1].split(/\s+/).includes("xl:hidden"), `hamburger shown below xl: ${menu[1]}`);
});

test("below xl the hamburger sits at the far left of the bar, before the brand", () => {
  const html = renderBar("employee");
  const row = html.match(/<header [^>]*><div [^>]*>([\s\S]*)<\/div><\/header>/);
  assert.ok(row, "the bar renders its row");
  const first = row[1].match(/^<(\w+)([^>]*)>/);
  assert.ok(first, "the row has a first element");
  assert.equal(first[1], "button", `the row starts with the hamburger: ${first[0]}`);
  assert.match(first[2], /aria-label="Menu"/);
  assert.ok(html.indexOf('aria-label="Menu"') < html.indexOf(">Withers Time<"), "the hamburger comes before the brand");
});

test("the tab row and the hamburger switch at the same breakpoint, and the row never scrolls", () => {
  const html = renderBar("manager");
  const row = html.match(/<nav aria-label="Main" class="([^"]*)"/);
  assert.ok(row, "the bar renders the tab row");
  const classes = row[1].split(/\s+/);
  assert.ok(classes.includes("hidden") && classes.includes("xl:flex"), `row shown from xl: ${row[1]}`);
  assert.ok(!classes.some((c) => c.startsWith("overflow")), `row never scrolls or clips: ${row[1]}`);
});

test("the bar is left-aligned: no centred max-width box", () => {
  const html = renderBar("manager");
  const inner = html.match(/<header [^>]*><div class="([^"]*)"/);
  assert.ok(inner, "the bar renders its row");
  assert.doesNotMatch(inner[1], /\bmx-auto\b|\bmax-w-/);
  assert.ok(html.indexOf(">Withers Time<") < html.indexOf('aria-label="Main"'), "the brand comes before the tabs");
});

test("a long name is capped and truncated, with the full name as its tooltip", () => {
  const long = "Maximiliana Christodoulopoulou-Washington";
  const nameLink = accountLinks(renderBar("manager", "/schedule", long)).find((l) => l.inner.includes(long));
  assert.ok(nameLink, "the long name links to /account");
  assert.ok(nameLink.classes.some((c) => c.startsWith("max-w-")), `width capped: ${nameLink.attrs}`);
  assert.match(nameLink.inner, /class="[^"]*\btruncate\b/);
  assert.match(nameLink.attrs, new RegExp(`title="${long}"`));
});

// #468: the login email must never stand in for a name. A profile with no
// usable name (null, blank, or an email-like value left in full_name) reads the
// neutral "No name set" in the bar — never the email, never blank.
for (const [label, name] of [
  ["a null name", null],
  ["a blank name", ""],
  ["an email-like name", "sam@example.test"],
] as const) {
  test(`with ${label} the link reads "No name set", never the email or blank`, () => {
    const nameLink = accountLinks(renderBar("employee", "/schedule", name)).find((l) => l.classes.includes("md:flex"));
    assert.ok(nameLink, "the desktop account link still renders");
    assert.match(nameLink.inner, /<span[^>]*>No name set<\/span>/);
    assert.match(nameLink.attrs, /title="No name set"/);
    assert.doesNotMatch(nameLink.inner, /@/);
  });
}
