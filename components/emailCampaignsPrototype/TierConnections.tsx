"use client";

// PROTOTYPE — Email campaigns tab (v5, v6): the tier connections panel.
//
// Read-only. How people move between tiers, as text and arrows, with the
// counts the data can give today (lib/emailCampaignsPrototype/model.ts,
// `flows`). Every count is people as of now, not movements over time: there is
// no tier history yet.

import type { Flows, TierPayload } from "@/lib/emailCampaignsPrototype/model";

const fmt = (n: number) => n.toLocaleString("en-US");

function N({ n, title }: { n: number; title: string }) {
  return (
    <span title={title} className="ml-1 rounded bg-slate-800 px-1 tabular-nums text-slate-200">
      {fmt(n)}
    </span>
  );
}

function Arrow() {
  return <span className="mx-1.5 text-slate-500">→</span>;
}

function T({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-slate-200">{children}</span>;
}

export default function TierConnections({ flows, tiers }: { flows: Flows; tiers: TierPayload[] }) {
  const offer = tiers.find((t) => t.key === "offer")?.total ?? 0;
  const rows: { flow: React.ReactNode; note: string }[] = [
    {
      flow: (
        <>
          <T>Cold</T>
          <Arrow />
          reply
          <N n={flows.coldReplied} title="Cold prospects who replied or were handed to sales" />
          <Arrow />
          <T>CRM deal</T>
          <N n={flows.coldToDeal} title="Cold prospects whose email is on a CRM deal" />
          <span className="mx-2 text-slate-600">·</span>
          <T>Cold</T>
          <Arrow />
          suppressed
          <N n={flows.coldSuppressed} title="Cold prospects who opted out, bounced or are suppressed" />
        </>
      ),
      note: "A reply goes to catering@ and becomes a deal.",
    },
    {
      flow: (
        <>
          <T>CRM deal</T>
          <Arrow />
          <T>Offer</T>
          <N n={offer} title="People in Offer now" />
          <span className="ml-1 text-slate-500">
            (booked in the last 12 months {fmt(flows.offerBookedRecent)}, or explicitly opted in {fmt(flows.offerOptedIn)})
          </span>
          <span className="mx-2 text-slate-600">·</span>
          <T>CRM deal</T>
          <Arrow />
          <T>Warm</T>
          <N n={flows.dealToWarm} title="Warm people with a deal on file who never booked" />
          <span className="ml-1 text-slate-500">(enquired, didn&apos;t book)</span>
        </>
      ),
      note: "",
    },
    {
      flow: (
        <>
          <T>Offer</T>
          <Arrow />
          <T>Warm</T>
          <N n={flows.offerToWarm} title="Warm people who booked, but more than 12 months ago" />
          <span className="ml-1 text-slate-500">(12 months without a booking)</span>
        </>
      ),
      note: "Moving tiers never restarts a sequence: nobody gets an email they already had.",
    },
    {
      flow: (
        <>
          <T>Any tier</T>
          <Arrow />
          suppressed
          <N n={flows.suppressed} title="Opted out, bounced or on the suppression list, across all tiers" />
          <span className="ml-1 text-slate-500">(opt-out)</span>
        </>
      ),
      note: "Suppressed people are left out of every number on this page.",
    },
  ];
  // v6: a plain disclosure row like "How the numbers are made", directly under
  // it, collapsed by default (no box around it).
  return (
    <details className="text-[11px] text-slate-500">
      <summary className="cursor-pointer hover:text-slate-300">
        Tier connections <span className="text-slate-600">· people as of now (derived); no tier history yet</span>
      </summary>
      <ul className="mt-1 space-y-1 pl-4 text-xs text-slate-400">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-y-0.5">
            <span className="flex flex-wrap items-baseline">{r.flow}</span>
            {r.note ? <span className="ml-3 text-[11px] text-slate-500">{r.note}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
