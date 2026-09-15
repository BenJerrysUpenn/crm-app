// The step catalogue: which steps an invite, re-invite or offboarding
// produces, in order, and who does each one.
//
//   auto    the app does it in the request (Withers-time invite, fob, auth
//           ban, role/active changes)
//   worker  queued for the onboarding worker (bj-finance
//           scripts/onboard_worker.py), which logs into the system as the
//           manager and performs the invite / deactivation, then writes the
//           result back. Its `detail.lines` are the by-hand instructions, so
//           a manager can do the step and mark it done if the worker is down.
//   manual  a checklist line only
//
// The by-hand wording is ported from bj-finance modules/onboarding/adapters.py
// (PR #509) so the CLI plan and this checklist say the same thing. Why each
// system needs a browser worker rather than an API is recorded once, in
// bj-finance docs/onboarding.md.
//
// Nothing in this file touches the database. lib/staffing/execute.ts runs
// the auto steps and applies the side effects of marking a step done.
import type { Role, StepDetail, StepMode } from "@/lib/types";

export const SQUARE_TEAM_URL = "https://app.squareup.com/dashboard/team";
export const SLACK_ADMIN_URL = "https://benandjerrys4-nsh6689.slack.com/admin";
export const QBO_EMPLOYEES_URL = "https://app.qbo.intuit.com/app/employees";
export const GOOGLE_GROUP = "upennscoops@withers-ventures.com";
export const GOOGLE_GROUP_URL =
  "https://groups.google.com/a/withers-ventures.com/g/upennscoops/members";

const SQUARE_WHY =
  "Per-person Square logins are what make item-level sales and per-shift tips attributable: on the shared 'Shift Leader' login every sale, void, discount and tip is recorded against a role.";

export const FINAL_PAY_NOTE_DEFAULT =
  "Hours worked through the last day are paid on the next regular pay date, whatever the notice given and whatever the employee says about not wanting to be paid (FLSA; PA Wage Payment and Collection Law). Do not accept a waiver. Include any held catering tips for events they worked.";

export const PAY_SCHEDULE_DEFAULT = "Every other Monday";
export const COMP_TYPES_DEFAULT: string[] = [
  "Regular Pay",
  "Overtime",
  "Paycheck Tips",
  "Travel Reimbursement",
];

export const OFFBOARD_REASONS = [
  "Quit",
  "Let go",
  "No-show",
  "Seasonal / end of term",
  "Other",
] as const;

// The systems a manager can tick on the invite / re-invite / offboard forms.
// Withers-time itself is always included. `fob` has no worker: it is a tap
// on the Pi reader, then the id typed into the step.
export type System = "square" | "slack" | "qbo" | "google" | "fob";
export const SYSTEMS: { key: System; label: string; hint: string }[] = [
  { key: "square", label: "Square Team", hint: "own POS login and passcode" },
  { key: "slack", label: "Slack", hint: "#attendance-chat, managers also #managers-chat" },
  { key: "qbo", label: "QuickBooks Payroll + Workforce", hint: "employee record and self-setup invite" },
  { key: "google", label: "Google Group", hint: GOOGLE_GROUP },
  { key: "fob", label: "RFID fob", hint: "assign a fob for the Pi clock" },
];
export const SYSTEMS_DEFAULT: System[] = ["square", "slack", "qbo", "google", "fob"];

