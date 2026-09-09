"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { defaultExtraQuantity, EXTRA_BY_LABEL } from "@/lib/menuOptions";
import {
  belowMinimum,
  EMPTY_DEAL_FORM_PAYLOAD,
  hasErrors,
  validateDealPayload,
  type DealFormErrors,
  type DealFormPayload,
} from "@/lib/callDesk/dealForm";
import {
  defaultQuantityForExtra,
  type DealFormExtraOption,
  type DealFormOptionsResponse,
} from "@/lib/callDesk/options";

// The queue UI (built on feature/409-call-desk) renders this component; the
// prop contract below is fixed by the build contract in docs/call-desk.md.
export type CallDeskProspect = {
  prospect_id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
};

type DryRunResponse = {
  dry_run: true;
  reason?: string;
  deal_insert: Record<string, unknown>;
  quote_jobs: { kind: string }[];
};

type LiveResponse = {
  deal_id: number;
  quote_job_ids: number[];
  warnings?: string[];
};

// ---------------------------------------------------------------------------
// Small presentational pieces. Every tappable thing is >= 44px tall.
// ---------------------------------------------------------------------------

const TAP = "min-h-[44px]";
const INPUT =
  "w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-md px-3 py-2.5 text-base " +
  "placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500 " +
  TAP;

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-slate-800 pt-4 mt-4 first:border-0 first:mt-0 first:pt-0">
      <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-3">
        <span className="text-slate-600 mr-2">{step}</span>
        {title}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-slate-300">
        {label}
        {required && <span className="text-rose-400 ml-0.5">*</span>}
      </span>
      {children}
      {hint && !error && (
        <span className="text-xs text-slate-500">{hint}</span>
      )}
      {error && <span className="text-xs text-rose-400">{error}</span>}
    </label>
  );
}

function Chip({
  selected,
  onClick,
  children,
  title,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`${TAP} text-left text-sm rounded-md px-3 py-2 border transition ${
        selected
          ? "bg-sky-500/20 border-sky-500/60 text-sky-100"
          : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600"
      }`}
    >
      {children}
    </button>
  );
}

