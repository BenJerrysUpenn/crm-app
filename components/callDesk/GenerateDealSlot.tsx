"use client";

import { useState } from "react";
import type { CallDeskRow } from "@/lib/callDesk/types";

/**
 * Placeholder for the guided "Generate deal" form (bj-finance #409, built on
 * a parallel branch). The coordinator swaps the body of the sheet for the
 * real form after that branch merges — the prop contract below is the seam
 * and must not change:
 *
 *   prospect    the queue row to prefill from (name, company, phone, email)
 *   callerEmail the signed-in caller; becomes lead_source on the new deal
 *   onCreated   called with the new deal id once the deal exists, so the
 *               queue can refresh and toast
 */
export default function GenerateDealSlot({
  prospect,
  callerEmail,
  onCreated,
}: {
  prospect: CallDeskRow;
  callerEmail: string;
  onCreated: (dealId: number) => void;
}) {
  const [open, setOpen] = useState(false);

  // `onCreated` is unused until the real form lands; referencing it here
  // keeps the contract honest and the linter quiet.
  void onCreated;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] flex-1 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md px-3 border border-slate-700"
      >
        Generate deal
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-label="Generate deal"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full sm:max-w-md bg-slate-900 border-t sm:border border-slate-700 sm:rounded-lg p-5 pb-8 sm:pb-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-slate-100 font-semibold mb-1">Generate deal</h2>
            <p className="text-sm text-slate-400 mb-4">
              Deal form arrives with the deal-form branch.
            </p>
            <div className="text-xs text-slate-500 space-y-1 mb-5">
              <div>
                Will prefill: {prospect.name ?? "—"}
                {prospect.company ? ` · ${prospect.company}` : ""}
                {prospect.phone ? ` · ${prospect.phone}` : ""}
              </div>
              <div>Lead source: {callerEmail || "the signed-in caller"}</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full min-h-[44px] text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md border border-slate-700"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
