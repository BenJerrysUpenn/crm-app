"use client";

// PROTOTYPE — Email campaigns tab. Throwaway UI on branch
// prototype/email-campaigns. Plan: two structurally different variants of the
// same read-only payload on /email-campaigns, switched by ?variant=A|B.
//   A — "Tiers": the owners' sketch. Three big tier containers left to right,
//       Everyone card on top, category cards beneath, resting + capacity at
//       the bottom of each tier.
//   B — "Ledger": one table, every category a row, every state a column, so
//       the accounting invariant reads down a column instead of per card.

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type {
  Bucket,
  CategoryStat,
  Payload,
  Tag,
  TierPayload,
} from "@/lib/emailCampaignsPrototype/model";

const fmt = (n: number) => n.toLocaleString("en-US");

const TAG_STYLE: Record<Tag, string> = {
  live: "border-emerald-700 text-emerald-300 bg-emerald-950/40",
  derived: "border-sky-700 text-sky-300 bg-sky-950/40",
  static: "border-violet-700 text-violet-300 bg-violet-950/40",
  mock: "border-amber-600 text-amber-300 bg-amber-950/40",
};

function TagPill({ tag }: { tag: Tag }) {
  return (
    <span
      className={`inline-block rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide leading-none ${TAG_STYLE[tag]}`}
    >
      {tag}
    </span>
  );
}

const BUCKET_LABEL: Record<Bucket, string> = {
  queue: "Queue",
  in_sequence: "In sequence",
  resting: "Resting",
  suppressed: "Suppressed",
  unaccounted: "Unaccounted",
};

type Drill =
  | { kind: "people"; tier: TierPayload; cat: CategoryStat; bucket: Bucket }
  | { kind: "sequence"; tier: TierPayload; cat: CategoryStat };

// --- shared pieces ------------------------------------------------------------

function Dots({
  steps,
  onClick,
  tag,
  compact,
}: {
  steps: number;
  onClick: () => void;
  tag: Tag;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={steps ? `${steps} email${steps === 1 ? "" : "s"} in sequence` : "No sequence"}
      className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-800"
    >
      {steps === 0 ? (
        <span className="h-2.5 w-2.5 rounded-full border border-dashed border-amber-500" />
      ) : (
        Array.from({ length: steps }, (_, i) => (
          <span key={i} className="h-2.5 w-2.5 rounded-full bg-sky-400" />
        ))
      )}
      {compact ? null : (
        <>
          <span className="ml-1 text-[11px] text-slate-400 whitespace-nowrap">
            {steps} step{steps === 1 ? "" : "s"}
          </span>
          {tag !== "live" ? <span className="ml-1"><TagPill tag={tag} /></span> : null}
        </>
      )}
    </button>
  );
}

function Invariant({ c }: { c: CategoryStat }) {
  const { queue, in_sequence, resting, suppressed, unaccounted } = c.counts;
  const active = c.total - suppressed;
  const sum = queue + in_sequence + resting;
  const gap = active - sum;
  return (
    <div className="text-[11px] leading-snug text-slate-400">
      <span className="text-slate-300">{fmt(queue)}</span> queue +{" "}
      <span className="text-slate-300">{fmt(in_sequence)}</span> in seq +{" "}
      <span className="text-slate-300">{fmt(resting)}</span> resting ={" "}
      <span className="text-slate-200 font-medium">{fmt(sum)}</span>
      {" · "}
      {fmt(c.total)} everyone − {fmt(suppressed)} suppressed = {fmt(active)}{" "}
      {gap === 0 ? (
        <span className="text-emerald-400">✓ adds up</span>
      ) : (
        <span className="rounded bg-amber-500/20 px-1 text-amber-300 font-medium">
          unaccounted: {fmt(unaccounted || gap)}
        </span>
      )}
    </div>
  );
}

