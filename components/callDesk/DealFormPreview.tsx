"use client";

import { useState } from "react";
import GenerateDealForm, { type CallDeskProspect } from "./GenerateDealForm";

// A stand-in queue row so the form can be opened and reviewed before the
// call-desk queue branch lands. Not real data — prospect_id 0 exists nowhere,
// which is also why live writes would fail against it.
const FAKE_PROSPECT: CallDeskProspect = {
  prospect_id: 0,
  name: "Dana Whitfield",
  company: "Rittenhouse Square Partners",
  email: "dana.whitfield@example.com",
  phone: "(215) 555-0142",
};

export default function DealFormPreview({
  callerEmail,
}: {
  callerEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 mb-6">
        <p className="text-amber-100 font-semibold">Preview page</p>
        <p className="text-sm text-amber-200/80 mt-1">
          This route exists only to review the guided deal form on its own,
          against a fake prospect. It is not the call desk. Deal writes are
          dry-run unless <code>CALL_DESK_DEAL_WRITES=live</code> is set, and a
          live write here would fail anyway because prospect #0 does not exist.
        </p>
      </div>

      <dl className="text-sm text-slate-300 border border-slate-800 rounded-lg divide-y divide-slate-800 mb-6">
        {[
          ["Name", FAKE_PROSPECT.name],
          ["Company", FAKE_PROSPECT.company],
          ["Email", FAKE_PROSPECT.email],
          ["Phone", FAKE_PROSPECT.phone],
        ].map(([label, value]) => (
          <div key={label} className="flex gap-4 px-4 py-2">
            <dt className="w-24 text-slate-500 shrink-0">{label}</dt>
            <dd className="text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>

      {createdId != null && (
        <p className="text-sm text-emerald-300 mb-4">
          onCreated fired with deal id {createdId}.
        </p>
      )}

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] w-full rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium px-4"
      >
        Generate deal
      </button>

      {open && (
        <GenerateDealForm
          prospect={FAKE_PROSPECT}
          callerEmail={callerEmail}
          onClose={() => setOpen(false)}
          onCreated={(id) => setCreatedId(id)}
        />
      )}
    </div>
  );
}
