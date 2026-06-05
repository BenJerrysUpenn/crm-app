"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { Deal } from "@/lib/types";
import {
  shouldShowBoomerang,
  shouldShowEventReminder,
  eventReminderLabel,
  formatFollowupDate,
  lastOutboundChipText,
  daysSince,
} from "@/lib/boomerang";
import { fmtEasternDate, daysUntilEvent } from "@/lib/dateFormat";
import { missingRequiredFields } from "@/lib/required";

function fmtMoney(n: number | null): string {
  if (n == null) return "";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function fullName(deal: Deal): string {
  return [deal.contact_first_name, deal.contact_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function CardBody({
  deal,
  floating,
  onTogglePayment,
}: {
  deal: Deal;
  floating?: boolean;
  onTogglePayment?: (next: "Deposit Paid" | "Paid in Full") => void;
}) {
  const paid = deal.payment_status === "Paid in Full";
  const depositPaid = deal.payment_status === "Deposit Paid";
  const contact = fullName(deal);
  const showBoomerang = shouldShowBoomerang(deal);
  const showEventReminder = shouldShowEventReminder(deal);
  const lastTouch = formatFollowupDate(deal.last_outbound_at);
  const lastOutboundDays = daysSince(deal.last_outbound_at);
  const lastOutboundShort = lastOutboundChipText(deal);
  // Stage-aware silence: hide on Closed/Event Complete (terminal) and
  // on Booked Paid (deposit landed; the balance chase is handled by
  // the event-reminder ⏰ closer to event day, no need to nag on the
  // card daily).
  const showFollowup =
    deal.stage !== "Event Complete" &&
    deal.stage !== "Booked Paid" &&
    !deal.stage.startsWith("Closed");
  // Color ramp: the boomerang flag (needs reply) wins and goes amber.
  // Otherwise the days-since-last-touch staleness drives the color so
  // fresh deals stay calm and stale ones stand out.
  const followupClasses = showBoomerang
    ? "bg-amber-500/25 text-amber-300 border-amber-500/40"
    : lastOutboundDays === null || lastOutboundDays >= 7
    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
    : lastOutboundDays >= 3
    ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
    : "bg-slate-700/40 text-slate-300 border-slate-600/40";
  const followupChipText = showBoomerang
    ? `↩ ${lastOutboundShort}`
    : lastOutboundShort;
  const reminderLabel = eventReminderLabel(deal);
  const missing = missingRequiredFields(deal);
  const showMissing = missing.length > 0 && !deal.stage.startsWith("Closed");
  // Next-action data folded into the followup chip's hover tooltip.
  const nextActionVerb = (deal.next_action_verb ?? "").trim();
  const nextActionReason = (deal.next_action_reason ?? "").trim();
  const days = daysUntilEvent(deal.event_date);
  // Urgent shade for today/tomorrow, softer amber for 2 days out.
  const reminderClasses =
    days != null && days <= 1
      ? "bg-rose-500/25 text-rose-200 border-rose-500/40"
      : "bg-amber-500/25 text-amber-200 border-amber-500/40";

  return (
    <div
      className={`bg-slate-800 border border-slate-700 rounded-md p-2.5 shadow-sm select-none ${
        floating
          ? "shadow-2xl rotate-1 cursor-grabbing ring-1 ring-slate-500"
          : "hover:border-slate-600 cursor-grab"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-sm text-slate-100 truncate">
          {deal.company || contact || "Untitled deal"}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {showMissing && (
            <span className="relative group">
              <span className="block text-[10px] font-bold leading-none bg-rose-500/25 text-rose-200 border border-rose-500/40 rounded px-1.5 py-0.5">
                !
              </span>
              <span className="pointer-events-none absolute right-0 top-full mt-1 z-30 whitespace-nowrap rounded-md bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 shadow-lg opacity-0 group-hover:opacity-100 transition">
                <span className="block text-rose-300 font-semibold uppercase tracking-wide text-[10px]">
                  Missing required ({missing.length})
                </span>
                {missing.slice(0, 6).map((m) => (
                  <span key={m.field} className="block">
                    {m.label}
                  </span>
                ))}
                {missing.length > 6 && (
                  <span className="block text-slate-500">
                    +{missing.length - 6} more
                  </span>
                )}
              </span>
            </span>
          )}
          {showEventReminder && (
            <span className="relative group">
              <span
                className={`block text-[10px] uppercase tracking-wide ${reminderClasses} border rounded px-1.5 py-0.5`}
              >
                ⏰
              </span>
              <span className="pointer-events-none absolute right-0 top-full mt-1 z-30 whitespace-nowrap rounded-md bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 shadow-lg opacity-0 group-hover:opacity-100 transition">
                <span className="block text-rose-300 font-semibold uppercase tracking-wide text-[10px]">
                  {reminderLabel}
                </span>
                <span className="block">
                  Send a day-before reminder
                </span>
              </span>
            </span>
          )}
          {showFollowup && (
            <span className="relative group">
              <span
                className={`block text-[10px] uppercase tracking-wide ${followupClasses} border rounded px-1.5 py-0.5`}
              >
                {followupChipText}
              </span>
              <span className="pointer-events-none absolute right-0 top-full mt-1 z-30 whitespace-nowrap rounded-md bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 shadow-lg opacity-0 group-hover:opacity-100 transition">
                <span className="block text-slate-400 font-semibold uppercase tracking-wide text-[10px]">
                  Next action
                </span>
                <span className="block text-slate-100">
                  {nextActionVerb || "No action needed"}
                </span>
                {nextActionReason && (
                  <span className="block text-slate-400 text-[11px] mt-0.5">
                    {nextActionReason}
                  </span>
                )}
                <span className="block text-slate-500 text-[11px] mt-1">
                  Last outbound: {lastTouch}
                </span>
              </span>
            </span>
          )}
        </div>
      </div>
      {contact && deal.company && (
        <div className="text-xs text-slate-400 mt-0.5 truncate">{contact}</div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
        <span>{fmtEasternDate(deal.event_date) || "no date"}</span>
        {deal.guest_count != null && (
          <span className="text-slate-500">{deal.guest_count} guests</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="font-medium text-slate-200">
          {fmtMoney(deal.total_with_tax)}
        </span>
        <div className="flex items-center gap-1">
          {paid && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePayment?.("Deposit Paid");
              }}
              title="Click to revert to Deposit Paid"
              className="text-[10px] uppercase tracking-wide bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded px-1.5 py-0.5 hover:bg-emerald-500/30 cursor-pointer"
            >
              Paid
            </button>
          )}
          {depositPaid && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePayment?.("Paid in Full");
              }}
              title="Click to mark Paid in Full"
              className="text-[10px] uppercase tracking-wide bg-sky-500/20 text-sky-300 border border-sky-500/30 rounded px-1.5 py-0.5 hover:bg-sky-500/30 cursor-pointer"
            >
              Deposit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DealCard({
  deal,
  onClick,
  onTogglePayment,
  dragging,
}: {
  deal: Deal;
  onClick?: () => void;
  onTogglePayment?: (next: "Deposit Paid" | "Paid in Full") => void;
  dragging?: boolean;
}) {
  if (dragging) {
    return <CardBody deal={deal} floating />;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: deal.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={() => onClick?.()}
    >
      <CardBody deal={deal} onTogglePayment={onTogglePayment} />
    </div>
  );
}
