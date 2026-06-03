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
      className={`bg-zinc-800 border border-zinc-700 rounded-md p-2.5 shadow-sm select-none ${
        floating
          ? "shadow-2xl rotate-1 cursor-grabbing ring-1 ring-zinc-500"
          : "hover:border-zinc-600 cursor-grab"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-sm text-zinc-100 truncate">
          {deal.company || contact || "Untitled deal"}
        </div>
        {deal.boomerang_reason && (
          <span
            title={`Boomerang: ${deal.boomerang_reason}`}
            className="flex-shrink-0 text-[10px] uppercase tracking-wide bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded px-1.5 py-0.5"
          >
            ↩
          </span>
        )}
      </div>
      {contact && deal.company && (
        <div className="text-xs text-zinc-400 mt-0.5 truncate">{contact}</div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-zinc-400">
        <span>{fmtDate(deal.event_date)}</span>
        {deal.guest_count != null && (
          <span className="text-zinc-500">{deal.guest_count} guests</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="font-medium text-zinc-200">
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
