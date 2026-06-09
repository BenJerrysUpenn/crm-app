"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { missingRequiredFields } from "@/lib/required";

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

  // When a job finishes successfully, re-fetch the deal row so any
  // fields the worker wrote (drive_minutes, staff_count, labor_hours,
  // mileage_charge_eligible, last_outbound_at, etc.) appear in the
  // drawer without a manual reload. Errors leave the row alone.
  //
  // refetchedJobIdsRef guards against re-firing on every render. The
  // parent passes a fresh `onDealUpdate` arrow function each render
  // (its identity changes constantly), so without this ref the effect
  // would call setEdits({}) on every keystroke and the user could
  // never type a value into any field while a previous job's status
  // is still "done".
  const refetchedJobIdsRef = useRef<Set<number>>(new Set());
  // Mobile-only: which column is showing. Desktop renders both
  // side-by-side and ignores this state.
  const [mobileTab, setMobileTab] = useState<"email" | "details">("details");
  useEffect(() => {
    if (quoteJob?.status !== "done") return;
    if (refetchedJobIdsRef.current.has(quoteJob.id)) return;
    refetchedJobIdsRef.current.add(quoteJob.id);
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("deals")
        .select("*")
        .eq("id", deal.id)
        .single();
      if (cancelled || error || !data) return;
      setEdits({});
      onDealUpdate?.(data as Deal);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, quoteJob?.status, quoteJob?.id, deal.id, onDealUpdate]);

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
    // Keep cart_service column in sync with whether "Ice Cream Cart"
    // is present in the extras list. They're stored separately but
    // semantically the same signal; without this sync the staff math
    // keeps forcing min 2 staff on a deal where the cart was removed.
    if ("extras" in edits) {
      const extrasStr =
        typeof edits.extras === "string" ? edits.extras : current.extras ?? "";
      const hasCart = /ice\s*cream\s*cart/i.test(extrasStr);
      updates.cart_service = hasCart ? 1 : 0;
    }
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

  async function requestJob(
    kind:
      | "quote"
      | "picklist"
      | "decline_below_min"
      | "decline_too_far"
      | "followup"
      | "retriage",
  ) {
    if (quoteRequesting) return;
    if (hasChanges) {
      setError(`Save changes before queueing ${kind}.`);
      return;
    }
    setQuoteRequesting(true);
    setError(null);
    const { data, error } = await supabase
      .from("quote_jobs")
      .insert({
        deal_id: deal.id,
        status: "pending",
        kind,
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

  const jobInFlight =
    quoteJob !== null &&
    (quoteJob.status === "pending" || quoteJob.status === "running");
  const jobKind = quoteJob?.kind ?? "quote";

  // Multi-select binding helpers.
  const flavorsSelected = parseFlavorsField(current.flavors);
  const extrasSelected = parseExtrasField(current.extras);
  // Source of truth: mileage_charge_eligible (1 = we drove, charged mileage;
  // 0 = we ubered). transport_mode is the picklist-side derived cache.
  // Uber checked → mileage_charge_eligible = 0.
  const isUber = current.mileage_charge_eligible === 0;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex justify-end"
      onClick={onClose}
    >
      <aside
        className="bg-slate-900 w-full max-w-5xl h-full flex flex-col shadow-2xl border-l border-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 sm:px-5 py-3 sm:py-4 border-b border-slate-800 bg-slate-900 flex items-start justify-between gap-2 sm:gap-3 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-base sm:text-lg text-slate-100 truncate">
              {current.company || contact || `Deal #${current.id}`}
            </h2>
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
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
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap justify-end max-w-[60%] sm:max-w-none">
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
              className="text-xs sm:text-sm bg-sky-500/20 text-sky-200 border border-sky-500/40 rounded-md px-2 sm:px-3 py-1 sm:py-1.5 hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : hasChanges ? `Save ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? "" : "s"}` : "Saved"}
            </button>
            <button
              type="button"
              onClick={() => requestJob("quote")}
              disabled={quoteRequesting || jobInFlight}
              className="text-xs sm:text-sm bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 rounded-md px-2 sm:px-3 py-1 sm:py-1.5 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Generate the quote PDF and attach as a Gmail draft reply"
            >
              {jobKind === "quote" && quoteRequesting
                ? "Queueing…"
                : jobKind === "quote" && quoteJob?.status === "pending"
                ? "Queued…"
                : jobKind === "quote" && quoteJob?.status === "running"
                ? "Generating…"
                : jobKind === "quote" && quoteJob?.status === "done"
                ? "Quote ready ✓"
                : "Generate quote"}
            </button>
            <button
              type="button"
              onClick={() => requestJob("picklist")}
              disabled={quoteRequesting || jobInFlight}
              className="text-xs sm:text-sm bg-violet-500/20 text-violet-200 border border-violet-500/40 rounded-md px-2 sm:px-3 py-1 sm:py-1.5 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Render the picklist DOCX and draft an internal email to Sophia"
            >
              {jobKind === "picklist" && quoteRequesting
                ? "Queueing…"
                : jobKind === "picklist" && quoteJob?.status === "pending"
                ? "Queued…"
                : jobKind === "picklist" && quoteJob?.status === "running"
                ? "Building…"
                : jobKind === "picklist" && quoteJob?.status === "done"
                ? "Picklist ready ✓"
                : "Create picklist"}
            </button>
            {(current.stage === "Sent Quote" ||
              current.stage === "Booked Unpaid" ||
              current.stage === "Booked Paid") && (
              <button
                type="button"
                onClick={() => requestJob("followup")}
                disabled={quoteRequesting || jobInFlight}
                className="text-xs sm:text-sm bg-sky-500/20 text-sky-200 border border-sky-500/40 rounded-md px-2 sm:px-3 py-1 sm:py-1.5 hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Draft a polite follow-up email (uses boomerang reason: quote_reply / deposit_due / balance_due)"
              >
                {jobKind === "followup" && quoteRequesting
                  ? "Queueing…"
                  : jobKind === "followup" && quoteJob?.status === "pending"
                  ? "Queued…"
                  : jobKind === "followup" && quoteJob?.status === "running"
                  ? "Drafting…"
                  : jobKind === "followup" && quoteJob?.status === "done"
                  ? "Follow-up drafted ✓"
                  : "Follow up"}
              </button>
            )}
            <button
              type="button"
              onClick={() => requestJob("retriage")}
              disabled={quoteRequesting || jobInFlight}
              className="text-xs sm:text-sm bg-slate-700/40 text-slate-200 border border-slate-600 rounded-md px-2 sm:px-3 py-1 sm:py-1.5 hover:bg-slate-700/60 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Recompute drive_minutes, mileage rule, staff_count, labor_hours from venue + event times. Formulas only, no AI."
            >
              {jobKind === "retriage" && quoteRequesting
                ? "Queueing…"
                : jobKind === "retriage" && quoteJob?.status === "pending"
                ? "Queued…"
                : jobKind === "retriage" && quoteJob?.status === "running"
                ? "Recomputing…"
                : jobKind === "retriage" && quoteJob?.status === "done"
                ? "Recalculated ✓"
                : "Recalculate"}
            </button>
            {current.stage === "Open" && (
              <>
                <button
                  type="button"
                  onClick={() => requestJob("decline_below_min")}
                  disabled={quoteRequesting || jobInFlight}
                  className="text-xs sm:text-sm bg-amber-500/20 text-amber-200 border border-amber-500/40 rounded-md px-2 sm:px-3 py-1 sm:py-1.5 hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Draft a polite decline pointing the customer to pick-up / Uber Eats (under $500 minimum)"
                >
                  {jobKind === "decline_below_min" && quoteRequesting
                    ? "Queueing…"
                    : jobKind === "decline_below_min" &&
                      quoteJob?.status === "pending"
                    ? "Queued…"
                    : jobKind === "decline_below_min" &&
                      quoteJob?.status === "running"
                    ? "Drafting…"
                    : jobKind === "decline_below_min" &&
                      quoteJob?.status === "done"
                    ? "Below min drafted ✓"
                    : "Below min"}
                </button>
                <button
                  type="button"
                  onClick={() => requestJob("decline_too_far")}
                  disabled={quoteRequesting || jobInFlight}
                  className="text-xs sm:text-sm bg-rose-500/20 text-rose-200 border border-rose-500/40 rounded-md px-2 sm:px-3 py-1 sm:py-1.5 hover:bg-rose-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Draft a polite decline (venue outside the driving range)"
                >
                  {jobKind === "decline_too_far" && quoteRequesting
                    ? "Queueing…"
                    : jobKind === "decline_too_far" &&
                      quoteJob?.status === "pending"
                    ? "Queued…"
                    : jobKind === "decline_too_far" &&
                      quoteJob?.status === "running"
                    ? "Drafting…"
                    : jobKind === "decline_too_far" &&
                      quoteJob?.status === "done"
                    ? "Too far drafted ✓"
                    : "Too far"}
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-200 text-xl leading-none ml-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {(() => {
          const missing = missingRequiredFields(current);
          if (missing.length === 0) return null;
          if (current.stage.startsWith("Closed")) return null;
          const labels = missing.map((m) => m.label).join(", ");
          return (
            <div className="px-5 py-1.5 border-b border-rose-900/60 bg-rose-950/30 text-xs text-rose-200/90 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-500/30 text-rose-200 font-bold text-[10px] flex-shrink-0">
                !
              </span>
              <span className="text-rose-300 font-medium uppercase tracking-wide text-[10px]">
                Missing
              </span>
              <span className="text-rose-100 truncate">{labels}</span>
              <span className="text-rose-500/70 text-[10px] ml-auto flex-shrink-0">
                for {current.stage}
              </span>
            </div>
          );
        })()}
        {(error || quoteJob?.error_message) && (
          <div className="px-5 py-2 bg-rose-950 border-b border-rose-900 text-sm text-rose-200">
            {error || quoteJob?.error_message}
          </div>
        )}
        {quoteJob?.status === "done" && (
          <div className="px-5 py-2 bg-emerald-950 border-b border-emerald-900 text-sm text-emerald-200">
            {jobKind === "picklist"
              ? "Picklist drafted in Gmail to Sophia. Check your drafts folder to review and send."
              : jobKind === "decline_below_min" ||
                jobKind === "decline_too_far"
              ? "Decline drafted in Gmail. Check your drafts folder to review and send."
              : jobKind === "followup"
              ? "Follow-up drafted in Gmail. Check your drafts folder to review and send."
              : jobKind === "retriage"
              ? "Recalculation complete. Drive time, mileage rule, staff count, and labor hours refreshed from the venue / event times."
              : "Quote drafted in Gmail. Check your drafts folder to review and send."}
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

        {/* Mobile-only tab switcher. Hidden ≥sm where both columns
            render side-by-side. */}
        <div className="sm:hidden border-b border-slate-800 bg-slate-900 flex flex-shrink-0">
          <button
            type="button"
            onClick={() => setMobileTab("details")}
            className={`flex-1 px-3 py-2 text-xs uppercase tracking-wide font-semibold ${
              mobileTab === "details"
                ? "text-slate-100 border-b-2 border-sky-500"
                : "text-slate-500 border-b-2 border-transparent"
            }`}
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => setMobileTab("email")}
            className={`flex-1 px-3 py-2 text-xs uppercase tracking-wide font-semibold ${
              mobileTab === "email"
                ? "text-slate-100 border-b-2 border-sky-500"
                : "text-slate-500 border-b-2 border-transparent"
            }`}
          >
            Email history
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left: chat-style message timeline. Visible on mobile only
              when the Email tab is active; always visible on ≥sm. */}
          <div
            className={`flex-1 min-w-0 flex-col bg-slate-950/40 sm:border-r sm:border-slate-800 ${
              mobileTab === "email" ? "flex" : "hidden sm:flex"
            }`}
          >
            <div className="hidden sm:flex px-5 py-3 border-b border-slate-800 items-center justify-between flex-shrink-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Email history
              </h3>
              <span className="text-[11px] text-slate-500">oldest → newest</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              <MessageTimeline dealId={deal.id} />
            </div>
          </div>

          {/* Right: editable detail fields. Full-width on mobile when
              Details tab is active; fixed 460px column on ≥sm. */}
          <div
            className={`w-full sm:w-[460px] flex-shrink-0 overflow-y-auto ${
              mobileTab === "details" ? "block" : "hidden sm:block"
            }`}
          >
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
                <FieldRow label="Arrival">
                  <TextInput
                    type="time"
                    value={current.arrival_time ?? ""}
                    onChange={(v) => setField("arrival_time", v || null)}
                    placeholder="Auto-set by Recalculate"
                  />
                </FieldRow>
                <FieldRow label="Departure">
                  <TextInput
                    type="time"
                    value={current.departure_time ?? ""}
                    onChange={(v) => setField("departure_time", v || null)}
                    placeholder="Auto-set by Recalculate"
                  />
                </FieldRow>
                <FieldRow label="Type">
                  <TextInput
                    value={current.event_type ?? ""}
                    onChange={(v) => setField("event_type", v || null)}
                  />
                </FieldRow>
                <FieldRow label="Event name">
                  <TextInput
                    value={current.event_name ?? ""}
                    onChange={(v) => setField("event_name", v || null)}
                    placeholder={
                      [current.company, current.event_type]
                        .filter(Boolean)
                        .join(" ") || "Auto: {company} {type}"
                    }
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
                <FieldRow label="Setups">
                  <TextInput
                    type="number"
                    value={current.setup_count == null ? "" : String(current.setup_count)}
                    onChange={(v) => setField("setup_count", numericInput(v))}
                    placeholder="1 setup (or 2 if scoopers split tables)"
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
                <FieldRow label="Drive minutes">
                  <TextInput
                    type="number"
                    step="1"
                    value={current.drive_minutes == null ? "" : String(current.drive_minutes)}
                    onChange={(v) => setField("drive_minutes", numericInput(v))}
                    placeholder="Auto-set by Recalculate"
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
                    onChange={(v) =>
                      setField("mileage_charge_eligible", v ? 0 : 1)
                    }
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
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Picklist summary
                  </h3>
                  <span className="text-[11px] text-slate-500">
                    auto-filled by the sweep
                  </span>
                </div>
                <TextArea
                  value={current.picklist_notes ?? ""}
                  onChange={(v) => setField("picklist_notes", v || null)}
                  rows={3}
                  placeholder="Max 30 words. New vs returning client, outdoor, allergies, special requests. Skip what's already on the picklist (flavors, address, etc.)."
                />
                {(() => {
                  const words = (current.picklist_notes ?? "")
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean).length;
                  const over = words > 30;
                  return (
                    <div
                      className={`mt-1 text-[11px] ${
                        over ? "text-rose-300" : "text-slate-500"
                      }`}
                    >
                      {words} / 30 words{over ? " — trim it" : ""}
                    </div>
                  );
                })()}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Activity log (auto, read-only)
                </h3>
                {current.notes ? (
                  <div className="text-xs text-slate-300 whitespace-pre-wrap bg-slate-800/60 rounded p-3 border border-slate-800 max-h-48 overflow-y-auto font-mono">
                    {current.notes}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 italic">
                    No entries.
                  </div>
                )}
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
