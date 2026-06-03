"use client";

import { useEffect } from "react";
import type { Deal } from "@/lib/types";
import { STAGE_COLOURS, type Stage } from "@/lib/stages";

function Row({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-zinc-800 text-sm">
      <div className="text-zinc-500 col-span-1">{label}</div>
      <div className="text-zinc-200 col-span-2 break-words">{String(value)}</div>
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
  const colour = STAGE_COLOURS[deal.stage as Stage];

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex justify-end"
      onClick={onClose}
    >
      <aside
        className="bg-zinc-900 w-full max-w-md h-full overflow-y-auto shadow-2xl border-l border-zinc-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-lg text-zinc-100">
              {deal.company || contact || `Deal #${deal.id}`}
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5">
              <span>#{deal.id}</span>
              <span>·</span>
              {colour && (
                <span className={`w-2 h-2 rounded-full ${colour.dot}`} />
              )}
              <span>{deal.stage}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
              Contact
            </h3>
            <Row label="Name" value={contact} />
            <Row label="Email" value={deal.contact_email} />
            <Row label="Phone" value={deal.contact_phone} />
            <Row label="Day-of contact" value={deal.day_of_contact_name} />
            <Row label="Day-of phone" value={deal.day_of_contact_phone} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
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
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
              Menu
            </h3>
            <Row label="Package" value={deal.package_name} />
            <Row label="Flavors" value={deal.flavors} />
            <Row label="Toppings" value={deal.toppings} />
            <Row label="Extras" value={deal.extras} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
              Staffing
            </h3>
            <Row label="Staff count" value={deal.staff_count} />
            <Row label="Labor hours" value={deal.labor_hours} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
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
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
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
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
                Notes
              </h3>
              <div className="text-sm text-zinc-200 whitespace-pre-wrap bg-zinc-800 rounded p-3 border border-zinc-700">
                {deal.notes}
              </div>
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
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
