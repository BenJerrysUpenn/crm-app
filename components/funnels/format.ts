// Small client-safe formatting helpers for the Funnels tab. Pure, no imports
// from server modules — keeps the client bundle clean.

export function money(n: number | null | undefined): string {
  const v = n ?? 0;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function pctLabel(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n}%`;
}

export function ageLabel(hours: number | null | undefined): string {
  if (hours == null) return "—";
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Relative "3h ago" / "2d ago" from an ISO instant. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** A Gmail thread deep-link, or a search on the address when no thread id. */
export function gmailLink(
  threadId: string | null | undefined,
  email: string | null | undefined,
): string {
  if (threadId) return `https://mail.google.com/mail/u/0/#all/${threadId}`;
  if (email)
    return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(email)}`;
  return "https://mail.google.com/mail/u/0/#all";
}
