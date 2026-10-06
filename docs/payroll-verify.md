# Verify timesheets (Finance tab)

What the **Finance → Payroll** tab in the time app does, and the rules it holds
timesheets to. Implements §0 and §1 of the payroll pipeline spec
(`docs/specs/payroll-pipeline.md` in `BenJerrysUpenn/bj-finance`, issue #519),
which was recorded live from the 2026-09-23 pay run.

**No AI agents anywhere in this process** (Alina, 2026-09-21). Every judgement
below is either a rule in `time-app/lib/payroll/verify.ts` or a screen that asks
the person, with both options costed before they are shown.

## Where things are

| Piece | Path |
| --- | --- |
| The rulebook (pure, tested) | `time-app/lib/payroll/verify.ts` |
| The pay window | `time-app/lib/payroll/window.ts` |
| Choice rules, submittal snapshot (pure, tested) | `time-app/lib/payroll/choices.ts` |
| Loader shared by the routes | `time-app/lib/payroll/loadVerify.ts` |
| Findings endpoint | `GET /api/payroll/verify?window_end=YYYY-MM-DD` |
| Choices endpoint | `POST` / `DELETE /api/payroll/rulings` |
| Submittal endpoint | `POST /api/payroll/submit` |
| Event shift + punch, one save (from 2026-10-05) | `POST /api/payroll/event-punch`, shape in `time-app/lib/payroll/eventShift.ts` |
| The page | `https://finance.withers-ventures.com/payroll` (`/payroll` on localhost and previews), manager-only |
| Solo-close dropdowns | the **Schedule** view, manager-only (`components/SoloCloseNights.tsx`) |
| Tests | `time-app/lib/payroll/*.test.ts` — `npm test` |

The rulebook is pure and dependency-free, like `lib/coverage.ts`: the route
loads rows and hands them in, and everything it decides is decided in a module
`node --test` can run with fixtures. Nothing is computed in the browser.

## The pay window

Pay periods end every other Sunday, on the cycle through 2026-09-20 (ruled
2026-09-27): 2026-09-20, 10-04, 10-18, 11-01 and so on. A period is the 14 days
ending on one of those Sundays, and the pay date is three days after it (a
Wednesday). The default window is the most recent period that has ended, so on
a period's own last Sunday the one before it is shown. `window_end` must be a
period end: any other day, including the Sunday in the middle of a period, is
refused rather than rounded, by `lib/payroll/window.ts`, by the verify, rulings
and submit routes, and by migration 27's CHECK constraints on `window_end` in
`payroll_run_submittals` and `payroll_rulings`.

QuickBooks' own upcoming-period list is **not** read: its dates are misaligned
with the periods this business runs, and the 2026-09-23 run had to correct both
the period and the pay date by hand on the QBO run screen.

## The three outcomes

Every finding is one of:

- **Resolved by rule** — reported so the person can see what the rule did. Does
  not hold the button.
- **A choice** — code cannot decide. Alina ruled on 2026-09-22 (bj-finance #519)
  that these are **per-case choices made in the app, each with a preselected
  default** (1.9, 3.5, 3.7). The default stands on its own; a manager changes
  it only when the case needs it, and the change is recorded with who and when
  in `payroll_rulings`. From the pay period starting **2026-10-05** none of
  the three is a choice any more: 1.9 is not asked, and 3.5 and 3.7 are fixes.
- **Needs a fix** — the data is wrong and no choice can make it right. Fix it in
  the app and press Verify again. This includes **1.4** (a runaway punch with no
  scheduled shift, or an open punch with no scheduled shift, ruled 2026-09-27)
  and **1.5** (a punch under 25% of its scheduled shift, meaning the person's
  own shift or the one its `shift_id` names, never a 1.10 cover guess): they
  have **no default and no picker** (ruled 2026-09-22, ruling D). The punch is
  corrected on the Timesheets page. From the pay period starting
  **2026-10-05** this also includes a catering event whose crew did not
  punch: one **"Catering crew didn't punch"** card per event (1.12 and 3.5
  merged, ruled 2026-10-05), with no default payee, and a period with **no
  bake shift worked** (3.7, ruled 2026-10-05), with no default payee either.

**The button is green when there is nothing to fix and every case is answered
by a recorded choice or its default.**

**Fixing a punch from the page** (2026-10-05). A finding a punch can fix
carries a fix form on its card: **edit the punch** (1.1 open punch with a
shift, 1.4 open or runaway punch with no shift, 1.5 short punch) or **add the
missing punch** (1.8 coverage gap, 1.12 a scheduled catering person with no
punch), with the employee, clock-in, clock-out and an optional shift
prefilled from the finding. It saves through the Timesheets routes
(`POST /api/time-entries`, which takes an optional `shift_id`, and
`PATCH /api/time-entries/:id`), so the manager check, RLS and `row_audit`
triggers are the same, and then runs Verify again. Times are New York wall
clock whatever the browser's time zone (`nyInputToIso`). Adding a punch on the
person's Catering shift makes them the event's crew.

The "Catering crew didn't punch" card (from 2026-10-05) carries **one form
per scheduled person with no punch**, each prefilled on their own shift. For
an event with **no Catering shift** on the schedule, its one form saves the
punch **and the event's Catering shift** together (`POST
/api/payroll/event-punch`, `lib/payroll/eventShift.ts`): an unassigned
Catering slot the CRM already made for the deal is filled, otherwise a new
shift is made over the punch's hours in the shape the CRM's catering shift
writer uses (`position = 'Catering'`, `deal_id`, the next `deal_slot`, live).
If the punch is refused, the shift write is undone. Nobody is texted about it.

The "No bake shift worked" card (3.7, from 2026-10-05) carries **one add-punch
form per Pastry Opener shift scheduled in the period that nobody worked**,
prefilled on that shift. With no Pastry Opener shift on the schedule there is
nothing to punch against, so the card says to put the bake shift on the
schedule first and add the punch on the Timesheets page.

## One submittal per run

There is **one submittal for the whole pay run**, not one per case, and **any
manager** can give it (`POST /api/payroll/submit`, the button on the Finance
tab). It is refused until the button above is green. While any 1.4 or 1.5
punch is uncorrected, Submit is disabled and the reason names each punch; the
submit route refuses it (409), and migration 27's trigger refuses it in the
database (`payroll_punch_blockers()`, as migration 35 redefines it). It stores a snapshot of
every case's effective choice, defaults included, in `payroll_run_submittals`.
The payroll sheet (bj-finance `modules/payroll_sheet.py`) will not produce a
keyable sheet until the run is submitted.

**Submittal is final** (ruled 2026-09-22, reworded 2026-09-27). It sends
money, and it cannot be cancelled or undone. The QBO staging script (§6) is
not built, so what submitting does today is submit and lock the run; the pay
run is then keyed in QBO by hand:

- **Only after the period ends.** Before the Monday after the period's last
  Sunday the button is disabled and says when it can be submitted. The submit
  route refuses it too (409), and so does migration 27's trigger.
- **A plain confirmation first.** The button opens a confirmation saying that
  submitting is final and cannot be undone; nothing is sent until the manager
  confirms.
- **Once.** There is no re-submittal and no "stale" state. A second submittal,
  an edit or a delete of a submittal is refused by the database.
- **It locks every choice in the period.** A locked case is read-only on the
  Finance tab and on the schedule, and migration 27's trigger refuses any
  insert, change or delete of a choice dated inside a submitted run. The
  trigger dates the case from its key: the night (1.9), the event (3.5), the
  window's last day (3.7).
- **No overlapping runs.** A window sharing a day with a submitted run cannot
  be submitted.

**The seam to §6.** The submittal row is written with
`status = 'submitted_pending_stage'`. That row is what the QBO staging script
(spec §6) will consume. It is not built: nothing in this app starts it or
touches QBO (`TODO(bj-finance #519, spec §6)` in the submit route and
migration 27).

**Flags** never block; they are shown to the submitter and on the sheet:

- 1.9 — a night paid to the manager who changed its dropdown.
- 3.5 / 3.7 — a crewless catering tip or stranded Olo tip (periods before
  2026-10-05 only) paid to the manager who submitted the run, whether by
  default or by a change.
- 3.4 — an invoice tip that joins to no deal, **from any point in history**
  (ruled 2026-09-22, ruling A). The Finance tab reads these from `held_tips`
  rows with no `deal_id` (migration 26); the payroll sheet lists every one it
  finds in Square.

Choices are keyed by case (`1.9:2026-09-18`, `3.5:deal:25188`,
`3.7:olo:2026-09-20`), not by pay window, so the schedule
(which shows calendar weeks) and the Finance tab write and read the same row.

## The checks

| # | Check | Outcome |
| --- | --- | --- |
| 0.6 | `store_hours` edited inside the window | rule, warning |
| 1.1 | Open punch (`clock_out IS NULL`) with a scheduled shift | **fix** |
| 1.1 | Open punch with **no** scheduled shift | rule → 1.4 |
| 1.2 | Punch over 15h | rule → 1.4 |
| 1.3 | Clock-out within 5s of the same person's next clock-in | rule → 1.4 |
| 1.4 | Truncation — with a shift, cut to the scheduled end | rule |
| 1.4 | Truncation — with **no** shift, or an open punch with no shift | **fix**: correct the punch (no default) |
| 1.5 | Punch under 25% of its scheduled shift (the person's own shift, or the one its `shift_id` names; never a guessed cover) | **fix**: correct the punch (no default) |
| 1.6 | Under 5 min with nothing scheduled | rule: 0 hours, listed |
| 1.7 | Same person, overlapping punches | **fix** |
| 1.8 | Opening hours with no in-store punch running, ≥15 min | rule, warning |
| 1.9 | Solo-close eligible nights only: last in-store clock-out >2h before close, or a solo tail ≥4h with the closer out before 10 PM (2.4 qualifying) | periods before **2026-10-05** only: **choice on the schedule**: pay scheduled closer / pay unpunched manager / skip (**default: skip**). From 2026-10-05: **not asked** (see below) |
| 1.11 | Catering shift with no `deal_id` | rule (a scheduling-time flag) |
| 1.12 | Fewer crew punched than `deals.staff_count` | periods before 2026-10-05: rule, warning (never blocks). From 2026-10-05: a line on the 3.5 card |
| 1.12 | Each person scheduled on an event who did not punch for it, by name | periods before 2026-10-05: rule, warning. From 2026-10-05: on the 3.5 card |
| 1.15 | A punch or shift in a submitted run changed after its submittal | rule, warning (never blocks) |
| 3.4 | Invoice tip with no deal, any date | rule, **flag** (never blocks) |
| 3.5 | Periods starting **2026-10-05** on, **"Catering crew didn't punch"**: one card per event (a booked event dated in the window, or a deal the window's shifts point at) where somebody scheduled did not punch, or a booked event with no Catering shift at all | **fix**, no default: add each missing punch on the card (or the shift and punch together). Once the punch exists the tip splits by punches. A crew smaller than `staff_count` with nobody unpunched is not a card |
| 3.5 | Periods before 2026-10-05: booked event in the window that nobody punched for | **choice**: who is paid its tip (**default: the designated tip payee, `DEFAULT_TIP_PAYEE_NAME`**) |
| 3.7 | Periods before 2026-10-05: no Pastry Opener shift worked in an open period | **choice**: who is paid stranded Olo tips (**default: the designated tip payee**); a schedule anomaly (norm ≥ 4 a period) |
| 3.7 | Periods starting **2026-10-05** on, **"No bake shift worked"**: no Pastry Opener shift worked (scheduled AND punched) in an open period | **fix**, no default and no picker: add the Pastry Opener punch (on the card or the Timesheets page). Once it exists the Olo tips split by bake shifts |

**Not reported** (Alina, 2026-10-05: "useless, kill these"): 0.1 pay window,
1.10 cover punches, 1.13 deleted rows and 1.14 name hygiene. They are not
findings and do not count in the summary. The window is still computed by
`window.ts` and shown in the page header, and an unfinished period is still
not ready and cannot be submitted. Blank-`shift_id` punches are still matched
to their own shift or a cover (the 1.10 ladder), because pay depends on it.

**The 2026-10-05 cutover** (Alina's rulings of 2026-10-05). For a pay period
that **starts on or after `CREW_PUNCH_REQUIRED_FROM`**
(`time-app/lib/payroll/verify.ts`, 2026-10-05; bj-finance
`modules/payroll_sheet.py` uses the same date). Periods before it keep the old
rules exactly, so the 2026-09-21 to 10-04 run is paid as it was (pinned by a
test). Moving the cutover is a one-line change to that constant.

- **Everyone punches.** The designated tip payee's last day was 2026-10-04. A
  catering event whose crew did not punch is a fix with no default, like 1.5,
  shown as **one card per event**, "Catering crew didn't punch" (key
  `3.5:deal:<id>`), replacing the per-event "1 of 2 crew punched" line and the
  per-person 1.12 lines. Crew is a punch on the event's Catering shift; once
  the punch exists the tip splits by punches, so there is no payee to pick.
  The crewless-tip picker is gone and `POST /api/payroll/rulings` refuses a
  3.5 choice for these periods.
- **No 1.9.** The store never closes before 10 PM and has no early half days
  (it is closed instead), so a last in-store clock-out before 22:00 is always
  a gap before close: 1.8 reports it and its add-punch form fixes it. The $30
  solo-close bonus is **alone 4h or more and clocked out at or after 22:00**,
  computed from punches only by the payroll sheet. No dropdown and no manager
  pick: the solo-close card on the payroll page stays empty and the rulings
  route refuses a 1.9 choice for these periods. 1.8 is unchanged.
- **No stranded-Olo payee.** "This should not happen and is an upstream time
  clock problem" (Alina, 2026-10-05). A period with no Pastry Opener shift
  worked is a fix with no default and no picker: the card says no bake shift
  was worked, so any Olo tips for the period have nobody to go to, and asks
  for the Pastry Opener punch. Once the punch exists the Olo tips split by
  bake shifts as normal. This app cannot see the Olo tips (the payroll sheet
  reads them from the Olo workbooks and names the amount), so it asks about
  every open period with no bake shift worked. `POST /api/payroll/rulings`
  refuses a 3.7 choice for these periods.
- **Pickup events are exempt.** A catering event whose `deals.event_type` is
  a pickup (`isPickupEvent`: "Pickup", "Pick up" or "Pick-up", any case) has
  no Catering shift by design and gets no "Catering crew didn't punch" card.
  Nothing else is exempt: "Drop Off" and delivery events still need their
  crew's punches. A pickup's tip, if any, goes to that day's in-store pool
  on the payroll sheet (ruled 2026-10-05); this app does not see tips.

The database submittal trigger (migration 27) does not enforce the catering
rule or 3.7; the Submit button and route do.

Notes on the ones that surprise people:

- **1.5 is the only check that can make a day longer.** Every other rule here
  shortens a runaway. An employee's 09-18 punch was 2m 11s against a 7h
  shift because the manager closed for her.
- **1.9's default is skip** (ruled 2026-09-22; periods before 2026-10-05
  only): no solo-close bonus unless a
  manager picks the scheduled closer or a manager who closed without punching.
  The dropdown is on the schedule, next to the week it happened in. It appears
  **only on solo-close eligible nights** (ruled 2026-09-22, ruling C): the last
  in-store clock-out more than 2h before close (1.9), or somebody alone for 4h
  or more who clocked out before 10 PM (2.4 qualifying, which the rule cannot
  pay). Any other night before 10 PM gets no dropdown and no bonus. The payroll
  sheet routes exactly the same nights. A day with no closing time is judged on
  2.4 alone.
- **Catering crew requires a punch** (ruled 2026-09-27). A person is on an
  event's crew only if they punched for it: a punch on the event's Catering
  shift by `shift_id`, or a manual punch (no `shift_id`) by the person
  scheduled on that shift, on the same date, overlapping it. Scheduled with no
  punch is not crew: 1.12 names them (a block from the period starting
  2026-10-05, never before), and an event nobody punched for is 3.5's
  crewless case. The event's Catering shifts are the ones
  linked by `shifts.deal_id`, or when there are none, the Catering shifts on the
  event date. The payroll sheet in bj-finance uses the same definition for the
  tip split.
- **3.5 cannot see the tip.** The tip arrives on a Square invoice, which this app
  does not read, so it asks about every crewless booked event; the payroll sheet
  applies the pick only where there is a tip.
- **1.15 reports, it never refuses.** Writes to `time_entries` and `shifts` are
  never blocked, even for a submitted period: the clock-in path must not fail,
  and Withers-time closes a forgotten clock-out at the next clock-in. Every
  change to a submitted run's punches or shifts made after its submittal is
  reported to the next run instead, naming the punch or shift, the person and
  who changed it (ruled 2026-09-27).
- **1.8 and 1.9 read `store_hours`.** For 1.8 a day whose hours nobody has set is
  reported, never judged — hours-not-set is deliberately different from closed,
  the same distinction `lib/coverage.ts` draws for the publish check.
- **Catering and Marketing shifts are off-site.** They never cover the store and
  can never be the night's closer.

## Migrations

| Migration | What it is for |
| --- | --- |
| `time-app/supabase/migration_25.sql` | `row_audit` + triggers — 1.15 reads it |
| `time-app/supabase/migration_26.sql` | `profiles.qbo_employee_id`, `profiles.pay_type`, `held_tips` — spec 2.5, 3.6 |
| `time-app/supabase/migration_27.sql` | `payroll_rulings` (per-case choices, locked once their run is submitted) and `payroll_run_submittals` (final; `status` is the §6 seam) |
| `time-app/supabase/migration_28.sql` | extends migration 26's profile guard: an employee cannot change their own `hourly_rate` or `active` either (managers and the service role still can) |
| `time-app/supabase/migration_35.sql` | redefines `payroll_punch_blockers()`: 1.5 measures a punch only against its own shift (explicit or the person's that day), never a 1.10 cover; a person's latest punch is no longer skipped as a NULL runaway |

All four are applied by hand in the Supabase SQL editor, in order, and all are
safe to re-run. Each has a `migration_2N_verify.sql` to run afterwards (in a
transaction that rolls back) and a `migration_2N_down.sql` that reverses it;
the header of each down script says what data it loses. Roll back in reverse
order: 28, then 27, then 26, then 25. Until 27
is applied, choices cannot be recorded and the run cannot be submitted.

## Not built yet

Build items 9.5–9.6 of the spec: the QBO staging automation behind a
Preview-only boundary (§6), and the run emails, paystub PDF and HP ePrint
receipt (§7). Item 9.4, the staged sheet, is bj-finance `modules/payroll_sheet.py`
(bj-finance PR #541), which reads the choices and the submittal recorded here.
