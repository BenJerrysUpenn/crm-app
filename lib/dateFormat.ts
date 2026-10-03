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

// Minutes that Eastern (America/New_York) is offset from UTC at the given
// instant, handling EST/EDT automatically. Negative (e.g. -240 under DST,
// -300 otherwise). The single home for the Eastern wall-clock rule — both the
// catering shift windows and the Funnels "today" counter read it from here so
// the offset is looked up once, in one place.
function nyOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = dtf.formatToParts(at).reduce<Record<string, string>>((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {});
  // `24` shows up at midnight in some runtimes; normalise to 0.
  const hour = p.hour === "24" ? "0" : p.hour;
  const asUTC = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +hour,
    +p.minute,
    +p.second,
  );
  return (asUTC - at.getTime()) / 60000;
}

// Interpret an Eastern wall-clock date+time ("YYYY-MM-DD", "HH:MM") as a real
// instant and return its UTC ISO string, or null when either input is
// unparseable. Two-step: guess the instant as if the wall time were UTC, look
// up Eastern's offset AT THAT GUESS, then correct — so the offset is the one
// in force at the target wall time, not at some other "now". That is what
// keeps it right across a DST boundary.
export function easternWallTimeToUTCISO(
  dateStr: string,
  timeStr: string,
): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const tm = /^(\d{1,2}):(\d{2})/.exec(timeStr.trim());
  if (!dm || !tm) return null;
  const [, y, mo, d] = dm;
  const [, hh, mm] = tm;
  const guess = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
  const offset = nyOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60000).toISOString();
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