export type StepSpec = {
  key: string;
  mode: StepMode;
  label: string;
  detail: StepDetail;
  system?: "square" | "slack" | "qbo" | "google";
  action?: string;
  payload?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Invite (onboarding) and re-invite
// ---------------------------------------------------------------------------

export type InviteForm = {
  legal_name: string;
  preferred_name: string | null;
  email: string;
  phone: string | null;
  role: Role;
  start_date: string | null; // YYYY-MM-DD
  pay_rate: number | null;
  fob_card_id: string | null;
  systems: System[];
  // Re-invite only: the existing profile.
  employee_id: string | null;
};

export function inviteSteps(f: InviteForm, kind: "onboarding" | "reinvite"): StepSpec[] {
  const name = f.legal_name;
  const has = (s: System) => f.systems.includes(s);
  const steps: StepSpec[] = [
    {
      key: "withers_time_invite",
      mode: "auto",
      label:
        kind === "reinvite"
          ? "Withers-time: re-send the sign-in link (and reactivate)"
          : "Withers-time: create the account and email the invite",
      detail: {
        recipient: f.email,
        lines: [
          `Full name: ${name}   Email: ${f.email}   Role: ${f.role}`,
          "The app emails the link itself; it works once and expires after about an hour. Re-invite again if it lapses.",
        ],
        link: "/team",
      },
    },
  ];

  if (has("fob")) {
    steps.push(
      f.fob_card_id
        ? {
            key: "fob_assign",
            mode: "auto",
            label: `RFID fob: assign card ${f.fob_card_id}`,
            detail: { lines: [`Links card ${f.fob_card_id} to ${name} in staff_cards.`] },
          }
        : {
            key: "fob_assign",
            mode: "manual",
            label: "RFID fob: tap a fob on the Pi reader and enter its id here",
            detail: {
              reason: "a fob id only exists once the fob is physically tapped on the reader",
              lines: [
                "On the Pi, run the listener by hand, tap the fob, and the log prints `unknown card: <raw_id>`.",
                "Type that id in the box on this step and mark it done; the app links it to the person.",
              ],
            },
          },
    );
  }

  if (has("square")) {
    steps.push({
      key: "square_invite",
      mode: "worker",
      system: "square",
      action: "invite",
      payload: { full_name: name, email: f.email, phone: f.phone, role: f.role },
      label: "Square Team: add a per-person team member and send the Team App invite",
      detail: {
        recipient: f.email,
        link: SQUARE_TEAM_URL,
        reason:
          "Square has no API token here; the worker drives the dashboard as the manager. Square's login sits behind a Cloudflare bot check, so the worker may hand this back",
        lines: [
          "app.squareup.com -> Staff -> Team -> Team members -> + Add team member",
          `Name: ${name}   Email: ${f.email}`,
          "Assign the location, give them their own POS passcode, and send the Team App invitation.",
          "Do NOT reuse the shared 'Shift Leader' login.",
          SQUARE_WHY,
        ],
      },
    });
  }

  if (has("slack")) {
    const channels = f.role === "manager" ? ["#attendance-chat", "#managers-chat"] : ["#attendance-chat"];
    steps.push({
      key: "slack_invite",
      mode: "worker",
      system: "slack",
      action: "invite",
      payload: { full_name: name, email: f.email, role: f.role, channels },
      label: "Slack: invite to the workspace and channels",
      detail: {
        recipient: f.email,
        link: SLACK_ADMIN_URL,
        reason: "Slack's invite API is Enterprise Grid only; the worker drives the admin page as the manager",
        lines: [
          `benandjerrys4-nsh6689.slack.com -> workspace menu -> Invite people -> ${f.email}`,
          `Then add to: ${channels.join(", ")}`,
          "#managers-chat is managers only.",
        ],
      },
    });
  }

  if (has("qbo")) {
    const payroll = {
      legal_name: name,
      email: f.email,
      phone: f.phone,
      hire_date: f.start_date,
      pay_type: "hourly",
      pay_rate: f.pay_rate,
      pay_schedule: PAY_SCHEDULE_DEFAULT,
      comp_types: COMP_TYPES_DEFAULT,
      role: f.role,
    };
    steps.push(
      {
        key: "qbo_create_employee",
        mode: "worker",
        system: "qbo",
        action: "create_employee",
        payload: payroll,
        label: "QuickBooks Payroll: create the employee record (skipped if one exists)",
        detail: {
          link: QBO_EMPLOYEES_URL,
          reason: "the app holds no QuickBooks credential; the worker drives QBO as the manager, searching by email first so a re-run never makes a second record",
          lines: [
            "QuickBooks Online -> Payroll -> Employees -> Add an employee",
            `Name: ${name}   Email: ${f.email}   Hire date: ${f.start_date ?? "(start date)"}`,
            `Pay: ${f.pay_rate != null ? `$${f.pay_rate.toFixed(2)}/hr` : "(rate)"}   Schedule: ${PAY_SCHEDULE_DEFAULT}`,
            `Pay types: ${COMP_TYPES_DEFAULT.join(", ")}. Add every pay type BEFORE keying a run: editing an employee mid-run wipes keyed Solo-close cells.`,
            "Paste the QBO employee id (eeid) into the box on this step when marking it done by hand.",
          ],
        },
      },
      {
        key: "qbo_invite_workforce",
        mode: "worker",
        system: "qbo",
        action: "invite_workforce",
        payload: { legal_name: name, email: f.email, after: ["qbo_create_employee"] },
        label: "QuickBooks Workforce: send the self-setup invite",
        detail: {
          recipient: f.email,
          link: QBO_EMPLOYEES_URL,
          reason: "the Workforce invitation is UI-only in QBO",
          lines: [
            `QuickBooks Online -> Payroll -> Employees -> ${name} -> Personal info -> invite to Workforce`,
            `Confirm the address on file is ${f.email}`,
            "They enter SSN, date of birth, home address and bank details themselves; nobody is payable until that is done.",
          ],
        },
      },
      {
        key: "workforce_completed",
        mode: "manual",
        label: "Workforce self-setup finished (SSN, date of birth, address, bank)",
        detail: {
          link: QBO_EMPLOYEES_URL,
          lines: [
            "Mark done once QBO shows the employee as complete and payable. This sets has_workforce on their profile.",
            "SSN, date of birth, home address and bank details are entered by the employee in Workforce, never typed into this app.",
          ],
        },
      },
    );
  }

  if (has("google")) {
    steps.push({
      key: "google_group_add",
      mode: "worker",
      system: "google",
      action: "add_to_group",
      payload: { email: f.email, group: GOOGLE_GROUP, role: f.role },
      label: `Google: add to the ${GOOGLE_GROUP} group`,
      detail: {
        recipient: f.email,
        link: GOOGLE_GROUP_URL,
        reason: "no Admin SDK credential is registered; the worker drives Google Groups as the manager",
        lines: [
          `groups.google.com -> ${GOOGLE_GROUP} -> Members -> Add members -> ${f.email}`,
          ...(f.role === "manager"
            ? ["Managers may also get a @withers-ventures.com Workspace account; that policy is undecided and the worker does not create one."]
            : []),
        ],
      },
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------

export type OffboardingForm = {
  employee_id: string;
  employee_name: string;
  employee_email: string | null;
  last_day: string; // YYYY-MM-DD
  reason: string;
  reason_note: string | null;
  final_pay_note: string;
  systems: System[];
};

// Archive over delete, everywhere it is possible and free: ban not delete in
// Withers-time, Terminated in QBO, deactivate in Slack and Square, remove
// group membership in Google. A Workspace account (if any) is left to the
// manager: suspending keeps paying the seat, deleting loses the mailbox.
export function offboardingSteps(f: OffboardingForm): StepSpec[] {
  const name = f.employee_name;
  const has = (s: System) => f.systems.includes(s);
  const steps: StepSpec[] = [
    {
      key: "auth_ban",
      mode: "auto",
      label: "Withers-time: ban the login",
      detail: {
        lines: [
          "Bans the Supabase auth user (100 years). The account and every time entry stay; nothing is deleted.",
          "Never delete a Withers-time user: time_entries cascades from profiles and their payroll hours would go with them.",
        ],
      },
    },
    {
      key: "sessions_revoke",
      mode: "auto",
      label: "Withers-time: sign them out everywhere",
      detail: { lines: ["Deletes their sessions and refresh tokens."] },
    },
    {
      key: "role_employee",
      mode: "auto",
      label: "Withers-time: role to employee",
      detail: { lines: ["Removes manager access if they had it."] },
    },
    {
      key: "mark_inactive",
      mode: "auto",
      label: `Withers-time: mark inactive, last day ${f.last_day}`,
      detail: { lines: ["Sets active = false and last_day on the profile. They drop off the schedule and reminders."] },
    },
  ];
  if (has("fob")) {
    steps.push({
      key: "fob_unassign",
      mode: "auto",
      label: "RFID fob: unassign",
      detail: { lines: ["Removes their staff_cards rows; the card ids are kept in this step's result so the fob can be reissued."] },
    });
  }
  if (has("slack")) {
    steps.push({
      key: "slack_deactivate",
      mode: "worker",
      system: "slack",
      action: "deactivate",
      payload: { full_name: name, email: f.employee_email },
      label: "Slack: deactivate the account (not delete)",
      detail: {
        recipient: f.employee_email,
        link: SLACK_ADMIN_URL,
        reason: "no Slack admin API on an ordinary workspace; the worker drives the admin page",
        lines: [`benandjerrys4-nsh6689.slack.com -> Admin -> Manage members -> ${name} -> Deactivate account`],
      },
    });
  }
  if (has("square")) {
    steps.push({
      key: "square_deactivate",
      mode: "worker",
      system: "square",
      action: "deactivate",
      payload: { full_name: name, email: f.employee_email },
      label: "Square Team: deactivate (clears passcode and Team App access)",
      detail: {
        recipient: f.employee_email,
        link: SQUARE_TEAM_URL,
        reason: "no Square API token; the worker drives the dashboard",
        lines: [`app.squareup.com -> Staff -> Team -> Team members -> ${name} -> Deactivate`],
      },
    });
  }
  if (has("google")) {
    steps.push({
      key: "google_group_remove",
      mode: "worker",
      system: "google",
      action: "remove_from_group",
      payload: { email: f.employee_email, group: GOOGLE_GROUP },
      label: `Google: remove from ${GOOGLE_GROUP}`,
      detail: {
        recipient: f.employee_email,
        link: GOOGLE_GROUP_URL,
        reason: "no Admin SDK credential; the worker drives Google Groups",
        lines: [
          `groups.google.com -> ${GOOGLE_GROUP} -> Members -> ${name} -> Remove`,
          "A @withers-ventures.com Workspace account, if they had one, is the manager's call: suspending keeps paying the seat, deleting loses the mailbox.",
        ],
      },
    });
  }
  steps.push({
    key: "final_pay",
    mode: "manual",
    label: "Final pay: pay every hour worked through the last day",
    detail: {
      lines: [
        f.final_pay_note,
        `Reason recorded: ${f.reason}${f.reason_note ? ` (${f.reason_note})` : ""}`,
        "Check for an open punch on the last day and truncate it to the scheduled shift end (standing rule). Mark done once the run that carries the hours is submitted.",
      ],
    },
  });
  if (has("qbo")) {
    steps.push({
      key: "qbo_terminate",
      mode: "worker",
      system: "qbo",
      action: "terminate",
      payload: { legal_name: name, email: f.employee_email, last_day: f.last_day, after: ["final_pay"] },
      label: `QuickBooks Payroll: status Terminated, last day ${f.last_day} (after final pay)`,
      detail: {
        link: QBO_EMPLOYEES_URL,
        reason: "employment status is UI-only in QBO; the worker waits for the final-pay step so QBO does not drop them from the run",
        lines: [
          `QuickBooks Online -> Payroll -> Employees -> ${name} -> Employment details -> Status: Terminated, last day ${f.last_day}`,
          "Do this AFTER their final pay run has been submitted.",
        ],
      },
    });
  }
  return steps;
}
