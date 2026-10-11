// Unit tests for Archive and On schedule on the Team page.
//
//   npm test        (node --test lib/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_NEEDS_MIGRATION,
  archiveColumnReady,
  archiveConfirmMessage,
  archiveName,
  archivePatch,
  archivedToggleLabel,
  isArchived,
  parseArchivedAt,
  splitArchived,
} from "./teamArchive.ts";

const p = (full_name: string | null, archived_at?: string | null, active = true) =>
  archived_at === undefined ? { full_name, active } : { full_name, active, archived_at };

const WHEN = "2026-09-29T18:00:00.000Z";

test("splitArchived: archived_at set is archived, null is current, order kept", () => {
  const ann = p("Ann", null);
  const bob = p("Bob", WHEN);
  const cat = p("Cat", null);
  const dan = p("Dan", WHEN);
  const { current, archived } = splitArchived([ann, bob, cat, dan]);
  assert.deepEqual(current, [ann, cat]);
  assert.deepEqual(archived, [bob, dan]);
});

test("splitArchived: off the schedule is NOT archived (owners and office staff stay on the team)", () => {
  const owner = p("Alina Withers", null, false);
  const { current, archived } = splitArchived([owner]);
  assert.deepEqual(current, [owner]);
  assert.equal(archived.length, 0);
});

test("splitArchived: before migration 32 (no archived_at key) nobody is archived, even if inactive", () => {
  const people = [p("Ann", undefined, true), p("Alex", undefined, false)];
  const { current, archived } = splitArchived(people);
  assert.equal(current.length, 2);
  assert.equal(archived.length, 0);
});

test("isArchived: only a timestamp counts", () => {
  assert.equal(isArchived({ archived_at: WHEN }), true);
  assert.equal(isArchived({ archived_at: null }), false);
  assert.equal(isArchived({}), false);
  assert.equal(isArchived({ archived_at: "" }), false);
});

test("archiveColumnReady: a null archived_at means the column exists; a missing key means it doesn't", () => {
  assert.equal(archiveColumnReady([p("Ann", null)]), true);
  assert.equal(archiveColumnReady([p("Ann", WHEN)]), true);
  assert.equal(archiveColumnReady([p("Ann"), p("Bob")]), false);
  assert.equal(archiveColumnReady([]), false);
});

test("archivePatch: Archive sends true, Unarchive sends null, and neither touches active", () => {
  assert.deepEqual(archivePatch(true), { archived_at: true });
  assert.deepEqual(archivePatch(false), { archived_at: null });
});

test("parseArchivedAt: true is the server's now, null unarchives, anything else refused", () => {
  const now = new Date(WHEN);
  assert.deepEqual(parseArchivedAt(true, now), { ok: true, value: WHEN });
  assert.deepEqual(parseArchivedAt(null, now), { ok: true, value: null });
  for (const bad of [false, "2020-01-01T00:00:00Z", "", 0, 1, {}, undefined]) {
    assert.equal(parseArchivedAt(bad, now).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("ARCHIVE_NEEDS_MIGRATION names the migration", () => {
  assert.match(ARCHIVE_NEEDS_MIGRATION, /migration 32/);
});

test("archiveName: full name first", () => {
  assert.equal(archiveName(p("Joey Smith"), "joey@example.com"), "Joey Smith");
});

test("archiveName: a name that is really an email, or none, falls back to the email", () => {
  assert.equal(archiveName(p("joey@example.com"), "joey@example.com"), "joey@example.com");
  assert.equal(archiveName(p(null), "joey@example.com"), "joey@example.com");
  assert.equal(archiveName(p("   "), "joey@example.com"), "joey@example.com");
});

test("archiveName: no name and no email", () => {
  assert.equal(archiveName(p(null), ""), "this person");
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
