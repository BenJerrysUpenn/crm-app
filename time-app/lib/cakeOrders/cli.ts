// The cake order packing reminders as a command (crm-app #142), for the
// 5-minute bj-cake-order-reminders.timer on bj-box (Software-Factory
// droplet/). It follows the cash count reminders (lib/cashCount/cli.ts):
// scripts/cake-order-reminders.ts wires it to Postgres (lib/cakeOrdersPg.ts),
// the mailbox (mail.ts), Slack (slack.ts) and Claude Code
// (lib/cashCount/claudeCli.ts); the tests wire it to an in-memory store and
// stand-ins.
//
// Usage: cake-order-reminders [--dry-run]
//   DATABASE_URL               Postgres DSN for the Supabase project (required).
//                              The unit maps it from secrets.env's BJ_DATABASE_URL.
//   CAKE_ORDERS_ORDER_ADDRESS  the address Olo sends each order to (required;
//                              set in the unit, not in this public repo)
//   CAKE_ORDERS_CLAUDE_BIN     the claude executable (default: claude on PATH)
//   CAKE_ORDERS_SLACK_CHANNEL  move the channel
//
// The tokens come from Supabase Vault at run time, over the same connection:
//   slack_cake_orders_bot_token  the "Cake Orders" Slack app's bot token (required)
//   gmail_sender_address,        the mailbox the order emails reach and its
//   gmail_app_password           Gmail app password, read over IMAP (required;
//                                already in Vault for bj-finance)
//   claude_usage_token           the owner's Claude subscription token, for
//                                Claude Code; missing means plain messages
// None is ever printed, logged or put on a command line.
//
// --dry-run reads everything and has Claude write every message that is due,
// plus a preview of a post and a follow-up, and prints them with the emails
// it could not read as orders. It posts nothing and writes nothing to the
// database; the mailbox is only ever read.
//
// Exit codes, as the cash count reminders':
//   0  ran; what was due was posted, or nothing was due
//   1  a failure: the database, Vault, the mailbox or Slack could not be used,
//      migration 54 is not applied, or a step of the run failed (each printed)
//   2  bad usage: unknown argument, or DATABASE_URL or
//      CAKE_ORDERS_ORDER_ADDRESS missing

import type { AskClaude } from "../cashCount/claudeCli";
import type { VaultReader } from "../cashCount/cli";
import type { MailReader } from "./mail";
import { PARSER_READY, WAITING_NOTE } from "./oloEmail";
import { runCakeOrderReminders, type CakeOrderResult } from "./run";
import type { SlackClient } from "./slack";
import type { CakeOrderStore } from "./store";

export type { VaultReader };

export const SLACK_TOKEN_SECRET = "slack_cake_orders_bot_token";
export const MAIL_USER_SECRET = "gmail_sender_address";
export const MAIL_PASSWORD_SECRET = "gmail_app_password";
export const CLAUDE_TOKEN_SECRET = "claude_usage_token";

/** Open a connection, run `fn`, always close. */
export type OpenCakeOrderStore = <T>(dsn: string, fn: (store: CakeOrderStore, vault: VaultReader) => Promise<T>) => Promise<T>;

export type CakeOrderCliDeps = {
  env: Record<string, string | undefined>;
  now: () => Date;
  openStore: OpenCakeOrderStore;
  slackFor: (token: string) => SlackClient;
  mailFor: (login: { user: string; password: string }) => MailReader;
  claudeFor: (token: string) => AskClaude;
  out: (line: string) => void;
  err: (line: string) => void;
};

