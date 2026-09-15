# Staffing: invite, re-invite, offboard from the Team page

The Team page (managers only) is where people are added, re-invited and
offboarded. Every one of those is a `staff_lifecycle` record with an ordered
checklist, shown under the team table. Steps come in three kinds:

| Mode | Who does it | Examples |
|---|---|---|
| `auto` | the app, in the request | Withers-time invite, fob assignment, auth ban, role/active changes |
| `worker` | the bj-finance onboarding worker (`scripts/onboard_worker.py`), which signs in to each system as the manager and performs the invite or deactivation, then writes the result back | Square, Slack, QuickBooks Payroll + Workforce, Google Group |
| `manual` | a manager, by hand | a fob not yet tapped, "Workforce self-setup finished", final pay |

A worker step carries the by-hand instructions too, so if the worker is down
or hits a login wall (Cloudflare on Square, 2FA on Google) the step comes back
`failed` with the wall named and a manager can do it and press "Done by hand".
A record closes itself when every step is done or skipped.

The by-hand wording is ported from bj-finance `modules/onboarding/adapters.py`
(PR #509, issue #510). Why each system needs a browser worker rather than an
API is written once in bj-finance `docs/onboarding.md`.

## Apply first

`supabase/migration_23.sql` in the Supabase SQL editor, after migration_22.
Safe to re-run. It adds five columns to `profiles` (`preferred_name`,
`start_date`, `last_day`, `has_workforce`, `qbo_employee_id`), two tables
(`staff_lifecycle`, `staff_lifecycle_steps`, manager-only RLS), and
`revoke_user_sessions(uuid)` (SECURITY DEFINER, service role only). Without
it the Team page's add / re-invite / offboard actions fail.

## The hard rule

**Never delete a Withers-time user.** `time_entries.employee_id` cascades
from `profiles`, so deleting a profile or auth user destroys the person's
payroll hours. Offboarding bans the auth user and revokes their sessions
instead. No code path here deletes a profile.

**Archive over delete everywhere else** that it is possible and free:
Terminated in QuickBooks, Deactivate in Slack and Square, remove group
membership in Google. A `@withers-ventures.com` Workspace account (if the
person had one) is the manager's call: suspending keeps paying the seat,
deleting loses the mailbox.

## Add employee (invite)

Fields: email, full legal name, preferred name, phone, role, hourly rate,
start date, fob card id, and the "Also set up on" checkboxes (Square, Slack,
QuickBooks, Google Group, fob; all ticked by default). Withers-time is always
included.

| Step | Mode | What happens |
|---|---|---|
| `withers_time_invite` | auto | `inviteTeamMember` in `lib/team.ts`: creates the auth user, emails the link via Resend, upserts the profile (name, phone, role, rate, start date, preferred name, `active: true`). Same code as `POST /api/profiles`. |
| `fob_assign` | auto if a card id was typed, else manual | Inserts into `staff_cards`. Manual: tap the fob on the Pi, read `unknown card: <id>` from the log, type it into the step. |
| `square_invite` | worker | Search the team by email first; add a per-person team member, assign the location, send the Team App invite. The POS passcode is set in the dashboard. Never the shared `Shift Leader` login. |
| `slack_invite` | worker | Invite by email; `#attendance-chat` for everyone, `#managers-chat` for managers. |
| `qbo_create_employee` | worker | Search by email first; create the payroll record with legal name, email, phone, hire date, hourly rate, "Every other Monday", and the default pay types. Writes the employee id to `profiles.qbo_employee_id`. |
| `qbo_invite_workforce` | worker, after `qbo_create_employee` | Sends the Workforce self-setup invite. The person enters SSN, DOB, address and bank themselves. |
| `workforce_completed` | manual | Marking done sets `profiles.has_workforce = true`. Active people with it false show "Workforce not finished" in the table: not payable. |
| `google_group_add` | worker | Adds the address to `upennscoops@withers-ventures.com`. Does not create a Workspace account. |

The invite link expires in about an hour. For a start date weeks out, expect
to press Re-invite.

## Re-invite

Per row. Re-sends the Withers-time sign-in link (and reactivates the profile),
plus whichever other systems are ticked (none by default). Same steps as above
for the ticked systems. This is how the per-person Square login rollout runs:
tick Square on each row.

## Offboard

Per row: last day, reason, note, final-pay note (prefilled), "Also remove
from" checkboxes (all ticked by default), "Remove access now". Automatic steps
run in this order and stop at the first failure; Retry re-runs from there.

| Step | Mode | What happens |
|---|---|---|
| `auth_ban` | auto | `auth.admin.updateUserById(id, { ban_duration: "876000h" })`. Account and time entries kept. |
| `sessions_revoke` | auto | `rpc("revoke_user_sessions")` deletes `auth.sessions` and `auth.refresh_tokens` rows. |
| `role_employee` | auto | Removes manager access. |
| `mark_inactive` | auto | `active = false`, `last_day` set. |
| `fob_unassign` | auto | Deletes their `staff_cards` rows; card ids kept in the step result. |
| `slack_deactivate` | worker | Deactivate, never delete. |
| `square_deactivate` | worker | Deactivate: clears the passcode and Team App access. |
| `google_group_remove` | worker | Removes group membership. |
| `final_pay` | manual | Hours worked through the last day are always paid (FLSA; PA WPCL). No waiver. Truncate an open last-day punch to the scheduled shift end. |
| `qbo_terminate` | worker, after `final_pay` | Status Terminated with the last day. Waits for the final-pay step so QBO does not drop them from the run. |

If the last day is still ahead the automatic steps wait; the record shows a
Run button for the day. "Remove access now" is for a no-show or someone let
go on the spot. A manager cannot offboard themself.

## Worker contract

The worker reads `public.staff_lifecycle_steps` where `mode = 'worker'` and
`status = 'pending'`, oldest first, and only takes a step once every lower-seq
`auto` step on the same record is done and every key in `payload.after` is
done. It claims with one UPDATE (status `running`, `claimed_at`, `attempts`),
performs the flow, and writes `status` (`done` / `failed`), `result`,
`worker_log`, `completed_at`. Three failed attempts hand the step back to the
manager. The columns `system`, `action`, `payload` say what to do; `payload`
never carries SSN, DOB, address or bank details.

## API

All manager-only, all service-role writes after the check, all `no-store`.

- `POST /api/staffing` body `{ kind: "onboarding" | "reinvite" | "offboarding", ...form, systems? }` creates the record and runs the automatic steps (offboarding: only when the last day has arrived or `run_now`).
- `POST /api/staffing/:id/run` runs or retries pending automatic steps in order.
- `PATCH /api/staffing/:id/steps/:key` body `{ note?, skipped?, fob_card_id?, qbo_employee_id? }` marks a worker or manual step done by hand; `{ reopen: true }` puts it back.
- `PATCH /api/staffing/:id` body `{ status: "cancelled" | "open" }`.
- `POST /api/profiles` is unchanged (the bj-finance script still uses it) and shares `lib/team.ts` with the invite step.

## Code map

- `lib/staffing/catalogue.ts` step definitions, wording, worker payloads
- `lib/staffing/forms.ts` request parsing and validation
- `lib/staffing/execute.ts` create, run automatic steps, by-hand side effects, close
- `lib/team.ts` the shared Withers-time invite
- `components/TeamAdmin.tsx` the add / re-invite / offboard forms
- `components/StaffingRecords.tsx` the checklists
- `supabase/migration_23.sql`
