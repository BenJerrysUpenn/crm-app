# One-click unsubscribe (bj-finance #440)

Spec of record: bj-finance #440, inside #425 (the sales communication layer).
If this file and the ticket disagree, the ticket wins and this file gets fixed.

Two halves were specified on #440. **Only the unsubscribe half is built.** The
click-redirect half is dropped entirely: click tracking was deliberately off on
this lane, and a tracking redirect on a young sending domain can itself hurt
placement. Nothing in this endpoint records a click.

## Why it exists

`List-Unsubscribe` on the warm lane is `mailto:` only today
(`outreach/warm_sender.py`, `build_message`). Both Yahoo's and Microsoft's bulk
sender rules want a one-click HTTPS control, and Gmail renders the "Unsubscribe"
affordance next to the sender name from the same pair of headers. RFC 8058 is
what turns a link into that control:

```
List-Unsubscribe: <mailto:…?subject=unsubscribe>, <https://…/api/unsubscribe/TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Both headers must be present. A `List-Unsubscribe-Post` header without an
HTTPS URI in `List-Unsubscribe` does nothing, and the mailto stays in the list
so the existing reply route (`outreach/bounce_reader.py`) keeps working.

## The two halves and who owns them

| Half | Repo | State |
| --- | --- | --- |
| The endpoint that honours the token | **crm-app** (this PR) | Built |
| Minting the token and shipping the two headers | **Catering-Manager**, `outreach/warm_sender.py` | Follow-up PR |

This file is the contract between them. The endpoint's own copy of it is
`lib/outreach/unsubscribeToken.ts`, which is the truth if the two ever drift.

## The token contract

```
email_key = email, whitespace-trimmed, then lowercased
mac       = hex( HMAC_SHA256( UNSUBSCRIBE_SECRET, prospect_id + ":" + email_key ) )
payload   = prospect_id + "." + mac
token     = base64url( payload )        -- unpadded, no "=" characters
```

Stated exactly:

- `prospect_id` is `outreach_prospects.id`, rendered in decimal, no padding.
- The MAC input is the ASCII string `"<id>:<email_key>"` — one colon, no
  spaces. `123:someone@example.com`.
- `email_key` is trimmed **and** lowercased. Trimming is in the contract so a
  stray space in a stored address cannot change the MAC; for a clean row it
  changes nothing. It matches the `lower(btrim(email))` the outreach SQL uses
  as its key everywhere.
- `mac` is lowercase hex, 64 characters. The endpoint rejects anything else
  before it touches the database.
- `payload` is `"<id>.<mac>"` — one dot, the id first.
- `token` is standard base64url (`-` and `_`, **no** padding). The endpoint
  rejects any character outside `[A-Za-z0-9_-]`.
- The secret is the raw bytes of `UNSUBSCRIBE_SECRET` as UTF-8. The same
  value must be set on the Vercel project and wherever the sender runs.

Minting it, for `outreach/warm_sender.py`:

```python
import base64, hashlib, hmac, os

