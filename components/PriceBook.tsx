"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type {
  PricingPackage,
  PricingExtra,
  PricingTaxRate,
  PricingScalar,
  PricingLaborTier,
} from "@/lib/pricing";
import {
  EXTRA_ADVANCED_FIELDS,
  PACKAGE_ADVANCED_FIELDS,
} from "@/lib/pricing";

type SaveState = "idle" | "saving" | "saved" | "error";

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function MoneyInput({
  value,
  onChange,
  prefix = "$",
}: {
  value: number;
  onChange: (n: number) => void;
  prefix?: string;
}) {
  return (
    <div className="flex items-center">
      <span className="text-slate-500 text-xs mr-1">{prefix}</span>
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-24 bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
      />
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  step = "1",
  width = "w-20",
}: {
  value: number;
  onChange: (n: number) => void;
  step?: string;
  width?: string;
}) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className={`${width} bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500`}
    />
  );
}

// Number input that round-trips null cleanly. Empty input = null in DB;
// non-empty = numeric value. Used for the optional high-headcount
// override on labor tiers, where 0 is a corrupting value.
function NullableNumberInput({
  value,
  onChange,
  step = "1",
  width = "w-20",
  placeholder = "—",
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  step?: string;
  width?: string;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      step={step}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "" || raw === null) {
          onChange(null);
          return;
        }
        const n = parseFloat(raw);
        onChange(Number.isFinite(n) ? n : null);
      }}
      className={`${width} bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500 placeholder-slate-600`}
    />
  );
}

function TextField({
  value,
  onChange,
  width = "w-40",
}: {
  value: string | null;
  onChange: (s: string) => void;
  width?: string;
}) {
  return (
    <input
      type="text"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={`${width} bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500`}
    />
  );
}

