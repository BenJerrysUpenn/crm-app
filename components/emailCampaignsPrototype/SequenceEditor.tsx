"use client";

// PROTOTYPE — Email campaigns tab (v4): the in-CRM sequence editor.
//
// Opened from a tile's sequence dots (loaded with that sequence) or from
// "+ Add sequence" (empty, for that tier and category). One step = one email
// = one dot on the tile. Edits persist in localStorage only: nothing here is
// sent to Apollo, warm_sender or the database.

import { useEffect, useRef, useState } from "react";
import { CADENCES, type Cadence, type TierPayload } from "@/lib/emailCampaignsPrototype/model";
import {
  LANES,
  dayOffsets,
  splitMerge,
  type FooterLine,
  type Lane,
  type SeqStep,
  type SequenceDoc,
} from "@/lib/emailCampaignsPrototype/sequences";

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export type EditorTarget = {
  tier: TierPayload;
  catKey: string; // "everyone" or a category key
  catLabel: string;
  cadence: Cadence;
};

// --- rendering helpers ----------------------------------------------------------

/** Text with {{merge_fields}} as chips (edit view). */
function WithChips({ text }: { text: string }) {
  return (
    <>
      {splitMerge(text).map((part, i) =>
        part.field ? (
          <span
            key={i}
            className="mx-px inline-flex items-center rounded bg-sky-500/15 px-1 font-mono text-[11px] leading-4 text-sky-300 ring-1 ring-inset ring-sky-500/30"
          >
            {part.field}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Text with {{merge_fields}} filled from the sample recipient (preview). */
function Filled({ text, lane }: { text: string; lane: Lane }) {
  return (
    <>
      {splitMerge(text).map((part, i) => {
        if (!part.field) return <span key={i}>{part.text}</span>;
        const v = lane.sample.fields[part.field];
        return v ? (
          <span key={i} title={`{{${part.field}}}`} className="rounded-sm bg-sky-100 decoration-sky-400">
            {v}
          </span>
        ) : (
          <span key={i} title="This lane does not fill this field" className="rounded-sm bg-rose-100 text-rose-700">
            [{part.field}?]
          </span>
        );
      })}
    </>
  );
}

function LinkTail({ line }: { line: FooterLine }) {
  if (!line.link || !line.text.endsWith(line.link)) return <>{line.text}</>;
  return (
    <>
      {line.text.slice(0, line.text.length - line.link.length)}
      <span className="text-blue-700 underline">{line.link}</span>
    </>
  );
}

function BlockLabel({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "amber" }) {
  return (
    <span
      className={`mb-1 inline-block rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${
        tone === "amber" ? "bg-amber-100 text-amber-800" : "bg-slate-200 text-slate-600"
      }`}
    >
      {children}
    </span>
  );
}

/** The whole email as the prospect sees it: headers, body, signature, footer. */
function RecipientPreview({ step, lane }: { step: SeqStep; lane: Lane }) {
  return (
    <div className="overflow-hidden rounded-md border border-slate-300 bg-white text-slate-900 shadow-sm">
      <div className="space-y-0.5 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
        <div>
          <span className="inline-block w-14 text-slate-400">From</span>
          {lane.sendsFrom}
          {lane.via !== "no lane yet" ? <span className="text-slate-400"> (via {lane.via})</span> : null}
        </div>
        <div>
          <span className="inline-block w-14 text-slate-400">To</span>
          {lane.sample.fields.first_name} {lane.sample.fields.last_name} &lt;{lane.sample.to}&gt;
        </div>
        {lane.replyTo ? (
          <div>
            <span className="inline-block w-14 text-slate-400">Reply-To</span>
            {lane.replyTo}
          </div>
        ) : null}
        <div className="pt-0.5 text-[14px] font-semibold text-slate-900">
          {step.subject ? <Filled text={step.subject} lane={lane} /> : <span className="text-slate-400">(no subject)</span>}
        </div>
      </div>
      <div className="space-y-3 px-4 py-3 text-[13px] leading-relaxed">
        <div className="whitespace-pre-wrap">
          {step.body ? <Filled text={step.body} lane={lane} /> : <span className="text-slate-400">(empty body)</span>}
        </div>
        <div className="border-l-2 border-dashed border-slate-300 pl-2">
          <BlockLabel>signature · {lane.signatureNote}</BlockLabel>
          {lane.signature ? (
            <div className="whitespace-pre-wrap">
              {lane.signature.split("\n").map((l, i) => (
                <div key={i} className={/^https?:\/\//.test(l) ? "text-blue-700 underline" : ""}>
                  {l}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12px] italic text-slate-400">none</div>
          )}
        </div>
        <div className="border-l-2 border-dashed border-slate-300 pl-2">
          <BlockLabel>footer · {lane.footerNote}</BlockLabel>
          {lane.footer.length === 0 ? <div className="text-[12px] italic text-slate-400">none</div> : null}
          <div className="space-y-1.5">
            {lane.footer.map((line) =>
              line.proposed ? (
                <div key={line.text} className="rounded border border-dashed border-amber-400 bg-amber-50 px-2 py-1">
                  <BlockLabel tone="amber">proposed footer line · {line.note}</BlockLabel>
                  <div className="text-[12px] text-slate-600">
                    <LinkTail line={line} />
                  </div>
                </div>
              ) : (
                <div key={line.text} className="text-[12px] text-slate-500">
                  <LinkTail line={line} />
                  {line.note ? <div className="text-[10px] italic text-slate-400">{line.note}</div> : null}
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- step editing ---------------------------------------------------------------

function StepForm({
  step,
  index,
  lane,
  onSave,
  onCancel,
}: {
  step: SeqStep;
  index: number;
  lane: Lane;
  onSave: (s: SeqStep) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(step);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const insert = (field: string) => {
    const el = bodyRef.current;
    const token = `{{${field}}}`;
    const at = el ? el.selectionStart : draft.body.length;
    const end = el ? el.selectionEnd : draft.body.length;
    const body = draft.body.slice(0, at) + token + draft.body.slice(end);
    setDraft({ ...draft, body });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };
  const input =
    "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none";
  return (
    <div className="space-y-2 rounded-md border border-sky-800/60 bg-slate-950/60 p-3">
      <label className="flex items-center gap-2 text-xs text-slate-400">
        {index === 0 ? "Send on day" : "Wait"}
        <input
          type="number"
          min={0}
          max={365}
          value={draft.waitDays}
          onChange={(e) => setDraft({ ...draft, waitDays: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })}
          className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-100 focus:border-slate-500 focus:outline-none"
        />
        {index === 0 ? "after they join the sequence" : `${plural(draft.waitDays, "day")} after step ${index}`}
      </label>
      <input
        value={draft.subject}
        onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
        placeholder="Subject"
        className={input}
      />
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
        <span>Insert merge field:</span>
        {lane.mergeFields.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => insert(f)}
            className="rounded bg-sky-500/15 px-1.5 font-mono text-[11px] leading-5 text-sky-300 ring-1 ring-inset ring-sky-500/30 hover:bg-sky-500/25"
          >
            {f}
          </button>
        ))}
        <span className="ml-1">{lane.mergeNote}</span>
      </div>
      <textarea
        ref={bodyRef}
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        rows={14}
        placeholder="Body. The signature and footer are added below it automatically."
        className={`${input} font-sans leading-relaxed`}
      />
      {draft.body ? (
        <div className="rounded border border-slate-800 px-2 py-1.5 text-xs leading-relaxed text-slate-400">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-600">merge fields</div>
          <div className="line-clamp-3 whitespace-pre-wrap">
            <WithChips text={draft.body} />
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(draft)}
          className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
        >
          Save step
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-slate-400 hover:text-slate-200">
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- the editor -------------------------------------------------------------------

export default function SequenceEditor({
  target,
  doc,
  seed,
  edited,
  onChange,
  onReset,
  onClose,
}: {
  target: EditorTarget;
  doc: SequenceDoc | null;
  seed: SequenceDoc | null;
  edited: boolean;
  onChange: (d: SequenceDoc) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { tier, catKey, catLabel, cadence } = target;
  const lane = LANES[tier.key];
  const current: SequenceDoc = doc ?? { name: "", steps: [] };
  const steps = current.steps;
  const offsets = dayOffsets(steps);
  const [preview, setPreview] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null); // added, never saved

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !editingId && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editingId]);

  const setSteps = (next: SeqStep[]) => onChange({ ...current, steps: next });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };
  const remove = (i: number) => {
    if (!window.confirm(`Delete step ${i + 1}? (Prototype: this browser only.)`)) return;
    setSteps(steps.filter((_, k) => k !== i));
  };
  const add = () => {
    const s: SeqStep = { id: newId(), waitDays: steps.length ? 3 : 0, subject: "", body: "" };
    setSteps([...steps, s]);
    setEditingId(s.id);
    setFreshId(s.id);
    setPreview(false);
  };
  const cancelEdit = (id: string) => {
    if (id === freshId) setSteps(steps.filter((s) => s.id !== id));
    setEditingId(null);
    setFreshId(null);
  };

  const cadenceLabel = CADENCES.find((c) => c.key === cadence)?.label ?? cadence;
  const span = offsets.length ? offsets[offsets.length - 1] : 0;
  const isEveryone = catKey === "everyone";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={() => !editingId && onClose()}>
      <aside
        role="dialog"
        aria-label={`${tier.label} › ${catLabel} sequence`}
        className="flex h-full w-full max-w-3xl flex-col border-l border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="space-y-2 border-b border-slate-800 px-5 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-slate-400">
              <span className="font-medium text-slate-300">{tier.label}</span>
              <span className="mx-1.5 text-slate-600">›</span>
              <span className="font-medium text-slate-300">{catLabel}</span>
              <span className="mx-1.5 text-slate-600">›</span>
              sequence
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={!!editingId}
              className="text-sm text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              Close
            </button>
          </div>
          <input
            value={current.name}
            onChange={(e) => onChange({ ...current, name: e.target.value })}
            placeholder={`Untitled ${tier.label.toLowerCase()} sequence`}
            className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold text-slate-100 placeholder:text-slate-600 hover:border-slate-700 focus:border-slate-500 focus:outline-none"
          />
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-slate-500">Sends from</dt>
            <dd className="text-slate-300">
              {tier.key === "offer" ? (
                lane.sendsFrom
              ) : (
                <>
                  {lane.sendsFrom} <span className="text-slate-500">via</span> {lane.via}
                  {lane.replyTo ? <span className="text-slate-500"> · replies to {lane.replyTo}</span> : null}
                </>
              )}
            </dd>
            <dt className="text-slate-500">Cadence</dt>
            <dd className="text-slate-300">
              Reach everyone {cadenceLabel} <span className="text-slate-500">(the tier&apos;s cadence)</span>
              <span className="text-slate-500">
                {" "}
                · {steps.length} {plural(steps.length, "email")}
                {steps.length > 1 ? ` over ${span} ${plural(span, "day")}` : ""}
              </span>
            </dd>
            {isEveryone && tier.sequence ? (
              <>
                <dt className="text-slate-500">Live today</dt>
                <dd className="text-slate-400">{tier.sequence.note}</dd>
              </>
            ) : null}
          </dl>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-slate-300">
              <button
                type="button"
                role="switch"
                aria-checked={preview}
                onClick={() => {
                  setPreview(!preview);
                  if (editingId) cancelEdit(editingId);
                }}
                className={`relative h-4 w-7 rounded-full transition-colors ${preview ? "bg-sky-500" : "bg-slate-700"}`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${preview ? "left-3.5" : "left-0.5"}`}
                />
              </button>
              Preview as recipient
            </label>
            {lane.apolloUrl ? (
              <a
                href={lane.apolloUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-slate-400 underline decoration-slate-600 hover:text-slate-200"
              >
                Open in Apollo ↗
              </a>
            ) : null}
            {seed && edited ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Put back the original copy? Your edits in this browser are discarded.")) onReset();
                }}
                className="ml-auto text-xs text-slate-500 hover:text-slate-200"
              >
                Reset to original
              </button>
            ) : null}
          </div>
        </div>

        <div className="border-b border-amber-700/50 bg-amber-500/10 px-5 py-2 text-xs text-amber-200">
          Prototype: edits are saved in this browser only and are NOT sent to Apollo or the warm sender.
        </div>

        {/* timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {steps.length === 0 ? (
            <div className="mb-4 rounded-md border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">
              No emails in this sequence yet.
              {tier.key === "offer" ? (
                <div className="mt-1 text-xs text-slate-500">The offer lane is not built (mass email / Kit, TBD).</div>
              ) : null}
            </div>
          ) : null}
          <ol className="relative space-y-4">
            {steps.length > 1 ? (
              <span className="absolute bottom-3 left-[9px] top-3 w-px bg-slate-700" aria-hidden />
            ) : null}
            {steps.map((s, i) => (
              <li key={s.id} className="relative pl-8">
                <span className="absolute left-0 top-0.5 flex h-[19px] w-[19px] items-center justify-center rounded-full bg-sky-400 text-[10px] font-semibold text-slate-950">
                  {i + 1}
                </span>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-200">
                    {i === 0 ? `Day ${offsets[i]}` : `+${s.waitDays} ${plural(s.waitDays, "day")}`}
                  </span>
                  {i > 0 ? <span className="text-[11px] text-slate-500">Day {offsets[i]}</span> : null}
                  <span className="text-[11px] text-slate-500">· Step {i + 1}: email</span>
                  {!preview && editingId !== s.id ? (
                    <span className="ml-auto flex items-center gap-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(s.id);
                          setFreshId(null);
                        }}
                        disabled={!!editingId}
                        className="rounded px-1.5 py-0.5 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        title="Move up"
                        onClick={() => move(i, -1)}
                        disabled={i === 0 || !!editingId}
                        className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-800 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        title="Move down"
                        onClick={() => move(i, 1)}
                        disabled={i === steps.length - 1 || !!editingId}
                        className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-800 disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        disabled={!!editingId}
                        className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-800 hover:text-rose-300 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </span>
                  ) : null}
                </div>
                {editingId === s.id ? (
                  <StepForm
                    step={s}
                    index={i}
                    lane={lane}
                    onCancel={() => cancelEdit(s.id)}
                    onSave={(d) => {
                      setSteps(steps.map((x) => (x.id === s.id ? d : x)));
                      setEditingId(null);
                      setFreshId(null);
                    }}
                  />
                ) : preview ? (
                  <RecipientPreview step={s} lane={lane} />
                ) : (
                  <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
                    <div className="mb-1 text-sm font-medium text-slate-100">
                      {s.subject ? <WithChips text={s.subject} /> : <span className="text-slate-500">(no subject)</span>}
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">
                      {s.body ? <WithChips text={s.body} /> : <span className="text-slate-500">(empty body)</span>}
                    </div>
                    <div className="mt-2 border-t border-slate-800 pt-1.5 text-[11px] text-slate-500">
                      + signature and footer ({lane.footerNote}). Turn on Preview as recipient to see them.
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {!preview ? (
            <button
              type="button"
              onClick={add}
              disabled={!!editingId}
              className="mt-4 rounded border border-dashed border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-400 hover:text-slate-100 disabled:opacity-40"
            >
              + Add step
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
