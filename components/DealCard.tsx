"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { Deal } from "@/lib/types";
import {
  shouldShowBoomerang,
  shouldShowEventReminder,
  eventReminderLabel,
  formatFollowupDate,
} from "@/lib/boomerang";
import { fmtEasternDate, daysUntilEvent } from "@/lib/dateFormat";

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

function CardBody({ deal, floating }: { deal: Deal; floating?: boolean }) {
  const paid = deal.payment_status === "Paid in Full";
  const depositPaid = deal.payment_status === "Deposit Paid";
  const contact = fullName(deal);
  const showBoomerang = shouldShowBoomerang(deal);
  const showEventReminder = shouldShowEventReminder(deal);
  const lastTouch = formatFollowupDate(deal.last_outbound_at);
  const reminderLabel = eventReminderLabel(deal);
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
          {showBoomerang && (
            <span className="relative group">
              <span className="block text-[10px] uppercase tracking-wide bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded px-1.5 py-0.5">
                ↩
              </span>
              <span className="pointer-events-none absolute right-0 top-full mt-1 z-30 whitespace-nowrap rounded-md bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 shadow-lg opacity-0 group-hover:opacity-100 transition">
                <span className="block text-amber-300 font-semibold uppercase tracking-wide text-[10px]">
                  {deal.boomerang_reason}
                </span>
                <span className="block">Last followed up: {lastTouch}</span>
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
        {paid && (
          <span className="text-[10px] uppercase tracking-wide bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded px-1.5 py-0.5">
            Paid
          </span>
        )}
        {depositPaid && (
          <span className="text-[10px] uppercase tracking-wide bg-sky-500/20 text-sky-300 border border-sky-500/30 rounded px-1.5 py-0.5">
            Deposit
          </span>
        )}
      </div>
    </div>
  );
}

export default function DealCard({
  deal,
  onClick,
  dragging,
}: {
  deal: Deal;
  onClick?: () => void;
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
      <CardBody deal={deal} />
    </div>
  );
}
