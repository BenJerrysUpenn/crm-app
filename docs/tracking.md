# Open and click tracking

Owners' ruling 2026-10-27: "add it", for the warm and wedding outreach lanes.
This reverses the earlier call in `docs/unsubscribe.md` that left click
tracking off.

## The two halves and who owns them

| Half | Repo | What |
| --- | --- | --- |
| Verifying tokens, logging events, serving the pixel and the redirect | **crm-app** | `app/api/t/o/[token]`, `app/api/t/c/[token]` |
| Minting the URLs into each message | **Catering-Manager** | `outreach/warm_sender.py` |
| Widening `outreach_events.event` to allow `'opened'` and `'clicked'` | **Catering-Manager** | its outreach migration |

`lib/outreach/trackingToken.ts` is the truth for the contract. If this file and
that one disagree, the code wins and this file gets fixed. Both test suites pin
the same literal vectors (`tests/trackingToken.test.ts` here).

crm-app adds no migration. Until the Catering-Manager migration is applied, every
insert fails the CHECK; the routes log the error and answer normally (the pixel
still renders, the link still redirects).

`supabase/crm/001_call_desk.sql` and `003_call_desk_compliance.sql` each
re-state `outreach_events_event_check` without `'opened'`/`'clicked'`. Re-running
either after the widening would narrow the vocabulary again and silently stop
tracking. Do not re-run them as-is.

## The token contract

Key: `UNSUBSCRIBE_SECRET`, the same key the unsubscribe and offers tokens use.
The MAC inputs keep the purposes apart.

```
email_key = the prospect's stored email, whitespace-trimmed, lowercased
tid       = 16 lowercase hex chars, one per sent message
            (the sender stores it in the 'sequenced' event's detail.tracking_id)

open mac  = hex( HMAC_SHA256( secret, "open:"  + id + ":" + tid + ":" + email_key ) )
click mac = hex( HMAC_SHA256( secret, "click:" + id + ":" + tid + ":" + email_key + ":" + url ) )

token     = base64url( id + "." + tid + "." + mac )     -- unpadded
```

- `id` is `outreach_prospects.id` in decimal, `[1-9][0-9]{0,15}`.
- `tid` must match `^[0-9a-f]{16}$`.
- `mac` is 64 lowercase hex characters.
- `url` in the click MAC is the exact destination string, byte for byte, as it
  arrives in `u` after URL-decoding. The sender must sign the same string it
  puts in `u`.
- Three dot-separated parts. An unsubscribe or offers token has two, so it does
  not parse here, and a tracking token does not parse there.

URLs:

```
open   <base>/api/t/o/<token>
click  <base>/api/t/c/<token>?u=<encodeURIComponent(url)>
```

`url` must be an absolute `http://` or `https://` URL in printable ASCII (no
spaces or raw non-ASCII; percent-encode them before signing). Anything else is
a 404, however it was signed.

Minting, for `outreach/warm_sender.py`:

```python
import base64, hashlib, hmac

def _tok(prospect_id: int, tid: str, mac: str) -> str:
    return base64.urlsafe_b64encode(f"{prospect_id}.{tid}.{mac}".encode()).rstrip(b"=").decode()

def open_token(secret: bytes, prospect_id: int, tid: str, email: str) -> str:
    key = email.strip().lower()
    mac = hmac.new(secret, f"open:{prospect_id}:{tid}:{key}".encode(), hashlib.sha256).hexdigest()
    return _tok(prospect_id, tid, mac)

def click_token(secret: bytes, prospect_id: int, tid: str, email: str, url: str) -> str:
    key = email.strip().lower()
    mac = hmac.new(secret, f"click:{prospect_id}:{tid}:{key}:{url}".encode(), hashlib.sha256).hexdigest()
    return _tok(prospect_id, tid, mac)
```

### Pinned vectors

