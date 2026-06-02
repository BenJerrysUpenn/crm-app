"use client";

import { useEffect } from "react";
import type { Deal } from "@/lib/types";

function Row({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-stone-100 text-sm">
      <div className="text-stone-500 col-span-1">{label}</div>
      <div className="text-stone-900 col-span-2 break-words">{String(value)}</div>
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

export default function DealDetailDrawer({
  deal,
  onClose,
}: {
  deal: Deal;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const contact = [deal.contact_first_name, deal.contact_last_name]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="fixed inset-0 bg-black/30 z-40 flex justify-end"
      onClick={onClose}
    >
      <aside
        className="bg-white w-full max-w-md h-full overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-stone-200 sticky top-0 bg-white flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-lg text-stone-900">
              {deal.company || contact || `Deal #${deal.id}`}
            </h2>
            <p className="text-xs text-stone-500 mt-0.5">
              #{deal.id} · {deal.stage}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-700 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
              Contact
            </h3>
            <Row label="Name" value={contact} />
            <Row label="Email" value={deal.contact_email} />
            <Row label="Phone" value={deal.contact_phone} />
            <Row label="Day-of contact" value={deal.day_of_contact_name} />
            <Row label="Day-of phone" value={deal.day_of_contact_phone} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
              Event
            </h3>
            <Row label="Date" value={deal.event_date} />
            <Row label="Start" value={deal.event_start_time} />
            <Row label="End" value={deal.event_end_time} />
            <Row label="Type" value={deal.event_type} />
            <Row label="Guests" value={deal.guest_count} />
            <Row label="Venue" value={deal.venue_name} />
            <Row label="Address" value={deal.venue_address} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
              Menu
            </h3>
            <Row label="Package" value={deal.package_name} />
            <Row label="Flavors" value={deal.flavors} />
            <Row label="Toppings" value={deal.toppings} />
            <Row label="Extras" value={deal.extras} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
              Staffing
            </h3>
            <Row label="Staff count" value={deal.staff_count} />
            <Row label="Labor hours" value={deal.labor_hours} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
              Money
            </h3>
            <Row label="Subtotal pre-tax" value={money(deal.subtotal_pretax)} />
            <Row label="Total with tax" value={money(deal.total_with_tax)} />
            <Row label="Signed total" value={money(deal.signed_contract_total)} />
            <Row label="Deposit" value={money(deal.deposit_amount)} />
            <Row label="Amount paid" value={money(deal.amount_paid)} />
            <Row label="Payment status" value={deal.payment_status} />
            <Row label="Tax exempt" value={boolish(deal.tax_exempt)} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
              Pipeline
            </h3>
            <Row label="Boomerang" value={deal.boomerang_reason} />
            <Row label="Last outbound" value={deal.last_outbound_at} />
            <Row label="Active" value={boolish(deal.is_active)} />
            <Row label="Lead source" value={deal.lead_source} />
            <Row label="How heard" value={deal.how_did_you_hear} />
          </section>

          {deal.notes && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
                Notes
              </h3>
              <div className="text-sm text-stone-800 whitespace-pre-wrap bg-stone-50 rounded p-3 border border-stone-200">
                {deal.notes}
              </div>
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">
              Meta
            </h3>
            <Row label="Created" value={deal.created_at} />
            <Row label="Updated" value={deal.updated_at} />
          </section>
        </div>
      </aside>
    </div>
  );
}
