// The cash count reminders as a command (crm-app #129), for the 5-minute
// bj-cash-count-reminders.timer on bj-box (Software-Factory droplet/). It
// follows the schedule coverage reminder (lib/coverageReminderCli.ts at the
// crm-app root): scripts/cash-count-reminders.ts wires it to Postgres
// (lib/cashCountPg.ts), Slack (slack.ts) and Claude Code (claudeCli.ts); the
// tests wire it to an in-memory store and stand-ins.
//
// Usage: cash-count-reminders [--dry-run]
//   DATABASE_URL              Postgres DSN for the Supabase project (required).
//                             The unit maps it from secrets.env's BJ_DATABASE_URL.
//   CASH_COUNT_CLAUDE_BIN     the claude executable (default: claude on PATH)
//   CASH_COUNT_SLACK_CHANNEL  CASH_COUNT_RULES_TS   move the channel and the steps message
//
// Both tokens come from Supabase Vault at run time, over the same connection:
//   slack_cash_count_bot_token  the "Cash Count" Slack app's bot token (required)
//   claude_usage_token          the owner's Claude subscription token, for
//                               Claude Code; missing means plain messages
// Neither is ever printed, logged or put on a command line.
//
// --dry-run reads everything and has Claude write every message that is due,
// plus a preview of today's opening and closing reminders, and prints them. It
// posts nothing and writes nothing to the database.
//
// Exit codes, as the coverage reminder's:
//   0  ran; what was due was posted, or nothing was due
//   1  a failure: the database, Vault or Slack could not be used, migration 51
//      is not applied, or a step of the run failed (each printed)
//   2  bad usage: unknown argument or DATABASE_URL missing

import type { AskClaude } from "./claudeCli";
import { runCashCountReminders, type CashCountResult } from "./run";
import type { SlackClient } from "./slack";
import type { CashCountStore } from "./store";

export const SLACK_TOKEN_SECRET = "slack_cash_count_bot_token";
export const CLAUDE_TOKEN_SECRET = "claude_usage_token";

/** Reads one Vault secret by name. Null when it is missing or empty; throws when Vault cannot be read. */
export type VaultReader = { secret: (name: string) => Promise<string | null> };

/** Open a connection, run `fn`, always close. */
export type OpenCashCountStore = <T>(dsn: string, fn: (store: CashCountStore, vault: VaultReader) => Promise<T>) => Promise<T>;

export type CashCountCliDeps = {
  env: Record<string, string | undefined>;
  now: () => Date;
  openStore: OpenCashCountStore;
  slackFor: (token: string) => SlackClient;
  claudeFor: (token: string) => AskClaude;
  out: (line: string) => void;
  err: (line: string) => void;
};

const TAG = "[cash-count]";
const USAGE = "usage: cash-count-reminders [--dry-run]  (DATABASE_URL must be set)";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runCashCountCli(argv: string[], deps: CashCountCliDeps): Promise<number> {
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

  let result: CashCountResult | { status: "no_slack_token" } | { status: "vault_unreadable"; error: string };
  let claudeNote = "";
  try {
    result = await deps.openStore(dsn, async (store, vault) => {
      let slackToken: string | null;
      let claudeToken: string | null;
      try {
        slackToken = await vault.secret(SLACK_TOKEN_SECRET);
        claudeToken = await vault.secret(CLAUDE_TOKEN_SECRET);
      } catch (e) {
        return { status: "vault_unreadable" as const, error: errText(e) };
      }
      if (!slackToken) return { status: "no_slack_token" as const };
      if (!claudeToken) claudeNote = `Vault has no ${CLAUDE_TOKEN_SECRET}: every message is the plain one`;
      return runCashCountReminders({
        now: deps.now().getTime(),
        store,
        slack: deps.slackFor(slackToken),
        ask: claudeToken ? deps.claudeFor(claudeToken) : null,
        channel: deps.env.CASH_COUNT_SLACK_CHANNEL?.trim() || undefined,
        rulesTs: deps.env.CASH_COUNT_RULES_TS?.trim() || undefined,
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
  if (result.status === "not_migrated") {
    deps.err(`${TAG} ERROR: migration 51 (cash_count_reminders) is not applied; nothing was posted`);
    return 1;
  }
  if (claudeNote) deps.err(`${TAG} ${claudeNote}`);

  const hours = result.hours ? ` ${result.hours.opens}-${result.hours.closes}` : "";
  const head = `${TAG}${dryRun ? " DRY RUN:" : ""} ${result.day}, store ${result.store}${hours}`;
  const done = [
    ...result.posted.map((p) => `posted ${p.kind} (${p.source}${p.note ? `: ${p.note}` : ""}, ${p.mentioned} mentioned)`),
    ...result.followups.map((f) => `follow-up ${f.kind} ${f.outcome}${f.source ? ` (${f.source}${f.note ? `: ${f.note}` : ""})` : ""}`),
  ];
  deps.out(`${head}: ${done.length ? done.join("; ") : dryRun ? "planned" : "nothing due"}`);
  for (const m of result.messages ?? []) {
    const what = m.when === "due" ? "would post" : "preview of";
    const label = m.occasion === "followup" ? `the ${m.kind} follow-up` : `the ${m.kind} reminder`;
    const note = m.note ? `: ${m.note}` : "";
    deps.out(`${TAG} ${what} ${label} to ${m.to.join(", ")} (${m.why}; ${m.source}${note})`);
    deps.out(`  ${m.text}`);
  }
  if (dryRun && !(result.messages ?? []).length) deps.out(`${TAG} nobody to remind yet today`);
  for (const e of result.errors) deps.err(`${TAG} ERROR: ${e}`);
  return result.errors.length ? 1 : 0;
}
