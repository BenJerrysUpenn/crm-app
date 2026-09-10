# Call desk — "Recently Contacted" tab (bj-finance #409)

Build contract for the prototype. Spec of record: bj-finance #409 (body) and the
operator model on #390 (closing frame). This file is what the builders share;
if it and the ticket disagree, the ticket wins and this file gets fixed.

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
last booked deal), booked_event_type, booked_guest_count`.

The deal-side columns (`last_deal_*`, `last_event_type`, `party_type_booked`,
`booked_*`) join on lowercased, trimmed `contact_email`. From crm/002 that
join accepts a deal when `archived = 0` **or** `legacy_sf_id IS NOT NULL`:
the 9,450 deals migrated from Salesforce were all imported archived, and they
are the booking history the desk exists to show. See "Why party type is
usually an event type" below for what those legacy rows do and don't carry.

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

## API routes (Next.js route handlers, all require a signed-in manager)

| Method + path | Body | Effect / response |
| --- | --- | --- |
| `GET /api/call-desk/queue` | – | `{ rows: CallDeskRow[] }` from the view |
| `POST /api/call-desk/prospects/[id]/calls` | `{}` | insert 'called' event (`by`, `via`, `started_at`); `{ event_id }` |
| `PATCH /api/call-desk/calls/[eventId]` | `{ disposition?, duration_seconds?, note?, recording_path?, consent_confirmed? }` | merge into `detail` (`detail || patch`, sets `dispositioned_at` when disposition arrives); if `note` → also `call_desk_append_note`; if `disposition = 'do_not_call'` → also `call_desk_do_not_call`; `{ ok, detail }` |
| `POST /api/call-desk/prospects/[id]/notes` | `{ text }` | RPC append; `{ notes }` |
| `POST /api/call-desk/calls/[eventId]/recording-url` | `{ consent_confirmed: true, ext, content_type }` | **400 unless `consent_confirmed === true`** (server-side gate, not just UI); `createSignedUploadUrl` in `call-recordings`; `{ path, token }`. Client uploads with `supabase.storage.from('call-recordings').uploadToSignedUrl(path, token, file)` then PATCHes `recording_path` + `consent_confirmed: true` |
| `GET /api/call-desk/options` | – | `{ event_types, customer_profiles, packages, extras, flavors, toppings, minimum_order }` |
| `POST /api/call-desk/deals` | deal form payload (below) | creates the deal + enqueues quote jobs (mechanism pending Alex's ruling; ships as dry-run until then) |

Route handlers set `export const dynamic = "force-dynamic"`. Errors:
`{ error: string }` with a real status code.

## Dispositions

`no_answer`, `voicemail`, `spoke`, `interested`, `do_not_call`. Required after
every call. `do_not_call` asks for a one-tap confirm ("Stop all outreach to
this person?") because it suppresses email too and drops the row from the queue.

## Why party type is usually an event type (bj-finance #414)

150 of the 152 "Booked before" prospects showed an empty Party type while
wearing the badge that says they booked. Two separate causes:

1. **The view couldn't see the history.** `call_desk_queue` filtered deals to
   `archived = 0`; every migrated Salesforce deal is `archived = 1`. The
   `ever_booked` flag came from `sync_contacts_from_deals()`, which reads the
   same deals without that filter — badge on, columns empty. crm/002 fixes it,
   and all 152 gain an event type.
2. **The Salesforce translator dropped Party Type.** It is a real Opportunity
   field (Sundae Party, Cup or Cone Party, Super Deluxe Sundae Party …) but
   only 3 of 9,450 migrated deals carry a `package_name`. Recovering it means
   exporting Opportunities from Salesforce and backfilling on `legacy_sf_id`
   — bj-finance #414 leaf B, Alina's call, **not in this repo yet**.

So the Party type cell reads, in order:

| Have | Shows |
| --- | --- |
| `party_type_booked` | the package, plain |
| else `booked_event_type` | the event type with a muted "(event type)" suffix |
| else | "—" |

The suffix is the point: an event type is *why* they booked, not *what* they
bought, and the reader has to be able to tell. Tapping either still filters —
a package on `party_type_booked`, a fallback on `booked_event_type`.

Note this column no longer falls back to `last_event_type`. That is an
enquiry's event type, not a booking's, and a column headed "Party type"
should not quietly show it.

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
| `party_type_booked` | Party type | package name of the last booked deal |
| `booked_event_type` | Booked event type | event type of the last booked deal |
| `category` | Category | prospect category |
| `city` | City | prospect city |
| `status` | Status | prospect status |
| `calls` | Calls | `0` / `1+` |

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
The status chips (All / Needs disposition / …) and the text search stay
local — they are one tap to retype.

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
card and the desktop table: the "Booked before" badge, the party type, the
"Call · 1h ago" type word, the outcome chip, and city / category in the
expanded details. A tap *adds* that value to the filters (`stopPropagation`
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
