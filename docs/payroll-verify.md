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
| The pay window (§0.1) | `time-app/lib/payroll/window.ts` |
| Choice rules, approval snapshot (pure, tested) | `time-app/lib/payroll/choices.ts` |
| Loader shared by the routes | `time-app/lib/payroll/loadVerify.ts` |
| Findings endpoint | `GET /api/payroll/verify?window_end=YYYY-MM-DD` |
| Choices endpoint | `POST` / `DELETE /api/payroll/rulings` |
| Approval endpoint | `POST /api/payroll/approve` |
| The page | `/finance?tab=payroll`, manager-only |
| Solo-close dropdowns | the **Schedule** view, manager-only (`components/SoloCloseNights.tsx`) |
| Tests | `time-app/lib/payroll/*.test.ts` — `npm test` |

The rulebook is pure and dependency-free, like `lib/coverage.ts`: the route
loads rows and hands them in, and everything it decides is decided in a module
`node --test` can run with fixtures. Nothing is computed in the browser.

## The pay window

The period is the 14 days ending the most recent Sunday, and the pay date is
three days after it (a Wednesday). `window_end` must be a Sunday — a window
ending on any other day is refused rather than rounded.

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
  in `payroll_rulings`.
- **Needs a fix** — the data is wrong and no choice can make it right. Fix it in
  the app and press Verify again. This includes **1.4** (a runaway punch with no
  scheduled shift) and **1.5** (a punch under 25% of its scheduled shift): they
  have **no default and no picker** (ruled 2026-09-22, ruling D). The punch is
  corrected on the Timesheets page.

**The button is green when there is nothing to fix and every case is answered
by a recorded choice or its default.**

## One approval per run

There is **one approval for the whole pay run**, not one per case, and **any
manager** can give it (`POST /api/payroll/approve`, the button on the Finance
tab). It is refused until the button above is green. While any 1.4 or 1.5
punch is uncorrected, Approve is disabled and the reason names each punch; the
approve route refuses it (409), and migration 27's trigger refuses it in the
database (`payroll_punch_blockers()`). It stores a snapshot of
every case's effective choice, defaults included, in `payroll_run_approvals`.
The payroll sheet (bj-finance `modules/payroll_sheet.py`) will not produce a
keyable sheet until the run is approved.

**Approval is final** (ruled 2026-09-22). It starts the payroll script that
stages the run in QBO, so it cannot be cancelled or undone:

- **Only after the period ends.** Before the Monday after the period's last
  Sunday the button is disabled and says when it can be approved. The approve
  route refuses it too (409), and so does migration 27's trigger.
- **A plain confirmation first.** The button opens a confirmation saying that
  this starts payroll and cannot be cancelled; nothing is sent until the
  manager confirms.
- **Once.** There is no re-approval and no "stale" state. A second approval,
  an edit or a delete of an approval is refused by the database.
- **It locks every choice in the period.** A locked case is read-only on the
  Finance tab and on the schedule, and migration 27's trigger refuses any
  insert, change or delete of a choice dated inside an approved run. The
  trigger dates the case from its key: the night (1.9), the event (3.5), the
  window's last day (3.7).
- **No overlapping runs.** A window sharing a day with an approved run cannot
  be approved.

**The seam to §6.** The approval row is written with
`status = 'approved_pending_stage'`. That row is what the QBO staging script
(spec §6) will consume. It is not built: nothing in this app starts it or
touches QBO (`TODO(bj-finance #519, spec §6)` in the approve route and
migration 27).

**Flags** never block; they are shown to the approver and on the sheet:

