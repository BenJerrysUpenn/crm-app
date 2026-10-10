// The Team page's staffing forms, before anything touches the database: what
// an invite, re-invite or offboarding body parses to (lib/staffing/forms.ts)
// and which checklist each produces, in what order, done by whom
// (lib/staffing/catalogue.ts). docs/staffing.md is the spec.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "./testing/fakeSupabase.ts";
import type * as Forms from "./staffing/forms.ts";
import type * as Catalogue from "./staffing/catalogue.ts";

// Loaded through the app's resolver: these modules import "@/lib/types".
const { parseInvite, parseOffboarding } = await loadAppModule<typeof Forms>("lib/staffing/forms.ts");
const { inviteSteps, offboardingSteps } = await loadAppModule<typeof Catalogue>("lib/staffing/catalogue.ts");

const PERSON = "00000000-0000-0000-0000-0000000000b1";

function invite(body: Record<string, unknown>, existing: { id: string; email: string | null } | null = null) {
  const p = parseInvite(body, existing);
  if (!p.ok) throw new Error(`expected a form, got: ${p.error}`);
  return p.form;
}
function offboard(body: Record<string, unknown>) {
  const p = parseOffboarding(body, { name: "Riley Test", email: "riley@example.test" });
  if (!p.ok) throw new Error(`expected a form, got: ${p.error}`);
  return p.form;
}
const keys = (steps: { key: string }[]) => steps.map((s) => s.key);

// ---- the invite form ----------------------------------------------------------

test("an invite needs a real name, not an email in the name box", () => {
  for (const legal_name of ["", "   ", "riley@example.test"]) {
    const p = parseInvite({ legal_name, email: "riley@example.test" }, null);
    assert.deepEqual(p, { ok: false, error: "Full name required (not an email)." });
  }
});

test("an invite needs an email; the address is trimmed and lower-cased", () => {
  assert.deepEqual(parseInvite({ legal_name: "Riley Test", email: "riley" }, null), {
    ok: false,
    error: "Valid email required.",
  });
  assert.equal(invite({ legal_name: "Riley Test", email: "  Riley@Example.TEST " }).email, "riley@example.test");
});

test("a re-invite with no email typed goes to the person's login email", () => {
  const f = invite({ legal_name: "Riley Test" }, { id: PERSON, email: "Riley@Example.test" });
  assert.equal(f.email, "riley@example.test");
  assert.equal(f.employee_id, PERSON);
});

test("a negative pay rate is refused; a typed rate arrives as a number", () => {
  assert.deepEqual(parseInvite({ legal_name: "Riley Test", email: "r@example.test", pay_rate: -1 }, null), {
    ok: false,
    error: "Pay rate cannot be negative.",
  });
  assert.equal(invite({ legal_name: "Riley Test", email: "r@example.test", pay_rate: "16.25" }).pay_rate, 16.25);
  assert.equal(invite({ legal_name: "Riley Test", email: "r@example.test", pay_rate: "" }).pay_rate, null);
});

test("only 'manager' makes a manager; anything else invites an employee", () => {
  assert.equal(invite({ legal_name: "Riley Test", email: "r@example.test", role: "manager" }).role, "manager");
  assert.equal(invite({ legal_name: "Riley Test", email: "r@example.test", role: "owner" }).role, "employee");
});

test("a start date that is not YYYY-MM-DD is dropped rather than stored", () => {
  assert.equal(invite({ legal_name: "Riley Test", email: "r@example.test", start_date: "2026-09-01" }).start_date, "2026-09-01");
  assert.equal(invite({ legal_name: "Riley Test", email: "r@example.test", start_date: "9/1/2026" }).start_date, null);
});

test("no systems list means every system; unknown system names are ignored", () => {
  assert.deepEqual(invite({ legal_name: "Riley Test", email: "r@example.test" }).systems, [
    "square",
    "slack",
    "qbo",
    "google",
    "fob",
  ]);
  assert.deepEqual(
    invite({ legal_name: "Riley Test", email: "r@example.test", systems: ["slack", "workday", 7] }).systems,
    ["slack"],
  );
  assert.deepEqual(invite({ legal_name: "Riley Test", email: "r@example.test", systems: [] }).systems, []);
});

// ---- the offboarding form -----------------------------------------------------

test("an offboarding names an existing person, a last day and a reason", () => {
  const ok = { employee_id: PERSON, last_day: "2026-09-30", reason: "Quit" };
  const who = { name: "Riley Test", email: null };
  assert.deepEqual(parseOffboarding({ ...ok, employee_id: "riley" }, who), { ok: false, error: "Pick the person." });
  assert.deepEqual(parseOffboarding(ok, null), { ok: false, error: "No such team member." });
  assert.deepEqual(parseOffboarding({ ...ok, last_day: "Friday" }, who), {
    ok: false,
    error: "Last day required (YYYY-MM-DD).",
  });
  assert.deepEqual(parseOffboarding({ ...ok, reason: " " }, who), { ok: false, error: "Reason required." });
});

test("a blank final-pay note falls back to the always-pay rule", () => {
  const f = offboard({ employee_id: PERSON, last_day: "2026-09-30", reason: "Quit", final_pay_note: "" });
  assert.match(f.final_pay_note, /Do not accept a waiver/);
  const own = offboard({ employee_id: PERSON, last_day: "2026-09-30", reason: "Quit", final_pay_note: "Pay tips too" });
  assert.equal(own.final_pay_note, "Pay tips too");
});

