"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { STAGE_COLOURS, type Stage } from "@/lib/stages";
import type { Deal } from "@/lib/types";
import SearchBar from "./SearchBar";
import DealDetailDrawer from "./DealDetailDrawer";

const PAGE_SIZE = 100;

function fmtMoney(n: number | null): string {
  if (n == null) return "";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  try {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

export default function HistoricalView() {
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDealId, setSelectedDealId] = useState<number | null>(null);

  // Debounce typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const runQuery = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);

      let request = supabase
        .from("deals")
        .select("*")
        .eq("archived", 1)
        .order("event_date", { ascending: false, nullsFirst: false })
        .limit(PAGE_SIZE);

      const trimmed = q.trim();
      if (trimmed) {
        // OR across the most useful searchable fields.
        const escaped = trimmed.replace(/[%,()]/g, " ");
        request = request.or(
          [
            `company.ilike.%${escaped}%`,
            `contact_first_name.ilike.%${escaped}%`,
            `contact_last_name.ilike.%${escaped}%`,
            `contact_email.ilike.%${escaped}%`,
            `venue_name.ilike.%${escaped}%`,
            `event_type.ilike.%${escaped}%`,
            `notes.ilike.%${escaped}%`,
          ].join(","),
        );
        // Also try matching by deal id if the query is purely numeric.
        // (Supabase doesn't easily mix ilike + eq in one OR, so we accept the limit.)
      }

      const { data, error } = await request;
      setLoading(false);
      if (error) {
        setError(error.message);
        setResults([]);
        return;
      }
      setResults((data ?? []) as Deal[]);
    },
    [supabase],
  );

  useEffect(() => {
    runQuery(debouncedQuery);
  }, [debouncedQuery, runQuery]);

  const selectedDeal =
    selectedDealId != null
      ? results.find((d) => d.id === selectedDealId) ?? null
      : null;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950">
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="Search archived deals (name, company, email, venue, notes...)"
        />
        <div className="text-sm text-slate-400 whitespace-nowrap">
          {loading
            ? "Searching..."
            : `${results.length}${results.length === PAGE_SIZE ? "+" : ""} results`}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-6 text-rose-300">{error}</div>
        ) : results.length === 0 && !loading ? (
          <div className="p-6 text-slate-500 italic text-sm">
            {query.trim() ? "No matches." : "No archived deals."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-950 z-10">
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                <th className="px-4 py-2 font-semibold">ID</th>
                <th className="px-4 py-2 font-semibold">Company / Contact</th>
                <th className="px-4 py-2 font-semibold">Event date</th>
                <th className="px-4 py-2 font-semibold">Stage</th>
                <th className="px-4 py-2 font-semibold text-right">Total</th>
                <th className="px-4 py-2 font-semibold">Payment</th>
              </tr>
            </thead>
            <tbody>
              {results.map((d) => {
                const colour = STAGE_COLOURS[d.stage as Stage];
                const contact = [d.contact_first_name, d.contact_last_name]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr
                    key={d.id}
                    onClick={() => setSelectedDealId(d.id)}
                    className="border-b border-slate-800/60 hover:bg-slate-900 cursor-pointer"
                  >
                    <td className="px-4 py-2 text-slate-500">#{d.id}</td>
                    <td className="px-4 py-2">
                      <div className="text-slate-100">
                        {d.company || contact || "—"}
                      </div>
                      {d.company && contact && (
                        <div className="text-xs text-slate-500">{contact}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-300">
                      {fmtDate(d.event_date)}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                        {colour && (
                          <span
                            className={`w-2 h-2 rounded-full ${colour.dot}`}
                          />
                        )}
                        {d.stage}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-slate-200">
                      {fmtMoney(d.total_with_tax)}
                    </td>
                    <td className="px-4 py-2 text-slate-400 text-xs">
                      {d.payment_status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedDeal && (
        <DealDetailDrawer
          deal={selectedDeal}
          onClose={() => setSelectedDealId(null)}
        />
      )}
    </div>
  );
}
