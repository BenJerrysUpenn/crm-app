# Call desk — "Recently Contacted" tab (bj-finance #409)

Build contract for the prototype. Spec of record: bj-finance #409 (body) and the
operator model on #390 (closing frame). This file is what the builders share;
if it and the ticket disagree, the ticket wins and this file gets fixed.

**Read alongside this:** `docs/call-desk-do-not-call-policy.md` — the written
do-not-call policy (bj-finance #420). It is the rule the code implements, it is
a legal precondition of dialling at all (47 C.F.R. §64.1200(d)(1)), and it
carries the training record everyone signs before their first call. The
research it rests on is `docs/call-desk-consent-and-calling-rules.md` in the
bj-finance repo (#418).

## Who uses it and how

Joey (sales coordinator, profile role `manager`, signs in with his Gmail
address) works a call queue on his phone. For each row he taps **Call now**
(a `tel:` link that also logs the call), and when he is back in the app he
must record a **disposition**. He can append **notes**, mark **do not call**,
optionally upload a **recording** (only after confirming consent was obtained
on the call; Pennsylvania is two-party consent), and **Generate deal** through
a guided form. The machine (Catering-Manager quote worker) then prices the
deal and drafts the quote email; a human sends.

Mobile first. Desktop is the same page, wider. Dark theme like the rest of
the CRM (Tailwind, slate palette). Route: `/call-desk`, tab label "Call desk"
in `components/TopBar.tsx` (make the bar wrap on narrow screens).

## Data (all in the shared Supabase project)

Migrations, in order — each runs once in the Supabase SQL editor and is safe
to re-run:

| File | What it does |
| --- | --- |
| `supabase/crm/001_call_desk.sql` | Grants + manager policies on the outreach tables, `call_desk_queue`, the two write RPCs, `deal_form_options`, the `call-recordings` bucket. |
| `supabase/crm/002_call_desk_history.sql` | Redefines `call_desk_queue` so legacy Salesforce deals count as booking history (#414), makes the booked-money test null-safe, and fixes one imported name. Needs 001. |
| `supabase/crm/003_call_desk_compliance.sql` | The lawful-dial gate (#420) and the lost outcome (#421): a phone key on `outreach_suppression`, `dnc_status` / `dnc_checked_at` and the `called_lost` status on `outreach_prospects`, `lost` in the events vocabulary, `call_desk_queue` redefined with the relationship window, and four RPCs. Needs 002. |


| Thing | Where |
| --- | --- |
| Queue rows | view `call_desk_queue` (one row per callable prospect, newest mail first) |
| Call log + disposition + recording pointer | `outreach_events` rows, `event = 'called'`, `detail` JSON |
| Prospect notes | `outreach_prospects.notes`, append-only via RPC `call_desk_append_note` |
| Do not call | RPC `call_desk_do_not_call` (suppression row + status + event, atomic) |
| Recordings | storage bucket `call-recordings`, path `<prospect_id>/<event_id>-<unix_ms>.<ext>` |
| Deal form enums | `deal_form_options` (event_type, customer_profile) + `pricing_packages` + `pricing_extras` + `pricing_scalars.MINIMUM_ICE_CREAM`; flavors/toppings from `lib/menuOptions.ts` (the CRM's existing single place) |
| New deals | `deals` (see "Generate deal" below) + `quote_jobs` |

Everything runs as the signed-in user through `lib/supabase/server.ts`
(route handlers) or `lib/supabase/client.ts` (browser). RLS is the guard:
manager-only policies on the outreach tables. Do **not** use the service-role
admin client for call-desk writes — the caller identity is the point.

### `call_desk_queue` columns

`prospect_id, name, company, title, phone, email, city, category, status,
last_outreach_at, ever_booked, deal_count, lifetime_value, last_event_date,
notes, last_contact_type ('call'|'reply'|'email'|null), last_contact_at,
last_call_event_id, last_call_at, last_disposition, last_call_by,
pending_disposition_event_id, calls_count, last_deal_id, last_deal_stage,
last_event_type, last_deal_event_date, party_type_booked (package_name of the
last booked deal), booked_event_type, booked_guest_count`,

plus, from crm/003 (#420): `last_paid_event_date, last_inquiry_at,
purchase_expires_on, inquiry_expires_on, ebr_basis ('purchase'|'inquiry'|null),
ebr_expires_on, ebr_active, phone_digits, phone_suppressed, dnc_status
('unknown'|'clear'|'national'|'pa_list'|'internal'), dnc_checked_at`.

`status` is `'sequenced'` or, from #421, `'called_lost'`. Rows whose phone is
on the internal do-not-call list are dropped by the view entirely and are the
one thing no toggle brings back; `phone_suppressed` is therefore always false
in practice and exists so a future "show suppressed" view needs no migration.

The deal-side columns (`last_deal_*`, `last_event_type`, `party_type_booked`,
`booked_*`) join on lowercased, trimmed `contact_email`. From crm/002 that
join accepts a deal when `archived = 0` **or** `legacy_sf_id IS NOT NULL`:
the 9,450 deals migrated from Salesforce were all imported archived, and they
are the booking history the desk exists to show. See "Event type and package
are separate columns" below for how the desk reads those columns and what the
legacy rows do and don't carry.

### `outreach_events` 'called' row — `detail` JSON shape

```json
{
  "by": "josephpettine@gmail.com",
  "via": "call_desk",
  "started_at": "2026-09-10T14:03:12.000Z",
  "disposition": "no_answer | voicemail | spoke | interested | do_not_call | null",
  "dispositioned_at": "2026-09-10T14:09:40.000Z",
  "duration_seconds": 240,
  "note": "free text typed in the disposition sheet (also appended to prospect notes)",
  "recording_path": "126/8812-1757512180000.m4a",
  "recording_uploaded_at": "…",
  "consent_confirmed": true
}
```

`occurred_at` = when Call now was tapped. A row with `disposition: null` is a
pending disposition; the queue surfaces it (`pending_disposition_event_id`)
and the UI must nag until it is resolved.

## The lawful-dial gate (bj-finance #420)

Nobody in this queue ever agreed to a phone call — the corporate enquiry form's
one checkbox says "email and online advertising" and names Ben & Jerry's, not
us. A live human dialling by hand sits outside the consent half of the TCPA
(47 U.S.C. §227(b) after *Facebook v. Duguid*), so what governs the desk is the
do-not-call regime: the established business relationship the rules grant
automatically, an internal do-not-call list, registry scrubs, calling hours and
an opening disclosure. `docs/call-desk-do-not-call-policy.md` is the written
version; `lib/callDesk/compliance.ts` is the code, pure and React-free so the
browser and the route handler run exactly the same rules.

**Nothing is hidden.** Alina's ruling, 2026-09-10: *"Don't hide the row itself.
This isn't only the call desk but the outreach desk, so just gray out the call
button if they are outside the safe window and not on registries."* So every
row stays on the desk and stays fully workable — notes, Generate deal, the
expanded details, the recording upload. The only thing the gate ever touches is
the **Call now** button.

**And nothing is explained twice.** Her second ruling the same day, after the
first live session (bj-finance #424): *"reduce row bloat: I need these red
crossed-out lines gone, and the 'say first' is already in the script. Then we
still need to be able to make the risky calls, but I'd like them striped green
and gray rather than full green."* So the hint paragraph under the button grid
and the collapsed **Say first** line are gone, the button itself carries the
whole story, and the out-of-window case became a **risk** rather than a block.

### The window arithmetic

| Leg | Column | Clock |
| --- | --- | --- |
| Purchase | `last_paid_event_date` — the **event date** of the most recent deal with `amount_paid > 0` or a booked stage, legacy Salesforce rows included | + 12 months → `purchase_expires_on` |
| Enquiry | `last_inquiry_at` — the most recent `replied` / `interested` event | + 90 days → `inquiry_expires_on` |

`ebr_expires_on` is the later of the two (`GREATEST` ignores nulls), `ebr_basis`
says which produced it, and `ebr_active` is `ebr_expires_on >= today` in
**Eastern**, not UTC, so a row does not expire five hours early in the evening.
Both are null when neither leg exists.

12 months and 90 days are Pennsylvania's numbers (73 P.S. §2245), the shortest
of the three regimes we could be judged under, and PA is where we dial from.
**Our own outbound email creates no window**: `last_outreach_at` is deliberately
absent from the arithmetic. That is why most of the queue reads "expired" —
31 of 190 rows have a paid booking inside 12 months and none has replied inside
90 days. That is correct, not a bug.

### Blocks and risks

Two separate verdicts, and they are not the same kind of thing.

A **block** is a call we will not place. `callBlockReason(row, now)` returns
the first that applies, hardest-to-clear first, so nobody is told "come back at
nine" about a number they can never dial. The disabled button's own label is
the whole explanation — there is no line underneath it:

| Reason | When | Button label |
| --- | --- | --- |
| `phone_suppressed` | the number is on the internal do-not-call list | Number suppressed |
| `dnc` | `dnc_status` is `national`, `pa_list` or `internal` | On DNC list |
| `lost` | `status = 'called_lost'` (#421) | Lost |
| `hours` | outside 9 a.m.–7 p.m. ET, Mon–Sat, or a federal holiday | After hours |
| `pending_outcome` | the last call has no outcome (#413) | Log outcome first |

The longer sentence (`BLOCK_HINT`) is the button's `title`; `BLOCK_EXPLANATION`
is the paragraph the API returns with a 409.

A **risk** is a call we will place, knowing what it is. `callRisk(row, now)`
returns `'outside_window'` when `ebr_active` is false **and** no fresh scrub
stands in its place — the condition that used to be the `expired` block
(bj-finance #424). Call now stays enabled and the same size, but wears diagonal
green-and-grey stripes with the sentence *"Outside the relationship window, not
yet scrubbed against the registries. Calling is allowed but is a cold call."* in
its tooltip and, for screen readers, in a visually-hidden span. There is no
confirmation dialog: Alina wants one tap, and the stripes are the warning.

"A fresh scrub" is `dnc_status = 'clear'` with `dnc_checked_at` inside 31 days
(16 C.F.R. §310.4(b)(3)(iv)). It is what turns a stale warm number back into an
ordinary solid-green call.

### Button states

| State | Looks like | Enabled |
| --- | --- | --- |
| Warm | solid emerald, "Call now" | yes |
| Risky (`outside_window`) | diagonal emerald/slate stripes, "Call now" on a dark pill | yes |
| Blocked | grey, the reason as its label, the number small beside it | no |
| No number on file | grey, "No phone" | no |

The `expired <date>` line under the phone number in the Phone column is
untouched; that is where the window information lives now.

### What the event records

A `called` event written for a risky call carries `outside_window: true` in its
`detail`, plus `ebr_expires_on` when the row had a window at all. Both are set
by `POST /api/call-desk/prospects/:id/calls` from its own re-read of
`call_desk_queue` — the client sends no opinion on either the block or the risk
and would not be believed if it did. A warm call carries neither key, so an old
row and a warm call read alike.

### The "Callable now" chip

Still the one-tap "who can I ring right now", and it now includes the striped
rows: the test is whether the button is live. To separate risky from safe, use
the **Relationship window** facet (`ebr_active`) — *In window* / *Expired*.

### Hours

9 a.m. to 7 p.m. Eastern, Monday to Saturday, never on one of the eleven US
federal legal holidays (5 U.S.C. §6103, with the Saturday→Friday and
Sunday→Monday observance shifts of §6103(b) / E.O. 11582 — both the day and its
observed day are closed). That is PA Act 47 of 2026, effective 2026-10-18,
adopted early because it is the tightest of PA / NJ / federal. The holiday table
is hardcoded in `compliance.ts` with its source cited; there is no calendar
service to go stale.

A banner sits at the top of the desk when the hours are closed, because the
alternative is a screen full of greyed buttons with no explanation.

### The opening script

`openingScript(row, callerEmail)` builds the one line that must be said before
any pitch — caller's first name, Ben & Jerry's Philadelphia, ice cream catering,
and how we know them ("You booked with us on …" / "You enquired with us on …",
chosen by `ebr_basis`, or "You have been in touch with us before" when there is
no window). 47 C.F.R. §64.1200(d)(4), 16 C.F.R. §310.4(d), 73 P.S. §2245(a)(5).

**It no longer renders on the row** (bj-finance #424) — the collapsed **Say
first** line was one of the two lines Alina asked to lose, because the script is
already in `docs/call-desk-do-not-call-policy.md`, which is what the caller is
trained on. The function stays exported and is still the single source of the
wording for anything that wants to print or read it.

### Registry scrubs

`dnc_status` + `dnc_checked_at` per prospect. `/call-desk/dnc-import`
(manager-only, a textarea and a source select) posts to
`POST /api/call-desk/dnc/import`, which pulls every 10-digit number out of the
pasted text and calls `call_desk_dnc_import`. Matching prospects are flagged
with the registry they appeared on. Non-matching prospects are marked `clear`
**only** when `mark_clear` is passed, and even then the RPC refuses to clear a
prospect already flagged `national`, `pa_list` or `internal` — a partial file
must never un-flag anyone. The asymmetry is the point: a wrong "clear" is a
violation, a wrong "unknown" is a call we didn't make.

Neither subscription is held yet (national registry, ~$85/area code past the
free five; PA list ~$495/yr), so today every out-of-window row is a striped,
risky row rather than a solid green one.

### Do not call, now phone-keyed

`outreach_suppression` was `email text primary key`, which could not hold a
phone number at all — so we had no internal do-not-call list in the sense
47 C.F.R. §64.1200(d)(3) means. crm/003 gives it `phone`, `channel`
(`email`|`phone`|`both`) and a surrogate `id` primary key so a phone-only entry
is storable, with partial unique indexes on each key. The `do_not_call`
disposition writes both keys through the rewritten `call_desk_do_not_call`, and
also stamps the prospect `dnc_status = 'internal'`. Entries are permanent;
nothing expires them.

## "Not now / lost" (bj-finance #421)

Alina, 2026-09-10: *"we also need a button to close out a lost deal but keep
them on the email list."* A sixth disposition, **Not now / lost (keep
emailing)**, does exactly that and nothing more:

- `call_desk_mark_lost` sets the prospect's status to `'called_lost'`, stamps
  the call row's `detail.disposition = 'lost'`, appends a dated notes line and
  writes an `outreach_events` row `event = 'lost'`.
- **Email eligibility is untouched.** Nothing writes `outreach_suppression`,
  nothing touches `marketing_opt_in`. `outreach_warm_eligible` admits
  `status not in ('suppressed','dead')` and `outreach_recontact_queue` admits
  `status <> 'suppressed'` (outreach/migrations/003), so `'called_lost'` leaves
  the prospect exactly as mailable as they were a minute earlier.
- If the row has an open deal (`last_deal_stage` in Open / Sent Quote / Quote
  Review), the sheet offers **Also close deal #N as lost**, which moves it to
  `Closed Lost` through the CRM's own stage-change path (`buildStagePatch` +
  `writeStageChange` in `lib/dealUpdate.ts` — the same code the Kanban board and
  the calendar use), so `boomerang_reason` and `is_active` stay consistent with
  what Catering-Manager's automation expects.
- The row is **not** hidden. It stays on the desk with a "Lost (still emailed)"
  badge, Call now greyed with "Marked lost, reopen to call", and a **Reopen for
  calling** button that posts to `/api/call-desk/prospects/[id]/reopen`. The
  `status` facet is how you pull the lost rows out, or push them away.

`call_desk_reopen` refuses anything that is not currently `'called_lost'` — in
particular a `'suppressed'` prospect can never be revived this way. A
do-not-call request outlives every relationship and every mis-tap.

## API routes (Next.js route handlers, all require a signed-in manager)

| Method + path | Body | Effect / response |
| --- | --- | --- |
| `GET /api/call-desk/queue` | – | `{ rows: CallDeskRow[] }` from the view |
| `POST /api/call-desk/prospects/[id]/calls` | `{}` | **409 `{ error, block_reason }`** when `callBlockReason` (re-computed server-side from `call_desk_queue`, never from the client) is non-null — see the gate above; otherwise insert 'called' event (`by`, `via`, `started_at`); `{ event_id }` |
| `POST /api/call-desk/prospects/[id]/reopen` | – | RPC `call_desk_reopen`; 409 if the prospect is not `called_lost`; `{ ok, prospect_id }` |
| `POST /api/call-desk/dnc/import` | `{ csv, source: 'national'\|'pa_list', mark_clear? }` | parses every 10-digit number out of `csv`, RPC `call_desk_dnc_import`; `{ ok, numbers, matched, cleared }` |
| `PATCH /api/call-desk/calls/[eventId]` | `{ disposition?, duration_seconds?, note?, recording_path?, consent_confirmed?, close_deal_id? }` | merge into `detail` (`detail \|\| patch`, sets `dispositioned_at` when disposition arrives); if `note` → also `call_desk_append_note`; if `disposition = 'do_not_call'` → also `call_desk_do_not_call`; if `disposition = 'lost'` → also `call_desk_mark_lost`, and `close_deal_id` moves that deal to Closed Lost via `lib/dealUpdate.ts`; `{ ok, detail }` |
| `POST /api/call-desk/prospects/[id]/notes` | `{ text }` | RPC append; `{ notes }` |
| `POST /api/call-desk/calls/[eventId]/recording-url` | `{ consent_confirmed: true, ext, content_type }` | **400 unless `consent_confirmed === true`** (server-side gate, not just UI); `createSignedUploadUrl` in `call-recordings`; `{ path, token }`. Client uploads with `supabase.storage.from('call-recordings').uploadToSignedUrl(path, token, file)` then PATCHes `recording_path` + `consent_confirmed: true` |
| `GET /api/call-desk/options` | – | `{ event_types, customer_profiles, packages, extras, flavors, toppings, minimum_order }` |
| `POST /api/call-desk/deals` | deal form payload (below) | creates the deal + enqueues quote jobs (mechanism pending Alex's ruling; ships as dry-run until then) |

Route handlers set `export const dynamic = "force-dynamic"`. Errors:
`{ error: string }` with a real status code.

## Dispositions

`no_answer`, `voicemail`, `spoke`, `interested`, `lost`, `do_not_call`.
Required after every call.

`do_not_call` asks for a one-tap confirm ("Stop all outreach to this person?")
because it suppresses email *and* phone, permanently, and drops the row from
the queue for good.

`lost` — "Not now / lost (keep emailing)" — is the opposite and must never be
used as a stop request: it takes them off the call queue and deliberately
leaves them on the marketing email list (#421, above).

## Event type and package are separate columns (bj-finance #414)

Alina's ruling, 2026-09-10: *"you need to separate party type and event type.
just print both columns. I only really care about if it's corporate or if it's
a birthday party or whatever. I do not care about the package they booked."*
So the queue carries two columns, not one.

**Event type** — primary, listed first, normal weight. This is the field she
reads. It falls back:

| Have | Shows | Tapping filters |
| --- | --- | --- |
| `booked_event_type` | the booked deal's event type | `booked_event_type` |
| else `last_event_type` | the most recent deal's event type | `last_event_type` |
| else | "—" | nothing |

The fallback is deliberate and is the reverse of what crm/002 shipped. Two
kinds of row depend on it: past cake customers, whose deals the #414 backfill
stamps `event_type = 'Cake Order'` ("cake orders are a deal type that's worth
knowing"), and people who enquired but never booked, whose enquiry event type
is the only thing the desk knows about why they got in touch. The old
"(event type)" suffix is gone — the column header now says what the value is,
so nothing has to be annotated.

**Package** — secondary, muted. `party_type_booked` (the `package_name` of the
last booked deal) or "—". Tapping filters `party_type_booked`. It is mostly
empty by nature: the Salesforce translator dropped the Party Type Opportunity
field, so only 3 of the 9,450 migrated deals carried a `package_name` until
the `003_party_type_from_sf_leads.py` backfill recovered it from the Leads
report. Nothing downstream reads it; it is there so a caller can see what a
returning customer bought last time.

Two other things about that history are still worth knowing:

1. **The view couldn't see it at all.** `call_desk_queue` filtered deals to
   `archived = 0`; every migrated Salesforce deal is `archived = 1`. The
   `ever_booked` flag came from `sync_contacts_from_deals()`, which reads the
   same deals without that filter — badge on, columns empty. crm/002 fixes it,
   and all 152 "Booked before" prospects gain an event type.
2. **Package recovery is a backfill, not a view change.** See
   `supabase/crm/backfills/003_party_type_from_sf_leads.py`; discontinued
   party types land in the deal's notes rather than `package_name`, which has
   a CHECK constraint on eight names.

## Filtering and sorting (bj-finance #412)

The queue is one long list; these narrow it. Everything is client-side over
the rows already fetched — no extra API calls, no server round-trip on a tap.
The pure logic lives in `lib/callDesk/filters.ts` (React-free, so it can be
read and tested on its own); `components/callDesk/FilterSheet.tsx` renders it.

### Facets

One facet per column worth slicing on, in this order:

| Key / query param | Label | Values |
| --- | --- | --- |
| `last_contact_type` | Last contact | call / reply / email |
| `last_disposition` | Last outcome | the five dispositions, plus `none` = "No outcome yet" |
| `ever_booked` | Booked before | `yes` / `no` |
| `booked_event_type` | Booked event type | event type of the last booked deal |
| `last_event_type` | Event type (last deal) | event type of the most recent deal — what the Event type column shows when there is no booked one |
| `party_type_booked` | Package | package name of the last booked deal |
| `category` | Category | prospect category |
| `city` | City | prospect city |
| `status` | Status | prospect status — `sequenced`, or `called_lost` shown as "Lost (still emailed)" |
| `calls` | Calls | `0` / `1+` |
| `ebr_active` | Relationship window | In window / Expired |
| `ebr_basis` | Window from | A booking / An enquiry / No relationship |
| `dnc_status` | Registry scrub | Never scrubbed / Scrubbed clear / On the national registry / On the PA registry / On our own list |

A null or blank column buckets as `none`, labelled "—" unless the table above
gives it a nicer name. Selection is **AND across facets, OR within one**:
`city=Philadelphia,Trenton` + `ever_booked=yes` means "booked before, in
either city".

Counts on the chips are computed against the rows left by every *other*
facet, so a number says what picking that value would leave you with — not
what the whole queue holds. A facet whose value is identical on every row is
hidden: there is nothing to filter by.

### URL

One query param per facet, comma-separated values, plus `sort`:

```
/call-desk?last_contact_type=call,reply&ever_booked=yes&sort=asc
```

The URL is the state. It is written with `router.replace` (no scroll, no
history spam) on every change, so the 30 s refresh, a reload and a link
pasted into Slack all land on the same view. Unknown keys and values are
ignored rather than thrown, so a stale link degrades to a looser filter.
The status chips (All / Callable now / Needs disposition / …) and the text
search stay local — they are one tap to retype. **Callable now** is the one-tap
answer to "who can I actually ring right now": it keeps the rows whose
`callBlockReason` is null, which folds the window, the registries, the hours and
the pending-outcome rule into a single chip. It is a chip and not a default
because the desk is where the email outreach gets worked too.

### Sorting

A single toggle next to the Filter button flips the queue between **Newest
first** (default, `sort` absent) and **Oldest first** (`sort=asc`). It orders
by `last_contact_at`, falling back to `last_outreach_at`, with `prospect_id`
breaking ties. Rows with no contact date at all sit at the bottom in both
directions — they have no place on a timeline. Calls awaiting a disposition
still float to the top whichever way the sort runs: an unresolved call
outranks recency.

### Tap a value to filter

Every badge and value that maps to a facet is tappable in both the mobile
card and the desktop table: the "Booked before" badge, the event type, the
package, the "Call · 1h ago" type word, the outcome chip, and city / category
in the expanded details. The event type taps whichever facet it was read
from — `booked_event_type` or `last_event_type` — so the filter always
matches what is on screen. A tap *adds* that value to the filters (`stopPropagation`
keeps the row from expanding); removal is the × on the active chip row under
the search box. The badges look the same as before — the only affordance is
a pointer cursor and an underline on hover/focus, plus a `title` and an
`aria-label` reading "Filter by …".

## Recording upload — consent gate (hard requirement)

The upload control is hidden behind a checkbox / confirm: "I told the caller
this call was being recorded and they agreed." Default practice is no
recording, so the control is collapsed by default under a small "Attach
recording" disclosure. The server refuses to mint an upload URL without
`consent_confirmed: true`, and the flag is persisted on the event.

## Undo and double-call guard (bj-finance #413)

From the first live use: Call now was tapped by mistake, then again 13 s
later. Two `called` events with no outcome landed on one prospect and nothing
in the UI could take either back.

**Undo.** The outcome sheet carries a secondary action, "I didn't call —
remove this", with a one-tap inline confirm (Remove / Keep). It calls
`DELETE /api/call-desk/calls/[eventId]`, which refuses with **404** if the
event is missing, **409** if it is not a `called` event, if
`detail.disposition` is set, or if `detail.recording_path` is set. A call
with an outcome or a recording is history; history is not edited here. On
success the sheet closes, the queue reloads, and the calls count drops back.

The client hides the action once a recording was attached in this session
(the queue view doesn't carry `recording_path`, so the browser can only know
about uploads it made); the server enforces the rule either way.

**Service role, deliberately.** Managers hold SELECT / INSERT / UPDATE on
`outreach_events` and nothing else (`supabase/crm/001_call_desk.sql`), so the
user-scoped client physically cannot delete. Rather than widen that grant,
the DELETE route runs its one delete statement through
`lib/supabase/admin.ts` — reached only after the sign-in check and all three
row checks have passed. Everything else on that route stays user-scoped, and
this is the only call-desk write that is not.

**No double call.** While a prospect has a pending disposition:

- the card renders Call now disabled, with the phone number in its place
  (still selectable, so it can be dialled by hand) and the hint "Log the
  outcome of the last call first" under the buttons — Log outcome stays the
  primary action;
- `POST /api/call-desk/prospects/[id]/calls` returns **409**
  `{ error, pending_event_id }` before inserting, so a stale tab cannot slip
  a second one past;
- the client turns that 409 into the disposition sheet for
  `pending_event_id` rather than an error toast — the tap becomes the nag.

## Generate deal — guided form

Prefill from the queue row (name split into first/last, company, phone,
email). Fields, in order, with enumerations visible (not hidden behind a
combobox: show them as chips / radio lists on mobile):

1. Contact: first name*, last name, email*, phone*, company
2. Customer profile (reference only; goes to notes) — from `deal_form_options`
3. Event: event type* (from `deal_form_options`), event name, date*, start*,
   end*, venue name, venue address*, guest count*, outdoor? (yes/no, default no)
4. Package* — from `pricing_packages` (name, price/guest, what's included)
5. Flavors (3 included, up to 6) — `lib/menuOptions.ts`
6. Toppings — `lib/menuOptions.ts`
7. Extras with quantity — from `pricing_extras`
8. Tax exempt? (default no), how did you hear (free text), day-of contact
   name/phone (optional), a first note for the deal
9. Live hint: guests × package price vs `MINIMUM_ICE_CREAM` (below-minimum
   warning; the machine's triage enforces the real rule)

### Small parties → cakes

A party of `CAKE_GUEST_MAX` (50) guests or fewer is a cake sale, not a
catering job: up to two sheet cakes cover 50 people. When guest count is set
and at or below that, a sky-toned panel appears under the Guest count field
pointing the caller at `CAKE_ORDER_URL`
(<https://www.benjerry.com/upenn/cakes>), with a Copy link button so Joey can
text it. Cakes travel `CAKE_MAX_DRIVE_MINUTES` (35) minutes one-way from the
shop — half catering's 70-minute one-way triage cap, an assumption from
Alina's 2026-09-09 ruling (bj-finance #411), not a measurement; beyond that
the customer picks up. All three constants and the pure `shouldSuggestCakes`
helper live in `lib/callDesk/dealForm.ts`.

It is a pointer and nothing more: no cake order is created, nothing is
written anywhere, and Create deal stays enabled — a small party at high spend
may still be worth a catering deal, and that stays Joey's call.

Write semantics must match `modules/db.py::create_deal` in Catering-Manager
exactly: `stage='Open'`, `payment_status='None'`, `is_active=1`,
`source='phone'`, `created_at`/`updated_at` = UTC `YYYY-MM-DDTHH:MM:SS`,
list columns (`flavors`, `toppings`, `extras`) as JSON arrays of strings,
booleans as 0/1 integers, `cart_service=1` iff extras contain "Ice Cream
Cart", `is_outdoor` never NULL (0 default), `notes` date-prefixed
`[YYYY-MM-DD] …` (created-from-call-desk line + profile + the caller's first
note), `lead_source` stamped to the caller (identifier pending ruling; default
the caller's email), `how_did_you_hear` = the customer's answer. Only columns
the form collects are written; every one of them is in `ALLOWED_DEAL_COLUMNS`.
After insert: `outreach_events` 'deal_created' for the prospect (`detail`:
`deal_id, by, via`), prospect `status='handed_off'` + 'handed_off' event, then
`quote_jobs` rows `retriage` and `quote` (in that order, `requested_by` =
caller email) so the worker computes drive/staff/labor and drafts the quote.

## Deliberately not built (this ticket)

Quote-chase queue segment, SMS, auto-dialing, transcription, editing or
deleting *dispositioned* call rows (an empty one can be undone — #413), a profile column on deals, cake ordering inside the CRM,
any change to Catering-Manager. Filtering (#412) adds no saved views, no
server-side filtering, and no free-text filter on notes.

From #420 / #421: no carrier line-type lookup (mobile vs landline is empty on
every Salesforce row, and NJ's cell-phone rule is handled by the window gate
blocking the number like any other), no automatic registry download (the
subscriptions do not exist yet — the import is a paste), no telemarketer
registration workflow, no per-state rule table (one conservative rule, PA's,
applies everywhere), no B2B exemption (PA's list covers business lines, so
claiming it would buy nothing), and no bulk "close all lost".
