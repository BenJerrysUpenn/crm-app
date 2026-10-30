// Claude Code headless as the reminders' writer (lib/cashCount/claudeCli.ts),
// driven as a real child process against a fake `claude` executable: a small
// Node script that records how it was started and answers as told. The
// stories:
//   * success: the message text comes back; the token is in the child's
//     environment only, never on its command line; no tools; the Haiku model;
//     the prompt goes in on stdin;
//   * the child sees none of this process's other environment (no stray
//     CLAUDE_CODE_OAUTH_TOKEN or DATABASE_URL from the unit's env files);
//   * a non-zero exit, an error result (a usage limit), a timeout, garbage
//     output, or no executable at all: an answer saying why, never a throw;
//   * end to end through writeReminder: any of those means the plain message.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Cli from "./claudeCli.ts";
import type * as Message from "./message.ts";

const { claudeCli, MODEL } = await loadAppModule<typeof Cli>("lib/cashCount/claudeCli.ts");
const { writeReminder } = await loadAppModule<typeof Message>("lib/cashCount/message.ts");

const TOKEN = "fake-subscription-token-for-tests";
let dir: string;
let bin: string;

// The fake reads what to do from behaviour.json beside it and writes what it
// saw to record.json.
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const here = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(here, "behaviour.json"), "utf8"));
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(here, "record.json"), JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin, cwd: process.cwd() }));
  if (b.mode === "hang") return setTimeout(() => {}, 60000);
  if (b.mode === "garbage") { process.stdout.write("not json at all\\n"); process.exit(0); }
  if (b.mode === "crash") { process.stderr.write("Error: boom\\n"); process.exit(3); }
  const result = { type: "result", subtype: "success", is_error: b.mode !== "ok", result: b.text, stop_reason: b.stop || "end_turn", api_error_status: b.status || null };
  process.stdout.write(JSON.stringify(result) + "\\n");
  process.exit(b.mode === "ok" ? 0 : 1);
});
`;

function behave(b: { mode: "ok" | "error" | "hang" | "garbage" | "crash"; text?: string; status?: number; stop?: string }) {
  writeFileSync(join(dir, "behaviour.json"), JSON.stringify(b));
}
const record = () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { argv: string[]; env: Record<string, string>; stdin: string; cwd: string };
const ask = (timeoutMs?: number, env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: dir }) =>
  claudeCli({ bin, token: TOKEN, env, timeoutMs });

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  bin = join(dir, "claude");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("success: the text comes back; the token is in the child's environment only; no tools; Haiku; the prompt on stdin", async () => {
  behave({ mode: "ok", text: "Morning <@U0SAM>, please post the opening counts here." });
  const answer = await ask()({ system: "You write one Slack message.", prompt: "<cash_count_steps>\nOpen: count.\n</cash_count_steps>" });
  assert.deepEqual(answer, { ok: true, text: "Morning <@U0SAM>, please post the opening counts here." });

  const seen = record();
  assert.equal(seen.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.ok(!seen.argv.some((a) => a.includes(TOKEN)), "the token is never on the command line");
  assert.equal(seen.stdin, "<cash_count_steps>\nOpen: count.\n</cash_count_steps>");
  const flag = (name: string) => seen.argv[seen.argv.indexOf(name) + 1];
  assert.ok(seen.argv.includes("-p"));
  assert.equal(flag("--model"), MODEL);
  assert.equal(MODEL, "claude-haiku-5-5");
  assert.equal(flag("--tools"), "", "no tools");
  assert.equal(flag("--system-prompt"), "You write one Slack message.");
  assert.equal(flag("--output-format"), "json");
  assert.ok(seen.argv.includes("--no-session-persistence"));
  assert.ok(seen.argv.includes("--strict-mcp-config"));
  assert.equal(seen.env.DISABLE_AUTOUPDATER, "1");
});

test("the child gets none of this process's other environment, so no stray token or DSN reaches it", async () => {
  behave({ mode: "ok", text: "hi" });
  await ask(undefined, {
    PATH: process.env.PATH,
    HOME: dir,
    CLAUDE_CODE_OAUTH_TOKEN: "a-stale-token-from-an-env-file",
    DATABASE_URL: "postgresql://user:secret@db.example.test/postgres",
    ANTHROPIC_API_KEY: "should-not-pass",
  })({ system: "s", prompt: "p" });
  const env = record().env;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN, "the Vault token, not the inherited one");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.HOME, dir);
});

test("an error result, such as a usage limit, is an answer saying why", async () => {
  behave({ mode: "error", text: "Claude AI usage limit reached|1793400000", status: 429 });
  const answer = await ask()({ system: "s", prompt: "p" });
  assert.deepEqual(answer, { ok: false, reason: "claude error 429: Claude AI usage limit reached|1793400000" });
});

test("a cut-off answer is not used", async () => {
  behave({ mode: "ok", text: "<@U0SAM> please po", stop: "max_tokens" });
  assert.deepEqual(await ask()({ system: "s", prompt: "p" }), { ok: false, reason: "claude stopped: max_tokens" });
});

test("a non-zero exit with no result, garbage output, and a missing executable are answers too", async () => {
  behave({ mode: "crash" });
  assert.deepEqual(await ask()({ system: "s", prompt: "p" }), { ok: false, reason: "claude exited 3: Error: boom" });
  behave({ mode: "garbage" });
  assert.deepEqual(await ask()({ system: "s", prompt: "p" }), { ok: false, reason: "claude printed no result" });
  const missing = claudeCli({ bin: join(dir, "no-such-claude"), token: TOKEN, env: { PATH: process.env.PATH } });
  assert.deepEqual(await missing({ system: "s", prompt: "p" }), { ok: false, reason: `claude not found (${join(dir, "no-such-claude")})` });
});

test("a hung child is killed at the timeout", async () => {
  behave({ mode: "hang" });
  const started = Date.now();
  assert.deepEqual(await ask(300)({ system: "s", prompt: "p" }), { ok: false, reason: "claude timed out after 0s" });
  assert.ok(Date.now() - started < 5000, "it does not wait for the child");
});

test("through writeReminder: a good answer is posted; a timeout, an error or a bad message means the plain one", async () => {
  const args = { rules: "Open: count the register and post it.", people: [{ token: "<@U0SAM>" }], phase: "open" as const, occasion: "reminder" as const };
  const plain = "<@U0SAM> thanks for opening! Please post the opening cash counts here, as the cash count steps in this channel say.";

  behave({ mode: "ok", text: "Morning <@U0SAM>! Please post the register count here." });
  assert.deepEqual(await writeReminder({ ...args, ask: ask() }), { text: "Morning <@U0SAM>! Please post the register count here.", source: "ai" });

  behave({ mode: "hang" });
  assert.deepEqual(await writeReminder({ ...args, ask: ask(300) }), { text: plain, source: "fallback", note: "claude timed out after 0s" });

  behave({ mode: "crash" });
  assert.equal((await writeReminder({ ...args, ask: ask() })).text, plain);

  behave({ mode: "ok", text: "<@U0SAM> the register should be $300." });
  assert.deepEqual(await writeReminder({ ...args, ask: ask() }), { text: plain, source: "fallback", note: "AI message rejected: a dollar sign" });
});