- 1.9 — a night paid to the manager who changed its dropdown.
- 3.5 / 3.7 — a crewless catering tip or stranded Olo tip paid to the manager
  who approved the run, whether by default or by a change.
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
| 0.1 | Pay window | rule (blocks if the period has not finished) |
| 0.6 | `store_hours` edited inside the window | rule, warning |
| 1.1 | Open punch (`clock_out IS NULL`) | **fix** |
| 1.2 | Punch over 15h | rule → 1.4 |
| 1.3 | Clock-out within 5s of the same person's next clock-in | rule → 1.4 |
| 1.4 | Truncation — with a shift, cut to the scheduled end | rule |
| 1.4 | Truncation — with **no** shift | **fix**: correct the punch (no default) |
| 1.5 | Punch under 25% of its scheduled shift | **fix**: correct the punch (no default) |
| 1.6 | Under 5 min with nothing scheduled | rule: 0 hours, listed |
| 1.7 | Same person, overlapping punches | **fix** |
| 1.8 | Opening hours with no in-store punch running, ≥15 min | rule, warning |
| 1.9 | Solo-close eligible nights only: last in-store clock-out >2h before close, or a solo tail ≥4h with the closer out before 10 PM (2.4 qualifying) | **choice on the schedule**: pay scheduled closer / pay unpunched manager / skip (**default: skip**) |
| 1.10 | Blank `shift_id` — own shift, then a cover swap | rule |
| 1.11 | Catering shift with no `deal_id` | rule (a scheduling-time flag) |
| 1.12 | Fewer crew punched than `deals.staff_count` | rule, warning |
| 1.13 | Rows deleted from inside the window | rule; **fix** when there is no audit table |
| 1.14 | `full_name` containing `@` | rule, warning |
| 3.4 | Invoice tip with no deal, any date | rule, **flag** (never blocks) |
| 3.5 | Booked event in the window with no Catering shift crewed | **choice**: who is paid its tip (**default: Sophia**); also the upstream warning to add the shift |
| 3.7 | No Pastry Opener shift worked in an open period | **choice**: who is paid stranded Olo tips (**default: Sophia**); a schedule anomaly (norm ≥ 4 a period) |

Notes on the ones that surprise people:

- **1.5 is the only check that can make a day longer.** Every other rule here
  shortens a runaway. Carli's 09-18 punch was 2m 11s against a 7h shift because
  Sophia closed for her.
- **1.9's default is skip** (ruled 2026-09-22): no solo-close bonus unless a
  manager picks the scheduled closer or a manager who closed without punching.
  The dropdown is on the schedule, next to the week it happened in. It appears
  **only on solo-close eligible nights** (ruled 2026-09-22, ruling C): the last
  in-store clock-out more than 2h before close (1.9), or somebody alone for 4h
  or more who clocked out before 10 PM (2.4 qualifying, which the rule cannot
  pay). Any other night before 10 PM gets no dropdown and no bonus. The payroll
  sheet routes exactly the same nights. A day with no closing time is judged on
  2.4 alone.
- **3.5 cannot see the tip.** The tip arrives on a Square invoice, which this app
  does not read, so it asks about every crewless booked event; the payroll sheet
  applies the pick only where there is a tip.
- **1.13 blocks when the audit table is missing.** "Nothing was deleted" and "a
  deletion would have left no trace" are different answers, and the second is
  what the 2026-09-23 run had.
- **1.8 and 1.9 read `store_hours`.** For 1.8 a day whose hours nobody has set is
  reported, never judged — hours-not-set is deliberately different from closed,
  the same distinction `lib/coverage.ts` draws for the publish check.
- **Catering and Marketing shifts are off-site.** They never cover the store and
  can never be the night's closer.

## Migrations

| Migration | What it is for |
| --- | --- |
| `time-app/supabase/migration_25.sql` | `row_audit` + triggers — 1.13 |
| `time-app/supabase/migration_26.sql` | `profiles.qbo_employee_id`, `profiles.pay_type`, `held_tips` — spec 2.5, 3.6 |
| `time-app/supabase/migration_27.sql` | `payroll_rulings` (per-case choices, locked once their run is approved) and `payroll_run_approvals` (final; `status` is the §6 seam) |

All three are applied by hand in the Supabase SQL editor, in order, and all are
safe to re-run. Until 25 is applied, Verify reports 1.13 as a blocker; until 27
is applied, choices cannot be recorded and the run cannot be approved.

## Not built yet

Build items 9.5–9.6 of the spec: the QBO staging automation behind a
Preview-only boundary (§6), and the run emails, paystub PDF and HP ePrint
receipt (§7). Item 9.4, the staged sheet, is bj-finance `modules/payroll_sheet.py`
(bj-finance PR #541), which reads the choices and the approval recorded here.
