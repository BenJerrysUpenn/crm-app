# Do-not-call policy — Withers Ventures LLC (Ben & Jerry's Philadelphia)

**Adopted 2026-09-10. Owner: Alina Withers. Review annually and whenever the
law changes.** Kept on file and produced on demand, which is itself the point:
47 C.F.R. §64.1200(d)(1) makes having a written policy a condition of calling
anyone at all, with no relationship exemption, and a copy must be given to any
person who asks for one. It is also the affirmative defence under 47 U.S.C.
§227(c)(5) and the safe harbour under 73 P.S. §2245(a)(2) and 16 C.F.R.
§310.4(b)(3).

This is our own operating rule, not legal advice. The items marked **needs
counsel** are open.

## 1. Who may make calls

Only a trained employee, dialling by hand, from the CRM call desk
(`/call-desk`). No autodialer, no pre-recorded or artificial voice, no text
messages. Every call is logged against the prospect at the moment it is
placed and must be given an outcome the same day.

Training is a condition of dialling. The record is at the end of this page.

## 2. Who may be called

Only someone the desk shows with **Call now** enabled. The rule the desk
applies, in plain words:

| We may call | Until |
| --- | --- |
| Someone who paid us for an event | 12 months after that event's date |
| Someone who enquired or replied to us | 90 days after that reply |
| Anyone else, or anyone past those dates | only after a registry scrub says the number is not listed, and only for 31 days after that scrub |

Two things this table does **not** say, both deliberate:

- **Our own emails create no permission.** The clock runs on what the customer
  did — paid, asked, replied — never on what we sent. A prospect the warm
  engine mailed yesterday and who never answered has no window at all.
- **These are the short clocks.** Federal law allows 18 months from a purchase
  and 3 months from an enquiry (47 C.F.R. §64.1200(f)(5)); the FTC's rule says
  540 and 90 days. Pennsylvania allows only 12 months (73 P.S. §2245) and PA is
  where we call from, so 12 months and 90 days is what we use everywhere.

**Never call**, whatever the table says: a number on our internal do-not-call
list, a number on the national registry, a number on the Pennsylvania state
list. Those three are permanent and beat every window.

## 3. When calls may be made

**9:00 a.m. to 7:00 p.m. Eastern, Monday to Saturday. Never on a Sunday and
never on a US federal legal holiday.**

That window is PA Act 47 of 2026, which takes effect 2026-10-18. We adopted it
early, in September, because it is the tightest of the Pennsylvania, New Jersey
and federal rules and because habits are easier to set than to change. The desk
enforces it: outside those hours Call now is greyed out on every row.

The eleven federal holidays are New Year's Day, Martin Luther King Jr. Day,
Washington's Birthday, Memorial Day, Juneteenth, Independence Day, Labor Day,
Columbus Day, Veterans Day, Thanksgiving and Christmas (5 U.S.C. §6103). When
one falls at a weekend, both the day itself and its observed day are closed.

## 4. What to say first

Before any pitch, before anything else, say all of this:

> Hi, this is **\<your first name\>** from **Ben & Jerry's Philadelphia**,
> calling about **ice cream catering**. You booked with us on \<date\> /
> You enquired with us on \<date\>.

The desk prints this line on each row under **Say first**, with the right date
already in it. That covers 47 C.F.R. §64.1200(d)(4), 16 C.F.R. §310.4(d),
73 P.S. §2245(a)(5) and §2245.2(j), and New Jersey's requirement that it land
inside the first 30 seconds.

If they ask how we got their number, the honest answer is that they enquired
with us or booked with us, and the date is on the screen. If they ask for a
number to call back, it is **609-369-6808**.

## 5. When someone says stop

**Any wording, on any channel, means stop.** "Take me off your list", "don't
call here again", "I'm not interested, stop calling", an email saying the same
thing, a voicemail saying the same thing. It does not have to be phrased as a
formal request and it does not have to be said to the person who called.

What to do, in order:

