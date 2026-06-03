// All display dates render in America/New_York (Eastern). The DB stores
// ISO UTC strings (e.g. "2026-06-02T21:47:42") for timestamps and plain
// YYYY-MM-DD for calendar dates. We treat YYYY-MM-DD as a calendar day
// in Eastern, not as midnight UTC, so "event tomorrow" math is correct
// regardless of when the user's browser local clock is.

const TZ = "America/New_York";

// "Jun 2, 2026" style for a calendar date.
export function fmtEasternDate(value: string | null): string {
  if (!value) return "";
  // Calendar-date input "YYYY-MM-DD" — anchor to noon Eastern so DST
  // edges don't drop us into the prior day.
  const isCalendar = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(isCalendar ? value + "T12:00:00-05:00" : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// "Jun 2, 2026, 5:47 PM" style for a timestamp.
export function fmtEasternDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// "5:47 PM" style for a time-of-day.
export function fmtEasternTime(value: string | null): string {
  if (!value) return "";
  // Accept either an ISO timestamp or a bare "HH:MM" / "HH:MM:SS" string.
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(value)) {
    // Bare time — treat as Eastern wall-clock for display, no TZ math.
    const [h, m] = value.split(":");
    const hour = parseInt(h, 10);
    const minute = parseInt(m, 10);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return value;
    const tag = hour >= 12 ? "PM" : "AM";
    const display = ((hour + 11) % 12) + 1;
    return `${display}:${String(minute).padStart(2, "0")} ${tag}`;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

// Today's calendar date in Eastern, as YYYY-MM-DD.
export function easternTodayYmd(now: Date = new Date()): string {
  // en-CA locale formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Calendar days from today (Eastern) to the event_date. Negative if past.
// Returns null when the input isn't a parseable YYYY-MM-DD.
export function daysUntilEvent(
  eventDate: string | null,
  now: Date = new Date(),
): number | null {
  if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  const today = easternTodayYmd(now);
  // UTC math on calendar dates is safe because both are anchored YMD.
  const t = Date.parse(today + "T00:00:00Z");
  const e = Date.parse(eventDate + "T00:00:00Z");
  if (Number.isNaN(t) || Number.isNaN(e)) return null;
  return Math.round((e - t) / (24 * 60 * 60 * 1000));
}