function YesNo({
  value,
  onChange,
  yesLabel = "Yes",
  noLabel = "No",
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  yesLabel?: string;
  noLabel?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Chip selected={!value} onClick={() => onChange(false)}>
        {noLabel}
      </Chip>
      <Chip selected={value} onClick={() => onChange(true)}>
        {yesLabel}
      </Chip>
    </div>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** One-line summary of what a package includes, from the pricing row. */
function packageIncludes(p: DealFormOptionsResponse["packages"][number]): string {
  const bits: string[] = [`${p.flavors_included} flavors`];
  if (p.dry_toppings_count > 0) bits.push(`${p.dry_toppings_count} toppings`);
  if (p.includes_waffle_cones) bits.push("waffle cones");
  if (p.includes_sauce) bits.push("sauce");
  if (p.includes_whipped_cream) bits.push("whipped cream");
  if (p.includes_cookies) bits.push("cookies");
  if (p.includes_brownies) bits.push("brownies");
  return bits.join(" · ");
}

function extraUnitLabel(e: DealFormExtraOption): string {
  if (e.price === 0) return "no charge";
  return e.per_serving_or_flat === "per_serving"
    ? `${money(e.price)}/serving`
    : `${money(e.price)} flat`;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export default function GenerateDealForm({
  prospect,
  callerEmail,
  onClose,
  onCreated,
}: {
  prospect: CallDeskProspect;
  callerEmail: string;
  onClose: () => void;
  onCreated: (dealId: number) => void;
}) {
  const [options, setOptions] = useState<DealFormOptionsResponse | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState<DealFormPayload>(() => {
    const full = (prospect.name ?? "").trim();
    const space = full.indexOf(" ");
    return {
      ...EMPTY_DEAL_FORM_PAYLOAD,
      contact_first_name: space === -1 ? full : full.slice(0, space),
      contact_last_name: space === -1 ? "" : full.slice(space + 1).trim(),
      company: prospect.company ?? "",
      contact_email: prospect.email ?? "",
      contact_phone: prospect.phone ?? "",
    };
  });
  // Extras are held as name → quantity and flattened to the repeated-name list
  // the DB stores only at submit time.
  const [extraQty, setExtraQty] = useState<Record<string, number>>({});

  const [errors, setErrors] = useState<DealFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [live, setLive] = useState<LiveResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setOptionsError(null);
      try {
        const res = await fetch("/api/call-desk/options");
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setOptionsError(body.error || `Options failed (${res.status})`);
        } else {
          setOptions(body as DealFormOptionsResponse);
        }
      } catch (e) {
        if (!cancelled)
          setOptionsError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = useCallback(
    <K extends keyof DealFormPayload>(key: K, value: DealFormPayload[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  const extrasList = useMemo(() => {
    const out: string[] = [];
    for (const [name, qty] of Object.entries(extraQty)) {
      for (let i = 0; i < qty; i++) out.push(name);
    }
    return out;
  }, [extraQty]);

  const selectedPackage = useMemo(
    () => options?.packages.find((p) => p.name === form.package_name) ?? null,
    [options, form.package_name],
  );

  const guests = form.guest_count;
  const estimate =
    selectedPackage && guests ? guests * selectedPackage.price : null;
  const isBelowMinimum = belowMinimum(
    guests,
    selectedPackage?.price,
    options?.minimum_order,
  );

  const flavorsIncluded = options?.flavors_included ?? 0;
  const maxFlavors = options?.max_flavors ?? 0;

  function toggleFlavor(name: string) {
    const has = form.flavors.includes(name);
    if (!has && maxFlavors && form.flavors.length >= maxFlavors) return;
    set(
      "flavors",
      has ? form.flavors.filter((f) => f !== name) : [...form.flavors, name],
    );
  }

  function toggleTopping(name: string) {
    const has = form.toppings.includes(name);
    set(
      "toppings",
      has ? form.toppings.filter((t) => t !== name) : [...form.toppings, name],
    );
  }

  function toggleExtra(extra: DealFormExtraOption) {
    setExtraQty((prev) => {
      const next = { ...prev };
      if (next[extra.name]) {
        delete next[extra.name];
        return next;
      }
      next[extra.name] = defaultQuantityForExtra(
        extra,
        form.guest_count,
        (label) =>
          EXTRA_BY_LABEL.has(label)
            ? defaultExtraQuantity(label, form.guest_count)
            : null,
      );
      return next;
    });
  }

  function setExtraQuantity(name: string, qty: number) {
    setExtraQty((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(qty) || qty <= 0) delete next[name];
      else next[name] = Math.trunc(qty);
      return next;
    });
  }

  async function submit() {
    if (submitting) return;
    const payload = { ...form, extras: extrasList };
    const found = validateDealPayload(payload, { maxFlavors });
    setErrors(found);
    if (hasErrors(found)) {
      setSubmitError("Some fields need fixing — see the red notes above.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setDryRun(null);
    try {
      const res = await fetch("/api/call-desk/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          prospect_id: prospect.prospect_id,
          customer_profile_label:
            options?.customer_profiles.find(
              (p) => p.value === form.customer_profile,
            )?.label ?? "",
          max_flavors: maxFlavors || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.field_errors) setErrors(body.field_errors as DealFormErrors);
        setSubmitError(body.error || `Create failed (${res.status})`);
        return;
      }
      if (body.dry_run) {
        setDryRun(body as DryRunResponse);
        return;
      }
      const created = body as LiveResponse;
      setLive(created);
      onCreated(created.deal_id);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------

  const shell = (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex sm:items-center sm:justify-center sm:p-6">
      <div className="bg-slate-950 border border-slate-800 w-full h-full sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-xl flex flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60 shrink-0">
          <div className="min-w-0">
            <h2 className="text-slate-100 font-semibold truncate">
              Generate deal
            </h2>
            <p className="text-xs text-slate-400 truncate">
              {prospect.name || "Unnamed prospect"}
              {prospect.company ? ` · ${prospect.company}` : ""} · prospect #
              {prospect.prospect_id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`${TAP} px-3 rounded-md border border-slate-700 bg-slate-800 text-slate-300 hover:text-slate-100 shrink-0`}
          >
            Close
          </button>
        </header>
        {renderBody()}
      </div>
    </div>
  );

  function renderBody() {
    if (loading)
      return (
        <div className="flex-1 flex items-center justify-center text-slate-400 text-sm p-8">
          Loading options…
        </div>
      );

    if (optionsError)
      return (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
            <p className="font-medium mb-1">Could not load the form options</p>
            <p className="text-rose-300/90">{optionsError}</p>
          </div>
        </div>
      );

    if (live)
      return (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-100">
            <p className="text-base font-semibold mb-1">
              Deal #{live.deal_id} created
            </p>
            <p className="text-emerald-200/90">
              The quote worker is pricing it now; the draft lands in Gmail
              Drafts for a human to send.
            </p>
            {live.quote_job_ids.length > 0 && (
              <p className="text-xs text-emerald-300/70 mt-2">
                Queued jobs: {live.quote_job_ids.join(", ")}
              </p>
            )}
            {live.warnings && live.warnings.length > 0 && (
              <ul className="mt-3 text-xs text-amber-300 list-disc pl-4 space-y-1">
                {live.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`${TAP} mt-4 w-full rounded-md bg-slate-800 border border-slate-700 text-slate-200`}
          >
            Back to the queue
          </button>
        </div>
      );

    if (!options) return null;

    return (
      <>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {dryRun && <DryRunPanel result={dryRun} onDismiss={() => setDryRun(null)} />}

          <Section step={1} title="Contact">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                label="First name"
                required
                error={errors.contact_first_name}
              >
                <input
                  className={INPUT}
                  value={form.contact_first_name}
                  onChange={(e) => set("contact_first_name", e.target.value)}
                />
              </Field>
              <Field label="Last name">
                <input
                  className={INPUT}
                  value={form.contact_last_name}
                  onChange={(e) => set("contact_last_name", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Email" required error={errors.contact_email}>
              <input
                className={INPUT}
                type="email"
                inputMode="email"
                autoCapitalize="off"
                value={form.contact_email}
                onChange={(e) => set("contact_email", e.target.value)}
              />
            </Field>
            <Field label="Phone" required error={errors.contact_phone}>
              <input
                className={INPUT}
                type="tel"
                inputMode="tel"
                value={form.contact_phone}
                onChange={(e) => set("contact_phone", e.target.value)}
              />
            </Field>
            <Field label="Company">
              <input
                className={INPUT}
                value={form.company}
                onChange={(e) => set("company", e.target.value)}
              />
            </Field>
          </Section>

          <Section step={2} title="Customer profile">
            <p className="text-xs text-slate-500 -mt-1">
              Reference only — there is no deal column for it yet, so the pick
              is recorded in the deal notes.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {options.customer_profiles.map((p) => (
                <Chip
                  key={p.value}
                  selected={form.customer_profile === p.value}
                  onClick={() =>
                    set(
                      "customer_profile",
                      form.customer_profile === p.value ? "" : p.value,
                    )
                  }
                >
                  <span className="block">{p.label}</span>
                  {p.hint && (
                    <span className="block text-[11px] text-slate-500">
                      {p.hint}
                    </span>
                  )}
                </Chip>
              ))}
            </div>
          </Section>

          <Section step={3} title="Event">
            <Field label="Event type" required error={errors.event_type}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {options.event_types.map((t) => (
                  <Chip
                    key={t.value}
                    selected={form.event_type === t.value}
                    onClick={() => set("event_type", t.value)}
                    title={t.hint ?? undefined}
                  >
                    <span className="block">{t.label}</span>
                    {t.hint && (
                      <span className="block text-[11px] text-slate-500">
                        {t.hint}
                      </span>
                    )}
                  </Chip>
                ))}
              </div>
            </Field>
            <Field label="Event name">
              <input
                className={INPUT}
                value={form.event_name}
                onChange={(e) => set("event_name", e.target.value)}
                placeholder="e.g. Sarah's 40th"
              />
            </Field>
            <Field label="Date" required error={errors.event_date}>
              <input
                className={INPUT}
                type="date"
                value={form.event_date}
                onChange={(e) => set("event_date", e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start" required error={errors.event_start_time}>
                <input
                  className={INPUT}
                  type="time"
                  value={form.event_start_time}
                  onChange={(e) => set("event_start_time", e.target.value)}
                />
              </Field>
              <Field label="End" required error={errors.event_end_time}>
                <input
                  className={INPUT}
                  type="time"
                  value={form.event_end_time}
                  onChange={(e) => set("event_end_time", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Venue name">
              <input
                className={INPUT}
                value={form.venue_name}
                onChange={(e) => set("venue_name", e.target.value)}
              />
            </Field>
            <Field
              label="Venue address"
              required
              error={errors.venue_address}
              hint="Street, city, state — the worker measures drive time from it."
            >
              <textarea
                className={`${INPUT} min-h-[72px]`}
                value={form.venue_address}
                onChange={(e) => set("venue_address", e.target.value)}
              />
            </Field>
            <Field label="Guest count" required error={errors.guest_count}>
              <input
                className={INPUT}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={form.guest_count ?? ""}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  set("guest_count", Number.isFinite(n) ? n : null);
                }}
              />
            </Field>
            <Field label="Outdoors?">
              <YesNo
                value={form.is_outdoor}
                onChange={(v) => set("is_outdoor", v)}
                noLabel="Indoors"
                yesLabel="Outdoors"
              />
            </Field>
          </Section>

          <Section step={4} title="Package">
            <div className="flex flex-col gap-2">
              {options.packages.map((p) => (
                <Chip
                  key={p.name}
                  selected={form.package_name === p.name}
                  onClick={() => set("package_name", p.name)}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span>{p.name}</span>
                    <span className="text-xs text-slate-400 shrink-0">
                      {money(p.price)}/guest
                    </span>
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {packageIncludes(p)}
                  </span>
                </Chip>
              ))}
            </div>
            {errors.package_name && (
              <span className="text-xs text-rose-400">
                {errors.package_name}
              </span>
            )}
            {estimate != null && (
              <p className="text-xs text-slate-400">
                {guests} guests × {money(selectedPackage!.price)} ={" "}
                <span className="text-slate-200">{money(estimate)}</span> before
                extras, labor, travel and tax.
              </p>
            )}
            {isBelowMinimum && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                Below the {money(options.minimum_order)} ice-cream minimum — the
                machine will flag it.
              </p>
            )}
          </Section>

          <Section step={5} title="Flavors">
            <p className="text-xs text-slate-500 -mt-1">
              {form.flavors.length} picked · {flavorsIncluded} included
              {maxFlavors ? ` · up to ${maxFlavors}` : ""}
              {flavorsIncluded > 0 && form.flavors.length > flavorsIncluded
                ? " · extras are billed per additional flavor"
                : ""}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {options.flavors.map((f) => {
                const picked = form.flavors.includes(f.name);
                const full =
                  !picked && maxFlavors > 0 && form.flavors.length >= maxFlavors;
                const tags = [
                  f.gf ? "GF" : null,
                  f.vegan ? "V" : null,
                  ...(f.allergens ?? []),
                ].filter(Boolean);
                return (
                  <button
                    key={f.name}
                    type="button"
                    disabled={full}
                    onClick={() => toggleFlavor(f.name)}
                    className={`${TAP} text-left text-sm rounded-md px-3 py-2 border transition ${
                      picked
                        ? "bg-sky-500/20 border-sky-500/60 text-sky-100"
                        : full
                          ? "bg-slate-900 border-slate-800 text-slate-600"
                          : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600"
                    }`}
                  >
                    <span className="block">{f.name}</span>
                    {tags.length > 0 && (
                      <span className="block text-[11px] text-slate-500">
                        {tags.join(" · ")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {errors.flavors && (
              <span className="text-xs text-rose-400">{errors.flavors}</span>
            )}
          </Section>

          <Section step={6} title="Toppings">
            <div className="grid grid-cols-2 gap-2">
              {options.toppings.map((t) => (
                <Chip
                  key={t}
                  selected={form.toppings.includes(t)}
                  onClick={() => toggleTopping(t)}
                >
                  {t}
                </Chip>
              ))}
            </div>
          </Section>

          <Section step={7} title="Extras">
            <div className="flex flex-col gap-2">
              {options.extras.map((e) => {
                const qty = extraQty[e.name] ?? 0;
                const picked = qty > 0;
                return (
                  <div key={e.name} className="flex flex-col gap-1">
                    <Chip selected={picked} onClick={() => toggleExtra(e)}>
                      <span className="flex items-baseline justify-between gap-2">
                        <span>{e.name}</span>
                        <span className="text-xs text-slate-400 shrink-0">
                          {extraUnitLabel(e)}
                        </span>
                      </span>
                      {e.notes && (
                        <span className="block text-[11px] text-slate-500 line-clamp-2">
                          {e.notes}
                        </span>
                      )}
                    </Chip>
                    {picked && (
                      <div className="flex items-center gap-2 pl-3">
                        <span className="text-xs text-slate-400">Qty</span>
                        <button
                          type="button"
                          onClick={() => setExtraQuantity(e.name, qty - 1)}
                          className={`${TAP} w-11 rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-lg`}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={qty}
                          onChange={(ev) =>
                            setExtraQuantity(
                              e.name,
                              parseInt(ev.target.value, 10),
                            )
                          }
                          className={`${TAP} w-20 text-center bg-slate-800 border border-slate-700 text-slate-100 rounded-md px-2`}
                        />
                        <button
                          type="button"
                          onClick={() => setExtraQuantity(e.name, qty + 1)}
                          className={`${TAP} w-11 rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-lg`}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section step={8} title="Details">
            <Field label="Tax exempt?">
              <YesNo
                value={form.tax_exempt}
                onChange={(v) => set("tax_exempt", v)}
              />
            </Field>
            <Field label="How did you hear about us?">
              <input
                className={INPUT}
                value={form.how_did_you_hear}
                onChange={(e) => set("how_did_you_hear", e.target.value)}
                placeholder="in the customer's own words"
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Day-of contact name">
                <input
                  className={INPUT}
                  value={form.day_of_contact_name}
                  onChange={(e) => set("day_of_contact_name", e.target.value)}
                />
              </Field>
              <Field label="Day-of contact phone">
                <input
                  className={INPUT}
                  type="tel"
                  inputMode="tel"
                  value={form.day_of_contact_phone}
                  onChange={(e) => set("day_of_contact_phone", e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="First note"
              hint="Goes into the deal notes, date-prefixed, under the call-desk line."
            >
              <textarea
                className={`${INPUT} min-h-[88px]`}
                value={form.first_note}
                onChange={(e) => set("first_note", e.target.value)}
                placeholder="anything the quote writer should know"
              />
            </Field>
          </Section>
        </div>

        <footer className="border-t border-slate-800 bg-slate-900/60 px-4 py-3 shrink-0">
          {submitError && (
            <p className="text-sm text-rose-300 mb-2">{submitError}</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className={`${TAP} flex-1 rounded-md bg-slate-800 border border-slate-700 text-slate-300`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className={`${TAP} flex-[2] rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-medium`}
            >
              {submitting ? "Creating…" : "Create deal"}
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-2 text-center">
            Creates at stage Open, source phone, lead source {callerEmail}.
          </p>
        </footer>
      </>
    );
  }

  return shell;
}

// ---------------------------------------------------------------------------
// Dry-run panel — a readable list of the would-be row, not a JSON dump.
// ---------------------------------------------------------------------------

const DRY_RUN_LABELS: [string, string][] = [
  ["stage", "Stage"],
  ["source", "Source"],
  ["payment_status", "Payment status"],
  ["contact_first_name", "First name"],
  ["contact_last_name", "Last name"],
  ["contact_email", "Email"],
  ["contact_phone", "Phone"],
  ["company", "Company"],
  ["event_type", "Event type"],
  ["event_name", "Event name"],
  ["event_date", "Date"],
  ["event_start_time", "Start"],
  ["event_end_time", "End"],
  ["venue_name", "Venue"],
  ["venue_address", "Venue address"],
  ["guest_count", "Guests"],
  ["is_outdoor", "Outdoors (0/1)"],
  ["package_name", "Package"],
  ["flavors", "Flavors"],
  ["toppings", "Toppings"],
  ["extras", "Extras"],
  ["cart_service", "Cart service (0/1)"],
  ["tax_exempt", "Tax exempt (0/1)"],
  ["how_did_you_hear", "How did you hear"],
  ["day_of_contact_name", "Day-of contact"],
  ["day_of_contact_phone", "Day-of phone"],
  ["lead_source", "Lead source"],
  ["created_at", "Created at (UTC)"],
  ["notes", "Notes"],
];

function DryRunPanel({
  result,
  onDismiss,
}: {
  result: DryRunResponse;
  onDismiss: () => void;
}) {
  const row = result.deal_insert;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 mb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-amber-100 font-semibold">
            Dry run — nothing was written
          </p>
          <p className="text-xs text-amber-200/80 mt-0.5">
            {result.reason ??
              "Live writes are off until the write mechanism is ruled on."}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={`${TAP} px-3 rounded-md border border-amber-500/40 text-amber-200 text-sm shrink-0`}
        >
          Dismiss
        </button>
      </div>
      <dl className="mt-3 text-sm divide-y divide-amber-500/20">
        {DRY_RUN_LABELS.filter(
          ([key]) => row[key] !== null && row[key] !== undefined,
        ).map(([key, label]) => (
          <div key={key} className="flex gap-3 py-1.5">
            <dt className="w-36 shrink-0 text-amber-200/70 text-xs pt-0.5">
              {label}
            </dt>
            <dd className="text-amber-50 text-xs whitespace-pre-wrap break-words min-w-0">
              {String(row[key])}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-amber-200/80 mt-3">
        Would also queue:{" "}
        {result.quote_jobs.map((j) => j.kind).join(" then ") || "nothing"} · log
        deal_created + handed_off on the prospect and set its status to
        handed_off.
      </p>
    </div>
  );
}
