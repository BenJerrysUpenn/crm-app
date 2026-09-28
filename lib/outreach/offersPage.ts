// The pages a person sees at /offers/<token> after clicking "Yes, send me
// offers" in a warm email footer (bj-finance #425). Served by
// app/offers/[token]/route.ts and previewed, with a sample address, at
// /email-campaigns/preview/offers-signup — one copy, so the preview cannot
// drift from what is served.
//
// The copy of the two main pages is the owners' prototype v6 copy, VERBATIM
// (crm-app PR #30, approved 2026-09-27). Do not reword it without them: the
// consent statement is what is stored as proof of opt-in, and changing a word
// of it means bumping OFFERS_PAGE_VERSION so every stored row still says which
// wording that person saw.
//
// Brand-plain and styled like the unsubscribe page (lib/outreach/
// unsubscribePage.ts): no framework, no JS, no cookies. The form has no
// action attribute, so it posts to the page's own URL and the token is never
// re-rendered into markup.

/** The exact statement stored as proof of opt-in, with the address and the
 * date and time the button was pressed. */
export const OFFERS_CONSENT_TEXT =
  "Yes, send me offers. I agree to receive one email a month from Ben & Jerry's Philadelphia with its seasonal menu and offers. I can unsubscribe at any time with the link at the bottom of any of these emails.";

/** Which page and wording the person saw. Stored on every consent row. Bump
 * it whenever the confirm page or OFFERS_CONSENT_TEXT changes. */
export const OFFERS_PAGE_VERSION = "offers-optin-2026-09-27";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "Sunday, September 27, 2026 at 7:42 PM ET" */
export function consentStamp(at: Date): string {
  const tz = "America/New_York";
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
  return `${day} at ${time} ET`;
}

const HEAD = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  body { margin: 0; padding: 48px 20px; background: #0f172a; color: #e2e8f0;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  h2 { font-size: 0.95rem; margin: 1.5rem 0 0.25rem; color: #e2e8f0; }
  p { margin: 0 0 1rem; color: #94a3b8; }
  ul { margin: 0 0 1rem; padding-left: 1.1rem; color: #94a3b8; }
  li { margin: 0 0 0.25rem; }
  button { font: inherit; font-weight: 600; cursor: pointer; border: 0;
           border-radius: 0.5rem; padding: 0.75rem 1.5rem;
           background: #e2e8f0; color: #0f172a; }
  blockquote { margin: 0 0 0.5rem; padding: 0.75rem 1rem; border-left: 3px solid #475569;
               background: #1e293b; color: #cbd5e1; font-size: 0.9rem; }
  .small { font-size: 0.85rem; }
  footer { margin-top: 2rem; font-size: 0.8rem; color: #64748b; }
</style>
</head>
<body>
<main>
`;

const TAIL = `<footer>Ben &amp; Jerry's Philadelphia · 218 S 40th St Philadelphia PA 19104</footer>
</main>
</body>
</html>
`;

/** GET: the landing page from the email link. Records nothing. */
export function offersConfirmHtml(email: string): string {
  return `${HEAD("Yes, send me offers")}<h1>One seasonal menu a month?</h1>
<p>Press the button and we will send ${esc(email)} one short email a month with our seasonal menu and offers.
Nothing is signed up until you do.</p>
<form method="post">
<input type="hidden" name="via" value="link">
<button type="submit">Yes, send me offers</button>
</form>
${TAIL}`;
}

/** POST: after the button. The consent statement shown is exactly what is
 * stored, with the address and the date and time. */
export function offersSignedUpHtml(at: Date, email: string): string {
  return `${HEAD("You're on the list")}<h1>You're on the list</h1>
<p>You're on the list: one short seasonal menu with offers a month from Ben &amp; Jerry's Philadelphia.</p>
<h2>What you'll get</h2>
<ul>
<li>One email a month, no more.</li>
<li>What's on the catering menu that season, and any offers running that month.</li>
<li>Sent to ${esc(email)}.</li>
</ul>
<h2>How to leave</h2>
<p>Every email has an Unsubscribe link at the bottom. One click and you're off the list.</p>
<h2>What we keep as proof you asked</h2>
<blockquote>${esc(OFFERS_CONSENT_TEXT)}</blockquote>
<p class="small">Agreed by ${esc(email)} on ${esc(consentStamp(at))}.</p>
${TAIL}`;
}

/** POST, refused: the address is on the suppression list (it unsubscribed,
 * bounced, complained or asked on a call not to be contacted). A button on a
 * page is not enough to undo that, so nothing is written. Not part of the
 * approved prototype copy; kept to two plain sentences. */
export function offersRefusedHtml(): string {
  return `${HEAD("Not added")}<h1>Not added</h1>
<p>This address asked us to stop emailing it, so we have not added it to the list.</p>
<p>If you would like to hear from us again, reply to any of our emails and we will sort it out.</p>
${TAIL}`;
}