def unsubscribe_token(prospect_id: int, email: str) -> str:
    secret = os.environ["UNSUBSCRIBE_SECRET"].encode()
    key = email.strip().lower()
    mac = hmac.new(secret, f"{prospect_id}:{key}".encode(), hashlib.sha256).hexdigest()
    payload = f"{prospect_id}.{mac}".encode()
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode()
```

`rstrip(b"=")` is not optional — `urlsafe_b64encode` pads and the endpoint
rejects `=`.

The URL is then `<base>/api/unsubscribe/<token>`, where `<base>` is the origin
the Vercel project serves. **Open: which host.** The project answers on the CRM
domain today; putting the unsubscribe control on the sending domain instead
reads better to a recipient and to a filter. Alina's call, and the sender
should read it from an env var (`OUTREACH_UNSUBSCRIBE_BASE`) rather than
hard-code it either way.

### Verification, on this side

1. Reject the token on its alphabet and length before anything else.
2. base64url-decode, split on the first `.`, require a positive integer id and
   64 lowercase hex characters.
3. Look the prospect up by id and read the **stored** address.
4. Recompute the MAC over that stored address and compare it in constant time
   (`crypto.timingSafeEqual`).
5. Anything that fails — bad alphabet, bad shape, no such id, no address on
   the row, wrong MAC — returns the **same** `404` with the same plain-text
   body. The endpoint never says whether an id exists.

The email is never in the token, only in the MAC. A token is therefore not a
disclosure of anyone's address, and re-keying `UNSUBSCRIBE_SECRET` invalidates
every token ever minted — which is the reason to treat it as a secret and not
as config.

## The endpoint

`app/api/unsubscribe/[token]/route.ts`. `dynamic = "force-dynamic"`,
`runtime = "nodejs"`. Reads Supabase through `lib/supabase/admin.ts`, never
through `fetch` (this repo has been bitten by Next's fetch cache before). No
cookies, no JS, no framework on the page.

`middleware.ts` returns early for `/api/unsubscribe/`, before `updateSession`.
That is load-bearing twice over: the auth gate 302s anonymous requests to
`/login`, and RFC 8058 §3.2 forbids this endpoint from redirecting at all.

### `POST /api/unsubscribe/<token>` — the RFC 8058 control

Accepts `application/x-www-form-urlencoded` with `List-Unsubscribe=One-Click`,
and also a bare POST with no body (some clients send one). No redirect. `200`
with `Unsubscribed.\n` as `text/plain`.

### `GET /api/unsubscribe/<token>` — the human-clicked link

Renders a minimal page with one **Unsubscribe** button that posts to the same
URL with a hidden `via=link`. **GET never writes.** Gmail, Outlook and every
corporate link scanner fetch URLs in mail before a person ever sees them; a
GET that unsubscribed would opt people out who never clicked anything. The
form post answers with a one-line HTML confirmation.

### Status matrix

| Request | Response |
| --- | --- |
| POST, valid token, first time | `200` `text/plain` — one suppression row, one event, status stamped |
| POST, valid token, repeat | `200`, identical body, **nothing written** |
| POST, bad MAC / malformed / unknown id | `404` `text/plain` |
| GET, valid token | `200` `text/html`, the button. No writes |
| GET, bad MAC / malformed / unknown id | `404` `text/plain` |
| Either, `UNSUBSCRIBE_SECRET` unset | `503` — loud, not silent. See below |
| Either, database error | `500`, so a provider retries |

A missing secret answers `503` rather than `404` on purpose. A `404` would look
to a mail provider like a working endpoint that refused the request, and every
genuine opt-out would be dropped in silence — the single outcome this endpoint
exists to prevent.

Every response carries `Cache-Control: no-store`, `X-Robots-Tag: noindex,
nofollow` and `Referrer-Policy: no-referrer`.

## What it writes

One RPC, `public.outreach_one_click_unsubscribe`, added by
`supabase/crm/005_unsubscribe.sql`. One transaction:

| Table | Row |
| --- | --- |
| `outreach_suppression` | `email` (lowercased), `channel='email'`, `reason='unsubscribe'`, `source='one-click-YYYY-MM-DD'` (RFC 8058) or `'link-YYYY-MM-DD'` (the button). Dates are Philadelphia time |
| `outreach_events` | `prospect_id`, `event='unsubscribed'`, `occurred_at=now()`, `detail = {via: 'rfc8058'\|'link', source, user_agent, endpoint}` |
| `outreach_prospects` | `status='suppressed'`, `updated_at=now()` |

The event row and the status change happen **if and only if** the suppression
insert actually inserted — the insert's own `ROW_COUNT`, not a prior `SELECT`.
A second press writes nothing and still answers `200`. That is the acceptance
test on #440: *a test one-click unsubscribe writes exactly one event and one
suppression row.*

**No vocabulary is widened.** `'unsubscribed'` is already in
`outreach_events_event_check` (added by Catering-Manager
`outreach/migrations/005_bounce_reader.sql` for #407, carried forward by
`crm/001` and `crm/003`). `'suppressed'` is already in
`outreach_prospects_status_check` (`crm/003`). `reason='unsubscribe'` and
`channel='email'` are what `outreach/bounce_reader.py` writes today. This
migration adds a function and nothing else.

`ON CONFLICT (email) WHERE email IS NOT NULL` repeats the predicate because
`outreach_suppression_email_uniq` is a partial index. Omitting the predicate
raises *"there is no unique or exclusion constraint matching the ON CONFLICT
specification"* on every row — the error that made `bounce_reader.py` a silent
no-op from the day it shipped. supabase-js cannot express a predicated conflict
target, which is the second reason the write lives in SQL rather than in three
client calls.

## Human steps before the sender ships headers

In this order. Step 3 must not happen before steps 1 and 2, or every one-click
press in the wild answers `503`.

1. **Generate a secret** and set `UNSUBSCRIBE_SECRET` on the Vercel project
   (Project Settings, Environment Variables, all environments), then redeploy.
   `openssl rand -hex 32` is fine. It is a signing key, not a password: never
   commit it, never put it in a ticket.
2. **Set the same value** in `/etc/bj-finance/outreach.env` on the droplet
   (`ssh bj-box`), which is the file the warm lane's units source, and in
   `~/.config/bj-catering/env` on the Mac if the sender is ever run by hand
   from there.
3. **Apply the migration**: run `supabase/crm/005_unsubscribe.sql` once in the
   Supabase SQL editor. Idempotent.
4. **Then** merge the Catering-Manager follow-up that mints tokens and adds the
   two headers, and decide the `OUTREACH_UNSUBSCRIBE_BASE` host above.
5. **Seed test**: send to the seed set and confirm Gmail renders the
   one-click control next to the sender name, then press it and check that
   exactly one `outreach_suppression` row and one `'unsubscribed'`
   `outreach_events` row appeared. That is #440's acceptance.
