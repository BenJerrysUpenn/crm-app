"use client";

import { useState } from "react";
import type { CallDeskRow } from "@/lib/callDesk/types";
import GenerateDealForm from "./GenerateDealForm";

/**
 * "Generate deal" row action (bj-finance #409). Opens the guided deal form
 * prefilled from the queue row; the caller's identity becomes lead_source on
 * the new deal. `onCreated` fires with the new deal id so the queue can
 * refresh and toast.
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
        <GenerateDealForm
          prospect={{
            prospect_id: prospect.prospect_id,
            name: prospect.name,
            company: prospect.company,
            email: prospect.email,
            phone: prospect.phone,
          }}
          callerEmail={callerEmail}
          onClose={() => setOpen(false)}
          onCreated={(dealId) => {
            setOpen(false);
            onCreated(dealId);
          }}
        />
      )}
    </>
  );
}
