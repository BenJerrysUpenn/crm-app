// The schedule coverage reminder as a command (npm run coverage-reminder),
// end to end against an in-memory schedule and a recording mailer.
//
// The stories:
//   * gaps -> one "Schedule gaps" email to the recipients the database names;
//   * no gaps -> nothing sent;
//   * --dry-run prints the recipients and the email and sends nothing;
//   * any failure (DB read, recipient lookup, Gmail send) emails
//     "Coverage reminder could not run" to the fixed failure address and
//     exits 1;
//   * a bad argument or a missing DSN exits 2.
//
// Addresses are fake: this repository is public.

import { describe, expect, it } from "vitest";
import type { RecipientRow, ReminderSnapshot } from "@/lib/coverageReminder";
import {
  FAILURE_TO,
  runCoverageReminderCli,
  type CliDeps,
  type OutgoingEmail,
  type ReminderStore,
} from "@/lib/coverageReminderCli";

// Thursday 2026-10-15, 12:00 New York.
const NOON_THURSDAY = new Date("2026-10-15T16:00:00Z");
const FROM = "sender@example.test";

const OWNER = { email: "owner@example.test", role: "owner", active: false, archived_at: null, banned_until: null };
const MANAGER = { email: "manager@example.test", role: "manager", active: true, archived_at: null, banned_until: null };

// Saturdays open 2–6 PM; Sat Oct 31 is covered, Sat Oct 24 is not.
const WITH_GAP: ReminderSnapshot = {
  storeHours: [{ weekday: 6, is_closed: false, opens: "14:00", closes: "18:00" }],
  exceptions: [],
  closedRanges: [],
  shiftTypes: [{ name: "PENN Closer", in_store: true }],
  shifts: [
    {
      starts_at: "2026-10-31T14:00:00-04:00",
      ends_at: "2026-10-31T18:00:00-04:00",
      employee_id: "emp-1",
      position: "PENN Closer",
      published: true,
    },
  ],
  deals: [],
  dealShifts: [],
};
const NO_GAP: ReminderSnapshot = { ...WITH_GAP, storeHours: [] };

