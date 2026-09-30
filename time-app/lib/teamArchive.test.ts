// Unit tests for Archive on the Team page.
//
//   npm test        (node --test lib/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";

import { archiveConfirmMessage, archiveName, archivedToggleLabel, splitArchived } from "./teamArchive.ts";

const p = (full_name: string | null, active: boolean) => ({ full_name, active });

test("splitArchived: active people are current, inactive are archived, order kept", () => {
  const ann = p("Ann", true);
  const bob = p("Bob", false);
  const cat = p("Cat", true);
  const dan = p("Dan", false);
  const { current, archived } = splitArchived([ann, bob, cat, dan]);
  assert.deepEqual(current, [ann, cat]);
  assert.deepEqual(archived, [bob, dan]);
});

test("splitArchived: nobody archived gives an empty archived list", () => {
  const { current, archived } = splitArchived([p("Ann", true)]);
  assert.equal(current.length, 1);
  assert.equal(archived.length, 0);
});

test("archiveName: full name first", () => {
  assert.equal(archiveName(p("Joey Smith", true), "joey@example.com"), "Joey Smith");
});

test("archiveName: a name that is really an email, or none, falls back to the email", () => {
  assert.equal(archiveName(p("joey@example.com", true), "joey@example.com"), "joey@example.com");
  assert.equal(archiveName(p(null, true), "joey@example.com"), "joey@example.com");
  assert.equal(archiveName(p("   ", true), "joey@example.com"), "joey@example.com");
});

test("archiveName: no name and no email", () => {
  assert.equal(archiveName(p(null, true), ""), "this person");
});

test("archiveConfirmMessage: the wording Alina asked for", () => {
  assert.equal(
    archiveConfirmMessage("Joey"),
    "Archive Joey? They'll be hidden from the team, schedule and availability. You can unarchive any time.",
  );
});

test("archivedToggleLabel: show and hide carry the count", () => {
  assert.equal(archivedToggleLabel(3, false), "Show archived (3)");
  assert.equal(archivedToggleLabel(3, true), "Hide archived (3)");
});
