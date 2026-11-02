// Cash count reminders in Slack #cash-count (crm-app #129): reminds the opener
// after they clock in and the closer just after closing to post the cash
// counts, and nudges once in the thread if nobody has posted 30 minutes
// later. Runs every 5 minutes from bj-cash-count-reminders.timer on bj-box
// (Software-Factory droplet/). Each message is written by Claude Code on the
// owner's subscription; any failure there sends the plain message.
// All logic lives in time-app/lib/cashCount/; this file only wires it to the process.
//
//   npm run cash-count-reminders -- --dry-run   # prints the plan and the messages, posts and writes nothing
//   npm run cash-count-reminders                # posts what is due
import { withPgCashCountStore } from "@/lib/cashCountPg";
import { runCashCountCli } from "../time-app/lib/cashCount/cli";
import { claudeCli } from "../time-app/lib/cashCount/claudeCli";
import { slackClient } from "../time-app/lib/cashCount/slack";

runCashCountCli(process.argv.slice(2), {
  env: process.env,
  now: () => new Date(),
  openStore: withPgCashCountStore,
  slackFor: slackClient,
  claudeFor: (token) => claudeCli({ bin: process.env.CASH_COUNT_CLAUDE_BIN?.trim() || "claude", token, env: process.env }),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[cash-count] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
