import { nyWallClock } from "../time-app/lib/coverage";
import {
  buildReminder,
  reminderEmail,
  reminderWindow,
  selectRecipients,
  type RecipientRow,
  type ReminderSnapshot,
  type ReminderWindow,
} from "@/lib/coverageReminder";

// The schedule coverage reminder as a command (bj-finance #709), for the
// Thu/Fri noon timer on bj-box. scripts/coverage-reminder.ts wires it to
// Postgres (lib/coverageReminderPg.ts) and the Gmail API (lib/gmailSend.ts);
// tests wire it to an in-memory schedule and a recording mailer.
//
// Usage: coverage-reminder [--dry-run]
//   DATABASE_URL            Postgres DSN for the Supabase project (required)
//   COVERAGE_REMINDER_FROM  the From address (required to send; set in the
//                           systemd unit, never in this public repository)
//   OUTREACH_GMAIL_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN  Gmail API
//
// Every run is a fresh read-only check; nothing is remembered between runs.
// Exit codes, as reconcile-shifts:
//   0  checked; the email went out, or there was nothing to send
//   1  a failure (DB read, recipient lookup, Gmail send), already emailed to
//      FAILURE_TO when it could be
//   2  bad usage: unknown argument or DATABASE_URL missing

/**
 * Where a failed run is reported. A constant on purpose: it must work when the
 * database is the thing that failed. Already public in time-app migration_42.
 */
export const FAILURE_TO = "alex@withers-ventures.com";
export const FAILURE_SUBJECT = "Coverage reminder could not run";

export type ReminderStore = {
  snapshot: (window: ReminderWindow) => Promise<ReminderSnapshot>;
  recipientRows: () => Promise<RecipientRow[]>;
};

/** Open a read-only connection, run `fn`, always close. */
export type OpenReminderStore = <T>(dsn: string, fn: (store: ReminderStore) => Promise<T>) => Promise<T>;

/** `from` undefined = send as the Gmail account the token belongs to. */
export type OutgoingEmail = { from?: string; to: string[]; subject: string; body: string };

export type CliDeps = {
  env: Record<string, string | undefined>;
  now: () => Date;
  openStore: OpenReminderStore;
  sendMail: (email: OutgoingEmail) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
};

const TAG = "[coverage-reminder]";
const USAGE = "usage: coverage-reminder [--dry-run]  (DATABASE_URL must be set)";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runCoverageReminderCli(argv: string[], deps: CliDeps): Promise<number> {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else {
      deps.err(`${TAG} unknown argument: ${arg}. ${USAGE}`);
      return 2;
    }
  }
  const from = deps.env.COVERAGE_REMINDER_FROM?.trim() || undefined;

  // Report a failure: print it, then email it to FAILURE_TO (a dry run only
  // says it would). Returns the exit code to use.
  async function fail(problem: string, code: number): Promise<number> {
    deps.err(`${TAG} ERROR: ${problem}`);
    const email = { from, to: [FAILURE_TO], subject: FAILURE_SUBJECT, body: `${problem}\n` };
    if (dryRun) {
      deps.err(`${TAG} DRY RUN: would email ${FAILURE_TO} "${FAILURE_SUBJECT}"`);
      return code;
    }
    try {
      await deps.sendMail(email);
      deps.err(`${TAG} failure emailed to ${FAILURE_TO}`);
    } catch (e) {
      deps.err(`${TAG} ERROR: the failure email could not be sent either: ${message(e)}`);
    }
    return code;
  }

  const dsn = deps.env.DATABASE_URL?.trim();
  if (!dsn) return fail(`DATABASE_URL is not set. ${USAGE}`, 2);
  if (!from && !dryRun) return fail("COVERAGE_REMINDER_FROM is not set, so there is no sender.", 1);

  const runDate = nyWallClock(deps.now().toISOString()).date;
  const window = reminderWindow(runDate);

  let snapshot: ReminderSnapshot;
  let rows: RecipientRow[];
  try {
    [snapshot, rows] = await deps.openStore(dsn, (store) =>
      Promise.all([store.snapshot(window), store.recipientRows()]),
    );
  } catch (e) {
    return fail(`reading the schedule failed: ${message(e)}`, 1);
  }

  const recipients = selectRecipients(rows);
  if (recipients.length === 0) return fail("the recipient lookup found no recipients.", 1);

  const lines = buildReminder(snapshot, runDate);
  const email = reminderEmail(lines);
  const span = `${window.start} to ${window.end}`;

  if (dryRun) {
    deps.out(`${TAG} DRY RUN: run date ${runDate}, checking ${span}`);
    deps.out(`${TAG} recipients (${recipients.length}): ${recipients.join(", ")}`);
    if (!email) {
      deps.out(`${TAG} no gaps: nothing would be sent`);
      return 0;
    }
    deps.out(`From: ${from ?? "(COVERAGE_REMINDER_FROM not set)"}`);
    deps.out(`To: ${recipients.join(", ")}`);
    deps.out(`Subject: ${email.subject}`);
    deps.out("");
    deps.out(email.body.trimEnd());
    return 0;
  }

  if (!email) {
    deps.out(`${TAG} checked ${span}: no gaps, nothing sent`);
    return 0;
  }
  try {
    await deps.sendMail({ from, to: recipients, subject: email.subject, body: email.body });
  } catch (e) {
    return fail(`sending "${email.subject}" failed: ${message(e)}`, 1);
  }
  const gaps = `${lines.length} gap${lines.length === 1 ? "" : "s"}`;
  deps.out(`${TAG} checked ${span}: sent ${gaps} to ${recipients.length} recipients`);
  return 0;
}
