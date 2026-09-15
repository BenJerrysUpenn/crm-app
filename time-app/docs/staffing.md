# Staffing forms: onboarding, payroll setup, offboarding

`/staffing` (managers only) is one page with three forms. Each submission is a
record with an ordered checklist. The app does the steps it can do itself and
turns the rest into a line with the link and the exact fields to type, plus a
Mark done button that records who ticked it and when.

The step wording is ported from bj-finance `modules/onboarding/adapters.py`
(PR #509, issue #510) so the CLI plan and this page say the same thing. Why
each system is manual today is written once in bj-finance
`docs/onboarding.md`; the `reason` on each step is the one-line version.

## Apply first

`supabase/migration_23.sql` in the Supabase SQL editor, after migration_22.
Safe to re-run. It adds five columns to `profiles` (`preferred_name`,
`start_date`, `last_day`, `has_workforce`, `qbo_employee_id`), two tables
(`staff_lifecycle`, `staff_lifecycle_steps`), and `revoke_user_sessions(uuid)`
(SECURITY DEFINER, service role only). Without it the page loads but every
form fails.

## The hard rule

**Never delete a Withers-time user.** `time_entries.employee_id` cascades
from `profiles`, so deleting a profile or auth user destroys the person's
payroll hours. Offboarding bans the auth user and revokes their sessions
instead. No code path on this page deletes a profile.

## Onboarding

Fields: legal name, preferred name, email, phone, role, start date, pay rate,
position types (from shift types, stored on the record only), fob card id.

| # | Step | Mode | What happens |
|---|---|---|---|
| 1 | Withers-time invite | auto | `inviteTeamMember` in `lib/team.ts`: creates the auth user, emails the link via Resend, upserts the profile (name, phone, role, rate, start date, preferred name, `active: true`). Same code as the Team page's Add employee. |
| 2 | RFID fob | auto if a card id was typed, else manual | Inserts into `staff_cards`. Manual variant: tap the fob on the Pi, read `unknown card: <id>` from the log, type it into the step. |
| 3 | Square Team | manual | Add a per-person team member, own POS passcode, Team App invite. Never the shared `Shift Leader` login. |
| 4 | Slack | manual | Invite; `#attendance-chat` for everyone, `#managers-chat` for managers. |
| 5 | QuickBooks Workforce invite | manual | UI only. The person enters SSN, DOB, address and bank themselves. |
| 6 | Google Group | manual | `upennscoops@withers-ventures.com`. Managers may also get a Workspace account; that policy is undecided. |

The invite link expires in about an hour. For a start date weeks out, expect
to press Resend invite on the Team page.

## Payroll setup

Pick an existing person; the form prefills from their profile. Fields: legal
name, email, hire date, pay type, rate, pay schedule (default Every other
Monday), job title, pay types, QBO employee id if known.

SSN, date of birth, home address and bank details are never collected by
this app.

| # | Step | Mode | What happens |
|---|---|---|---|
| 1 | Rate into Withers-time | auto | Sets `hourly_rate` (hourly only), `start_date` if empty, `qbo_employee_id` if given. |
| 2 | QBO employee record | manual | The step prints the exact payload. Create it in the QBO UI, or hand the payload to a finance-agent session with the QBO payroll tool. Paste the eeid when marking done; it lands on the profile. |
| 3 | Workforce invite | manual | UI only. |
| 4 | Workforce finished | manual | Marking done sets `profiles.has_workforce = true`. The Payroll readiness list on the page shows every active person still false. |

## Offboarding

Pick a person, last day, reason, final-pay note (prefilled). Steps run in
this order and stop at the first failure; Retry re-runs from the failed step.

| # | Step | Mode | What happens |
|---|---|---|---|
| 1 | Ban login | auto | `auth.admin.updateUserById(id, { ban_duration: "876000h" })`. Account and time entries kept. |
| 2 | Sign out everywhere | auto | `rpc("revoke_user_sessions")` deletes `auth.sessions` and `auth.refresh_tokens` rows. |
| 3 | Role to employee | auto | Removes manager access. |
| 4 | Mark inactive | auto | `active = false`, `last_day` set. |
| 5 | Unassign fob | auto | Deletes their `staff_cards` rows; card ids kept in the step result. |
| 6 | QBO Terminated | manual | Status is UI-only in QBO. Do it after the final run is submitted. |
| 7 | Slack deactivate | manual | |
| 8 | Square deactivate | manual | Clears the passcode and Team App access. |
| 9 | Google Group remove | manual | |
| 10 | Final pay | manual | Hours worked through the last day are always paid (FLSA; PA WPCL). No waiver. Truncate an open last-day punch to the scheduled shift end. |

If the last day is still ahead the automatic steps wait; the record shows a
Run button for the day. Tick "Remove access now" on the form for a no-show or
someone let go on the spot. A manager cannot offboard themself.

## API

All manager-only, all service-role writes after the check, all `no-store`.

- `POST /api/staffing` body `{ kind, ...form }` creates the record and runs the automatic steps (offboarding: only when the last day has arrived or `run_now`).
- `POST /api/staffing/:id/run` runs or retries pending automatic steps in order.
- `PATCH /api/staffing/:id/steps/:key` body `{ note?, skipped?, fob_card_id?, qbo_employee_id? }` marks a manual step; `{ reopen: true }` puts it back.
- `PATCH /api/staffing/:id` body `{ status: "cancelled" | "open" }`.

A record closes itself when every step is done or skipped.

## Code map

- `lib/staffing/catalogue.ts` step definitions and wording
- `lib/staffing/forms.ts` request parsing and validation
- `lib/staffing/execute.ts` create, run automatic steps, manual side effects, close
- `lib/team.ts` the shared Withers-time invite (also behind `POST /api/profiles`)
- `components/StaffingAdmin.tsx` the page
- `supabase/migration_23.sql`
