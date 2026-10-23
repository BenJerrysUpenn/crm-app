// All display dates render in America/New_York (Eastern). The DB stores
// ISO UTC strings (e.g. "2026-06-02T21:47:42") for timestamps and plain
// YYYY-MM-DD for calendar dates. We treat YYYY-MM-DD as a calendar day
// in Eastern, not as midnight UTC, so "event tomorrow" math is correct
// regardless of when the user's browser local clock is.
//
// Many of those UTC timestamps carry no Z or offset, and `new Date()` reads
// such a string as the browser's local time (4 hours late in an Eastern
// browser). Read a column that holds them with parseNaiveUtc /
// fmtNaiveUtcDateTime, never a bare `new Date()`. Confirmed naive UTC:
// deals.last_outbound_at, created_at and updated_at (Catering-Manager
// db.now_iso(), the CRM's nowIso() in lib/callDesk/dealForm.ts; the CRM's own
// updated_at writes add a Z), thread_messages.sent_at (the Date header,
// normalised to UTC) and call_logs.called_at (lib/callLog.ts).

const TZ = "America/New_York";

const DATE_TIME_PARTS: Intl.DateTimeFormatOptions = {
  timeZone: TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

// A date and a time with no Z and no offset: "2026-10-22T19:17:14", also with
// a space for the T, without seconds, or with a fraction of any length.
const NAIVE_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

// The instant a stored timestamp names, reading a naive date-time as UTC.
// A string with a Z or an offset, a bare date, or anything else is parsed by
// `new Date()` exactly as before. Null for nothing or an unparseable string.
export function parseNaiveUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = NAIVE_DATE_TIME.exec(value.trim());
  const d = m
    ? new Date(
        `${m[1]}T${m[2]}:${m[3] ?? "00"}.${(m[4] ?? "").padEnd(3, "0").slice(0, 3)}Z`,
      )
    : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "Oct 22, 2026, 3:17 PM" for a timestamp column whose naive values are UTC.
// Empty for nothing; an unparseable string comes back as it was.
export function fmtNaiveUtcDateTime(value: string | null): string {
  if (!value) return "";
  const d = parseNaiveUtc(value);
  return d ? d.toLocaleString("en-US", DATE_TIME_PARTS) : value;
}

// Eastern wall-clock parts of an instant. h23 keeps midnight at "00".
const WALL_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function easternParts(instant: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const p of WALL_CLOCK.formatToParts(instant)) parts[p.type] = p.value;
  return parts;
}

// Minutes Eastern time is ahead of UTC at an instant: -240 in EDT, -300 in EST.
function easternOffsetMinutes(ms: number): number {
  const p = easternParts(new Date(ms));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

// "2026-10-22T15:11": an instant as Eastern wall-clock time, the value an
// <input type="datetime-local"> holds when its time is Eastern.
export function easternInputValue(instant: Date): string {
  const p = easternParts(instant);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const WALL_CLOCK_INPUT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

// The instant an Eastern wall-clock time names, whatever the machine's zone.
// A time the spring-forward skips (2:30 AM) reads as the clock moved on
// (3:30 AM EDT); the hour the fall-back repeats reads as its first, EDT pass.
// Null for anything that is not a real "YYYY-MM-DDTHH:MM[:SS]".
export function parseEasternInput(value: string): Date | null {
  const m = WALL_CLOCK_INPUT.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi ||
    check.getUTCSeconds() !== s
  )
    return null;
  // The offsets in force half a day either side cover any DST change.
  const before = easternOffsetMinutes(wall - 12 * 3600_000);
  const after = easternOffsetMinutes(wall + 12 * 3600_000);
  const fits = [before, after]
    .map((off) => wall - off * 60_000)
    .filter((ms) => easternOffsetMinutes(ms) * 60_000 === wall - ms);
  return new Date(fits.length ? Math.min(...fits) : wall - before * 60_000);
}

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

// "Jun 2, 2026, 5:47 PM" style for a timestamp. A naive value is read as the
// browser's local time: for a naive-UTC column use fmtNaiveUtcDateTime.
export function fmtEasternDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", DATE_TIME_PARTS);
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
  const days = calendarDaysBetween(easternTodayYmd(now), eventDate);
  return Number.isNaN(days) ? null : days;
}

// Whole calendar days from one YYYY-MM-DD to another. Negative if `to` is
// earlier; NaN when either is not a real date.
export function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  // UTC math on calendar dates is safe because both are anchored YMD.
  const from = Date.parse(fromYmd + "T00:00:00Z");
  const to = Date.parse(toYmd + "T00:00:00Z");
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}
