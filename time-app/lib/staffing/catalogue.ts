// The step catalogue: which steps each staffing form produces, in order, and
// whether the app does each one itself (auto) or a manager does it by hand
// (manual) with the link and the exact fields to type.
//
// The manual wording is ported from bj-finance modules/onboarding/adapters.py
// (PR #509) so the CLI plan and this checklist say the same thing. Why each
// system is manual today is recorded once, in bj-finance docs/onboarding.md
// ("What is automatic, what is manual, and why"); the one-line `reason` on
// each step travels with it into the UI.
//
// Nothing in this file touches the database. lib/staffing/execute.ts runs
// the auto steps and applies the side effects of marking a manual one done.
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
export const COMP_TYPES = [
  "Regular Pay",
  "Overtime",
  "Qualified OT",
  "Paycheck Tips",
  "Travel Reimbursement",
  "Solo close",
] as const;
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

export type StepSpec = {
  key: string;
  mode: StepMode;
  label: string;
  detail: StepDetail;
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export type OnboardingForm = {
  legal_name: string;
  preferred_name: string | null;
  email: string;
  phone: string | null;
  role: Role;
  start_date: string; // YYYY-MM-DD
  pay_rate: number | null;
  position_types: string[];
  fob_card_id: string | null;
};

export function onboardingSteps(f: OnboardingForm): StepSpec[] {
  const name = f.legal_name;
  const steps: StepSpec[] = [
    {
      key: "withers_time_invite",
      mode: "auto",
      label: "Withers-time: create the account and email the invite",
      detail: {
        recipient: f.email,
        lines: [
          `Full name: ${name}   Email: ${f.email}   Role: ${f.role}`,
          "The app emails the link itself; it works once and expires after about an hour. Resend from the Team page if it lapses.",
        ],
        link: "/team",
      },
    },
    f.fob_card_id
      ? {
          key: "fob_assign",
          mode: "auto",
          label: `RFID fob: assign card ${f.fob_card_id}`,
          detail: {
            lines: [`Links card ${f.fob_card_id} to ${name} in staff_cards.`],
          },
        }
      : {
          key: "fob_assign",
          mode: "manual",
          label: "RFID fob: tap a fob on the Pi reader and enter its id here",
          detail: {
            reason:
              "a fob id only exists once the fob is physically tapped on the reader",
            lines: [
              "On the Pi, run the listener by hand, tap the fob, and the log prints `unknown card: <raw_id>`.",
              "Type that id in the box on this step and mark it done; the app links it to the person.",
              "The Withers-time account has to exist first, which is why this step comes second.",
            ],
          },
        },
    {
      key: "square_team",
      mode: "manual",
      label: "Square Team: add a per-person team member and send the Team App invite",
      detail: {
        recipient: f.email,
        link: SQUARE_TEAM_URL,
        reason:
          "no Square API access token exists; the only Square credential is a dashboard login",
        lines: [
          "app.squareup.com -> Staff -> Team -> Team members -> + Add team member",
          `Name: ${name}   Email: ${f.email}`,
          "Assign the location, give them their own POS passcode, and send the Team App invitation.",
          "Do NOT reuse the shared 'Shift Leader' login.",
          SQUARE_WHY,
        ],
      },
    },
    {
      key: "slack_invite",
      mode: "manual",
      label: "Slack: invite to the workspace and channels",
      detail: {
        recipient: f.email,
        link: SLACK_ADMIN_URL,
        reason:
          "Slack's admin.users.invite is Enterprise Grid only; an ordinary workspace has no invite API",
        lines: [
          `benandjerrys4-nsh6689.slack.com -> workspace menu -> Invite people -> ${f.email}`,
          f.role === "manager"
            ? "Then add to: #managers-chat, #attendance-chat"
            : "Then add to: #attendance-chat",
          "#managers-chat is managers only.",
        ],
      },
    },
    {
      key: "qbo_workforce_invite",
      mode: "manual",
      label: "QuickBooks Workforce: send the self-setup invite",
      detail: {
        recipient: f.email,
        link: QBO_EMPLOYEES_URL,
        reason:
          "creating the payroll employee record is available through the QBO payroll tooling, but the Workforce invitation is a UI action with no API behind it",
        lines: [
          `QuickBooks Online -> Payroll -> Employees -> ${name}`,
          "Personal info -> invite to Workforce / enable self-setup",
          `Confirm the address on file is ${f.email}`,
          "They enter SSN, date of birth, home address and bank details themselves. Nobody is payable until that is done; use the Payroll setup form to track it.",
        ],
      },
    },
    {
      key: "google_group_add",
      mode: "manual",
      label: `Google: add to the ${GOOGLE_GROUP} group`,
      detail: {
        recipient: f.email,
        link: GOOGLE_GROUP_URL,
        reason:
          "no Admin SDK service-account credential is registered in the vault or the system BOM",
        lines: [
          `groups.google.com -> ${GOOGLE_GROUP} -> Members -> Add members -> ${f.email}`,
          ...(f.role === "manager"
            ? [
                "Managers may also get a @withers-ventures.com Workspace account. Whether they do is a standing policy question; today one of fifteen staff has one.",
              ]
            : []),
        ],
      },
    },
  ];
  return steps;
}

// ---------------------------------------------------------------------------
// Payroll setup
// ---------------------------------------------------------------------------

export type PayrollSetupForm = {
  employee_id: string;
  legal_name: string;
  email: string;
  hire_date: string; // YYYY-MM-DD
  pay_type: "hourly" | "salary";
  pay_rate: number;
  pay_schedule: string;
  job_title: string | null;
  comp_types: string[];
  qbo_employee_id: string | null;
};

export function payrollSetupSteps(f: PayrollSetupForm): StepSpec[] {
  const rate =
    f.pay_type === "hourly"
      ? `$${f.pay_rate.toFixed(2)}/hr`
      : `$${f.pay_rate.toFixed(2)}/yr salary`;
  const payload = {
    name: f.legal_name,
    email: f.email,
    hire_date: f.hire_date,
    pay_type: f.pay_type,
    rate: f.pay_rate,
    pay_schedule: f.pay_schedule,
    job_title: f.job_title,
    comp_types: f.comp_types,
  };
  return [
    {
      key: "withers_time_rate",
      mode: "auto",
      label: "Withers-time: record the rate and hire date on the profile",
      detail: {
        lines: [
          f.pay_type === "hourly"
            ? `Sets hourly_rate = ${f.pay_rate.toFixed(2)}`
            : "Salaried: hourly_rate is left as is",
          `Sets start_date = ${f.hire_date} if the profile has none`,
        ],
      },
    },
    {
      key: "qbo_employee_record",
      mode: "manual",
      label: "QuickBooks Payroll: create the employee record",
      detail: {
        link: QBO_EMPLOYEES_URL,
        reason:
          "the app holds no QuickBooks credential; the record can be created in the QBO UI, or by a finance-agent session with the QBO payroll tool using the payload below",
        lines: [
          `QuickBooks Online -> Payroll -> Employees -> Add an employee`,
          `Name: ${f.legal_name}   Email: ${f.email}   Hire date: ${f.hire_date}`,
          `Pay: ${rate}   Schedule: ${f.pay_schedule}${f.job_title ? `   Title: ${f.job_title}` : ""}`,
          `Pay types: ${f.comp_types.join(", ")}`,
          "Add every pay type BEFORE keying a run: editing an employee mid-run wipes keyed Solo-close cells.",
          "Regular Pay effective date defaults to today when created by the payroll tool, not the hire date; check the first run.",
          "Paste the QBO employee id (eeid) into the box on this step when you mark it done.",
          `Payroll-tool payload: ${JSON.stringify(payload)}`,
        ],
      },
    },
    {
      key: "qbo_workforce_invite",
      mode: "manual",
      label: "QuickBooks Workforce: send the self-setup invite",
      detail: {
        recipient: f.email,
        link: QBO_EMPLOYEES_URL,
        reason:
          "the Workforce invitation is a UI action (Payroll -> Employees -> person -> invite to Workforce) with no API behind it",
        lines: [
          `QuickBooks Online -> Payroll -> Employees -> ${f.legal_name} -> Personal info -> invite to Workforce`,
          `Confirm the address on file is ${f.email}`,
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
  ];
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
};

export function offboardingSteps(f: OffboardingForm): StepSpec[] {
  const name = f.employee_name;
  return [
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
      detail: {
        lines: ["Sets active = false and last_day on the profile. They drop off the schedule and reminders."],
      },
    },
    {
      key: "fob_unassign",
      mode: "auto",
      label: "RFID fob: unassign",
      detail: {
        lines: ["Removes their staff_cards rows; the card ids are kept in this step's result so the fob can be reissued."],
      },
    },
    {
      key: "qbo_terminated",
      mode: "manual",
      label: `QuickBooks Payroll: set status Terminated, last day ${f.last_day}`,
      detail: {
        link: QBO_EMPLOYEES_URL,
        reason:
          "the payroll tool has no employment-status field; status changes are UI-only",
        lines: [
          `QuickBooks Online -> Payroll -> Employees -> ${name} -> Employment details -> Status: Terminated, last day ${f.last_day}`,
          "Do this AFTER their final pay run has been submitted, or QBO drops them from the run.",
        ],
      },
    },
    {
      key: "slack_deactivate",
      mode: "manual",
      label: "Slack: deactivate the account",
      detail: {
        recipient: f.employee_email,
        link: SLACK_ADMIN_URL,
        reason: "no Slack admin API on an ordinary workspace",
        lines: [
          `benandjerrys4-nsh6689.slack.com -> Admin -> Manage members -> ${name} -> Deactivate account`,
        ],
      },
    },
    {
      key: "square_deactivate",
      mode: "manual",
      label: "Square Team: revoke the POS passcode and deactivate",
      detail: {
        recipient: f.employee_email,
        link: SQUARE_TEAM_URL,
        reason: "no Square API access token exists",
        lines: [
          `app.squareup.com -> Staff -> Team -> Team members -> ${name} -> Deactivate (clears their passcode and Team App access)`,
        ],
      },
    },
    {
      key: "google_group_remove",
      mode: "manual",
      label: `Google: remove from ${GOOGLE_GROUP}`,
      detail: {
        recipient: f.employee_email,
        link: GOOGLE_GROUP_URL,
        reason: "no Admin SDK service-account credential is registered",
        lines: [
          `groups.google.com -> ${GOOGLE_GROUP} -> Members -> ${name} -> Remove`,
          "If they had a @withers-ventures.com Workspace account, suspend it in admin.google.com as well.",
        ],
      },
    },
    {
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
    },
  ];
}
