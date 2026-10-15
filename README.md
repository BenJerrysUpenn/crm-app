# Withers Ventures CRM

Login-protected Kanban board for the catering pipeline. Reads and writes the
`deals` table in the existing Supabase project.

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
the staff roster" and is never an access check; access ends by banning the
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

## COI panel (deal drawer)
`components/CoiPanel.tsx` renders on deals with `coi_required = 1` and assembles the
Hartford certificate request from the deal (`buildCoiRequest` in `lib/coi.ts`). It never
submits to The Hartford; the human sends. Its only write is `coi_sent_at` plus
`updated_at` in one `deals` update (it never touches `stage`). A COI is urgent when
required, unsent and the event is 0 to 14 days out (`COI_URGENT_WINDOW_DAYS`), the
same window as Catering-Manager `revive.coi_required_unsent`.

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
bj-finance feed (migration 40). Tests: `npm test` in `time-app/` includes `lib/metrics/*.test.ts`.

## Travel Reimbursements (Withers Time)
Staff log mileage, tolls and parking in `time-app/` at `/reimbursements`; Approvers decide
them under `/payroll/reimbursements` on the finance host. Words: `GLOSSARY.md`. Decisions:
`docs/adr/0001` (Receipts go to receipts@ but are never bank-matched) and `0002` (files live
in a private Supabase Storage bucket). The lifecycle is enforced twice, in
`time-app/lib/reimbursements/lifecycle.ts` and in the database trigger of migration 37.

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
the web app, and from the droplet's checkout of this repo, which runs nothing.

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
