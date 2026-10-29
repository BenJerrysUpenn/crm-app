# Withers Ventures CRM

Login-protected Kanban board for the catering pipeline. Reads and writes the
`deals` table in the existing Supabase project.

## This repo is public
crm-app is the one public BenJerrysUpenn repo: Vercel Hobby deploys a private repo only
from commits its owner authored. Treat every commit, branch, PR and issue here as published.

- Never commit staff PII (names tied to pay, HR or schedule facts, contact details) or
  Alina's personal phone number, in code, SQL, fixtures, tests, docs or commit messages.
  Use placeholders.
- Keys and tokens live in Vercel env vars and Supabase only (see Environment variables).
- Real figures (hours, sales, salaries) are entered by owners into the database. Migrations
  here are schema only.

## Stack
- Next.js 14 (App Router) + TypeScript
- Supabase Auth (email + password)
- @dnd-kit for drag-and-drop
- Tailwind CSS

## Environment variables
Set both in Vercel (Project Settings, Environment Variables). Do not commit them.

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | The Supabase Project URL, e.g. `https://abcd.supabase.co` (no trailing path) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The Supabase publishable key (starts `sb_publishable_`) or legacy anon key |

A `.env.example` is included as a reference. For local dev, copy it to `.env.local`.

### Who gets in
`profiles.role` decides, through `lib/roles.ts`: `manager` and `owner` reach
the CRM, `employee` does not. An owner passes every manager gate (in the
database too: `is_manager()` is true for owners). `profiles.active` means "on
the schedule" and is never an access check; access ends by banning the
login. The owner role and its guard are time-app migration 42, applied by
hand in the Supabase SQL editor after both apps deploy (its header has the
order; `migration_42_verify.sql` checks it, `migration_42_down.sql` reverses it).

### Personal-finance pages (`/money`, `/dial`, `/safe`)
**Owners only** (the `owner` role). Each page reads the feed only through
`loadPfForOwner()` in `lib/pf/access.ts`, which answers anyone else signed in
with a 404, so the pages do not admit they exist; signed out goes to `/login`.
The middleware's role gate still sends an employee to `/no-access`, as it does
on every CRM path.
These pages sit behind the same Supabase auth as the rest of the app and read
a single JSON feed **server-side only** (never from a public path). Feed
source is resolved in this order:

| Name | Value |
| --- | --- |
| `PF_DATA_PATH` | Local file path to `pf_data.json` (dev; point it at `fixtures/pf_data.sample.json` for synthetic data) |
| `PF_GITHUB_TOKEN` | Fine-grained GitHub PAT with contents:read on the private data repo only; used to fetch the feed from its `pf-data` branch via the GitHub contents API (prod on Vercel; server-only, cached ~5 min) |

With neither set, the pages render a "feed not wired yet" state. No real
financial data or secrets are ever committed to this repo.