// ---- the invite checklist -------------------------------------------------------

test("with no other systems ticked an invite is the Withers-time invite alone, done by the app", () => {
  const steps = inviteSteps(invite({ legal_name: "Riley Test", email: "r@example.test", systems: [] }), "onboarding");
  assert.deepEqual(keys(steps), ["withers_time_invite"]);
  assert.equal(steps[0].mode, "auto");
});

test("every system ticked: Withers-time first, then fob, Square, Slack, QuickBooks and Google", () => {
  const steps = inviteSteps(invite({ legal_name: "Riley Test", email: "r@example.test" }), "onboarding");
  assert.deepEqual(keys(steps), [
    "withers_time_invite",
    "fob_assign",
    "square_invite",
    "slack_invite",
    "qbo_create_employee",
    "qbo_invite_workforce",
    "workforce_completed",
    "google_group_add",
  ]);
  const workers = steps.filter((s) => s.mode === "worker").map((s) => s.system);
  assert.deepEqual(workers, ["square", "slack", "qbo", "qbo", "google"]);
});

test("a fob id typed on the form is assigned by the app; without one the fob is a manual step", () => {
  const typed = inviteSteps(
    invite({ legal_name: "Riley Test", email: "r@example.test", fob_card_id: "CARD-9", systems: ["fob"] }),
    "onboarding",
  );
  assert.equal(typed[1].key, "fob_assign");
  assert.equal(typed[1].mode, "auto");
  const untyped = inviteSteps(invite({ legal_name: "Riley Test", email: "r@example.test", systems: ["fob"] }), "onboarding");
  assert.equal(untyped[1].mode, "manual");
});

test("Slack adds a manager to #managers-chat and an employee only to #attendance-chat", () => {
  const slack = (role: string) =>
    inviteSteps(invite({ legal_name: "Riley Test", email: "r@example.test", role, systems: ["slack"] }), "onboarding")[1];
  assert.deepEqual(slack("manager").payload?.channels, ["#attendance-chat", "#managers-chat"]);
  assert.deepEqual(slack("employee").payload?.channels, ["#attendance-chat"]);
});

test("the Workforce invite waits for the QuickBooks record, and no worker payload carries SSN, DOB, address or bank", () => {
  const steps = inviteSteps(
    invite({ legal_name: "Riley Test", email: "r@example.test", pay_rate: 16, start_date: "2026-09-01" }),
    "onboarding",
  );
  const workforce = steps.find((s) => s.key === "qbo_invite_workforce")!;
  assert.deepEqual(workforce.payload?.after, ["qbo_create_employee"]);
  const record = steps.find((s) => s.key === "qbo_create_employee")!;
  assert.equal(record.payload?.pay_rate, 16);
  assert.equal(record.payload?.hire_date, "2026-09-01");
  const sensitive = /ssn|birth|dob|address|bank|routing|account/i;
  for (const s of steps) {
    for (const k of Object.keys(s.payload ?? {})) assert.doesNotMatch(k, sensitive, `${s.key}.payload.${k}`);
  }
});

test("a re-invite's first step says it re-sends the link", () => {
  const f = invite({ legal_name: "Riley Test", systems: [] }, { id: PERSON, email: "r@example.test" });
  assert.match(inviteSteps(f, "reinvite")[0].label, /re-send/);
  assert.doesNotMatch(inviteSteps(f, "onboarding")[0].label, /re-send/);
});

// ---- the offboarding checklist ----------------------------------------------------

test("offboarding locks the login before it changes role or active, and does all of it before any worker step", () => {
  const steps = offboardingSteps(offboard({ employee_id: PERSON, last_day: "2026-09-30", reason: "Quit" }));
  assert.deepEqual(keys(steps), [
    "auth_ban",
    "sessions_revoke",
    "role_employee",
    "mark_inactive",
    "fob_unassign",
    "slack_deactivate",
    "square_deactivate",
    "google_group_remove",
    "final_pay",
    "qbo_terminate",
  ]);
  const lastAuto = steps.map((s) => s.mode).lastIndexOf("auto");
  const firstWorker = steps.findIndex((s) => s.mode === "worker");
  assert.ok(lastAuto < firstWorker);
});

test("QuickBooks termination waits for final pay, which is always on the list", () => {
  const none = offboardingSteps(offboard({ employee_id: PERSON, last_day: "2026-09-30", reason: "Quit", systems: [] }));
  assert.deepEqual(keys(none), ["auth_ban", "sessions_revoke", "role_employee", "mark_inactive", "final_pay"]);
  const qbo = offboardingSteps(offboard({ employee_id: PERSON, last_day: "2026-09-30", reason: "Quit", systems: ["qbo"] }));
  const terminate = qbo.find((s) => s.key === "qbo_terminate")!;
  assert.deepEqual(terminate.payload?.after, ["final_pay"]);
  assert.equal(terminate.payload?.last_day, "2026-09-30");
});

test("the final-pay step carries the note and the recorded reason", () => {
  const steps = offboardingSteps(
    offboard({ employee_id: PERSON, last_day: "2026-09-30", reason: "Let go", reason_note: "no-call twice", final_pay_note: "Pay through Friday" }),
  );
  const lines = steps.find((s) => s.key === "final_pay")!.detail.lines ?? [];
  assert.equal(lines[0], "Pay through Friday");
  assert.equal(lines[1], "Reason recorded: Let go (no-call twice)");
});
