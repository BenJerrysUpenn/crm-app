"use client";

import { useEffect, useMemo, useState } from "react";
import type { Deal, QuoteJob } from "@/lib/types";
import { STAGE_COLOURS, STAGES, type Stage } from "@/lib/stages";
import {
  fmtEasternDate,
  fmtEasternDateTime,
  fmtEasternTime,
} from "@/lib/dateFormat";
import { createClient } from "@/lib/supabase/client";
import {
  FLAVOR_NAMES,
  EXTRA_LABELS,
  TOPPING_NAMES,
  PACKAGES,
  PAYMENT_STATUSES,
  defaultExtraQuantity,
  parseExtrasField,
  parseFlavorsField,
  parseToppingsField,
  serializeMultiselect,
} from "@/lib/menuOptions";

const PACKAGE_OPTIONS = PACKAGES.map((p) => ({
  value: p.value,
  label: p.description ? `${p.value} (${p.description})` : p.value,
}));
import {
  FieldRow,
  TextInput,
  TextArea,
  SelectInput,
  ToggleYesNo,
  Checkbox,
} from "./EditableField";
import MultiSelect from "./MultiSelect";
import MessageTimeline from "./MessageTimeline";

function ReadOnlyRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-slate-800 text-sm">
      <div className="text-slate-500 col-span-1">{label}</div>
      <div className="text-slate-200 col-span-2 break-words">{String(value)}</div>
    </div>
  );
}

