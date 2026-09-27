// The two HTML pages a person sees on the one-click unsubscribe endpoint
// (app/api/unsubscribe/[token]/route.ts, bj-finance #440). Kept here so the
// email-campaigns "Recipient pages" preview renders exactly the markup the
// endpoint serves, with no second copy to drift. Static: no token, no
// address and nothing personal is interpolated.

/** GET: the one-button page. The form posts to the page's own URL. */
export const UNSUBSCRIBE_CONFIRM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unsubscribe</title>
<style>
  body { margin: 0; padding: 48px 20px; background: #0f172a; color: #e2e8f0;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.5rem; color: #94a3b8; }
  button { font: inherit; font-weight: 600; cursor: pointer; border: 0;
           border-radius: 0.5rem; padding: 0.75rem 1.5rem;
           background: #e2e8f0; color: #0f172a; }
</style>
</head>
<body>
<main>
<h1>Unsubscribe</h1>
<p>Press the button and we will stop emailing this address. Nothing is sent
until you do.</p>
<form method="post">
<input type="hidden" name="via" value="link">
<button type="submit">Unsubscribe</button>
</form>
</main>
</body>
</html>
`;

/** POST via=link: the confirmation after the button is pressed. */
export const UNSUBSCRIBED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unsubscribed</title>
<style>
  body { margin: 0; padding: 48px 20px; background: #0f172a; color: #e2e8f0;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0; color: #94a3b8; }
</style>
</head>
<body>
<main>
<h1>Unsubscribed</h1>
<p>You are off the list. We will not email this address again.</p>
</main>
</body>
</html>
`;
