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
| Findings endpoint | `GET /api/payroll/verify?window_end=YYYY-MM-DD` |
| Rulings endpoint | `POST` / `DELETE /api/payroll/rulings` |
| The page | `/finance?tab=payroll`, manager-only |
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
- **Needs a ruling** — code cannot decide. The screen shows both bases and
  records the choice, who made it and when, in `payroll_rulings`.
- **Needs a fix** — the data is wrong and no ruling can make it right. Fix it in
  the app and press Verify again.

**The button is green only when there is nothing to fix and every ruling has
been recorded.**

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
| 1.9 | Last in-store clock-out >2h before close | **ruling**: early close / salaried cover (**default: salaried cover**) |
| 1.10 | Blank `shift_id` — own shift, then a cover swap | rule |
| 1.11 | Catering shift with no `deal_id` | rule (a scheduling-time flag) |
| 1.12 | Fewer crew punched than `deals.staff_count` | rule, warning |
| 1.13 | Rows deleted from inside the window | rule; **fix** when there is no audit table |
| 1.14 | `full_name` containing `@` | rule, warning |

Notes on the ones that surprise people:

- **1.5 is the only check that can make a day longer.** Every other rule here
  shortens a runaway. Carli's 09-18 punch was 2m 11s against a 7h shift because
  Sophia closed for her.
- **1.9's default is salaried cover** — Sophia, 2026-09-21: "if it's missing a
  punch it would be me closing". Salaried cover carries no solo-close bonus;
  early close means the last person out is owed one.
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
| `time-app/supabase/migration_26.sql` | `profiles.qbo_employee_id`, `held_tips` — spec 2.5, 3.6 |
| `time-app/supabase/migration_27.sql` | `payroll_rulings` — the recorded choices |

All three are applied by hand in the Supabase SQL editor, in order, and all are
safe to re-run. Until 25 is applied, Verify reports 1.13 as a blocker; until 27
is applied, rulings cannot be recorded and the button stays grey.

## Not built yet

Build items 9.4–9.6 of the spec: the hours and tips computation that produces
the staged sheet (§2, §3, §5), the QBO staging automation behind a Preview-only
boundary (§6), and the run emails, paystub PDF and HP ePrint receipt (§7).