function PeopleModal({ drill, onClose, setBucket }: { drill: Extract<Drill, { kind: "people" }>; onClose: () => void; setBucket: (b: Bucket) => void }) {
  const { tier, cat, bucket } = drill;
  const rows = cat.sample[bucket];
  const n = cat.counts[bucket];
  return (
    <Modal onClose={onClose} title={`${tier.label} · ${cat.label}`}>
      <div className="flex flex-wrap gap-1 mb-3">
        {(Object.keys(BUCKET_LABEL) as Bucket[]).map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setBucket(b)}
            className={`text-xs rounded-md px-2 py-1 border ${
              b === bucket
                ? "bg-slate-800 border-slate-600 text-slate-100"
                : "border-slate-800 text-slate-400 hover:text-slate-200"
            } ${b === "unaccounted" && cat.counts[b] > 0 ? "text-amber-300" : ""}`}
          >
            {BUCKET_LABEL[b]} {fmt(cat.counts[b])}
          </button>
        ))}
      </div>
      {bucket === "resting" && cat.key === "everyone" && tier.restingReasons.length ? (
        <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-slate-400">
          {tier.restingReasons.map((r) => (
            <span key={r.why} className="rounded bg-slate-800/70 px-1.5 py-0.5">
              {r.why}: <span className="text-slate-200">{fmt(r.n)}</span>
              {r.due ? <span className="text-amber-300"> ({fmt(r.due)} due)</span> : null}
            </span>
          ))}
        </div>
      ) : null}
      <div className="text-[11px] text-slate-500 mb-2">
        Showing {fmt(rows.length)} of {fmt(n)}, most recently touched first.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-medium">Name</th>
              <th className="py-1 pr-3 font-medium">Email</th>
              <th className="py-1 pr-3 font-medium">Status</th>
              <th className="py-1 pr-3 font-medium">Last touch</th>
              <th className="py-1 pr-3 font-medium">Why here</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-slate-800 text-slate-300">
                <td className="py-1 pr-3 whitespace-nowrap">{p.name}</td>
                <td className="py-1 pr-3">{p.email ?? <span className="text-slate-600">none yet</span>}</td>
                <td className="py-1 pr-3">{p.status}</td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {p.last_touch ? new Date(p.last_touch).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "never"}
                </td>
                <td className="py-1 pr-3 text-slate-400">{p.why}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 text-center text-slate-500">
                  Nobody here.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function SequenceModal({ tier, cat, onClose }: { tier: TierPayload; cat: CategoryStat; onClose: () => void }) {
  const s = tier.sequence;
  return (
    <Modal onClose={onClose} title={`${tier.label} · ${cat.label} · sequence`}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-100">{s.name}</span>
          <TagPill tag={s.tag} />
        </div>
        <ol className="flex flex-wrap items-center gap-2">
          {s.steps === 0 ? (
            <li className="rounded-md border border-dashed border-amber-600 px-3 py-2 text-xs text-amber-300">
              No steps yet
            </li>
          ) : (
            Array.from({ length: s.steps }, (_, i) => (
              <li key={i} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300">
                Step {i + 1}: email
              </li>
            ))
          )}
        </ol>
        <p className="text-slate-400 text-xs">{s.note}</p>
        {cat.key !== "everyone" ? (
          <p className="text-slate-500 text-xs">
            Every {tier.label.toLowerCase()} category uses this one sequence today. A per-category sequence
            is the design question this card is asking.
          </p>
        ) : null}
        {s.url ? (
          <a href={s.url} target="_blank" rel="noreferrer" className="inline-block text-sky-400 hover:underline text-xs">
            Open {tier.key === "cold" ? "in Apollo" : "the template"} ↗
          </a>
        ) : null}
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[80vh] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-100">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200 text-sm">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function VolumeBar({ tier }: { tier: TierPayload }) {
  const v = tier.volume;
  const max = Math.max(v.demand, v.capacity, 1);
  const short = v.demand > v.capacity;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-300 font-medium">
          Volume per {v.period} <TagPill tag={v.tag} />
        </span>
        <span className={short ? "text-rose-300 font-medium" : "text-emerald-300"}>
          {fmt(v.demand)} needed / {fmt(v.capacity)} capacity
        </span>
      </div>
      <div className="space-y-1">
        <div className="h-2 rounded bg-slate-800 overflow-hidden" title="needed">
          <div className={`h-full ${short ? "bg-rose-500" : "bg-sky-500"}`} style={{ width: `${(v.demand / max) * 100}%` }} />
        </div>
        <div className="h-2 rounded bg-slate-800 overflow-hidden" title="capacity">
          <div className="h-full bg-slate-400" style={{ width: `${(v.capacity / max) * 100}%` }} />
        </div>
      </div>
      <div className="text-[11px] text-slate-400">
        {fmt(v.firstTouches)} first touches + {fmt(v.followUps)} follow-ups + {fmt(v.retouches)} re-touches due
      </div>
      <div className="text-[11px] text-slate-500">{v.capacityNote}</div>
      {short ? (
        <div className="rounded border border-rose-800 bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200">
          Needs {v.mailboxesNeeded} mailbox{v.mailboxesNeeded === 1 ? "" : "es"} at {fmt(v.perMailbox)}/{v.period}; has {v.mailboxes}.
          {v.mailboxesNeeded > v.mailboxes ? ` Build ${v.mailboxesNeeded - v.mailboxes} more.` : ""}
          {v.mailboxes > 0 && v.capacity < v.mailboxes * v.perMailbox ? " The global daily cap also binds: lift it before adding mailboxes." : ""}
        </div>
      ) : null}
      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">Assumptions</summary>
        <ul className="list-disc pl-4 mt-1 space-y-0.5">
          {v.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// --- Variant A: tier containers ----------------------------------------------

function CategoryCard({ tier, cat, open, wide }: { tier: TierPayload; cat: CategoryStat; open: (d: Drill) => void; wide?: boolean }) {
  const gap = cat.counts.unaccounted;
  return (
    <div className={`rounded-md border ${gap ? "border-amber-600" : "border-slate-800"} bg-slate-900/70 p-2.5 flex flex-col gap-2 ${wide ? "" : "min-h-[112px]"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-slate-100 ${wide ? "font-semibold" : "text-sm font-medium"} leading-tight`}>{cat.label}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {fmt(cat.total)} people · {fmt(cat.counts.suppressed)} suppressed
          </div>
        </div>
        <TagPill tag={cat.tag} />
      </div>
      {wide ? <Invariant c={cat} /> : gap ? (
        <div className="text-[11px] rounded bg-amber-500/20 px-1 text-amber-300">unaccounted: {fmt(gap)}</div>
      ) : null}
      {wide && cat.queueSplit ? (
        <div className="text-[11px] text-slate-400">
          Queue = {cat.queueSplit.map((q) => `${fmt(q.n)} ${q.label}`).join(" + ")}
        </div>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => open({ kind: "people", tier, cat, bucket: "queue" })}
          className="text-left rounded px-1.5 py-0.5 hover:bg-slate-800"
          title="People in this category's queue"
        >
          <span className={`${wide ? "text-2xl" : "text-xl"} font-semibold text-slate-100 tabular-nums`}>{fmt(cat.counts.queue)}</span>
          <span className="ml-1 text-[11px] text-slate-400 whitespace-nowrap">in queue</span>
        </button>
        <Dots steps={tier.sequence.steps} tag={tier.sequence.tag} compact={!wide} onClick={() => open({ kind: "sequence", tier, cat })} />
      </div>
      {cat.counts.in_sequence ? (
        <button
          type="button"
          onClick={() => open({ kind: "people", tier, cat, bucket: "in_sequence" })}
          className="text-left text-[11px] text-sky-300 hover:underline"
        >
          {fmt(cat.counts.in_sequence)} in sequence now
        </button>
      ) : null}
    </div>
  );
}

function TierColumn({ tier, open }: { tier: TierPayload; open: (d: Drill) => void }) {
  const e = tier.everyone;
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950 p-3 flex flex-col gap-3 min-w-0">
      <header>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-100">
            {tier.label} <span className="text-sm font-normal text-slate-500">{tier.blurb}</span>
          </h2>
          <span className="text-sm text-slate-400 tabular-nums">{fmt(e.total)}</span>
        </div>
        <p className="text-[11px] text-slate-500">{tier.definition}</p>
      </header>

      <CategoryCard tier={tier} cat={e} open={open} wide />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {tier.categories.map((c) => (
          <CategoryCard key={c.key} tier={tier} cat={c} open={open} />
        ))}
      </div>

      <div className="mt-auto space-y-3 border-t border-slate-800 pt-3">
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={() => open({ kind: "people", tier, cat: e, bucket: "resting" })}
            className="flex-1 text-left rounded-md border border-slate-700 bg-slate-900 px-3 py-2 hover:border-slate-500"
          >
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Resting</div>
            <div className="text-2xl font-semibold text-slate-100 tabular-nums">{fmt(e.counts.resting)}</div>
            <div className="text-[11px] text-slate-400">
              {tier.restingDue ? <span className="text-amber-300">{fmt(tier.restingDue)} due now · </span> : "none due · "}
              {tier.restingReasons.slice(0, 2).map((r) => `${fmt(r.n)} ${r.why}`).join(", ") || "empty"}
            </div>
          </button>
          <button
            type="button"
            onClick={() => open({ kind: "people", tier, cat: e, bucket: "suppressed" })}
            className="w-28 text-left rounded-md border border-slate-800 bg-slate-950 px-3 py-2 hover:border-slate-600"
          >
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Opted out</div>
            <div className="text-xl font-semibold text-slate-300 tabular-nums">{fmt(e.counts.suppressed)}</div>
            <div className="text-[11px] text-slate-500">suppressed</div>
          </button>
        </div>
        <VolumeBar tier={tier} />
      </div>
    </section>
  );
}

function VariantA({ payload, open }: { payload: Payload; open: (d: Drill) => void }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {payload.tiers.map((t) => (
        <TierColumn key={t.key} tier={t} open={open} />
      ))}
    </div>
  );
}

// --- Variant B: ledger table -------------------------------------------------

function VariantB({ payload, open }: { payload: Payload; open: (d: Drill) => void }) {
  const cols: Bucket[] = ["queue", "in_sequence", "resting", "suppressed", "unaccounted"];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {payload.tiers.map((t) => (
          <div key={t.key} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <div className="text-sm font-semibold text-slate-100 mb-2">{t.label} capacity</div>
            <VolumeBar tier={t} />
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-xs text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Tier / category</th>
              <th className="px-3 py-2 font-medium text-right">Everyone</th>
              {cols.map((b) => (
                <th key={b} className="px-3 py-2 font-medium text-right">
                  {BUCKET_LABEL[b]}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Sequence</th>
            </tr>
          </thead>
          <tbody>
            {payload.tiers.map((t) =>
              [t.everyone, ...t.categories].map((c, i) => (
                <tr
                  key={`${t.key}-${c.key}`}
                  className={`border-t border-slate-800 ${i === 0 ? "bg-slate-900/80 font-medium" : ""}`}
                >
                  <td className={`px-3 py-1.5 ${i === 0 ? "text-slate-100" : "pl-8 text-slate-300"}`}>
                    {i === 0 ? `${t.label} · everyone` : c.label} <TagPill tag={c.tag} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-300">{fmt(c.total)}</td>
                  {cols.map((b) => (
                    <td key={b} className="px-3 py-1.5 text-right tabular-nums">
                      <button
                        type="button"
                        onClick={() => open({ kind: "people", tier: t, cat: c, bucket: b })}
                        className={`hover:underline ${
                          b === "unaccounted" && c.counts[b] > 0
                            ? "rounded bg-amber-500/20 px-1 text-amber-300"
                            : c.counts[b] === 0
                              ? "text-slate-600"
                              : "text-slate-200"
                        }`}
                      >
                        {fmt(c.counts[b])}
                      </button>
                    </td>
                  ))}
                  <td className="px-3 py-1.5">
                    <Dots steps={t.sequence.steps} tag={t.sequence.tag} onClick={() => open({ kind: "sequence", tier: t, cat: c })} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Queue + In sequence + Resting + Suppressed + Unaccounted = Everyone on every row. Anything in the
        Unaccounted column is a person in a state the model does not know about.
      </p>
    </div>
  );
}

// --- Shell -------------------------------------------------------------------

const VARIANTS = [
  { key: "A", name: "Tiers (owners' sketch)" },
  { key: "B", name: "Ledger table" },
] as const;

function Switcher({ current }: { current: "A" | "B" }) {
  const router = useRouter();
  const pathname = usePathname();
  const go = useCallback(
    (dir: 1 | -1) => {
      const i = VARIANTS.findIndex((v) => v.key === current);
      const next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length];
      router.replace(`${pathname}?variant=${next.key}`);
    },
    [current, pathname, router],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
  const v = VARIANTS.find((x) => x.key === current)!;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full bg-fuchsia-600 text-white shadow-lg shadow-black/50 px-2 py-1 text-sm">
      <button type="button" onClick={() => go(-1)} className="px-2 hover:bg-fuchsia-500 rounded-full" aria-label="Previous variant">
        ←
      </button>
      <span className="whitespace-nowrap font-medium">
        {v.key} — {v.name}
      </span>
      <button type="button" onClick={() => go(1)} className="px-2 hover:bg-fuchsia-500 rounded-full" aria-label="Next variant">
        →
      </button>
    </div>
  );
}

export default function EmailCampaignsPrototype({
  payload,
  variant,
  showSwitcher,
}: {
  payload: Payload;
  variant: "A" | "B";
  showSwitcher: boolean;
}) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const close = useCallback(() => setDrill(null), []);

  return (
    <div className="px-3 sm:px-6 py-4 pb-20 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold text-slate-100">Email campaigns</h2>
          <span className="rounded bg-fuchsia-600/20 border border-fuchsia-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-300">
            Prototype
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className="flex items-center gap-1"><TagPill tag="live" /> read from the DB</span>
          <span className="flex items-center gap-1"><TagPill tag="derived" /> computed by this page</span>
          <span className="flex items-center gap-1"><TagPill tag="static" /> hard-coded today</span>
          <span className="flex items-center gap-1"><TagPill tag="mock" /> placeholder</span>
          <span className="text-slate-500">
            as of {new Date(payload.generated_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET
          </span>
        </div>
      </div>
      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">
          How the numbers are made ({fmt(payload.totals.prospects)} contacts, {fmt(payload.outsideTiers)} outside any tier)
        </summary>
        <ul className="list-disc pl-4 mt-1 space-y-0.5">
          {payload.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>
            Queue = never touched and lined up for a first send (warm/offer: the outreach_warm_eligible rules;
            cold: not yet sent, with or without a revealed email). In sequence = status sequenced and sent
            recently. Resting = touched before, or held back, and waiting. Suppressed = opted out, bounced or
            on the suppression list.
          </li>
        </ul>
      </details>

      {variant === "B" ? <VariantB payload={payload} open={setDrill} /> : <VariantA payload={payload} open={setDrill} />}

      {drill?.kind === "people" ? (
        <PeopleModal drill={drill} onClose={close} setBucket={(b) => setDrill({ ...drill, bucket: b })} />
      ) : null}
      {drill?.kind === "sequence" ? <SequenceModal tier={drill.tier} cat={drill.cat} onClose={close} /> : null}
      {showSwitcher ? <Switcher current={variant} /> : null}
    </div>
  );
}
