// Host-based routing (bj-finance #519, ruled 2026-09-27): one Next.js app,
// two sites.
//
//   time.withers-ventures.com     the staff time clock, schedule and team pages
//   finance.withers-ventures.com  the manager-only finance pages: /payroll, /metrics
//
// The finance pages are real routes (app/payroll, app/metrics), not rewrites,
// so every other host (localhost, Vercel previews) simply serves both sites and
// the pages can be opened at /payroll and /metrics with no domain set up. Only
// the two production hosts are gated. For testing the gate itself locally,
// finance.localhost and time.localhost stand in for them (browsers and curl
// resolve *.localhost to this machine).
//
// Pure: no Next.js imports, so middleware.ts and the unit tests share it.

export type Site = "time" | "finance" | "any";

export type HostRoute =
  | { kind: "next" }
  | { kind: "redirect"; location: string; status: 307 | 308 }
  | { kind: "not_found" };

const PRODUCTION_HOST: Record<Exclude<Site, "any">, string> = {
  time: "time.withers-ventures.com",
  finance: "finance.withers-ventures.com",
};

const LOCAL_SUFFIX = ".localhost";

/** Paths that make up the finance site's own pages. */
const FINANCE_PAGES = ["/payroll", "/metrics"];

/** What the finance host serves besides its pages: sign-in and the APIs the pages call. */
const FINANCE_HOST_ALSO = ["/login", "/auth", "/api/auth", "/api/logout", "/api/payroll", "/_next"];
const FINANCE_HOST_FILES = new Set(["/favicon.ico", "/manifest.webmanifest", "/sw.js"]);

function parseHost(host: string | null): { name: string; port: string } {
  const raw = (host ?? "").trim().toLowerCase();
  const m = raw.match(/^([^:]*)(?::(\d+))?$/);
  const name = (m?.[1] ?? raw).replace(/\.$/, "");
  return { name, port: m?.[2] ?? "" };
}

/** Which site a Host header is for. */
export function siteForHost(host: string | null): Site {
  const { name } = parseHost(host);
  if (name === PRODUCTION_HOST.finance || name === `finance${LOCAL_SUFFIX}`) return "finance";
  if (name === PRODUCTION_HOST.time || name === `time${LOCAL_SUFFIX}`) return "time";
  return "any";
}

/** The origin of `site`, as seen from a request to `fromHost` (one of the gated hosts). */
function originFor(site: Exclude<Site, "any">, fromHost: string | null): string {
  const { name, port } = parseHost(fromHost);
  if (name.endsWith(LOCAL_SUFFIX)) return `http://${site}${LOCAL_SUFFIX}${port ? `:${port}` : ""}`;
  return `https://${PRODUCTION_HOST[site]}`;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Where the retired /finance?tab= page's tabs now live. */
function financeTabPath(search: string): string {
  return new URLSearchParams(search).get("tab") === "metrics" ? "/metrics" : "/payroll";
}

/**
 * Decide what to do with a request before auth runs.
 *
 * On the finance host a staff page is redirected to the time host rather than
 * refused, so a link like the payroll page's "open in schedule" still works;
 * a staff API is a 404, since redirecting a fetch to another origin helps no one.
 * /finance is a permanent redirect on the time host only: a permanent redirect
 * cached by a browser on localhost or a preview would outlive the test.
 */
export function routeForHost(host: string | null, pathname: string, search: string): HostRoute {
  const site = siteForHost(host);
  const isOldFinance = under(pathname, "/finance");

  if (site === "any") {
    if (isOldFinance) return { kind: "redirect", location: financeTabPath(search), status: 307 };
    return { kind: "next" };
  }

  if (site === "time") {
    if (isOldFinance)
      return { kind: "redirect", location: `${originFor("finance", host)}${financeTabPath(search)}`, status: 308 };
    if (FINANCE_PAGES.some((p) => under(pathname, p)))
      return { kind: "redirect", location: `${originFor("finance", host)}${pathname}${search}`, status: 307 };
    return { kind: "next" };
  }

  // site === "finance"
  if (pathname === "/") return { kind: "redirect", location: "/payroll", status: 307 };
  if (isOldFinance) return { kind: "redirect", location: financeTabPath(search), status: 308 };
  if (FINANCE_PAGES.some((p) => under(pathname, p))) return { kind: "next" };
  if (FINANCE_HOST_ALSO.some((p) => under(pathname, p))) return { kind: "next" };
  if (FINANCE_HOST_FILES.has(pathname)) return { kind: "next" };
  if (under(pathname, "/api")) return { kind: "not_found" };
  return { kind: "redirect", location: `${originFor("time", host)}${pathname}${search}`, status: 307 };
}

/** The finance header's link back to the time clock: absolute only when it is another host. */
export function timeHomeHref(host: string | null): string {
  return siteForHost(host) === "finance" ? `${originFor("time", host)}/` : "/";
}
