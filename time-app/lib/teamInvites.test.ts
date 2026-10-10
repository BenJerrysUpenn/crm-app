// Inviting people from the Team page, driven through the real route handlers:
// POST /api/profiles (add a team member) and POST /api/profiles/:id/invite
// (resend a sign-in link). bj-finance #468: a name is required and is never an
// email address, and an email sitting where a name should be (a pre-migration_21
// row) never reaches the invite: not in the greeting, not as "<name> added you",
// not in the new user's metadata.
//
// Stand-in Supabase: lib/testing/fakeSupabase.ts. The two auth-admin calls an
// invite makes (look up the login email, generate the link) and Resend are
// answered here, at the network boundary, and record what was sent.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { SUPABASE_URL, loadAppModule, startFakeSupabase, type FakeSupabase } from "./testing/fakeSupabase.ts";

type Handler = (request: Request, ctx?: { params: { id: string } }) => Promise<Response>;
const addRoute = await loadAppModule<{ POST: Handler }>("app/api/profiles/route.ts");
const resendRoute = await loadAppModule<{ POST: Handler }>("app/api/profiles/[id]/invite/route.ts");

const BOSS = "00000000-0000-0000-0000-00000000000a";
const SAM = "00000000-0000-0000-0000-00000000000b";
const OLD = "00000000-0000-0000-0000-00000000000c"; // pre-migration_21: email as name
const LOGIN_EMAIL: Record<string, string> = {
  [SAM]: "sam.lee@example.test",
  [OLD]: "staff2@example.com",
};

let db: FakeSupabase;
// What left the app: the metadata of each generated link, and each email.
let linkRequests: { email: string; data?: Record<string, unknown> }[];
let emails: { to: string; subject: string; text: string }[];

function boundary(fakeFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://api.resend.com") {
      emails.push(await request.json());
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    }
    if (url.origin === new URL(SUPABASE_URL).origin && url.pathname === "/auth/v1/admin/generate_link") {
      const body = (await request.json()) as { email: string; data?: Record<string, unknown> };
      linkRequests.push({ email: body.email, data: body.data });
      const id = Object.keys(LOGIN_EMAIL).find((k) => LOGIN_EMAIL[k] === body.email) ?? "new-user-id";
      return new Response(JSON.stringify({ id, email: body.email, hashed_token: "tok123" }), { status: 200 });
    }
    const userLookup = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
    if (userLookup && LOGIN_EMAIL[userLookup[1]]) {
      return new Response(JSON.stringify({ id: userLookup[1], email: LOGIN_EMAIL[userLookup[1]] }), { status: 200 });
    }
    return fakeFetch(input, init);
  }) as typeof fetch;
}

function setUp(bossName: string) {
  db = startFakeSupabase({
    profiles: [
      { id: BOSS, role: "manager", active: true, full_name: bossName },
      { id: SAM, role: "employee", active: true, full_name: "Sam Lee" },
      { id: OLD, role: "employee", active: false, full_name: "staff2@example.com" },
    ],
  });
  globalThis.fetch = boundary(globalThis.fetch);
  db.signIn(BOSS);
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://time.test";
  linkRequests = [];
  emails = [];
  setUp("Alex Boss");
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

function add(body: unknown): Promise<Response> {
  return addRoute.POST(
    new Request("https://time.test/api/profiles", { method: "POST", body: JSON.stringify(body) }),
  );
}

function resend(id: string): Promise<Response> {
  return resendRoute.POST(new Request(`https://time.test/api/profiles/${id}/invite`, { method: "POST" }), {
    params: { id },
  });
}

// ---- adding someone: the name is required and not an email ------------------

test("a manager can't add someone with an email as their name, and no invite goes out", async () => {
  const res = await add({ email: "new.person@example.test", full_name: "new.person@example.test" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Enter the person's name, not their email address.");
  assert.equal(linkRequests.length, 0);
  assert.equal(emails.length, 0);
  assert.equal(db.rows("profiles").length, 3);
});

test("a manager can't add someone without a name, and no invite goes out", async () => {
  for (const blank of [undefined, "", "   "]) {
    const res = await add({ email: "new.person@example.test", full_name: blank });
    assert.equal(res.status, 400, `full_name ${JSON.stringify(blank)}`);
    assert.equal((await res.json()).error, "Full name is required.");
  }
  assert.equal(linkRequests.length, 0);
  assert.equal(emails.length, 0);
});

test("a manager can't add someone with a name over 100 characters, and no invite goes out", async () => {
  const res = await add({ email: "new.person@example.test", full_name: "x".repeat(101) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Full name must be 100 characters or fewer.");
  assert.equal(emails.length, 0);
});

// ---- resending an invite: an email-as-name never reaches the invite ---------

test("a resent invite greets a named person by first name and carries their name", async () => {
  const res = await resend(SAM);
  assert.equal(res.status, 200);
  assert.deepEqual(linkRequests[0].data, { full_name: "Sam Lee" });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "sam.lee@example.test");
  assert.match(emails[0].text, /^Hi Sam,\n/);
  assert.match(emails[0].text, /\nAlex Boss added you to Withers Time,/);
});

test("a resent invite to someone whose name is still their email says plain Hi and stores no name", async () => {
  const res = await resend(OLD);
  assert.equal(res.status, 200);
  assert.equal(linkRequests[0].email, "staff2@example.com");
  assert.equal(linkRequests[0].data, undefined, "no full_name metadata from an email-like name");
  assert.equal(emails.length, 1);
  assert.match(emails[0].text, /^Hi,\n/);
  assert.doesNotMatch(emails[0].text, /Hi staff2/);
});

test("a manager whose own name is still their email is not named in the invite", async () => {
  setUp("boss@example.test");
  const res = await resend(SAM);
  assert.equal(res.status, 200);
  assert.match(emails[0].text, /\nYou've been added to Withers Time,/);
  assert.doesNotMatch(emails[0].text, /boss@example\.test/);
});