function money(n: number | null | undefined): string | null {
  if (n == null) return null;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function boolish(n: number | null | undefined): string | null {
  if (n == null) return null;
  return n ? "Yes" : "No";
}

function numericInput(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export default function DealDetailDrawer({
  deal,
  onClose,
  onStageChange,
  onDealUpdate,
  userEmail,
}: {
  deal: Deal;
  onClose: () => void;
  onStageChange?: (deal: Deal, newStage: Stage) => void;
  onDealUpdate?: (deal: Deal) => void;
  userEmail?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [edits, setEdits] = useState<Partial<Deal>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteJob, setQuoteJob] = useState<QuoteJob | null>(null);
  const [quoteRequesting, setQuoteRequesting] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Reset local edits when the deal switches.
  useEffect(() => {
    setEdits({});
    setError(null);
    setQuoteJob(null);
  }, [deal.id]);

  // Poll the quote job while it's in flight.
  useEffect(() => {
    if (!quoteJob) return;
    if (quoteJob.status === "done" || quoteJob.status === "error") return;
    const t = setInterval(async () => {
      const { data } = await supabase
        .from("quote_jobs")
        .select("*")
        .eq("id", quoteJob.id)
        .single();
      if (data) setQuoteJob(data as QuoteJob);
    }, 1500);
    return () => clearInterval(t);
  }, [supabase, quoteJob?.id, quoteJob?.status]);

  const current = useMemo(() => ({ ...deal, ...edits }) as Deal, [deal, edits]);
  const hasChanges = Object.keys(edits).length > 0;
  const contact = [current.contact_first_name, current.contact_last_name]
    .filter(Boolean)
    .join(" ");
  const colour = STAGE_COLOURS[current.stage as Stage];

  function setField<K extends keyof Deal>(key: K, value: Deal[K]) {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!hasChanges || saving) return;
    setError(null);
    setSaving(true);
    const updates: Record<string, unknown> = {
      ...edits,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("deals")
      .update(updates)
      .eq("id", deal.id);
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    onDealUpdate?.({ ...deal, ...edits, updated_at: String(updates.updated_at) } as Deal);
    setEdits({});
  }

  function discard() {
    setEdits({});
    setError(null);
  }

  async function generateQuote() {
    if (quoteRequesting) return;
    if (hasChanges) {
      setError("Save changes before generating a quote.");
      return;
    }
    setQuoteRequesting(true);
    setError(null);
    const { data, error } = await supabase
      .from("quote_jobs")
      .insert({
        deal_id: deal.id,
        status: "pending",
        requested_by: userEmail ?? null,
      })
      .select()
      .single();
    setQuoteRequesting(false);
    if (error) {
      setError(error.message);
      return;
    }
    setQuoteJob(data as QuoteJob);
  }

  // Multi-select binding helpers.
  const flavorsSelected = parseFlavorsField(current.flavors);
  const extrasSelected = parseExtrasField(current.extras);
  const isUber = current.transport_mode === "uber";

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex justify-end"
      onClick={onClose}
    >
      <aside
        className="bg-slate-900 w-full max-w-5xl h-full flex flex-col shadow-2xl border-l border-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900 flex items-start justify-between gap-3 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-lg text-slate-100 truncate">
              {current.company || contact || `Deal #${current.id}`}
            </h2>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-xs text-slate-500">#{current.id}</span>
              {colour && (
                <span className={`w-2 h-2 rounded-full ${colour.dot}`} />
              )}
              {onStageChange ? (
                <select
                  value={current.stage}
                  onChange={(e) =>
                    onStageChange(deal, e.target.value as Stage)
                  }
                  className="text-xs bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-slate-500"
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-slate-300">{current.stage}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <button
                type="button"
                onClick={discard}
                className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5"
              >
                Discard
              </button>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!hasChanges || saving}
              className="text-sm bg-sky-500/20 text-sky-200 border border-sky-500/40 rounded-md px-3 py-1.5 hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : hasChanges ? `Save ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? "" : "s"}` : "Saved"}
            </button>
            <button
              type="button"
              onClick={generateQuote}
              disabled={
                quoteRequesting ||
                (quoteJob !== null &&
                  (quoteJob.status === "pending" || quoteJob.status === "running"))
              }
              className="text-sm bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 rounded-md px-3 py-1.5 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Generate the quote PDF and attach as a Gmail draft reply"
            >
              {quoteRequesting
                ? "Queueing…"
                : quoteJob?.status === "pending"
                ? "Queued…"
                : quoteJob?.status === "running"
                ? "Generating…"
                : quoteJob?.status === "done"
                ? "Quote ready ✓"
                : "Generate quote"}
            </button>
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-200 text-xl leading-none ml-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {(error || quoteJob?.error_message) && (
          <div className="px-5 py-2 bg-rose-950 border-b border-rose-900 text-sm text-rose-200">
            {error || quoteJob?.error_message}
          </div>
        )}
        {quoteJob?.status === "done" && (
          <div className="px-5 py-2 bg-emerald-950 border-b border-emerald-900 text-sm text-emerald-200">
            Quote drafted in Gmail. Check your drafts folder to review and send.
          </div>
        )}
        {quoteJob?.run_log &&
          (quoteJob.status === "done" || quoteJob.status === "error") && (
            <details
              open={quoteJob.status === "error"}
              className="px-5 py-2 bg-slate-950 border-b border-slate-800 text-xs"
            >
              <summary className="cursor-pointer text-slate-400 hover:text-slate-200 select-none">
                Run log
              </summary>
              <pre className="mt-2 whitespace-pre-wrap max-h-80 overflow-auto bg-slate-900 border border-slate-800 text-slate-300 p-2 rounded">
                {quoteJob.run_log}
              </pre>
            </details>
          )}

        <div className="flex flex-1 min-h-0">
          {/* Left: chat-style message timeline. */}
          <div className="flex-1 min-w-0 flex flex-col bg-slate-950/40 border-r border-slate-800">
            <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Email history
              </h3>
              <span className="text-[11px] text-slate-500">oldest → newest</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              <MessageTimeline dealId={deal.id} />
            </div>
          </div>

          {/* Right: editable detail fields. */}
          <div className="w-[460px] flex-shrink-0 overflow-y-auto">
            <div className="px-5 py-4 space-y-5">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Contact
                </h3>
                <FieldRow label="Company">
                  <TextInput
                    value={current.company ?? ""}
                    onChange={(v) => setField("company", v || null)}
                  />
                </FieldRow>
                <FieldRow label="First name">
                  <TextInput
                    value={current.contact_first_name ?? ""}
                    onChange={(v) => setField("contact_first_name", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Last name">
                  <TextInput
                    value={current.contact_last_name ?? ""}
                    onChange={(v) => setField("contact_last_name", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Email">
                  <TextInput
                    type="email"
                    value={current.contact_email ?? ""}
                    onChange={(v) => setField("contact_email", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Phone">
                  <TextInput
                    type="tel"
                    value={current.contact_phone ?? ""}
                    onChange={(v) => setField("contact_phone", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Day-of contact">
                  <TextInput
                    value={current.day_of_contact_name ?? ""}
                    onChange={(v) => setField("day_of_contact_name", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Day-of phone">
                  <TextInput
                    type="tel"
                    value={current.day_of_contact_phone ?? ""}
                    onChange={(v) => setField("day_of_contact_phone", v || null)}
                  />
                </FieldRow>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Event
                </h3>
                <FieldRow label="Date">
                  <TextInput
                    type="date"
                    value={current.event_date ?? ""}
                    onChange={(v) => setField("event_date", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Start">
                  <TextInput
                    type="time"
                    value={current.event_start_time ?? ""}
                    onChange={(v) => setField("event_start_time", v || null)}
                  />
                </FieldRow>
                <FieldRow label="End">
                  <TextInput
                    type="time"
                    value={current.event_end_time ?? ""}
                    onChange={(v) => setField("event_end_time", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Type">
                  <TextInput
                    value={current.event_type ?? ""}
                    onChange={(v) => setField("event_type", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Guests">
                  <TextInput
                    type="number"
                    value={current.guest_count == null ? "" : String(current.guest_count)}
                    onChange={(v) => setField("guest_count", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Venue">
                  <TextInput
                    value={current.venue_name ?? ""}
                    onChange={(v) => setField("venue_name", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Address">
                  <TextArea
                    value={current.venue_address ?? ""}
                    onChange={(v) => setField("venue_address", v || null)}
                    rows={2}
                  />
                </FieldRow>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Menu
                </h3>
                <FieldRow label="Package">
                  <SelectInput
                    value={current.package_name ?? ""}
                    onChange={(v) => setField("package_name", v || null)}
                    options={PACKAGE_OPTIONS}
                    placeholder="—"
                  />
                </FieldRow>
                <FieldRow label="Flavors">
                  <MultiSelect
                    options={FLAVOR_NAMES}
                    value={flavorsSelected}
                    onChange={(next) =>
                      setField("flavors", serializeMultiselect(next))
                    }
                    placeholder="Pick flavors"
                  />
                </FieldRow>
                <FieldRow label="Toppings">
                  <MultiSelect
                    options={TOPPING_NAMES}
                    value={parseToppingsField(current.toppings)}
                    onChange={(next) =>
                      setField("toppings", serializeMultiselect(next))
                    }
                    placeholder="Pick toppings"
                  />
                </FieldRow>
                <FieldRow label="Extras">
                  <MultiSelect
                    options={EXTRA_LABELS}
                    value={extrasSelected}
                    onChange={(next) =>
                      setField("extras", serializeMultiselect(next))
                    }
                    placeholder="Pick extras"
                    quantityMode
                    defaultQuantityFor={(opt) =>
                      defaultExtraQuantity(opt, current.guest_count)
                    }
                  />
                </FieldRow>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Staffing & transport
                </h3>
                <FieldRow label="Staff count">
                  <TextInput
                    type="number"
                    value={current.staff_count == null ? "" : String(current.staff_count)}
                    onChange={(v) => setField("staff_count", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Labor hours">
                  <TextInput
                    type="number"
                    step="0.5"
                    value={current.labor_hours == null ? "" : String(current.labor_hours)}
                    onChange={(v) => setField("labor_hours", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Round-trip miles">
                  <TextInput
                    type="number"
                    step="0.1"
                    value={current.round_trip_miles == null ? "" : String(current.round_trip_miles)}
                    onChange={(v) => setField("round_trip_miles", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Uber">
                  <Checkbox
                    checked={isUber}
                    onChange={(v) => setField("transport_mode", v ? "uber" : "drive")}
                    label="Use Uber for this event"
                  />
                </FieldRow>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Money
                </h3>
                <FieldRow label="Subtotal pre-tax">
                  <TextInput
                    type="number"
                    step="0.01"
                    value={current.subtotal_pretax == null ? "" : String(current.subtotal_pretax)}
                    onChange={(v) => setField("subtotal_pretax", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Total with tax">
                  <TextInput
                    type="number"
                    step="0.01"
                    value={current.total_with_tax == null ? "" : String(current.total_with_tax)}
                    onChange={(v) => setField("total_with_tax", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Deposit">
                  <TextInput
                    type="number"
                    step="0.01"
                    value={current.deposit_amount == null ? "" : String(current.deposit_amount)}
                    onChange={(v) => setField("deposit_amount", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Signed total">
                  <TextInput
                    type="number"
                    step="0.01"
                    value={current.signed_contract_total == null ? "" : String(current.signed_contract_total)}
                    onChange={(v) => setField("signed_contract_total", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Payment status">
                  <SelectInput
                    value={current.payment_status}
                    onChange={(v) => setField("payment_status", v)}
                    options={PAYMENT_STATUSES as unknown as string[]}
                  />
                </FieldRow>
                <FieldRow label="Amount paid">
                  <TextInput
                    type="number"
                    step="0.01"
                    value={current.amount_paid == null ? "" : String(current.amount_paid)}
                    onChange={(v) => setField("amount_paid", numericInput(v))}
                  />
                </FieldRow>
                <FieldRow label="Tax exempt">
                  <ToggleYesNo
                    value={current.tax_exempt === 1}
                    onChange={(v) => setField("tax_exempt", v ? 1 : 0)}
                  />
                </FieldRow>
                <FieldRow label="Minimum order">
                  <Checkbox
                    checked={current.minimum_order_override === 1}
                    onChange={(v) =>
                      setField("minimum_order_override", v ? 1 : 0)
                    }
                    label="Override to $500 ice-cream minimum"
                  />
                </FieldRow>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Notes
                </h3>
                <TextArea
                  value={current.notes ?? ""}
                  onChange={(v) => setField("notes", v || null)}
                  rows={5}
                  placeholder="Internal notes — visible to the team only."
                />
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Pipeline (read only)
                </h3>
                <ReadOnlyRow label="Boomerang" value={current.boomerang_reason} />
                <ReadOnlyRow
                  label="Last outbound"
                  value={fmtEasternDateTime(current.last_outbound_at)}
                />
                <ReadOnlyRow label="Active" value={boolish(current.is_active)} />
                <ReadOnlyRow label="Lead source" value={current.lead_source} />
                <ReadOnlyRow label="How heard" value={current.how_did_you_hear} />
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Meta
                </h3>
                <ReadOnlyRow
                  label="Event date (formatted)"
                  value={fmtEasternDate(current.event_date)}
                />
                <ReadOnlyRow
                  label="Start (formatted)"
                  value={fmtEasternTime(current.event_start_time)}
                />
                <ReadOnlyRow
                  label="Created"
                  value={fmtEasternDateTime(current.created_at)}
                />
                <ReadOnlyRow
                  label="Updated"
                  value={fmtEasternDateTime(current.updated_at)}
                />
              </section>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
