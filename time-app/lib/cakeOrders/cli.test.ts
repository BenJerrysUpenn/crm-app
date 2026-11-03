// The cake order packing reminders as a command (lib/cakeOrders/cli.ts), the
// way the bj-box timer runs it: `cake-order-reminders [--dry-run]`. The
// stories:
//   * the tokens come from Vault: the Slack one to Slack, the mailbox login to
//     the mailbox, the Claude one to Claude Code; none is ever printed;
//   * a run says what it read and did, and that the Olo parser is not built;
//   * --dry-run prints the plan and the messages, posts nothing and writes
//     nothing;
//   * no claude_usage_token: plain messages, said once, still exit 0;
//   * no Slack token (the "Cake Orders" app not made yet), no mailbox login,
//     Vault or the database unreadable, migration 54 not applied, or a failed
//     step: exit 1 with the reason;
//   * a bad argument, no DATABASE_URL or no CAKE_ORDERS_ORDER_ADDRESS: exit 2.
// Stand-ins: the in-memory store, the mailbox, Slack's Web API at the HTTP
// boundary, and an AskClaude.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import { memoryCakeOrderStore, type MemoryCakeOrderStore } from "../testing/cakeOrderStore.ts";
import type * as CliModule from "./cli.ts";
import type * as Slack from "./slack.ts";

const { runCakeOrderCli } = await loadAppModule<typeof CliModule>("lib/cakeOrders/cli.ts");
const { slackClient } = await loadAppModule<typeof Slack>("lib/cakeOrders/slack.ts");

const SLACK_TOKEN = "xoxb-cli-test-token";
const CLAUDE_TOKEN = "claude-cli-test-token";
const MAIL_USER = "owner@example.test";
const MAIL_PASSWORD = "mail-cli-test-password";
const ANA = "00000000-0000-0000-0000-00000000000a";
const ENV = { DATABASE_URL: "postgresql://cli.test/db", CAKE_ORDERS_ORDER_ADDRESS: "orders@example.test" };
const est = (hhmm: string) => new Date(`2026-11-04T${hhmm}:00-05:00`).toISOString();

let db: MemoryCakeOrderStore;
let vault: Record<string, string>;
let vaultDown: boolean;
let dbDown: boolean;
let posts: string[];
let logins: { user: string; password: string }[];
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
  if (method === "users.lookupByEmail") return Response.json({ ok: true, user: { id: "U0ANA" } });
  if (method === "users.list") return Response.json({ ok: true, members: [] });
  throw new Error(`unexpected Slack method ${method}`);
}

function deps(at: string, env: Record<string, string | undefined> = ENV): CliModule.CakeOrderCliDeps {
  return {
    env,
    now: () => new Date(est(at)),
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
    mailFor: (login) => {
      logins.push(login);
      return {
        async search() {
          return [{ uid: 7, receivedAt: est("12:00"), raw: "From: Someone <a@example.test>\r\nSubject: Weekly summary\r\n\r\nhi\r\n" }];
        },
      };
    },
    claudeFor: (token) => {
      claudeTokens.push(token);
      return async () => ({ ok: true, text: "<@U0ANA> cake order! Please pack it and react when done." });
    },
    out: (line) => out.push(line),
    err: (line) => errs.push(line),
  };
}