secret `test-secret`, prospect 42, tid `0123456789abcdef`, email
` Jane.Doe@Example.com ` (email_key `jane.doe@example.com`):

| | Value |
| --- | --- |
| open mac | `09f926b6d70120ce1e5ddb1ad728a295c1a940b84efd1a7cb2d6be52f71d30fb` |
| open token | `NDIuMDEyMzQ1Njc4OWFiY2RlZi4wOWY5MjZiNmQ3MDEyMGNlMWU1ZGRiMWFkNzI4YTI5NWMxYTk0MGI4NGVmZDFhN2NiMmQ2YmU1MmY3MWQzMGZi` |
| click url | `https://crm.withers-ventures.com/offers/abc` |
| click mac | `59605da8bf51ffc864a3d99260950cccbf23a60909310110998a100938ecf133` |
| click token | `NDIuMDEyMzQ1Njc4OWFiY2RlZi41OTYwNWRhOGJmNTFmZmM4NjRhM2Q5OTI2MDk1MGNjY2JmMjNhNjA5MDkzMTAxMTA5OThhMTAwOTM4ZWNmMTMz` |

## The endpoints

Both are `GET`, `dynamic = "force-dynamic"`, `runtime = "nodejs"`, and read
Supabase through the service-role client in `lib/supabase/admin.ts` (the
fetcher is not a CRM user; the token is the authorisation). `middleware.ts`
returns early for `/api/t/`, before `updateSession`.

Verification, on both: parse the token, look the prospect up by id, recompute
the MAC over the **stored** address (and, for a click, over `u`), compare in
constant time.

### `GET /api/t/o/<token>`: the open pixel

Always `200` with a 43-byte 1x1 transparent GIF: `Content-Type: image/gif`,
`Cache-Control: no-store, no-cache, must-revalidate, private`,
`X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`. That holds
whether or not the token verifies, whether or not `UNSUBSCRIBE_SECRET` is set,
and whether or not the database answers.

A verified token writes one row per fetch:

```
outreach_events (prospect_id, event = 'opened',
                 detail = {tracking_id, source: 'pixel', user_agent})
```

### `GET /api/t/c/<token>?u=<url>`: the click redirect

| Request | Response |
| --- | --- |
| Verified token, valid `u` | one `'clicked'` row, then `302` to `u` (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`) |
| Same, but the insert fails | still `302` to `u`; the error is logged |
| Bad token, bad MAC, unknown prospect, missing/relative/non-http `u`, `u` other than the one signed | `404` `Not found.` (identical body for all), **no redirect** |
| `UNSUBSCRIBE_SECRET` unset | `503` `Tracking is not configured.` |
| Prospect lookup fails | `500` `Link unavailable.`, no redirect (nothing was verified) |

```
outreach_events (prospect_id, event = 'clicked',
                 detail = {tracking_id, url, source: 'redirect', user_agent})
```

It is never an open redirect: the MAC covers `u`, so a genuine token cannot be
re-aimed at another destination, and nothing unverified gets a `Location`.

`user_agent` is truncated to 300 characters. No IP address is stored.

## Reading the numbers

Both counts are inflated, and the user agent is recorded so they can be
filtered:

- **Opens.** Apple Mail Privacy Protection fetches every pixel on delivery,
  whether or not anyone reads the message, and Gmail fetches images through its
  own proxy (`GoogleImageProxy` in the user agent), sometimes on delivery.
  Clients that block images record no open at all. Treat an open as "probably
  delivered to a mailbox that loads images", not "read".
- **Clicks.** Corporate link scanners (Microsoft Defender Safe Links, Mimecast,
  Proofpoint and the like) follow every link in a message before a person sees
  it. Several clicks within seconds of delivery, or on every link in a message,
  are a scanner.
- One row is written per fetch, so re-opens and repeat clicks each count.
  Join on `detail->>'tracking_id'` against the `'sequenced'` row to tie an event
  to the message that carried it.
