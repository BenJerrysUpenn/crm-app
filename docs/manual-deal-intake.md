# Manual deal intake — "New deal"

Staff can add a deal for a customer who did not use the catering form on
benjerry.com/upenn/catering: they rang, emailed, or asked at the counter. The
deal behaves like any other from the moment it exists, and it queues itself
for Salesforce, where a corporate Lead has to be created because the form
never made one.

Read alongside `docs/call-desk.md`. This feature is an extension of the call
desk's guided form, not a second form.

## What already existed, and what is new

The call desk (bj-finance #409, live 2026-09-10) could already create a deal.
What it could not do:

| | Call desk, before | New deal |
| --- | --- | --- |
| Entry point | a row in the call queue | the **New deal** button in the top bar, from any page |
| Needs a prospect | yes, `prospect_id` was required | no |
| Source | hard-coded `phone` | the human picks: phone / email / walk-in / other |
| Required to submit | name, email, phone, event type, venue, package, date, both times, guests | name, **one** contact method, source |
| Duplicate check | none | advisory warning on email or phone |
| Salesforce | nothing | the deal is queued for lead creation |

So the gap was: you could only write down a deal for somebody the outreach
machine already knew about, and only if you had every detail of the event in
front of you. A voicemail from a stranger had nowhere to go.

Everything else is deliberately shared. `components/callDesk/GenerateDealForm`
renders both intakes — pass `prospect: null` and it grows a source picker and
a duplicate panel and relaxes its required set. `lib/callDesk/dealCreate`
writes the row for both. A second copy of either would drift the first time a
package or an event type changed.

## The minimal required set

Name, one contact method, and where the enquiry came from. Alina's rule, and
it is the difference between writing an enquiry down and losing it.

Optional does not mean unchecked: a date that IS typed still has to be a date,
an email still has to look like one. `validateDealPayload(payload, { mode })`
holds both rule sets; `call_desk` is the default so nothing about the existing
form changed.

### What a thin deal costs

A deal with no venue, date, head count and package cannot be priced, so **no
quote job is queued** (`isQuoteReady`). The deal sits on the board at stage
Open like any other enquiry waiting on information, and the form says so
rather than queueing a job that would fail. Fill the details in on the board
and request the quote from the deal drawer.

Two further things a thin deal does not get, both pre-existing behaviour worth
knowing:

- **No `gmail_thread_id`.** `modules/validators.py` lists it as hard-required
  at stage Open, so the deal reads as incomplete until the sweep's thread
  discovery links one by email address. A walk-in who left only a phone number
  never will. This is exactly how call-desk deals have behaved since September
  and is not changed here.
- **No quote email.** `quote_worker._process_quote_job` requires
  `contact_email`. A phone-only deal can be priced by hand but cannot have a
  quote drafted to it.

## Duplicate warning

`POST /api/deals/dedupe` matches the typed email (lowercased, trimmed) and the
typed phone (digits only, leading US 1 dropped) against existing **deals** and
**outreach prospects**, through the `deal_dedupe_candidates` RPC. The phone
half has to be SQL, because `deals.contact_phone` holds whatever a human
typed — "(215) 665-5323", "+1 215 665 5323" — and PostgREST cannot normalise
the column side of a filter.

Archived deals are included on purpose: the 9,450 rows migrated from
Salesforce are all archived, and "this office booked us three times under the
previous owner" is the most useful thing the check can say.

It is a **warning, never a block**. The same office books four parties a year
and the fourth is a new deal, not a mistake. What it does enforce is that
nobody creates a duplicate without having seen the match: the form shows the
list with a tick-box, and `POST /api/deals` returns **409** with the matches
unless the request carries `confirm_duplicate: true`. The client check is
debounced while typing; the server check is the one that catches two people
entering the same voicemail at once.

If the RPC is missing the lookup returns `unavailable` and intake carries on.
A duplicate check that cannot run must never stop somebody writing down a
customer who is standing at the counter.

## Source, and why 'form' is not on the list

`deals.source` records how the enquiry arrived. The picker offers `phone`,
`email`, `walk_in`, `other`.

It does **not** offer `form` or `migrated`, and the server refuses them:

- `form` is what tells the Salesforce mirror that a corporate Lead already
  exists for this enquiry. Stamping it on a walk-in would make the mirror hunt
  forever for a Lead nobody created.
- `migrated` belongs to the historic rows imported at the transfer.

`walk_in` and `other` are new values and need the migration below.

## Salesforce

`deals.sf_lead_state` is the queue. `buildDealInsert` stamps `'queued'` on
every hand-entered source and leaves it NULL for form deals, so applying the
migrations changes nothing about what tonight's mirror run does to the deals
already in scope.

The nightly mirror then **searches Salesforce first** — a walk-in customer may
also have filled in the corporate form — and only creates a Lead when the
search genuinely misses. Creating is behind its own switch,
`SF_LEAD_CREATE_ENABLED`, which is off. The full story, including what is
proven and what is not, is `sfmirror/README.md` in the Catering-Manager repo.

The CRM's whole involvement is that one word, `queued`. Every state after it
belongs to the mirror.

## Migrations to apply

In this order, in the Supabase SQL editor. Both are idempotent.

1. **`Catering-Manager/migrations/023_manual_deal_sources_and_sf_lead_state.sql`**
   — widens the `deals.source` CHECK to admit `walk_in` and `other`, and adds
   `deals.sf_lead_state`. `deals` is owned by Catering-Manager, which is why
   its DDL lives there and not in `supabase/crm/`.
2. **`supabase/crm/005_manual_deal_intake.sql`** — the
   `deal_dedupe_candidates` RPC and two indexes. Needs crm/003 for
   `public.normalize_phone`.

Until (1) is applied the form loads and validates but the insert fails; the
route detects the missing column and says which migration to run rather than
returning a raw PostgREST error.

## The write gate

Both intakes honour `CALL_DESK_DEAL_WRITES`. Anything other than `live` and
the routes compute every row and return it as a dry run without writing. One
gate for both, so there is no state where one form writes and the other
pretends to.

**Check this is set to `live` in Vercel before telling staff the button
works.** It shipped off with the call desk pending a ruling on the write
mechanism (#409).

## Files

| Thing | Where |
| --- | --- |
| Source + lead-state vocabulary, dedupe keys | `lib/dealIntake.ts` |
| Payload, validation modes, the row builder | `lib/callDesk/dealForm.ts` |
| The shared writer | `lib/callDesk/dealCreate.ts` |
| Untrusted-body coercion | `lib/callDesk/dealRequest.ts` |
| Duplicate lookup | `lib/dealDedupe.ts` + `supabase/crm/005` |
| The form | `components/callDesk/GenerateDealForm.tsx` (`prospect: null`) |
| Page and entry point | `app/deals/new/page.tsx`, `components/NewDealForm.tsx`, `components/TopBar.tsx` |
| Routes | `app/api/deals/route.ts`, `app/api/deals/dedupe/route.ts` |
| Tests | `tests/dealIntake.test.ts` |