beforeEach(() => {
  db = memoryCakeOrderStore({
    persons: [{ id: ANA, full_name: "Ana Able", preferred_name: null, email: "ana@example.test" }],
    types: [{ name: "PENN Opener", in_store: true }],
    shifts: [{ id: 1, employee_id: ANA, starts_at: est("11:00"), ends_at: est("17:00"), position: "PENN Opener", deal_id: null, published: true }],
    entries: [{ id: 11, employee_id: ANA, shift_id: 1, clock_in_at: est("11:00"), clock_out_at: null }],
  });
  vault = { slack_cake_orders_bot_token: SLACK_TOKEN, gmail_sender_address: MAIL_USER, gmail_app_password: MAIL_PASSWORD, claude_usage_token: CLAUDE_TOKEN };
  vaultDown = false;
  dbDown = false;
  posts = [];
  logins = [];
  claudeTokens = [];
  out = [];
  errs = [];
  globalThis.fetch = fakeSlack as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const printed = () => [...out, ...errs].join("\n");
const noSecrets = () => [SLACK_TOKEN, CLAUDE_TOKEN, MAIL_PASSWORD].every((s) => !printed().includes(s));
const WAITING = "[cake-orders] no order can be posted yet: the Olo email parser waits on the first real order email (crm-app #142)";

test("a run reads the mailbox with the Vault login, says what it read, exits 0, and prints no secret", async () => {
  assert.equal(await runCakeOrderCli([], deps("12:05")), 0);
  assert.deepEqual(logins, [{ user: MAIL_USER, password: MAIL_PASSWORD }]);
  assert.deepEqual(out, ["[cake-orders] 2026-11-04 12:05, mail 1 read, 0 cake orders, 1 not readable: nothing due", WAITING]);
  assert.deepEqual(errs, []);
  assert.deepEqual(posts, []);
  assert.ok(noSecrets());
});

test("--dry-run lists what it could not read and previews the messages, posts nothing and writes nothing", async () => {
  assert.equal(await runCakeOrderCli(["--dry-run"], deps("12:05")), 0);
  assert.deepEqual(posts, []);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(claudeTokens, [CLAUDE_TOKEN], "Claude Code gets the subscription token");
  assert.deepEqual(out.slice(0, 5), [
    "[cake-orders] DRY RUN: 2026-11-04 12:05, mail 1 read, 0 cake orders, 1 not readable, 1 on the clock: planned",
    WAITING,
    "[cake-orders] not read as an order: Someone <a@example.test> | Weekly summary",
    "[cake-orders] preview of the post for preview to <@U0ANA> (on the clock now; ai)",
    "  <@U0ANA> cake order! Please pack it and react when done.",
  ]);
  assert.ok(out.some((l) => l.startsWith("[cake-orders] preview of the follow-up for preview in its thread (an hour later, not packed;")));
  assert.ok(noSecrets());
});

test("no claude_usage_token: plain messages, said once, exit 0", async () => {
  delete vault.claude_usage_token;
  assert.equal(await runCakeOrderCli(["--dry-run"], deps("12:05")), 0);
  assert.deepEqual(claudeTokens, []);
  assert.deepEqual(errs, ["[cake-orders] Vault has no claude_usage_token: every message is the plain one"]);
  assert.ok(out.includes("  <@U0ANA> a new cake order just came in. Please pack it, then react to this message or reply in the thread when it is done."));
});

test("no Slack token, no mailbox login, Vault or the database unreadable, or migration 54 missing: exit 1 with the reason", async () => {
  delete vault.slack_cake_orders_bot_token;
  assert.equal(await runCakeOrderCli(["--dry-run"], deps("12:05")), 1);
  assert.deepEqual(errs, ["[cake-orders] ERROR: Vault has no slack_cake_orders_bot_token; nothing was posted"]);
  assert.deepEqual(logins, [], "the mailbox is not opened");

  vault.slack_cake_orders_bot_token = SLACK_TOKEN;
  delete vault.gmail_app_password;
  errs = [];
  assert.equal(await runCakeOrderCli([], deps("12:05")), 1);
  assert.deepEqual(errs, ["[cake-orders] ERROR: Vault has no gmail_app_password; the order emails cannot be read, nothing was posted"]);

  vault.gmail_app_password = MAIL_PASSWORD;
  vaultDown = true;
  errs = [];
  assert.equal(await runCakeOrderCli([], deps("12:05")), 1);
  assert.deepEqual(errs, ["[cake-orders] ERROR: Vault could not be read: permission denied for view decrypted_secrets"]);

  vaultDown = false;
  dbDown = true;
  errs = [];
  assert.equal(await runCakeOrderCli([], deps("12:05")), 1);
  assert.deepEqual(errs, ["[cake-orders] ERROR: the database could not be used: connect ECONNREFUSED"]);

  dbDown = false;
  db.migrated_ = false;
  errs = [];
  assert.equal(await runCakeOrderCli([], deps("12:05")), 1);
  assert.deepEqual(errs, ["[cake-orders] ERROR: migration 54 (cake_order_reminders) is not applied; nothing was posted"]);
  assert.deepEqual(posts, []);
  assert.ok(noSecrets());
});

test("a step that fails is printed and exits 1", async () => {
  db.fail.add("orders");
  assert.equal(await runCakeOrderCli([], deps("12:05")), 1);
  assert.deepEqual(errs, ["[cake-orders] ERROR: orders: connection lost (orders)"]);
});

test("a bad argument, no DATABASE_URL or no order address exits 2", async () => {
  assert.equal(await runCakeOrderCli(["--post"], deps("12:05")), 2);
  assert.match(errs[0], /unknown argument: --post/);
  assert.equal(await runCakeOrderCli([], deps("12:05", { CAKE_ORDERS_ORDER_ADDRESS: "orders@example.test" })), 2);
  assert.match(errs[1], /DATABASE_URL is not set/);
  assert.equal(await runCakeOrderCli([], deps("12:05", { DATABASE_URL: "postgresql://cli.test/db" })), 2);
  assert.match(errs[2], /CAKE_ORDERS_ORDER_ADDRESS is not set/);
  assert.deepEqual(posts, []);
});
