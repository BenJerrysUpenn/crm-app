// Schedule coverage reminder (bj-finance #709): emails the owners and
// on-schedule managers every open store hour and booked catering event in the
// next two Sun–Sat weeks that nobody is scheduled for. Runs Thu/Fri at noon
// ET from bj-coverage-reminder.timer on bj-box (Software-Factory droplet/).
// All logic lives in lib/; this file only wires it to the process.
//
//   npm run coverage-reminder -- --dry-run   # prints recipients + email, sends nothing
//   npm run coverage-reminder                # sends (only if there are gaps)
import { withPgReminderStore } from "@/lib/coverageReminderPg";
import { runCoverageReminderCli } from "@/lib/coverageReminderCli";
import { gmailApiSender } from "@/lib/gmailSend";

runCoverageReminderCli(process.argv.slice(2), {
  env: process.env,
  now: () => new Date(),
  openStore: withPgReminderStore,
  sendMail: gmailApiSender(process.env),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[coverage-reminder] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