const TAG = "[cake-orders]";
const USAGE = "usage: cake-order-reminders [--dry-run]  (DATABASE_URL and CAKE_ORDERS_ORDER_ADDRESS must be set)";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runCakeOrderCli(argv: string[], deps: CakeOrderCliDeps): Promise<number> {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else {
      deps.err(`${TAG} unknown argument: ${arg}. ${USAGE}`);
      return 2;
    }
  }
  const dsn = deps.env.DATABASE_URL?.trim();
  if (!dsn) {
    deps.err(`${TAG} ERROR: DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  const orderAddress = deps.env.CAKE_ORDERS_ORDER_ADDRESS?.trim();
  if (!orderAddress) {
    deps.err(`${TAG} ERROR: CAKE_ORDERS_ORDER_ADDRESS is not set. ${USAGE}`);
    return 2;
  }

  type Stop = { status: "no_slack_token" } | { status: "no_mailbox"; missing: string } | { status: "vault_unreadable"; error: string };
  let result: CakeOrderResult | Stop;
  let claudeNote = "";
  try {
    result = await deps.openStore(dsn, async (store, vault) => {
      let slackToken: string | null;
      let mailUser: string | null;
      let mailPassword: string | null;
      let claudeToken: string | null;
      try {
        slackToken = await vault.secret(SLACK_TOKEN_SECRET);
        mailUser = await vault.secret(MAIL_USER_SECRET);
        mailPassword = await vault.secret(MAIL_PASSWORD_SECRET);
        claudeToken = await vault.secret(CLAUDE_TOKEN_SECRET);
      } catch (e) {
        return { status: "vault_unreadable" as const, error: errText(e) };
      }
      if (!slackToken) return { status: "no_slack_token" as const };
      if (!mailUser || !mailPassword) return { status: "no_mailbox" as const, missing: !mailUser ? MAIL_USER_SECRET : MAIL_PASSWORD_SECRET };
      if (!claudeToken) claudeNote = `Vault has no ${CLAUDE_TOKEN_SECRET}: every message is the plain one`;
      return runCakeOrderReminders({
        now: deps.now().getTime(),
        store,
        slack: deps.slackFor(slackToken),
        mail: deps.mailFor({ user: mailUser, password: mailPassword }),
        orderAddress,
        ask: claudeToken ? deps.claudeFor(claudeToken) : null,
        channel: deps.env.CAKE_ORDERS_SLACK_CHANNEL?.trim() || undefined,
        dryRun,
      });
    });
  } catch (e) {
    deps.err(`${TAG} ERROR: the database could not be used: ${errText(e)}`);
    return 1;
  }

  if (result.status === "vault_unreadable") {
    deps.err(`${TAG} ERROR: Vault could not be read: ${result.error}`);
    return 1;
  }
  if (result.status === "no_slack_token") {
    deps.err(`${TAG} ERROR: Vault has no ${SLACK_TOKEN_SECRET}; nothing was posted`);
    return 1;
  }
  if (result.status === "no_mailbox") {
    deps.err(`${TAG} ERROR: Vault has no ${result.missing}; the order emails cannot be read, nothing was posted`);
    return 1;
  }
  if (result.status === "not_migrated") {
    deps.err(`${TAG} ERROR: migration 54 (cake_order_reminders) is not applied; nothing was posted`);
    return 1;
  }
  if (claudeNote) deps.err(`${TAG} ${claudeNote}`);

  const mail = result.mail
    ? `mail ${result.mail.read} read, ${result.mail.orders} cake order${result.mail.orders === 1 ? "" : "s"}` +
      (result.mail.unrecognised ? `, ${result.mail.unrecognised} not readable` : "")
    : "mail unreadable";
  const clocked = result.onClock === null ? "" : `, ${result.onClock} on the clock`;
  const head = `${TAG}${dryRun ? " DRY RUN:" : ""} ${result.at}, ${mail}${clocked}`;
  const done = [
    ...result.posted.map((p) => `posted ${p.order} (${p.source}${p.note ? `: ${p.note}` : ""}, ${p.mentioned} mentioned)`),
    ...result.held.map((h) => `held ${h.order} (${h.why})`),
    ...result.followups.map(
      (f) => `follow-up ${f.order} ${f.outcome}${f.how ? ` (${f.how})` : ""}${f.source ? ` (${f.source}${f.note ? `: ${f.note}` : ""})` : ""}`,
    ),
  ];
  deps.out(`${head}: ${done.length ? done.join("; ") : dryRun ? "planned" : "nothing due"}`);
  if (!PARSER_READY) deps.out(`${TAG} no order can be posted yet: ${WAITING_NOTE}`);
  for (const u of result.unread ?? []) deps.out(`${TAG} not read as an order: ${u.from || "(no sender)"} | ${u.subject || "(no subject)"}`);
  for (const m of result.messages ?? []) {
    const what = m.when === "due" ? "would post" : "preview of";
    const label = m.occasion === "followup" ? `the follow-up for ${m.order} in its thread` : `the post for ${m.order}`;
    const to = m.to.length ? ` to ${m.to.join(", ")}` : "";
    const note = m.note ? `: ${m.note}` : "";
    deps.out(`${TAG} ${what} ${label}${to} (${m.why}; ${m.source}${note})`);
    for (const line of m.text.split("\n")) deps.out(`  ${line}`);
  }
  if (dryRun && !(result.messages ?? []).length) deps.out(`${TAG} nothing to post, and nobody on the clock to preview for`);
  for (const e of result.errors) deps.err(`${TAG} ERROR: ${e}`);
  return result.errors.length ? 1 : 0;
}
