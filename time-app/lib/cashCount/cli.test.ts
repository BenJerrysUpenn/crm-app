// The cash count reminders as a command (lib/cashCount/cli.ts), the way the
// bj-box timer runs it: `cash-count-reminders [--dry-run]`. The stories:
//   * both tokens come from Vault: the Slack one to Slack, the Claude one to
//     Claude Code; neither is ever printed;
//   * a run that posts exits 0 and says what it posted;
//   * --dry-run prints the plan and the Claude-written messages, posts
//     nothing and writes nothing;
//   * no claude_usage_token: plain messages, said once, still exit 0;
//   * no Slack token, Vault or the database unreadable, migration 51 not
//     applied, or a failed step: exit 1 with the reason;
//   * a bad argument or no DATABASE_URL: exit 2.
// Stand-ins: the in-memory store, Slack's Web API at the HTTP boundary, and
// an AskClaude.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import { memoryCashCountStore, type MemoryCashCountStore } from "../testing/cashCountStore.ts";
import type * as CliModule from "./cli.ts";
import type * as Slack from "./slack.ts";

const { runCashCountCli } = await loadAppModule<typeof CliModule>("lib/cashCount/cli.ts");
const { slackClient } = await loadAppModule<typeof Slack>("lib/cashCount/slack.ts");

const SLACK_TOKEN = "xoxb-cli-test-token";
const CLAUDE_TOKEN = "claude-cli-test-token";
const OPENER = "00000000-0000-0000-0000-00000000000a";
const RULES_TS = "1793315956.512979";
const edt = (hhmm: string) => new Date(`2026-10-29T${hhmm}:00-04:00`).toISOString();

let db: MemoryCashCountStore;
let vault: Record<string, string>;
let vaultDown: boolean;
let dbDown: boolean;
let posts: string[];
let claudeTokens: string[];
let out: string[];
let errs: string[];
const realFetch = globalThis.fetch;

async function fakeSlack(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  assert.equal(request.headers.get("authorization"), `Bearer ${SLACK_TOKEN}`, "Slack gets the Vault token");
  const method = new URL(request.url).pathname.replace("/api/", "");
  const form = new URLSearchParams(await request.text());
  if (method === "chat.postMessage") {
    posts.push(form.get("text")!);
    return Response.json({ ok: true, ts: `1793400000.00000${posts.length}` });
  }
  if (method === "conversations.history") {
    return Response.json({ ok: true, messages: form.get("latest") === RULES_TS ? [{ ts: RULES_TS, user: "U0ALEX", text: "Open: count the register and post it." }] : [] });
  }
  if (method === "users.lookupByEmail") return Response.json({ ok: true, user: { id: "U0OPENER" } });
  if (method === "users.list") return Response.json({ ok: true, members: [] });
  throw new Error(`unexpected Slack method ${method}`);
}

function deps(at: string, env: Record<string, string | undefined> = { DATABASE_URL: "postgresql://cli.test/db" }): CliModule.CashCountCliDeps {
  return {
    env,
    now: () => new Date(edt(at)),
    openStore: async (dsn, fn) => {
      assert.equal(dsn, "postgresql://cli.test/db");
      if (dbDown) throw new Error("connect ECONNREFUSED");
      return fn(db, {
        secret: async (name) => {
          if (vaultDown) throw new Error("permission denied for view decrypted_secrets");
          return vault[name] ?? null;
        },
      });
    },
    slackFor: slackClient,
    claudeFor: (token) => {
      claudeTokens.push(token);
      return async () => ({ ok: true, text: "Morning <@U0OPENER>! Please post the register count here." });
    },
    out: (line) => out.push(line),
    err: (line) => errs.push(line),
  };
}

beforeEach(() => {
  db = memoryCashCountStore({
    persons: [{ id: OPENER, full_name: "Olive Opener", preferred_name: null, email: "olive@example.test" }],
    day: {
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens: "11:00:00", closes: "22:00:00" })),
      exceptions: [],
      closed: [],
      shiftTypes: [{ name: "PENN Opener", in_store: true }],
    },
    shifts: [{ id: 1, employee_id: OPENER, starts_at: edt("10:00"), ends_at: edt("16:00"), position: "PENN Opener", deal_id: null, published: true }],
    entries: [{ id: 11, employee_id: OPENER, shift_id: 1, clock_in_at: edt("10:20"), clock_out_at: null }],
  });
  vault = { slack_cash_count_bot_token: SLACK_TOKEN, claude_usage_token: CLAUDE_TOKEN };
  vaultDown = false;
  dbDown = false;
  posts = [];
  claudeTokens = [];
  out = [];
  errs = [];
  globalThis.fetch = fakeSlack as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const printed = () => [...out, ...errs].join("\n");

