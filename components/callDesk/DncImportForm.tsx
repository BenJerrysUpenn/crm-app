"use client";

import { useState } from "react";
import Link from "next/link";

type Result = {
  source: string;
  mark_clear: boolean;
  numbers: number;
  matched: number;
  cleared: number;
};

/**
 * Paste a registry file, stamp the base (bj-finance #420).
 *
 * The plainest thing that does the job. Two registries have to be scrubbed
 * before an out-of-window number may be dialled — the national one and
 * Pennsylvania's separate state list — and both hand over plain text, so a
 * textarea beats a file picker on a phone and needs no upload path.
 */
export default function DncImportForm() {
  const [csv, setCsv] = useState("");
  const [source, setSource] = useState("national");
  const [markClear, setMarkClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/call-desk/dnc/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, source, mark_clear: markClear }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload.error || `Import failed (${res.status})`);
        return;
      }
      setResult(payload as Result);
      setCsv("");
    } catch {
      setError("Could not reach the CRM.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-3 sm:px-6 py-4 max-w-2xl">
      <h1 className="text-lg font-semibold text-slate-100">
        Do-not-call registry scrub
      </h1>
      <p className="mt-1 text-xs text-slate-500">
        Paste the registry file. Every 10-digit number in it is matched against
        the contact base and stamped, so the call desk can tell a scrubbed
        number from an unscrubbed one. See{" "}
        <Link
          href="/call-desk"
          className="text-sky-400 hover:text-sky-300 underline underline-offset-2"
        >
          the call desk
        </Link>
        .
      </p>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="block text-xs text-slate-400 mb-1">Which list</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-full min-h-[44px] text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded px-3 focus:outline-none focus:ring-2 focus:ring-slate-500"
          >
            <option value="national">National registry (donotcall.gov)</option>
            <option value="pa_list">Pennsylvania state list</option>
          </select>
        </label>

        <label className="block">
          <span className="block text-xs text-slate-400 mb-1">
            The numbers — one per line, or any CSV with a phone column
          </span>
          <textarea
            rows={10}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"2155550134\n2675550199\n..."}
            className="w-full text-sm font-mono bg-slate-800 border border-slate-700 text-slate-100 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
        </label>

        <label className="flex items-start gap-3 px-3 py-3 rounded-md border border-slate-700 bg-slate-900 cursor-pointer">
          <input
            type="checkbox"
            checked={markClear}
            onChange={(e) => setMarkClear(e.target.checked)}
            className="mt-1 h-5 w-5 accent-slate-400 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm text-slate-100">
              This is the complete list for our area codes
            </span>
            <span className="block text-xs text-slate-400">
              Marks every other number as scrubbed clear, which is what lets an
              out-of-window prospect be called for the next 31 days. Leave it
              off for a partial file. Numbers already flagged by a registry or
              by the customer are never cleared either way.
            </span>
          </span>
        </label>

        {error && (
          <div className="rounded-md border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        )}

        {result && (
          <div className="rounded-md border border-emerald-900 bg-emerald-950/60 px-3 py-3 text-sm text-emerald-100">
            <p className="font-medium">Scrub loaded.</p>
            <ul className="mt-1 space-y-0.5 text-emerald-200/90">
              <li>{result.numbers.toLocaleString()} numbers read from the file</li>
              <li>
                {result.matched.toLocaleString()} prospects flagged{" "}
                {result.source === "national" ? "national registry" : "PA list"}
              </li>
              <li>
                {result.mark_clear
                  ? `${result.cleared.toLocaleString()} prospects marked scrubbed clear`
                  : "nothing marked clear (partial file)"}
              </li>
            </ul>
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || !csv.trim()}
          className="min-h-[44px] w-full text-sm font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Loading…" : "Load the scrub"}
        </button>
      </div>
    </div>
  );
}
