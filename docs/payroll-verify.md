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
  in `payroll_rulings`. 1.4 and 1.5 have no default and must be answered.
- **Needs a fix** — the data is wrong and no choice can make it right. Fix it in
  the app and press Verify again.

**The button is green when there is nothing to fix and every case is answered
by a recorded choice or its default.**

## One approval per run

There is **one approval for the whole pay run**, not one per case, and **any
manager** can give it (`POST /api/payroll/approve`, the button on the Finance
tab). It is refused until the button above is green. It stores a snapshot of
every case's effective choice, defaults included, in `payroll_run_approvals`.
A choice changed after the approval makes it **stale**: approve again. The
payroll sheet (bj-finance `modules/payroll_sheet.py`) will not produce a
keyable sheet until the run is approved.

**Flags** never block; they are shown to the approver and on the sheet:

- 1.9 — a night paid to the manager who changed its dropdown.
- 3.5 / 3.7 — a crewless catering tip or stranded Olo tip paid to the manager
  who approved the run, whether by default or by a change.

Choices are keyed by case (`1.9:2026-09-18`, `3.5:deal:25188`,
`3.7:olo:2026-09-20`, `1.5:punch:1281`), not by pay window, so the schedule
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
| 1.4 | Truncation — with **no** shift | **ruling**: real hours / void |
| 1.5 | Punch under 25% of its scheduled shift | **ruling**: as punched / scheduled |
| 1.6 | Under 5 min with nothing scheduled | rule: 0 hours, listed |
| 1.7 | Same person, overlapping punches | **fix** |
| 1.8 | Opening hours with no in-store punch running, ≥15 min | rule, warning |
| 1.9 | Last in-store clock-out >2h before close, or before 10 PM (2.4) | **choice on the schedule**: pay scheduled closer / pay unpunched manager / skip (**default: skip**) |
| 1.10 | Blank `shift_id` — own shift, then a cover swap | rule |
| 1.11 | Catering shift with no `deal_id` | rule (a scheduling-time flag) |
| 1.12 | Fewer crew punched than `deals.staff_count` | rule, warning |
| 1.13 | Rows deleted from inside the window | rule; **fix** when there is no audit table |
| 1.14 | `full_name` containing `@` | rule, warning |
| 3.5 | Booked event in the window with no Catering shift crewed | **choice**: who is paid its tip (**default: Sophia**); also the upstream warning to add the shift |
| 3.7 | No Pastry Opener shift worked in an open period | **choice**: who is paid stranded Olo tips (**default: Sophia**); a schedule anomaly (norm ≥ 4 a period) |

Notes on the ones that surprise people:

- **1.5 is the only check that can make a day longer.** Every other rule here
  shortens a runaway. Carli's 09-18 punch was 2m 11s against a 7h shift because
  Sophia closed for her.
- **1.9's default is skip** (ruled 2026-09-22): no solo-close bonus unless a
  manager picks the scheduled closer or a manager who closed without punching.
  The dropdown is on the schedule, next to the week it happened in. A night
  qualifies before 10 PM too, because the payroll sheet routes every close
  before 10 PM here (spec 2.4).
- **3.5 cannot see the tip.** The tip arrives on a Square invoice, which this app
  does not read, so it asks about every crewless booked event; the payroll sheet
  applies the pick only where there is a tip.
- **1.13 blocks when the audit table is missing.** "Nothing was deleted" and "a
  deletion would have left no trace" are different answers, and the second is
  what the 2026-09-23 run had.
- **1.8 and 1.9 read `store_hours`.** A day whose hours nobody has set is
  reported, never judged — hours-not-set is deliberately different from closed,
  the same distinction `lib/coverage.ts` draws for the publish check.
- **Catering and Marketing shifts are off-site.** They never cover the store and
  can never be the night's closer.

## Migrations

| Migration | What it is for |
| --- | --- |
| `time-app/supabase/migration_25.sql` | `row_audit` + triggers — 1.13 |
| `time-app/supabase/migration_26.sql` | `profiles.qbo_employee_id`, `profiles.pay_type`, `held_tips` — spec 2.5, 3.6 |
| `time-app/supabase/migration_27.sql` | `payroll_rulings` (per-case choices) and `payroll_run_approvals` |

All three are applied by hand in the Supabase SQL editor, in order, and all are
safe to re-run. Until 25 is applied, Verify reports 1.13 as a blocker; until 27
is applied, choices cannot be recorded and the run cannot be approved.

## Not built yet

Build items 9.5–9.6 of the spec: the QBO staging automation behind a
Preview-only boundary (§6), and the run emails, paystub PDF and HP ePrint
receipt (§7). Item 9.4, the staged sheet, is bj-finance `modules/payroll_sheet.py`
(bj-finance PR #541), which reads the choices and the approval recorded here.
