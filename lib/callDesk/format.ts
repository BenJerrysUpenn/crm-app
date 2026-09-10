// Formatting helpers for the call desk (bj-finance #409).
//
// Everything renders in America/New_York on a 12-hour clock, matching
// lib/dateFormat.ts (which the rest of the CRM uses). The call desk needs
// two things that file doesn't have: relative labels for recent timestamps
// ("2h ago", "yesterday") and phone helpers for the tel: link.

const TZ = "America/New_York";

/** "Sep 9, 2026, 2:03 PM" — the absolute stamp shown under a relative one. */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** "2:03 PM" — used for the "updated HH:MM" freshness stamp. */
export function fmtClock(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** YYYY-MM-DD in Eastern, for calendar-day comparisons like "yesterday". */
function easternYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function daysApartEastern(a: Date, b: Date): number {
  const ta = Date.parse(easternYmd(a) + "T00:00:00Z");
  const tb = Date.parse(easternYmd(b) + "T00:00:00Z");
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Relative label for a timestamp: "just now", "12m ago", "2h ago",
 * "yesterday", "3d ago". Past 7 days it falls back to an absolute date
 * ("Aug 14"), because "38d ago" tells the caller nothing useful.
 */
export function fmtRelative(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);

  const diffMs = now.getTime() - d.getTime();
  // Future timestamps (clock skew) read as "just now" rather than "-3m ago".
  if (diffMs < 60_000) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24 && daysApartEastern(d, now) === 0) return `${hours}h ago`;

  const days = daysApartEastern(d, now);
  if (days === 1) return "yesterday";
  if (days > 1 && days < 7) return `${days}d ago`;
  if (days === 0) return `${hours}h ago`;

  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  });
}

const CONTACT_TYPE_LABEL: Record<string, string> = {
  call: "Call",
  reply: "Reply",
  email: "Email",
};

/** "Call" / "Reply" / "Email" — the contact type on its own, for filter chips. */
export function contactTypeLabel(type: string | null | undefined): string {
  if (!type) return "";
  return CONTACT_TYPE_LABEL[type] ?? type;
}

/** "Email · 2h ago" for the queue row's last-contact line. */
export function fmtLastContact(
  type: string | null | undefined,
  at: string | null | undefined,
  now: Date = new Date(),
): string {
  const label = type ? contactTypeLabel(type) : null;
  const rel = fmtRelative(at, now);
  if (label && rel) return `${label} · ${rel}`;
  if (label) return label;
  if (rel) return rel;
  return "No contact yet";
}

/**
 * tel: URL for a stored phone. Phones arrive formatted — "(215) 665-5323" —
 * so strip everything but digits, a leading +, and the pause chars iOS
 * understands. Same rule as DealDetailDrawer's telHref.
 */
export function telHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9+,;]/g, "");
  return cleaned ? `tel:${cleaned}` : null;
}

/** Digits only, for the search box to match "2156655323" against "(215) …". */
export function digitsOnly(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/** "$1,240" — lifetime value, whole dollars. Null/0-safe. */
export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** "4m 12s" for a stored duration_seconds. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (!m) return `${s}s`;
  return s ? `${m}m ${s}s` : `${m}m`;
}
