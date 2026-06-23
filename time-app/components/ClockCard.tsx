"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtTime, fmtDateTime, hoursBetween } from "@/lib/format";
import type { TimeEntry, Shift, Location } from "@/lib/types";

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This device has no location support."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

export default function ClockCard({
  openEntry,
  todaysShift,
  recent,
  location,
}: {
  openEntry: TimeEntry | null;
  todaysShift: Shift | null;
  recent: TimeEntry[];
  location: Location | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const clockedIn = !!openEntry;

  async function act(action: "in" | "out") {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const pos = await getPosition();
      const res = await fetch("/api/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error ?? "Something went wrong.");
      } else {
        setMsg(action === "in" ? "Clocked in." : "Clocked out.");
        router.refresh();
      }
    } catch (e: unknown) {
      const m = e instanceof GeolocationPositionError || (e as { code?: number })?.code
        ? "Location blocked. Allow location access in your browser and retry."
        : (e as Error)?.message ?? "Could not get your location.";
      setErr(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center">
        <div className="text-sm text-slate-400">
          {clockedIn ? "On the clock since" : "You are clocked out"}
        </div>
        {clockedIn && (
          <div className="text-2xl font-semibold text-emerald-400 mt-1">
            {fmtTime(openEntry!.clock_in_at)}
          </div>
        )}
        <button
          onClick={() => act(clockedIn ? "out" : "in")}
          disabled={busy}
          className={`mt-5 w-full py-5 rounded-xl text-lg font-semibold transition ${
            clockedIn
              ? "bg-rose-500 hover:bg-rose-400 text-white"
              : "bg-emerald-500 hover:bg-emerald-400 text-slate-950"
          } disabled:opacity-50`}
        >
          {busy ? "Checking location…" : clockedIn ? "Clock out" : "Clock in"}
        </button>
        {location && (
          <div className="text-xs text-slate-500 mt-3">
            Must be within {location.radius_meters}m of {location.name}.
          </div>
        )}
        {msg && <div className="text-sm text-emerald-400 mt-3">{msg}</div>}
        {err && (
          <div className="text-sm text-rose-300 bg-rose-950 border border-rose-900 rounded-md px-3 py-2 mt-3">
            {err}
          </div>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="text-sm font-medium text-slate-300 mb-1">Today&apos;s shift</div>
        {todaysShift ? (
          <div className="text-slate-200">
            {fmtTime(todaysShift.starts_at)} – {fmtTime(todaysShift.ends_at)}
            {todaysShift.position ? ` · ${todaysShift.position}` : ""}
          </div>
        ) : (
          <div className="text-slate-500 text-sm">No shift scheduled today.</div>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="text-sm font-medium text-slate-300 mb-3">Recent</div>
        {recent.length === 0 ? (
          <div className="text-slate-500 text-sm">No entries yet.</div>
        ) : (
          <div className="space-y-2">
            {recent.map((e) => (
              <div key={e.id} className="flex justify-between text-sm border-b border-slate-800 pb-2 last:border-0">
                <span className="text-slate-300">{fmtDateTime(e.clock_in_at)}</span>
                <span className="text-slate-400">
                  {e.clock_out_at
                    ? `${hoursBetween(e.clock_in_at, e.clock_out_at)} h`
                    : "open"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
