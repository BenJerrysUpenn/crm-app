// Unit tests for host-based routing: which site a request is for, and where a
// request for the other site's pages goes (bj-finance #519, ruled 2026-09-27:
// payroll lives at finance.withers-ventures.com, not time.withers-ventures.com/finance).
//
//   npm test        (node --test — Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { routeForHost, siteForHost, timeHomeHref } from "./hosts.ts";

const FIN = "finance.withers-ventures.com";
const TIME = "time.withers-ventures.com";

test("siteForHost: the two production hosts, their .localhost stand-ins, everything else", () => {
  assert.equal(siteForHost(FIN), "finance");
  assert.equal(siteForHost("FINANCE.withers-ventures.com"), "finance");
  assert.equal(siteForHost("finance.withers-ventures.com."), "finance");
  assert.equal(siteForHost("finance.localhost:3000"), "finance");
  assert.equal(siteForHost(TIME), "time");
  assert.equal(siteForHost("time.localhost:3000"), "time");
  assert.equal(siteForHost("localhost:3000"), "any");
  assert.equal(siteForHost("127.0.0.1:3000"), "any");
  assert.equal(siteForHost("time-git-feature-x-alina-withers-projects.vercel.app"), "any");
  assert.equal(siteForHost("finance.withers-ventures.com.evil.example"), "any");
  assert.equal(siteForHost(null), "any");
});

// ---- time.withers-ventures.com ------------------------------------------------

test("time host: /finance is a permanent redirect to the finance host's /payroll", () => {
  assert.deepEqual(routeForHost(TIME, "/finance", ""), {
    kind: "redirect",
    location: "https://finance.withers-ventures.com/payroll",
    status: 308,
  });
  assert.deepEqual(routeForHost(TIME, "/finance/", ""), {
    kind: "redirect",
    location: "https://finance.withers-ventures.com/payroll",
    status: 308,
  });
});

test("time host: an old /finance?tab=metrics bookmark lands on /metrics", () => {
  assert.deepEqual(routeForHost(TIME, "/finance", "?tab=metrics"), {
    kind: "redirect",
    location: "https://finance.withers-ventures.com/metrics",
    status: 308,
  });
});

test("time host: the finance pages themselves are sent to the finance host, query kept", () => {
  assert.deepEqual(routeForHost(TIME, "/payroll", "?x=1"), {
    kind: "redirect",
    location: "https://finance.withers-ventures.com/payroll?x=1",
    status: 307,
  });
  assert.deepEqual(routeForHost(TIME, "/metrics", ""), {
    kind: "redirect",
    location: "https://finance.withers-ventures.com/metrics",
    status: 307,
  });
});

test("time host: staff pages and every API, including /api/payroll, are served as before", () => {
  // /api/payroll/* stays on the time host too: the schedule's solo-close
  // dropdowns read and write through it.
  for (const path of ["/", "/schedule", "/team", "/login", "/auth/confirm", "/api/shifts", "/api/payroll/verify", "/payrollish"]) {
    assert.deepEqual(routeForHost(TIME, path, ""), { kind: "next" }, path);
  }
});

// ---- finance.withers-ventures.com ---------------------------------------------

test("finance host: / goes to /payroll", () => {
  assert.deepEqual(routeForHost(FIN, "/", ""), { kind: "redirect", location: "/payroll", status: 307 });
});

test("finance host: finance pages, sign-in and the APIs they use are served", () => {
  for (const path of [
    "/payroll",
    "/metrics",
    "/login",
    "/auth/confirm",
    "/auth/callback",
    "/auth/forgot",
    "/auth/set-password",
    "/api/auth/forgot",
    "/api/logout",
    "/api/payroll/verify",
    "/api/payroll/rulings",
    "/api/payroll/submit",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
    "/manifest.webmanifest",
    "/sw.js",
  ]) {
    assert.deepEqual(routeForHost(FIN, path, ""), { kind: "next" }, path);
  }
});

test("finance host: a staff page is sent to the time host, path and query kept", () => {
  assert.deepEqual(routeForHost(FIN, "/schedule", "?week=2026-09-21"), {
    kind: "redirect",
    location: "https://time.withers-ventures.com/schedule?week=2026-09-21",
    status: 307,
  });
  for (const path of ["/team", "/timesheets", "/attendance", "/availability", "/account", "/payrollish", "/metricsboard"]) {
    const r = routeForHost(FIN, path, "");
    assert.equal(r.kind, "redirect", path);
    assert.equal(r.kind === "redirect" && r.location, `https://time.withers-ventures.com${path}`, path);
  }
});

test("finance host: staff APIs are not served at all", () => {
  for (const path of ["/api/shifts", "/api/clock", "/api/profiles", "/api/cron/missed-clockins", "/api/payrollx", "/api/authx"]) {
    assert.deepEqual(routeForHost(FIN, path, ""), { kind: "not_found" }, path);
  }
});

test("finance host: the old /finance path redirects to /payroll on the same host", () => {
  assert.deepEqual(routeForHost(FIN, "/finance", ""), { kind: "redirect", location: "/payroll", status: 308 });
  assert.deepEqual(routeForHost(FIN, "/finance", "?tab=metrics"), { kind: "redirect", location: "/metrics", status: 308 });
});

// ---- localhost and Vercel previews ---------------------------------------------

test("any other host serves both sites; /finance goes to /payroll on the same host", () => {
  const preview = "time-git-feature-519-alina-withers-projects.vercel.app";
  for (const host of ["localhost:3000", preview]) {
    for (const path of ["/", "/schedule", "/payroll", "/metrics", "/api/payroll/verify", "/api/shifts"]) {
      assert.deepEqual(routeForHost(host, path, ""), { kind: "next" }, `${host}${path}`);
    }
    // Temporary here: a cached permanent redirect on localhost outlives the test.
    assert.deepEqual(routeForHost(host, "/finance", ""), { kind: "redirect", location: "/payroll", status: 307 });
    assert.deepEqual(routeForHost(host, "/finance", "?tab=metrics"), { kind: "redirect", location: "/metrics", status: 307 });
  }
});

test(".localhost stand-ins redirect to each other over http, port kept", () => {
  assert.deepEqual(routeForHost("time.localhost:3000", "/finance", ""), {
    kind: "redirect",
    location: "http://finance.localhost:3000/payroll",
    status: 308,
  });
  assert.deepEqual(routeForHost("finance.localhost:3000", "/schedule", ""), {
    kind: "redirect",
    location: "http://time.localhost:3000/schedule",
    status: 307,
  });
});

// ---- the finance header's link back to Withers Time --------------------------

test("timeHomeHref: absolute on the finance host, relative everywhere else", () => {
  assert.equal(timeHomeHref(FIN), "https://time.withers-ventures.com/");
  assert.equal(timeHomeHref("finance.localhost:3000"), "http://time.localhost:3000/");
  assert.equal(timeHomeHref("localhost:3000"), "/");
  assert.equal(timeHomeHref(TIME), "/");
});
