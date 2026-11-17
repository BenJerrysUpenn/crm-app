// Cake order packing reminders in Slack #cake-orders-and-ideas (crm-app
// #142): when Olo's per-order email for a cake arrives, @mentions everyone on
// a store punch to pack it (or, if nobody is in, 30 minutes after the first
// clock-in), and replies once in the thread if it is not marked packed 60
// minutes later. Runs every 5 minutes from bj-cake-order-reminders.timer on
// bj-box (Software-Factory droplet/). Each message is written by Claude Code
// on the owner's subscription; any failure there sends the plain message.
// All logic lives in time-app/lib/cakeOrders/; this file only wires it to the process.
//
//   npm run cake-order-reminders -- --dry-run   # prints the plan and the messages, posts and writes nothing
//   npm run cake-order-reminders                # posts what is due
import { withPgCakeOrderStore } from "@/lib/cakeOrdersPg";
import { runCakeOrderCli } from "../time-app/lib/cakeOrders/cli";
import { claudeCli } from "../time-app/lib/cashCount/claudeCli";
import { imapMailbox } from "../time-app/lib/cakeOrders/mail";
import { slackClient } from "../time-app/lib/cakeOrders/slack";

runCakeOrderCli(process.argv.slice(2), {
  env: process.env,
  now: () => new Date(),
  openStore: withPgCakeOrderStore,
  slackFor: slackClient,
  mailFor: (login) => imapMailbox(login),
  claudeFor: (token) => claudeCli({ bin: process.env.CAKE_ORDERS_CLAUDE_BIN?.trim() || "claude", token, env: process.env }),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[cake-orders] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
