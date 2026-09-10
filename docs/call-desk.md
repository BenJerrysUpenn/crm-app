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

## Data (all in the shared Supabase project; see `supabase/crm/001_call_desk.sql`)

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

## Recording upload — consent gate (hard requirement)

The upload control is hidden behind a checkbox / confirm: "I told the caller
this call was being recorded and they agreed." Default practice is no
recording, so the control is collapsed by default under a small "Attach
recording" disclosure. The server refuses to mint an upload URL without
`consent_confirmed: true`, and the flag is persisted on the event.

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
deleting call rows, a profile column on deals, cake ordering inside the CRM,
any change to Catering-Manager.
