// Which requests skip the CRM login gate (middleware.ts).
//
// crm-app #35: the scheduler that hits GET /api/cron/catering-shifts has no
// session, so the gate 307'd it to /login and the sweep never ran. The fix
// exempts that one path and nothing else. These tests pin both halves:
//
//   * the cron path reaches its route without the gate (and without the
//     Supabase session round trip);
//   * every neighbour of it still meets the gate, above all
//     POST /api/deals/:id/booked-shifts, which writes shifts with the service
//     role on a signed-in user's behalf;
//   * the one earlier exemption (one-click unsubscribe) is unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// The real gate talks to Supabase. Stand in for it with what it does to an
// anonymous request: a 307 to /login. The test only asks whether the gate was
// consulted at all.
const gate = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: async (request: NextRequest) => {
    gate.calls.push(request.nextUrl.pathname);
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  },
}));

const { middleware } = await import("@/middleware");

function get(path: string, host = "crm.withers-ventures.com") {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

beforeEach(() => {
  gate.calls = [];
});

describe("the catering-shift cron", () => {
  it("passes through without the login gate", async () => {
    const response = await middleware(get("/api/cron/catering-shifts"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(gate.calls).toEqual([]);
  });

  it("passes through with the secret in the query string, as a scheduler sends it", async () => {
    const response = await middleware(get("/api/cron/catering-shifts?secret=anything"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(gate.calls).toEqual([]);
  });
});

describe("everything else stays behind the login", () => {
  it.each([
    ["the booked-shifts route", "/api/deals/25401/booked-shifts"],
    ["a path under the cron path", "/api/cron/catering-shifts/extra"],
    ["a path that only starts with the cron path", "/api/cron/catering-shifts-backfill"],
    ["the cron directory itself", "/api/cron"],
    ["another cron name", "/api/cron/missed-clockins"],
    ["the board", "/"],
  ])("gates %s", async (_label, path) => {
    const response = await middleware(get(path));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(gate.calls).toEqual([path]);
  });
});

describe("the earlier exemption", () => {
  it("still lets one-click unsubscribe through", async () => {
    const response = await middleware(get("/api/unsubscribe/some-token"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(gate.calls).toEqual([]);
  });
});

describe("the offers opt-in page (bj-finance #425)", () => {
  // The person pressing "Yes, send me offers" is not a CRM user; the signed
  // token is the authorisation, so the page must not bounce them to /login.
  it.each([
    ["the landing page", "GET", "/offers/some-token"],
    ["the button's post", "POST", "/offers/some-token"],
  ])("lets %s through without the login gate", async (_label, method, path) => {
    const response = await middleware(
      new NextRequest(`https://crm.withers-ventures.com${path}`, {
        method,
        headers: { host: "crm.withers-ventures.com" },
      }),
    );

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(gate.calls).toEqual([]);
  });

  it.each([
    ["the bare /offers path", "/offers"],
    ["a path that only starts with offers", "/offers-admin"],
  ])("still gates %s", async (_label, path) => {
    const response = await middleware(get(path));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(gate.calls).toEqual([path]);
  });
});

describe("the personal-finance host (bj-finance #223)", () => {
  const PF = "personal.withers-ventures.com";

  it.each(["/api/pf/overrides", "/api/pf"])(
    "lets the pf API %s through to the login gate, not to /safe",
    async (path) => {
      const response = await middleware(get(path, PF));
      expect(gate.calls).toEqual([path]);
      expect(response.headers.get("location")).not.toContain("/safe");
    },
  );

  it.each([
    ["a CRM API", "/api/deals"],
    ["a path that only starts with the same letters", "/api/pfx"],
  ])("still sends %s on that host to /safe", async (_what, path) => {
    const response = await middleware(get(path, PF));
    expect(response.headers.get("location")).toBe(`https://${PF}/safe`);
    expect(gate.calls).toEqual([]);
  });

  it("sends the change-category API on the CRM host to the personal host", async () => {
    const response = await middleware(get("/api/pf/overrides"));
    expect(response.headers.get("location")).toBe(`https://${PF}/api/pf/overrides`);
    expect(gate.calls).toEqual([]);
  });
});

describe("the open and click tracking endpoints", () => {
  // The pixel is fetched by a mail client or an image proxy and the click by
  // whoever opened the mail; neither is a CRM user, and the signed token is
  // the authorisation. The gate would answer the pixel with a /login page and
  // turn every tracked link into a login prompt.
  it.each([
    ["the open pixel", "/api/t/o/some-token"],
    ["a tracked link", "/api/t/c/some-token?u=https%3A%2F%2Fexample.com%2F"],
  ])("lets %s through without the login gate", async (_label, path) => {
    const response = await middleware(get(path));

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(gate.calls).toEqual([]);
  });

  it.each([
    ["the bare /api/t path", "/api/t"],
    ["a path that only starts with /api/t", "/api/tracking-admin"],
  ])("still gates %s", async (_label, path) => {
    const response = await middleware(get(path));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    expect(gate.calls).toEqual([path]);
  });
});
