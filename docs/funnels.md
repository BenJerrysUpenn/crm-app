# Funnels tab — on-the-loop supervision of the automated email sales funnels

bj-finance #422 (under #425 Sales communication layer, inside #389 Sales funnels).
Sibling of the call desk (#409). This is **not** a manual work surface: the machine
runs the loop (warm/cold email engines, catering sweep, quotes, boomerangs) and this
tab is where a human **watches it flow and intervenes on exceptions only**.

Route: `/funnels` (in the top nav). Data: `GET /api/funnels?window=7|30|90|semester`,
fetched client-side with `cache: 'no-store'` (route-handler fetches are cached even
under `force-dynamic` — PR #12). Auth/data access mirror the call desk exactly: the
page runs as the **signed-in manager**, and every table is gated by the manager RLS
policies from `supabase/crm/001_call_desk.sql`. No service-role client is used here.

## The four panels

1. **Loop status** — warm engine (sends today vs the 20/day cap, active sequence,
   last engine activity) and cold engine (the domain-age gate, now **passed** as of
   2026-09-24; staged/queued count). The sweep run-log telemetry is not yet persisted,
   so last-activity is derived from the newest non-`added` outreach event; the proposed
   `sweep_runs` table (below) closes this.
2. **Exception queue** — the only interactive panel. Items the automation parked for a
   human, with age:
   - *Drafts awaiting send* = deals at stage **Quote Review**. This is an
     **approximation** (Gmail drafts have no single DB source of truth); the UI says so.
   - *Replies awaiting handling* = prospects with a recent `replied`/`interested` event
     not yet `handed_off`/`suppressed`. Clears automatically once the #285 reply→CRM
     bridge files each reply as a deal.
   - Actions are exception-shaped, not row-by-row: **Open in Gmail** (deep link),
     **Mark handled** (per-viewer, `localStorage`-only — there is no DB write path for
     it without a migration), and **Suppress** (replies only), which reuses the existing
     `call_desk_do_not_call` RPC verbatim — the same write an email opt-out makes.
3. **Funnel flow** — left-of-pipeline per engine (sent → replied → handed_off → deal →
   quoted → booked) and the deal funnel per derived profile (created → quoted → booked →
   complete, with $ and conversion), a below-min counter per profile/overall, and a
   quote-latency reading. **Attribution is the activity join**: a prospect was mailed,
   then a deal on the same email was *touched* (`updated_at`) after the mail date. It is
   **never** a join on `deals.created_at` — repeat/legacy contacts reuse deal rows, so
   created_at would credit the machine for deals it never touched. See
   `lib/funnels/compute.ts::computeOutreachFunnel`.
4. **Health strip** — suppression count + rate, opt-out events, quote-job backlog, and
   failed quote jobs (a sweep-failure proxy). Seed/DMARC is a static note this pass.

## Profile derivation

Layer 1 derives the customer profile in **TypeScript** (`lib/funnels/profile.ts`),
not a SQL view — a view is DDL, and this pass is pure reads that must run without an
Alex-approved migration. Precedence: `penn_account` (@upenn.edu) → `wedding`
(wedding/bridal/rehearsal/engagement) → `mitzvah` → `office_admin` (corporate event
type **and** a business email domain) → `family_celebration`
(birthday/baby shower/gender reveal/family reunion) → `unclassified`. `event_type` is
dirty free-text and is normalized before matching.

## What is a proxy / approximation (say it, don't hide it)

- Warm daily cap is a constant (`WARM_DAILY_CAP`), because Vercel can't read the droplet
  env; the proposed `sweep_runs` table would carry the live value.
- "Drafts awaiting send" is the Quote-Review stage, not real Gmail drafts.
- Quote latency uses the earliest **done** `quote_jobs` row per deal as the "quote sent"
  instant (the artifact is produced right before the human send).
- Seed/DMARC is a static note, not live-polled.

## Deferred (layer 2 — `supabase/crm/proposed/007_funnels_layer2.sql`, DO NOT RUN)

`deals.profile` (durable + human-overridable), `advocates`, `store_campaigns` (campaign
board with the "no Live without counting_method + break_even" rule), and the `sweep_runs`
telemetry table. All gated on Alex's approval and on #392/#395/#396/#438 ratifying the
vocabulary. The proposed file lives under `proposed/` so it is not part of the applied
`crm/00x` sequence.

## Reconciliation (window = 30 days, now = 2026-09-25T04:00Z)

The tab's compute functions, run over the real prod rows, match direct SQL:

| Metric | Tab | Direct SQL |
|---|---|---|
| Warm sent (distinct prospects mailed in window) | 420 | 420 |
| Deals created in window | 39 | 39 |
| Below-min in window | 6 | 6 |
| Below-min all-time | 74 | 74 (Closed Below Min) |
| Booked all-time | 64 | 64 (Booked Unpaid 1 + Booked Paid 8 + Event Complete 55) |
| Quoted all-time | 69 | 69 (+ Sent Quote 5) |
| Quote-job errors | 111 | 111 |

(`warm.replied` counts mailed-in-window prospects who replied — a subset of the 9 total
reply events, by design.)
