"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { Deal } from "@/lib/types";

function fmtMoney(n: number | null): string {
  if (n == null) return "";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "no date";
  try {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
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

  return (
    <div
      className={`bg-white border border-stone-200 rounded-md p-2.5 shadow-sm select-none ${
        floating ? "shadow-lg rotate-1 cursor-grabbing" : "hover:shadow cursor-grab"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-sm text-stone-900 truncate">
          {deal.company || contact || "Untitled deal"}
        </div>
        {deal.boomerang_reason && (
          <span
            title={`Boomerang: ${deal.boomerang_reason}`}
            className="flex-shrink-0 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 rounded px-1.5 py-0.5"
          >
            ↩
          </span>
        )}
      </div>
      {contact && deal.company && (
        <div className="text-xs text-stone-500 mt-0.5 truncate">{contact}</div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-stone-600">
        <span>{fmtDate(deal.event_date)}</span>
        {deal.guest_count != null && (
          <span className="text-stone-500">{deal.guest_count} guests</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="font-medium text-stone-800">
          {fmtMoney(deal.total_with_tax)}
        </span>
        {paid && (
          <span className="text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5">
            Paid
          </span>
        )}
        {depositPaid && (
          <span className="text-[10px] uppercase tracking-wide bg-blue-100 text-blue-800 rounded px-1.5 py-0.5">
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
  // Floating render used inside DragOverlay: no draggable hook, no listeners.
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