function Checkbox({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={value}
      onChange={(e) => onChange(e.target.checked)}
      className="accent-sky-500"
    />
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const cls =
    state === "saving"
      ? "text-slate-400"
      : state === "saved"
      ? "text-emerald-300"
      : "text-rose-300";
  const text =
    state === "saving"
      ? "Saving…"
      : state === "saved"
      ? "Saved ✓"
      : "Error";
  return (
    <span className={`text-[11px] ml-2 ${cls}`}>{text}</span>
  );
}

// Section wrapper with collapse + Advanced toggle.
function Section({
  title,
  description,
  showAdvanced,
  onToggleAdvanced,
  advancedAvailable,
  children,
}: {
  title: string;
  description?: string;
  showAdvanced?: boolean;
  onToggleAdvanced?: (v: boolean) => void;
  advancedAvailable?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-950/60">
        <div>
          <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wide">
            {title}
          </h2>
          {description && (
            <p className="text-xs text-slate-500 mt-0.5">{description}</p>
          )}
        </div>
        {advancedAvailable && (
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!showAdvanced}
              onChange={(e) => onToggleAdvanced?.(e.target.checked)}
              className="accent-sky-500"
            />
            Edit advanced
          </label>
        )}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export default function PriceBook() {
  const supabase = useMemo(() => createClient(), []);

  const [packages, setPackages] = useState<PricingPackage[] | null>(null);
  const [extras, setExtras] = useState<PricingExtra[] | null>(null);
  const [tax, setTax] = useState<PricingTaxRate[] | null>(null);
  const [scalars, setScalars] = useState<PricingScalar[] | null>(null);
  const [tiers, setTiers] = useState<PricingLaborTier[] | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPkgAdvanced, setShowPkgAdvanced] = useState(false);
  const [showExtraAdvanced, setShowExtraAdvanced] = useState(false);

  const [saveStates, setSaveStates] = useState<
    Record<string, SaveState>
  >({});

  useEffect(() => {
    (async () => {
      const [p, e, t, s, l] = await Promise.all([
        supabase.from("pricing_packages").select("*").order("sort_order"),
        supabase.from("pricing_extras").select("*").order("sort_order"),
        supabase.from("pricing_tax_rates").select("*").order("sort_order"),
        supabase.from("pricing_scalars").select("*").order("sort_order"),
        supabase
          .from("pricing_labor_tiers")
          .select("*")
          .order("sort_order"),
      ]);
      if (p.error || e.error || t.error || s.error || l.error) {
        setLoadError(
          p.error?.message ??
            e.error?.message ??
            t.error?.message ??
            s.error?.message ??
            l.error?.message ??
            "Unknown error",
        );
        return;
      }
      setPackages((p.data ?? []) as PricingPackage[]);
      setExtras((e.data ?? []) as PricingExtra[]);
      setTax((t.data ?? []) as PricingTaxRate[]);
      setScalars((s.data ?? []) as PricingScalar[]);
      setTiers((l.data ?? []) as PricingLaborTier[]);
    })();
  }, [supabase]);

  // Generic save with debounce per row+field.
  function setSaveState(key: string, state: SaveState) {
    setSaveStates((prev) => ({ ...prev, [key]: state }));
    if (state === "saved") {
      window.setTimeout(() => {
        setSaveStates((prev) => {
          if (prev[key] !== "saved") return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, 1500);
    }
  }

  async function patchRow(
    table: string,
    pkColumn: string,
    pkValue: string,
    patch: Record<string, unknown>,
  ) {
    const key = `${table}:${pkValue}`;
    setSaveState(key, "saving");
    const { error } = await supabase
      .from(table)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq(pkColumn, pkValue);
    setSaveState(key, error ? "error" : "saved");
  }

  // --- Mutators -----------------------------------------------------------

  function updatePackage(
    name: string,
    patch: Partial<PricingPackage>,
  ) {
    setPackages((prev) =>
      prev
        ? prev.map((p) => (p.name === name ? { ...p, ...patch } : p))
        : prev,
    );
    patchRow("pricing_packages", "name", name, patch);
  }

  function updateExtra(name: string, patch: Partial<PricingExtra>) {
    setExtras((prev) =>
      prev
        ? prev.map((e) => (e.name === name ? { ...e, ...patch } : e))
        : prev,
    );
    patchRow("pricing_extras", "name", name, patch);
  }

  function updateTax(code: string, patch: Partial<PricingTaxRate>) {
    setTax((prev) =>
      prev
        ? prev.map((t) => (t.code === code ? { ...t, ...patch } : t))
        : prev,
    );
    patchRow("pricing_tax_rates", "code", code, patch);
  }

  function updateScalar(key: string, patch: Partial<PricingScalar>) {
    setScalars((prev) =>
      prev
        ? prev.map((s) => (s.key === key ? { ...s, ...patch } : s))
        : prev,
    );
    patchRow("pricing_scalars", "key", key, patch);
  }

  function updateTier(tier: string, patch: Partial<PricingLaborTier>) {
    setTiers((prev) =>
      prev
        ? prev.map((t) => (t.tier === tier ? { ...t, ...patch } : t))
        : prev,
    );
    patchRow("pricing_labor_tiers", "tier", tier, patch);
  }

  if (loadError) {
    return (
      <div className="p-6 text-rose-300">
        Could not load Price Book: {loadError}
      </div>
    );
  }
  if (
    packages == null ||
    extras == null ||
    tax == null ||
    scalars == null ||
    tiers == null
  ) {
    return (
      <div className="p-6 text-slate-500 text-sm">Loading price book…</div>
    );
  }

  return (
    <div className="overflow-y-auto h-full">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="mb-2">
          <h1 className="text-xl font-semibold text-slate-100">Price book</h1>
          <p className="text-sm text-slate-500 mt-1">
            Edits save automatically. The catering automation picks up
            changes on the next quote job (no restart needed).
          </p>
        </header>

        {/* ============================== PACKAGES */}
        <Section
          title="Packages"
          description="Per-serving price for each package. Advanced fields define what's included."
          showAdvanced={showPkgAdvanced}
          onToggleAdvanced={setShowPkgAdvanced}
          advancedAvailable
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-950/60 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Package</th>
                <th className="text-left px-4 py-2">Price / serving</th>
                {showPkgAdvanced && (
                  <>
                    <th className="text-left px-4 py-2">Flavours inc.</th>
                    <th className="text-left px-4 py-2">Dry topp.</th>
                    <th className="text-left px-4 py-2">Service</th>
                    <th className="text-left px-4 py-2">Waffle cones</th>
                    <th className="text-left px-4 py-2">Sauce</th>
                    <th className="text-left px-4 py-2">Whip</th>
                    <th className="text-left px-4 py-2">Cookies</th>
                    <th className="text-left px-4 py-2">Brownies</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.name} className="border-t border-slate-800">
                  <td className="px-4 py-2 text-slate-100 font-medium">
                    {p.name}
                    <SaveBadge state={saveStates[`pricing_packages:${p.name}`] ?? "idle"} />
                  </td>
                  <td className="px-4 py-2">
                    <MoneyInput
                      value={p.price}
                      onChange={(v) => updatePackage(p.name, { price: v })}
                    />
                  </td>
                  {showPkgAdvanced && (
                    <>
                      <td className="px-4 py-2">
                        <NumberInput
                          value={p.flavors_included}
                          onChange={(v) =>
                            updatePackage(p.name, { flavors_included: v })
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <NumberInput
                          value={p.dry_toppings_count}
                          onChange={(v) =>
                            updatePackage(p.name, { dry_toppings_count: v })
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <TextField
                          value={p.service_style}
                          onChange={(v) =>
                            updatePackage(p.name, { service_style: v })
                          }
                          width="w-28"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Checkbox
                          value={p.includes_waffle_cones}
                          onChange={(v) =>
                            updatePackage(p.name, {
                              includes_waffle_cones: v,
                            })
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Checkbox
                          value={p.includes_sauce}
                          onChange={(v) =>
                            updatePackage(p.name, { includes_sauce: v })
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Checkbox
                          value={p.includes_whipped_cream}
                          onChange={(v) =>
                            updatePackage(p.name, {
                              includes_whipped_cream: v,
                            })
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Checkbox
                          value={p.includes_cookies}
                          onChange={(v) =>
                            updatePackage(p.name, { includes_cookies: v })
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <Checkbox
                          value={p.includes_brownies}
                          onChange={(v) =>
                            updatePackage(p.name, { includes_brownies: v })
                          }
                        />
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* ============================== EXTRAS */}
        <Section
          title="Extras"
          description="Per-serving or flat add-ons. Advanced fields control billing rules."
          showAdvanced={showExtraAdvanced}
          onToggleAdvanced={setShowExtraAdvanced}
          advancedAvailable
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-950/60 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Extra</th>
                <th className="text-left px-4 py-2">Price</th>
                {showExtraAdvanced && (
                  <>
                    <th className="text-left px-4 py-2">Per-serving / Flat</th>
                    <th className="text-left px-4 py-2">Taxable</th>
                    <th className="text-left px-4 py-2">Duplicate-with</th>
                    <th className="text-left px-4 py-2">Notes</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {extras.map((e) => (
                <tr key={e.name} className="border-t border-slate-800">
                  <td className="px-4 py-2 text-slate-100 font-medium">
                    {e.name}
                    <SaveBadge state={saveStates[`pricing_extras:${e.name}`] ?? "idle"} />
                  </td>
                  <td className="px-4 py-2">
                    <MoneyInput
                      value={e.price}
                      onChange={(v) => updateExtra(e.name, { price: v })}
                    />
                  </td>
                  {showExtraAdvanced && (
                    <>
                      <td className="px-4 py-2">
                        <select
                          value={e.per_serving_or_flat}
                          onChange={(ev) =>
                            updateExtra(e.name, {
                              per_serving_or_flat: ev.target.value,
                            })
                          }
                          className="bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                        >
                          <option value="per_serving">per_serving</option>
                          <option value="flat">flat</option>
                        </select>
                      </td>
                      <td className="px-4 py-2">
                        <Checkbox
                          value={e.taxable}
                          onChange={(v) => updateExtra(e.name, { taxable: v })}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <TextField
                          value={(e.duplicate_with ?? []).join(", ")}
                          onChange={(v) => {
                            const arr = v
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean);
                            updateExtra(e.name, {
                              duplicate_with: arr.length ? arr : null,
                            });
                          }}
                          width="w-44"
                        />
                      </td>
                      <td className="px-4 py-2 max-w-md">
                        <TextField
                          value={e.notes}
                          onChange={(v) => updateExtra(e.name, { notes: v })}
                          width="w-full"
                        />
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* ============================== SCALARS */}
        <Section
          title="Operational constants"
          description="Per-mile rate, staff hourly, throughputs, minimums, flavour-overage rates."
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-950/60 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Setting</th>
                <th className="text-left px-4 py-2">Value</th>
                <th className="text-left px-4 py-2">Description</th>
              </tr>
            </thead>
            <tbody>
              {scalars.map((s) => (
                <tr key={s.key} className="border-t border-slate-800">
                  <td className="px-4 py-2 text-slate-100 font-medium align-top">
                    <div>{s.label}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {s.key}
                    </div>
                    <SaveBadge state={saveStates[`pricing_scalars:${s.key}`] ?? "idle"} />
                  </td>
                  <td className="px-4 py-2 align-top">
                    <NumberInput
                      value={s.value}
                      onChange={(v) => updateScalar(s.key, { value: v })}
                      step="0.01"
                      width="w-28"
                    />
                  </td>
                  <td className="px-4 py-2 text-slate-400 text-xs align-top max-w-md">
                    {s.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* ============================== TAX RATES */}
        <Section
          title="Tax rates"
          description="Per-jurisdiction sales tax. Default is used when the venue address can't be resolved."
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-950/60 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Code</th>
                <th className="text-left px-4 py-2">Label</th>
                <th className="text-left px-4 py-2">Rate</th>
                <th className="text-left px-4 py-2">Default?</th>
              </tr>
            </thead>
            <tbody>
              {tax.map((t) => (
                <tr key={t.code} className="border-t border-slate-800">
                  <td className="px-4 py-2 text-slate-300 font-mono text-xs">
                    {t.code}
                    <SaveBadge state={saveStates[`pricing_tax_rates:${t.code}`] ?? "idle"} />
                  </td>
                  <td className="px-4 py-2">
                    <TextField
                      value={t.label}
                      onChange={(v) => updateTax(t.code, { label: v })}
                      width="w-64"
                    />
                  </td>
                  <td className="px-4 py-2 flex items-center gap-1">
                    <NumberInput
                      value={Number((t.rate * 100).toFixed(3))}
                      onChange={(v) =>
                        updateTax(t.code, { rate: v / 100 })
                      }
                      step="0.001"
                      width="w-24"
                    />
                    <span className="text-slate-500 text-xs">%</span>
                  </td>
                  <td className="px-4 py-2">
                    <Checkbox
                      value={t.is_default}
                      onChange={(v) =>
                        updateTax(t.code, { is_default: v })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* ============================== LABOR TIERS */}
        <Section
          title="Labor tiers"
          description="Per commute band: BILLED drive hours per staff (covers there + back including traffic/parking padding). 45-70 is the MAX viable commute, only used for high-guest-count events. Over 70 is 'too far'."
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-950/60 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Tier</th>
                <th className="text-left px-4 py-2">Commute (min)</th>
                <th className="text-left px-4 py-2">
                  Drive hrs
                  <div className="text-[10px] text-slate-600 normal-case font-normal">
                    there + back, billed per staff
                  </div>
                </th>
                <th className="text-left px-4 py-2">
                  Post-event buffer
                  <div className="text-[10px] text-slate-600 normal-case font-normal">
                    teardown + return load, hrs
                  </div>
                </th>
                <th className="text-left px-4 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => {
                const isFailTier = t.tier === "over_70";
                return (
                  <tr
                    key={t.tier}
                    className={`border-t border-slate-800 ${
                      isFailTier ? "opacity-60" : ""
                    }`}
                  >
                    <td className="px-4 py-2 text-slate-300 font-mono text-xs">
                      {t.tier}
                      {isFailTier && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-rose-400">
                          fail
                        </span>
                      )}
                      <SaveBadge state={saveStates[`pricing_labor_tiers:${t.tier}`] ?? "idle"} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <NumberInput
                          value={t.commute_min}
                          onChange={(v) =>
                            updateTier(t.tier, { commute_min: v })
                          }
                          width="w-16"
                        />
                        <span className="text-slate-500 text-xs">–</span>
                        <NumberInput
                          value={t.commute_max}
                          onChange={(v) =>
                            updateTier(t.tier, { commute_max: v })
                          }
                          width="w-16"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <NumberInput
                        value={t.hours_per_staff}
                        onChange={(v) =>
                          updateTier(t.tier, { hours_per_staff: v })
                        }
                        step="0.25"
                        width="w-20"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <NumberInput
                        value={t.post_event_buffer_hrs ?? 1.5}
                        onChange={(v) =>
                          updateTier(t.tier, {
                            post_event_buffer_hrs: v,
                          })
                        }
                        step="0.25"
                        width="w-20"
                      />
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500 max-w-sm">
                      {t.components}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-4 py-3 border-t border-slate-800 text-xs text-slate-500 bg-slate-950/40">
            <div className="mb-1 font-semibold text-slate-400">
              Labor formula:
            </div>
            <code className="block text-slate-300 font-mono">
              per_staff_hours = service_hours
            </code>
            <code className="block text-slate-300 font-mono">
              {"                "}+ LABOR_SETUP_BUFFER_HRS
            </code>
            <code className="block text-slate-300 font-mono">
              {"                "}+ post_event_buffer (from tier)
            </code>
            <code className="block text-slate-300 font-mono">
              {"                "}+ drive_hrs (from tier)
            </code>
            <code className="block text-slate-300 font-mono">
              labor_cost = per_staff_hours × staff_count × STAFF_HOURLY
            </code>
            <div className="mt-2 space-y-1">
              <div>
                Doubletree (12-min, 2-hr service, 1 staff): tier{" "}
                <code className="text-slate-400">under_20</code> →
                drive 1.5, buffer 1.5. 2 + 0.5 + 1.5 + 1.5 ={" "}
                <span className="text-slate-300">
                  5.5 hrs × $25 = $137.50
                </span>
                .
              </div>
              <div>
                Nerrie (39-min, 5-hr service, 2 staff): tier{" "}
                <code className="text-slate-400">30_45</code> → drive
                2.0, buffer 1.5. 5 + 0.5 + 1.5 + 2.0 = 9.0 hrs × 2 ={" "}
                <span className="text-slate-300">$450</span>.
              </div>
              <div>
                Far-out example (60-min, 3-hr service, 3 staff): tier{" "}
                <code className="text-slate-400">45_70</code> → drive
                3.0, buffer 2.0. 3 + 0.5 + 2.0 + 3.0 = 8.5 hrs × 3 ={" "}
                <span className="text-slate-300">$637.50</span>.
              </div>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
