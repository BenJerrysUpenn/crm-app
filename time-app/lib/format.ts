const TZ = "America/New_York";

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

// Hours between two ISO timestamps, rounded to 2 dp.
export function hoursBetween(a: string, b: string | null): number {
  if (!b) return 0;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.round((ms / 3600000) * 100) / 100);
}

// yyyy-mm-dd for a date in the business timezone.
export function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}