### One-click unsubscribe (`/api/unsubscribe/[token]`)
The RFC 8058 unsubscribe control for the warm outreach lane (bj-finance #440).
Full contract, including how `outreach/warm_sender.py` mints a matching token:
**`docs/unsubscribe.md`**.

| Name | Value |
| --- | --- |
| `UNSUBSCRIBE_SECRET` | HMAC signing key for unsubscribe tokens. Server-only. Generate with `openssl rand -hex 32` |

Before the sender ships the headers, Alina must:

1. Set `UNSUBSCRIBE_SECRET` on the Vercel project and redeploy.
2. Set **the same value** in `/etc/bj-finance/outreach.env` on the droplet
   (`ssh bj-box`) — the file the warm lane's units source. A mismatch means
   every token in a delivered email fails to verify.
3. Apply `supabase/crm/005_unsubscribe.sql` once in the Supabase SQL editor.

Unset, the endpoint answers `503` rather than silently dropping opt-outs.

### Open and click tracking (`/api/t/o/[token]`, `/api/t/c/[token]`)
The open pixel and click redirect for the warm and wedding outreach lanes
(owners' ruling 2026-10-27). Signed with `UNSUBSCRIBE_SECRET`; the middleware
lets `/api/t/` past the login gate. Contract, caveats and pinned vectors:
**`docs/tracking.md`**.

### Short links (`benjerryphilly.com`)
When the Host is `benjerryphilly.com` or `www.benjerryphilly.com`, the
middleware serves nothing but redirects and never reaches the login gate: a
slug in `SHORT_LINKS` (`lib/shortLinks.ts`, one line per link) logs a row in
`short_link_clicks` and 302s to its destination; every other path 301s to
`https://www.benjerry.com/upenn`. On every other host those paths stay behind
the login. `/<slug>/<code>` goes to the same place as `/<slug>`; the code is a
per-deal code Catering-Manager mints into `short_link_codes`, and the click row
records the code and its `deal_id`; HEAD requests and link scanners are logged
with `is_probable_bot` true so counts can leave them out. The code lookup and the insert use
`SUPABASE_SERVICE_ROLE_KEY` and never delay or block the redirect. Tables:
`supabase/crm/010_short_link_clicks.sql`.

## Supabase setup required
The web app assumes the following are already done in Supabase:

1. Row Level Security enabled on every table in the `public` schema.
2. A policy on `public.deals` granting full access to the `authenticated` role:
   ```sql
   create policy "authenticated full access to deals"
   on public.deals for all
   to authenticated
   using (true) with check (true);
   ```
3. User accounts created by hand under Authentication, Users, with **Auto Confirm User** ticked. No public sign-up page exists.
   **Allow new users to sign up** must be off under Authentication, Sign In / Providers: the anon key
   ships to every browser, so with it on anyone can create an account through the Auth API.

If the board later needs to read/write other tables (e.g. `quote_versions`,
`invoices`), add the same policy for each.

## Stage write rules
When a card is dragged to a new column, the app writes three fields in a single
update (`buildStagePatch` in `lib/dealUpdate.ts`):

1. `stage` = new stage
2. `is_active` = `0` for terminal stages (Event Complete, Closed Lost, Closed
   Below Min, Closed Marketing Event), else `1`
3. `updated_at` = current ISO timestamp

A move into `Booked Paid` also sets `payment_status` to `Deposit Paid` when the
row had none.

The app does **not** write `deals.boomerang_reason`. The automatic boomerang
follow-up was retired by bj-finance #333 and the column is dropped by
Catering-Manager migration `018b`; writing it would make every stage change
fail. Nothing in the app reads it either (bj-finance #466).

Updates are optimistic: the card moves immediately, and rolls back with a toast
if the write fails.

## Filtering
The board loads `archived = 0` rows only. Archived deals (9.5k+ historical rows)
stay hidden. Within each column, cards sort by `event_date` ascending.

## Timestamps
Deal timestamps are text. `deals.last_outbound_at`, `created_at`, `updated_at` and
`thread_messages.sent_at` hold UTC, mostly with no Z or offset (`2026-10-22T19:17:14`).
`new Date()` reads a naive string as the browser's local time, so read these with
`parseNaiveUtc` or `fmtNaiveUtcDateTime` (`lib/dateFormat.ts`), which leave a value with a
Z or an offset as it was. Event dates and times (`YYYY-MM-DD`, `HH:MM`) are Eastern
wall-clock. The card's days-since-last-outbound chip counts Eastern calendar days
(`daysSince` in `lib/boomerang.ts`): "today", "1d" for yesterday.

`call_logs.called_at` is naive UTC too (`lib/callLog.ts`). The drawer's Log a call and
edit inputs hold Eastern wall-clock time in any browser; the call routes convert it to UTC
with `parseCalledAt`, never with the server's own zone (Vercel runs in UTC). An edit sends
`called_at` only when the time was changed, so saving untouched leaves it as stored.

## COI panel (deal drawer)
`components/CoiPanel.tsx` renders on deals with `coi_required = 1` and assembles the
Hartford certificate request from the deal (`buildCoiRequest` in `lib/coi.ts`). It never
submits to The Hartford; the human sends. Its only write is `coi_sent_at` plus
`updated_at` in one `deals` update (it never touches `stage`). A COI is urgent when
required, unsent and the event is 0 to 14 days out (`COI_URGENT_WINDOW_DAYS`), the
same window as Catering-Manager `revive.coi_required_unsent`.

## Winter menu (deal drawer)
No winter package exists: a winter item is an existing package plus extras (bj-finance
#717). `supabase/crm/012_winter_menu_extras.sql` adds the three Price Book extras (Belgian
Waffle, Winter Dry Toppings, Winter Pourable Toppings); `lib/menuOptions.ts` lists them
and the two topping groups, and the drawer's toppings picker offers both groups. The drawer
also edits `deals.custom_menu_line` (printed on the quote in place of the package name) and
`deals.price_override` (a per-guest price replacing the package's on every quote of the
deal; blank, 0 or negative clears it). Both columns belong to Catering-Manager migration
`026`. `winterMenuWarnings` (`lib/winterMenu.ts`) shows amber notes, and never blocks a
save. When the deal has a winter item (Hot Chocolate Float Party, or a winter extra) it
notes an event outside Nov 1 - Mar 31 and an empty custom menu line. For each winter
toppings extra on the deal it notes a pick count from that group other than 3; for winter
toppings picked without their extra it notes that nothing bills them, unless a price
override is set. Every winter item includes whipped cream and chocolate sauce: the Hot
Chocolate Float Party has them, and marshmallows, in the package (`PACKAGES` description and the
call-desk chip, `packageIncludes` in `lib/callDesk/options.ts`, both name them); on a Cup or Cone Party (the Cookie and
Brownie Sundaes, the Waffle Sundae) they are the $0 Whipped Cream and Chocolate Sauce
extras, added by hand, and `winterMenuWarnings` does not check for them. It mirrors Catering-Manager `modules/winter_menu.py`.

## Email campaigns sequence editor (crm/013)
The sequence editor on `/email-campaigns` saves steps, and each lane's signature and footer, to
the shared copy in Supabase: `supabase/crm/013_email_campaign_sequences.sql` (apply by hand in
the SQL editor BEFORE deploying the app that reads it; `_verify.sql` checks it, `_down.sql`
reverses it and drops every saved sequence). A sequence or lane with no row shows its seed in
`lib/emailCampaignsPrototype/sequences.ts`; "Reset to original" deletes the row. Writes go through
`/api/email-campaigns/sequences` as the signed-in manager. Neither Apollo nor warm_sender reads
these tables: editing here changes nothing that is sent.

Before crm/013 every edit lived in one browser's localStorage. On load the page uploads any such
copies (`rescue` in `lib/emailCampaignsPrototype/sharedSequences.ts`): a copy whose every step has
an empty subject and body, or one identical to its seed, is skipped; a copy for a key with no row
becomes the row; a copy that differs from an existing row never overwrites it and is kept in
`email_campaign_sequence_conflicts`, with a notice on the page until an owner sets `resolved_at`.
The localStorage keys are never deleted.

## Local dev (optional)
```
npm install
cp .env.example .env.local   # fill in real values
npm run dev
```
Open http://localhost:3000.

## Deploy
Push to GitHub, import the repo into Vercel, set the two env vars, deploy.

Two Vercel projects build from this repo: `crm-app` (repo root; crm.withers-ventures.com,
personal.withers-ventures.com) and `time` (`time-app/`; time.withers-ventures.com,
finance.withers-ventures.com). `vercel.json` in each root limits automatic deploys to
`main` (production) and branches named `preview/*` (preview URLs). Every other branch,
including PR branches and review-pass commits, builds nothing on Vercel: the Hobby plan
allows 100 deployments a day across the account. To get a preview URL for a prototype or
a PR, push the same commit to a `preview/<name>` branch.
Custom domain via Vercel, Project Settings, Domains.

## Metrics page (Withers Time)
`time-app/` serves `/metrics` on the finance host (bj-finance #671), managers and owners only: the page,
the `/api/metrics/*` routes and RLS each check it. `lib/metrics/load.ts` reads the CRM and time
clock tables as the signed-in manager; a section that fails to read is reported in `problems`,
never drawn as zeros. Saved views live in `public.metric_views` and `metric_preferences`
(migration 39); until it is applied the routes answer 503 `views_not_enabled` and the page keeps
views in the browser's localStorage. Sales targets come only from `public.sales_targets`
(migration 39): there is no copy in the page code, and when the read fails the sales widget
draws no target or pace and says so. Cash, in-store sales, wages and closed months wait on the
bj-finance feed (migration 40). Labor vs target (bj-finance #696, `lib/metrics/laborTarget.ts`)
reads `labor_daily_actuals` (migration 46), `sales_daily_in_store` (migration 41) and the control
board's settings in force on each day, plus the booked catering deals, their Catering shifts and the
team, read as the Schedule page reads them. Both sides are all-in (taxes and workers' comp): the target is
the board's `hourlyAllInPct`, and the catering crew clients paid for comes off the actual through the
Schedule page's own `cateringOffset`. Every board value is the one in force on the day, so a past week
is judged by the board as it stood then: a pay rule before its first row paid nothing, and fixed payroll
counts only the people salaried that day. A Sunday-to-Saturday week shows only once it is over with all
seven days of payroll and sales on file, every booked catering deal priced (a deal billed zero crew hours,
a pickup, takes nothing off), and hours and hourly labor
still above zero after the catering crew comes off, otherwise "n/a" with the reason. The card covers a range of weeks
(`lib/metrics/weekRange.ts`), saved in the widget's settings as `from` and `to`, the Sundays of its first and last
week, chosen from 2026-05-03 (`FIRST_LABOR_WEEK`) to the week holding today. Unset, it shows the last 8 weeks ending
with the most recent one that is over. A view saved under the old month picker keeps its `month`, read as the weeks
that start in it. A button per month on offer sets the range to that month's weeks by the same rule, and shows
pressed while the range is that month. Every save of a saved view goes through `serialSaves`
(`lib/metrics/saveQueue.ts`), one at a time per view, in the order made: a save sent around it can land out of
order and leave the older choice saved. Tests: `npm test` in `time-app/` includes
`lib/metrics/*.test.ts`.

## Travel Reimbursements (Withers Time)
Staff log mileage, tolls and parking in `time-app/` at `/reimbursements`; Approvers decide
them under `/payroll/reimbursements` on the finance host. Words: `GLOSSARY.md`. Decisions:
`docs/adr/0001` (Receipts go to receipts@ but are never bank-matched) and `0002` (files live
in a private Supabase Storage bucket). The lifecycle is enforced twice, in
`time-app/lib/reimbursements/lifecycle.ts` and in the database trigger of migration 37.

"Compute miles from stops" makes one traffic-unaware Routes API call per trip (the stops as
intermediates) and sums the legs, each rounded to 0.1 mi. Every call stays on the Compute Routes
Essentials SKU: no traffic-aware routing and at most 10 intermediates. Rules and the billing
triggers: the header of `time-app/lib/reimbursements/routeMiles.ts`.

Setup, in the `time` Vercel project:

| Name | Value |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Routes API key. Server-only. Unset, "compute miles from stops" answers that it is not set up and staff type the miles |
| `RESEND_API_KEY` | Already used for notifications; it also sends the Receipts and Lyft ride reports to receipts@withers-ventures.com |

Apply `time-app/supabase/migration_37.sql` by hand in the Supabase SQL editor, after
migration 36. It creates the tables, the payroll views, and the `travel-reimbursements`
bucket; `migration_37_verify.sql` checks it and `migration_37_down.sql` reverses it. Until
it is applied the reimbursement routes answer 503.

## Metrics page tables (Withers Time, bj-finance #671)
Apply `time-app/supabase/migration_39.sql` (saved views, preferences, `sales_targets`), then
`migration_40.sql` (`metrics_snapshots`, the finance feed), by hand in the Supabase SQL editor,
after migration 38. Each has `_verify.sql` and `_down.sql` beside it. Sales targets are data:
change them with an UPDATE in the SQL editor. Snapshots are published by bj-finance, never
written through the API, and never updated or deleted.

## Sales history tables (Withers Time, bj-finance #694)
Apply `time-app/supabase/migration_41.sql` by hand in the Supabase SQL editor, after migration 40.
It adds `sales_daily_in_store` (one row per day) and `sales_monthly` (one row per month and
source, `qbo` or `seller`), the permanent sales history the labor targets read (lane bj-finance
#692). Both are schema only: bj-finance writes every row from the Mac (its daily publisher and a
one-time seed of the previous owner's books), never through the API, and managers read them.
In-store excludes delivery and catering and includes online pickup orders, as the finance feed
does. A missing day or month is unknown, not zero; weeks are grouped by the reader. Verify with
`migration_41_verify.sql`; roll back with `migration_41_down.sql`.

## Staffing forms (Withers Time, Team page)
Apply `time-app/supabase/migration_44.sql` by hand in the Supabase SQL editor, after migration 42.
It adds the `staff_lifecycle` records and steps behind the Team page's Add employee, Re-invite and
Offboard forms, five `profiles` columns, and `revoke_user_sessions`. Until it is applied those
actions fail. Never delete a Withers-time user: `time_entries` cascades from `profiles`. Steps,
API and worker contract: `time-app/docs/staffing.md`.

## Control board: the Targets tab (Withers Time, bj-finance #693)
`/payroll/targets` on the finance host is the control board: the targets the business runs to
(COGS, total payroll and prime cost as shares of sales), the 12-month sales estimate they are
shares of, and the rates they are built from. It is the single source for those values; code
reads them from here rather than keeping copies (bj-finance payroll will, lane #692). Managers and
owners see it; only an owner changes a value, in the page, the routes behind it
(`/api/payroll/targets`, `/api/payroll/targets/salary`) and the database. A salaried person's
annual salary is set on the Team page (owners) and feeds the board's fixed payroll. Fixed payroll
counts everyone set to Salaried who is not overhead, on the schedule or not, on each day they were
employed: `profiles.active` means "on the schedule", `archived_at` (its New York day is the last day
they count) is what marks someone gone, and someone whose first salary starts after a day was not
employed yet (`inFixedPayroll` in `board.ts`). Someone with no salary row at all still counts, as a missing salary.

Every value is dated. A change is a new row, never an edit: it carries an as-of date
(`effective_from`), a review-by date (the green / yellow within a month / red chip; nothing is
ever sent as a reminder), where it came from and how it was worked out. The value in force on a
day is the row with the latest `effective_from` on or before it; a same-day correction wins (later
`recorded_at`, then higher `id`). Categories and keys are data in `time-app/lib/controlBoard/`
(`board.ts`, `settings.ts`): a new category is new keys, not a migration. The derived numbers
(fixed payroll, hourly dollars, the hourly goal, the trend factor) are `lib/controlBoard/math.ts`;
a missing input shows as missing, never as zero.

| Key | `value` | `detail` |
| --- | --- | --- |
| `sales_estimate.in_store`, `sales_estimate.catering` | dollars, next 12 months | |
| `target.cogs_pct`, `target.payroll_pct`, `target.prime_cost_pct` | fraction of sales (0.25 = 25%) | |
| `tax.fica`, `tax.futa`, `tax.pa_uc` | fraction of wages | `wage_cap`: dollars a year, or null for all wages |
| `tax.workers_comp` | dollars per $100 of wages | `class_code` |
| `rule.catering_premium` | dollars added per catering hour | `cap_rate`: dollars an hour |
| `rule.solo_close` | dollars a qualifying night | `min_alone_hours`, `out_at_or_after` (`HH:MM`) |
| `staffing.open_up_minutes`, `staffing.close_down_minutes` | whole minutes before opening / after closing | |

The two `staffing.*` keys make staffed hours (bj-finance #742 follow-up): the open hours widened by the
open-up minutes before and the close-down minutes after, the values in force on the date
(`staffedWindow` in `time-app/lib/coverage.ts`). The schedule's Check week button, the coverage reminder
and the coverage line on Labor Hours Planning measure cover against staffed hours; with a value not set
they fall back to open hours (the button and Labor Hours Planning say so; the reminder does not). Sales projections, affordable hours and payroll verify keep open
hours. New keys, so no migration.

Reading it from the Mac (bj-finance): `select * from public.control_settings_on(date)` gives one
row per key in force on that day, and `public.profile_salaries_on(date)` one per person.

Apply `time-app/supabase/migration_43.sql` by hand in the Supabase SQL editor, after migration 42.
Schema only: no values are in this repo, and owners enter every one on the board after it is
applied. Until then the tab says it needs migration 43 and the Team page shows no salaries.

### The Schedule page's labor line (bj-finance #695)
The manager Schedule page (not the staff view) reads the board. The week reads as an aligned
block, label | hours | $ with the numbers right-aligned: `Target Hourly Labor`, `Scheduled Hourly
Labor`, and `Remaining Hourly Labor` (target minus scheduled, with a real minus sign and in red
when either value is negative; `missing` when the target is). A week with higher-paid people shows
a higher $ against the same target; the day headers show only the day and date. Hourly labor $ is hourly staff (`pay_type =
'hourly'`, read strictly) at their rate, plus the catering premium on Catering shifts and the
solo-close bonus per qualifying night as the board had them on that date, plus open shifts at the
average rate of active hourly staff; salaried and overhead staff are left out. A day's projected
sales are IN-STORE ONLY: last year's in-store sales on the same weekday 52 weeks earlier
(`sales_daily_in_store`) times the trend factor; catering bookings never feed them. The in-store
target $ is that times the hourly goal in force that day; its hours divide it by the average
active hourly rate. Catering crew labor is cancelled out by what the client paid for (Alina,
2026-10-16): for each booked deal that day the target adds the crew hours billed on it in the CRM
(`deals.labor_hours`, which is per crew member, times `deals.staff_count`), priced at crew cost
plus the board's catering premium in force (zero before the rule's first row; capped at its `cap_rate` per person, as on the
scheduled side). Crew cost is the rate of whoever is on that deal's Catering shifts (`shifts.deal_id`,
hours-weighted, open shifts at the average rate), else the average active hourly rate. The
Catering shifts stay on the scheduled side, so an event staffed as billed nets to zero and
over-staffing shows as over target. The math is `lib/controlBoard/schedule.ts` (it calls `boardOn`
in `board.ts`, which runs `computeBoard`), the reads `scheduleLoad.ts`. Anything missing (nothing
on the board yet, no last-year day on file, a partial trend month, a person with no rate, a booked
deal with no billed crew hours on file, named by deal number; zero billed hours is a pickup and offsets nothing) shows as missing with its reason, never
zero, and the empty board points to the Targets tab.
Verify with `migration_43_verify.sql`; roll back with `migration_43_down.sql` (it drops every
entered value; run it before `migration_42_down.sql`).

### Overhead staff (bj-finance #692)
`profiles.is_overhead` (migration 45, default false) marks a person whose pay is overhead, not
part of the payroll target. An overhead person is left out of fixed payroll on the board (and so
out of the hourly goal), out of the Schedule page's hourly labor hours and $, and out of the
average active hourly rate behind open shifts and target hours, and out of a catering deal's crew
cost. They stay on the schedule grid
and in total hours. A manager sets it (an owner's row only an owner); the guard on profiles stops
anyone else, the person included. The Team page has no control for it yet: set it in the SQL
editor. Apply `time-app/supabase/migration_45.sql` BEFORE deploying the time app: the board's
read of the salaried team filters on the column. Verify with `migration_45_verify.sql`; roll back
with `migration_45_down.sql` (code first).

### Hourly payroll actuals (bj-finance #721)
Apply `time-app/supabase/migration_46.sql` by hand in the Supabase SQL editor, after migration 45.
It adds `labor_paycheck_actuals`: one row per hourly paycheck as QBO Payroll paid it (pay period,
pay date, the stub's name and year-to-date gross, Regular and Overtime hours and pay, catering
premium and solo close kept apart), with `profile_id` when exactly one profile has the stub's
name, read from the saved paystub PDFs. bj-finance writes every row of both tables from the Mac
(`modules.labor_actuals`), never through the API; managers read them. Salaried paychecks, tips and
reimbursements are not in it, and nor are employer taxes (a paystub does not carry them: readers
apply the Targets tab's rates). It also adds `labor_daily_actuals`: one row per day of a pay period
whose daily hours (When I Work timesheets before the time app, punches after) tie to the hours QBO
paid, with the period's wages, catering premium and solo close spread over its days by hours.
Hourly, non-overhead labor only; a period that does not tie has no days (unknown, not zero), and
Sunday to Saturday weeks are the reader's grouping. Only the Labor vs target card (bj-finance #696) reads them; apply this
migration before deploying that card, or it says it could not load. Verify with `migration_46_verify.sql`; roll back with
`migration_46_down.sql`.

### Labor Hours Planning (bj-finance #742)
Apply `time-app/supabase/migration_47.sql` by hand in the Supabase SQL editor, after migration 46, BEFORE
deploying the app that reads it. Schema only (this repo is public: owners enter every hour, sales figure and
event date). It adds `store_hours_seasons` (open hours from a first day until the next season starts, one
row per weekday), `concession_events` (dated revisions per `event_key`, `cancelled` takes one off) and
`catering_hours_history` (last year's raw Catering shift hours by day, `kind = 'marketing'` marking a
marketing day; written from the Mac, never through the API). Owners write seasons and events on the Targets
tab (`components/finance/targets/PlanningInputs.tsx`, routes under `/api/payroll/targets/`); managers set
closed days and short hours there too, as `store_hours_exceptions` rows. Without the migration the readers
see no seasons, events or history: every reader of `store_hours` (the schedule's coverage check, the
coverage reminder, payroll verify, the Team page) takes the season in force on the date
(`storeHoursFor` in `lib/coverage.ts`) and falls back to the standing `store_hours`. The Labor Hours
Planning card on `/metrics` (`lib/metrics/laborPlanning.ts`, whose header defines every band) is
the forward view: Labor vs target is the past, the Schedule page the present. Verify with
`migration_47_verify.sql`; roll back with `migration_47_down.sql` (it drops every season, event and day of
history).

Local preview, before the migration is live: `LOCAL_PREVIEW=1 npm run dev` in `time-app/` serves
`/dev/labor-hours-planning` with no sign-in, only when `NODE_ENV` is `development`
(`previewEnabled`, `lib/localPreview.ts`). It reads production with SELECT only through `psql` on
`DIRECT_DATABASE_URL`, and takes what migration 47 will hold from the files named by
`LABOR_PLANNING_SEED` and `LABOR_PLANNING_HISTORY`, outside every repo; its editor saves to the seed file,
never the database.

## Schedule and availability notices (Withers Time, bj-finance #754)
Apply `time-app/supabase/migration_48.sql` by hand in the Supabase SQL editor, after migration 47
(`_verify.sql` and `_down.sql` beside it). Either order with the code is safe: before it, a removed
shift or an availability change is not queued (logged; the save is made) and saving weekly
availability answers 503 with a message.

- **Staff summary** (`lib/shiftNotice.ts`): the 8pm summary's lines lead with the day,
  `Thu, Oct 22 · New|Changed|Removed · <times>`. A shift a manager deletes or moves away from
  someone is a `Removed` line with the times they had (the notice keeps them; the shift may be
  gone). Not a line: a shift new to them since their last summary and taken away again, and a
  drop they asked for (its approval tells them). `schedule_change` governs removed lines.
- **Schedulers' availability email** (`lib/availabilityNotice.ts`): an employee's change to their
  own availability (`/api/availability` POST and DELETE, `week`, `copy-week`, `recurring`) puts
  an in-app row on each scheduler's bell and queues the dates or weekdays whose blocks changed in
  `availability_notices`. The same 8pm cron claims the day's queue once
  (`claim_availability_digest`) and emails each scheduler one list, by person. Schedulers: every
  owner plus every active manager, not archived or banned (the coverage reminder's rule). Off with
  notif_prefs `availability_change` or `email`. Time-off requests, a scheduler's own changes and a
  manager's edits to someone else's rows are left out.
- **Repeat-until** (`lib/repeatUntil.ts`): `availability.repeat_until` is the last date, inclusive,
  a weekly row applies. Saving a weekly block requires it (the calendar fills in three months
  out). `resolveDay` in `lib/availabilityCheck.ts` drops a weekly row after it, so the save and
  auto-fill checks, the schedule cells and the team grid all stop there; the personal calendar
  uses `weeklyRowApplies`. Null means open-ended: every row saved before migration 48.

## Schedule coverage reminder (droplet command)
Every day at noon ET, emails the owners and on-schedule managers every staffed
store hour (open hours plus the open-up and close-down minutes on the Targets
tab) and every booked catering event in two Sun–Sat weeks that nobody is
scheduled for (bj-finance #709, daily since #753). No gaps, no email. The two
weeks start the Sunday after the most recent Thursday (a Thursday run counts
itself), because the schedule is made on Wednesdays: Thursday, Friday and
Saturday runs check the next two weeks; Sunday to Wednesday runs check the
current week from that day on, plus the next week. Days already past are left
out. Every run from one Thursday to the Wednesday after checks the same two
weeks (`reminderWindow`). Store hours are judged by `checkWeekCoverage` in
`time-app/lib/coverage.ts`, the function the schedule board's "Check week"
button runs, so the two cannot disagree. Catering events are deals at Booked
Paid, Booked Unpaid or Closed Marketing Event (`archived = 0`); one counts as
covered when a published shift on it has a person. Recipients are read from
the database (`profiles` joined to `auth.users`): every owner plus every active
manager, leaving out anyone archived or banned. Logic: `lib/coverageReminder.ts`;
command: `lib/coverageReminderCli.ts`; reads: `lib/coverageReminderPg.ts`;
send: `lib/gmailSend.ts`.

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Postgres DSN for the Supabase project |
| `COVERAGE_REMINDER_FROM` | The From address. Set in the droplet's systemd unit, never in this repository |
| `OUTREACH_GMAIL_CLIENT_ID`, `OUTREACH_GMAIL_CLIENT_SECRET`, `OUTREACH_GMAIL_REFRESH_TOKEN` | Gmail API credentials (gmail.send). SMTP is blocked on the droplet |

```
npm run coverage-reminder -- --dry-run   # prints the recipients and the email, sends nothing
npm run coverage-reminder                # sends, only when there are gaps
```
Exit 0 = checked (sent, or nothing to send), 1 = a failure, 2 = bad argument
or `DATABASE_URL` missing. Every failure (database read, recipient lookup,
Gmail send) is also emailed to the fixed failure address with the subject
"Coverage reminder could not run"; a dry run only prints that it would. Reads
run in a read-only transaction. Where it runs: bj-box, from
`bj-coverage-reminder.timer` (Software-Factory `droplet/systemd/`).

## Catering-shift reconciler (local command)
Creates the open crew shifts for booked catering deals that have a
`departure_time` and no shifts yet. Same logic as `/api/cron/catering-shifts`
(`reconcileShifts` in `lib/cateringShifts.ts`: cart events start 120 min
before departure, 15h+ shifts are flagged CHECK HOURS), run straight against
Postgres instead of over HTTP.

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Postgres DSN for the Supabase project. Never read from the Google Drive |

```
npm ci                                   # installs tsx and postgres (both runtime dependencies)
npm run reconcile-shifts -- --dry-run    # read-only: reports what it would create
npm run reconcile-shifts                 # creates the shifts
```
Prints one summary line. Exit 0 = ok, 1 = the sweep or a deal failed,
2 = bad argument or `DATABASE_URL` missing. The dry run runs in a read-only
transaction and EXPLAINs each insert it would make.

Where it runs: on Alina's Mac, from a clean checkout of `main` at
`~/systems/crm-app` (the same `~/systems/` convention as the catering
automations), never from a dev clone or the Google Drive. This is the only
thing that runs from that checkout. It is separate from Vercel, which serves
the web app, and from the droplet's checkout of this repo, which runs only the
schedule coverage reminder above.

The web routes that create the same shifts, `POST /api/deals/:id/booked-shifts`
(signed-in) and `GET /api/cron/catering-shifts`, insert through supabase-js with
`ON CONFLICT (deal_id, deal_slot) DO NOTHING`. That needs
`shifts_deal_slot_uidx` to be a plain unique index
(`time-app/supabase/migration_29.sql`); against the partial index of migration
18 every insert is refused (crm-app #35). The cron route is exempt from the
login gate (alongside the one-click-unsubscribe exemption), so it requires
`CRON_SECRET` (Bearer header or
`?secret=`): unset answers 503, wrong answers 401, and neither touches the
database.