function harness(
  opts: {
    snapshot?: ReminderSnapshot;
    recipients?: RecipientRow[];
    snapshotError?: Error;
    sendError?: (email: OutgoingEmail) => Error | null;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const sent: OutgoingEmail[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const opened: { dsn: string }[] = [];
  const store: ReminderStore = {
    async snapshot() {
      if (opts.snapshotError) throw opts.snapshotError;
      return opts.snapshot ?? WITH_GAP;
    },
    async recipientRows() {
      return opts.recipients ?? [OWNER, MANAGER];
    },
  };
  const deps: CliDeps = {
    env: opts.env ?? { DATABASE_URL: "postgres://fake", COVERAGE_REMINDER_FROM: FROM },
    now: () => NOON_THURSDAY,
    openStore: async (dsn, fn) => {
      opened.push({ dsn });
      return fn(store);
    },
    sendMail: async (email) => {
      const failure = opts.sendError?.(email);
      if (failure) throw failure;
      sent.push(email);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, sent, out, err, opened };
}

describe("a live run", () => {
  it("emails the gap list to the database's recipients, from the configured sender", async () => {
    const h = harness();
    expect(await runCoverageReminderCli([], h.deps)).toBe(0);
    expect(h.sent).toEqual([
      {
        from: FROM,
        to: ["manager@example.test", "owner@example.test"],
        subject: "Schedule gaps",
        body: "Sat Oct 24, 2:00–6:00 PM\n",
      },
    ]);
    expect(h.out.join("\n")).toContain("sent 1 gap to 2 recipients");
  });

  it("counts every gap in the summary line", async () => {
    const twoGaps: ReminderSnapshot = { ...WITH_GAP, shifts: [] };
    const h = harness({ snapshot: twoGaps });
    expect(await runCoverageReminderCli([], h.deps)).toBe(0);
    expect(h.sent[0].body).toBe("Sat Oct 24, 2:00–6:00 PM\nSat Oct 31, 2:00–6:00 PM\n");
    expect(h.out.join("\n")).toContain("sent 2 gaps to 2 recipients");
  });

  it("sends nothing when nothing is missing", async () => {
    const h = harness({ snapshot: NO_GAP });
    expect(await runCoverageReminderCli([], h.deps)).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.out.join("\n")).toContain("no gaps");
  });
});

describe("--dry-run", () => {
  it("prints the recipients and the email and sends nothing", async () => {
    const h = harness();
    expect(await runCoverageReminderCli(["--dry-run"], h.deps)).toBe(0);
    expect(h.sent).toEqual([]);
    const printed = h.out.join("\n");
    expect(printed).toContain("2026-10-18 to 2026-10-31");
    expect(printed).toContain("recipients (2): manager@example.test, owner@example.test");
    expect(printed).toContain(`From: ${FROM}`);
    expect(printed).toContain("Subject: Schedule gaps");
    expect(printed).toContain("Sat Oct 24, 2:00–6:00 PM");
  });

  it("takes the run date in New York, not UTC", async () => {
    // 02:00 UTC Sunday Oct 18 is 10:00 PM Saturday Oct 17 in New York: the
    // window is the two weeks after Saturday, not after Sunday.
    const h = harness();
    h.deps.now = () => new Date("2026-10-18T02:00:00Z");
    expect(await runCoverageReminderCli(["--dry-run"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("run date 2026-10-17, checking 2026-10-18 to 2026-10-31");
  });

  it("shows the email without a configured sender, and says the sender is not set", async () => {
    const h = harness({ env: { DATABASE_URL: "postgres://fake" } });
    expect(await runCoverageReminderCli(["--dry-run"], h.deps)).toBe(0);
    expect(h.sent).toEqual([]);
    const printed = h.out.join("\n");
    expect(printed).toContain("From: (COVERAGE_REMINDER_FROM not set)");
    expect(printed).toContain("Sat Oct 24, 2:00–6:00 PM");
  });

  it("says when there is nothing to send", async () => {
    const h = harness({ snapshot: NO_GAP });
    expect(await runCoverageReminderCli(["--dry-run"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("no gaps: nothing would be sent");
  });

  it("a failure prints the failure email instead of sending it", async () => {
    const h = harness({ snapshotError: new Error("connection refused") });
    expect(await runCoverageReminderCli(["--dry-run"], h.deps)).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.err.join("\n")).toContain("connection refused");
    expect(h.err.join("\n")).toContain(`would email ${FAILURE_TO}`);
  });
});

describe("failures email the failure address and exit 1", () => {
  it("the failure address is the fixed constant", () => {
    expect(FAILURE_TO).toBe("alex@withers-ventures.com");
  });

  it("a database error", async () => {
    const h = harness({ snapshotError: new Error("permission denied for table shifts") });
    expect(await runCoverageReminderCli([], h.deps)).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toEqual([FAILURE_TO]);
    expect(h.sent[0].subject).toBe("Coverage reminder could not run");
    expect(h.sent[0].body).toContain("permission denied for table shifts");
  });

  it("a recipient lookup that finds nobody", async () => {
    const h = harness({ recipients: [{ ...MANAGER, active: false }] });
    expect(await runCoverageReminderCli([], h.deps)).toBe(1);
    expect(h.sent.map((e) => e.subject)).toEqual(["Coverage reminder could not run"]);
    expect(h.sent[0].body).toContain("no recipients");
  });

  it("a Gmail send that fails", async () => {
    const h = harness({
      sendError: (email) => (email.subject === "Schedule gaps" ? new Error("Gmail send failed: HTTP 403") : null),
    });
    expect(await runCoverageReminderCli([], h.deps)).toBe(1);
    expect(h.sent.map((e) => e.to)).toEqual([[FAILURE_TO]]);
    expect(h.sent[0].body).toContain("HTTP 403");
  });

  it("a missing sender address, before anything is sent", async () => {
    const h = harness({ env: { DATABASE_URL: "postgres://fake" } });
    expect(await runCoverageReminderCli([], h.deps)).toBe(1);
    expect(h.sent.map((e) => e.subject)).toEqual(["Coverage reminder could not run"]);
    expect(h.sent[0].body).toContain("COVERAGE_REMINDER_FROM");
    // With no configured sender, the failure email goes out as the Gmail account itself.
    expect(h.sent[0].from).toBeUndefined();
  });

  it("still exits 1, and says so, when the failure email cannot be sent either", async () => {
    const h = harness({ snapshotError: new Error("db down"), sendError: () => new Error("gmail down") });
    expect(await runCoverageReminderCli([], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("db down");
    expect(h.err.join("\n")).toContain("gmail down");
  });
});

describe("usage", () => {
  it("an unknown argument exits 2 without touching the database or sending", async () => {
    const h = harness();
    expect(await runCoverageReminderCli(["--send-now"], h.deps)).toBe(2);
    expect(h.opened).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("a missing DATABASE_URL exits 2 and, on a live run, emails the failure address", async () => {
    const h = harness({ env: { COVERAGE_REMINDER_FROM: FROM } });
    expect(await runCoverageReminderCli([], h.deps)).toBe(2);
    expect(h.opened).toEqual([]);
    expect(h.sent.map((e) => [e.to, e.subject])).toEqual([[[FAILURE_TO], "Coverage reminder could not run"]]);
  });

  it("a missing DATABASE_URL on a dry run sends nothing", async () => {
    const h = harness({ env: {} });
    expect(await runCoverageReminderCli(["--dry-run"], h.deps)).toBe(2);
    expect(h.sent).toEqual([]);
  });
});