1. **Say it back to them.** "Of course — I'll take you off our list right now."
2. **Stop.** Do not rebut, do not offer a discount, do not ask why. Requiring
   someone to listen to a pitch before their request is accepted is itself a
   violation, 16 C.F.R. §310.4(b)(1)(ii).
3. **Record it the same day**, in the call desk: outcome **Do not call**. That
   writes their phone number and their email address to the permanent
   suppression list, stops the marketing email too, and takes them off the
   queue. Federal law allows ten business days (FCC 24-24); we do it before the
   end of the shift.

Entries never expire. They are honoured even if the person later books with us
again — a booking creates a relationship, it does not undo a request.

Note the difference from **Not now / lost**, which is the other outcome on the
sheet: that one means no sale this time, takes them off the call queue, and
deliberately leaves them on the marketing email list. It is not a stop request
and must never be used as one.

## 6. Registry scrubs

Out-of-window numbers may only be dialled after a scrub against **both** the
national registry (telemarketing.donotcall.gov) and the **Pennsylvania state
list**, and only for **31 days** after it (16 C.F.R. §310.4(b)(3)(iv)).

Loading a scrub: `/call-desk/dnc-import`, paste the file, pick the list. A
matching number is flagged with the registry it appeared on and can never be
dialled from the desk again. A non-matching number is marked "scrubbed clear"
only when the file is complete for our area codes — a partial file never clears
anyone, and a number a registry or a customer has already flagged is never
cleared by any import.

**Open — needs the subscriptions.** Neither list is held yet, which is why most
of the queue reads "expired" today.

The desk no longer refuses those rows (bj-finance #424, Alina 2026-09-10). An
out-of-window number is dialled from a **striped green-and-grey** Call now
button instead of a solid green one, and the call is written to
`outreach_events` with `outside_window: true`, so the record shows the cold
call was made knowingly. The obligation in this section is unchanged: a
registry-listed residential number must not be dialled, and a scrub inside 31
days is how you know it is not one. The button now marks that duty rather than
enforcing it, and the flag on the event is what an audit reads.

## 7. Records

| Record | Where | Kept |
| --- | --- | --- |
| Every call, with who placed it, when, and its outcome | `outreach_events`, `event = 'called'` | 5 years |
| Do-not-call requests | `outreach_suppression` (email and phone) | permanent (built to Delaware's 10-year standard, 6 Del. C. §2506A) |
| Registry scrub dates | `outreach_prospects.dnc_status` / `dnc_checked_at` | 5 years |
| This policy and its training records | this file, in the crm-app repository | 5 years after the last call |
| Call recordings (only with spoken consent, Pennsylvania is all-party) | Supabase `call-recordings` bucket | 5 years |

Five years is our own rule and is longer than the FTC's two (16 C.F.R.
§310.5(a)), chosen because the statute of limitations on a TCPA claim runs to
four.

## 8. Still open — needs counsel

- Telemarketer registration in Pennsylvania, New Jersey and Delaware. Each has
  its own requirement and its own exemptions; NJ's Division of Consumer Affairs
  says a seller running its own campaign must register.
- Whether PA Act 47's text and its 2026-10-18 effective date are as reported.
- Whether the purchase clock starts at deposit, final payment or event date.
  The desk currently uses the **event date**, which is the latest of the three
  and therefore the most generous to us — worth a ruling.
- Where the business-to-business line falls for a work number used personally.
  Note that PA's list covers business lines even where the federal rule does
  not (16 C.F.R. §310.6(b)(7)).
- Delaware's 7-business-day cancellation window (6 Del. C. §2506A(b)) against
  our deposit terms.

## 9. Training record

Everyone who dials signs here before their first call. Read sections 2 to 5
aloud with them; they are the whole job.

| Name | Role | Trained by | Date | Signature |
| --- | --- | --- | --- | --- |
| | | | | |
| | | | | |
| | | | | |

---

Research behind this policy: `docs/call-desk-consent-and-calling-rules.md` in
the bj-finance repository (bj-finance #418). Build: bj-finance #420.