test("a run posts what is due with the Vault tokens, exits 0, and prints neither token", async () => {
  assert.equal(await runCashCountCli([], deps("10:21")), 0);
  assert.deepEqual(posts, ["Morning <@U0OPENER>! Please post the register count here."]);
  assert.deepEqual(claudeTokens, [CLAUDE_TOKEN], "Claude Code gets the subscription token");
  assert.deepEqual(out, ["[cash-count] 2026-10-29, store open 11:00-22:00: posted open (ai, 1 mentioned)"]);
  assert.deepEqual(errs, []);
  assert.ok(!printed().includes(SLACK_TOKEN) && !printed().includes(CLAUDE_TOKEN));

  assert.equal(await runCashCountCli([], deps("10:26")), 0);
  assert.equal(posts.length, 1, "the next tick posts nothing");
  assert.equal(out[1], "[cash-count] 2026-10-29, store open 11:00-22:00: nothing due");
});

test("--dry-run prints the plan and the messages Claude wrote, posts nothing and writes nothing", async () => {
  assert.equal(await runCashCountCli(["--dry-run"], deps("10:21")), 0);
  assert.deepEqual(posts, []);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(out, [
    "[cash-count] DRY RUN: 2026-10-29, store open 11:00-22:00: planned",
    "[cash-count] would post the open reminder to <@U0OPENER> (opening_shift; ai)",
    "  Morning <@U0OPENER>! Please post the register count here.",
  ]);
  assert.ok(!printed().includes(SLACK_TOKEN) && !printed().includes(CLAUDE_TOKEN));
});

test("--dry-run before anyone has clocked in says so", async () => {
  db.entries = [];
  db.shifts = [];
  assert.equal(await runCashCountCli(["--dry-run"], deps("09:00")), 0);
  assert.deepEqual(out, ["[cash-count] DRY RUN: 2026-10-29, store open 11:00-22:00: planned", "[cash-count] nobody to remind yet today"]);
});

test("no claude_usage_token: the plain message goes out, said once, exit 0", async () => {
  delete vault.claude_usage_token;
  assert.equal(await runCashCountCli([], deps("10:21")), 0);
  assert.deepEqual(claudeTokens, []);
  assert.match(posts[0], /^<@U0OPENER> thanks for opening! Please post the opening cash counts here/);
  assert.deepEqual(errs, ["[cash-count] Vault has no claude_usage_token: every message is the plain one"]);
});

test("no Slack token, Vault or the database unreadable, or migration 51 missing: exit 1 with the reason, nothing posted", async () => {
  delete vault.slack_cash_count_bot_token;
  assert.equal(await runCashCountCli([], deps("10:21")), 1);
  assert.deepEqual(errs, ["[cash-count] ERROR: Vault has no slack_cash_count_bot_token; nothing was posted"]);

  vault.slack_cash_count_bot_token = SLACK_TOKEN;
  vaultDown = true;
  errs = [];
  assert.equal(await runCashCountCli([], deps("10:21")), 1);
  assert.deepEqual(errs, ["[cash-count] ERROR: Vault could not be read: permission denied for view decrypted_secrets"]);

  vaultDown = false;
  dbDown = true;
  errs = [];
  assert.equal(await runCashCountCli([], deps("10:21")), 1);
  assert.deepEqual(errs, ["[cash-count] ERROR: the database could not be used: connect ECONNREFUSED"]);

  dbDown = false;
  db.migrated_ = false;
  errs = [];
  assert.equal(await runCashCountCli([], deps("10:21")), 1);
  assert.deepEqual(errs, ["[cash-count] ERROR: migration 51 (cash_count_reminders) is not applied; nothing was posted"]);
  assert.deepEqual(posts, []);
});

test("a step that fails is printed and exits 1", async () => {
  db.fail.add("dayRows");
  assert.equal(await runCashCountCli([], deps("10:21")), 1);
  assert.deepEqual(errs, ["[cash-count] ERROR: store hours: connection lost (dayRows)"]);
  assert.deepEqual(out, ["[cash-count] 2026-10-29, store unreadable: nothing due"]);
});

test("a bad argument or no DATABASE_URL exits 2", async () => {
  assert.equal(await runCashCountCli(["--post"], deps("10:21")), 2);
  assert.match(errs[0], /unknown argument: --post/);
  assert.equal(await runCashCountCli([], deps("10:21", {})), 2);
  assert.match(errs[1], /DATABASE_URL is not set/);
  assert.deepEqual(posts, []);
});
