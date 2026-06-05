"use client";

import { useDroppable } from "@dnd-kit/core";
import { STAGE_COLOURS, isTerminal, type Stage } from "@/lib/stages";
import type { Deal } from "@/lib/types";
import DealCard from "./DealCard";

export default function KanbanColumn({
  stage,
  deals,
  onCardClick,
  onTogglePayment,
}: {
  stage: Stage;
  deals: Deal[];
  onCardClick: (deal: Deal) => void;
  onTogglePayment?: (
    deal: Deal,
    next: "Deposit Paid" | "Paid in Full",
  ) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const colour = STAGE_COLOURS[stage];
  const terminal = isTerminal(stage);

  return (
    <div
      ref={setNodeRef}
      className={`w-full sm:w-72 flex-shrink-0 flex flex-col rounded-lg overflow-hidden border border-slate-800 ${
        terminal ? "opacity-95" : ""
      } ${isOver ? "ring-2 ring-white/30" : ""}`}
    >
      <div
        className={`${colour.header} px-3 py-2 text-white font-semibold text-sm flex items-center gap-1`}
      >
        <span>{stage}</span>
        <span className="text-white/70 font-normal">/ {deals.length}</span>
      </div>
      <div className="flex-1 bg-slate-900 p-2 space-y-2 overflow-y-auto min-h-[120px]">
        {deals.length === 0 ? (
          <div className="text-xs text-slate-600 italic text-center py-6">
            No deals
          </div>
        ) : (
          deals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              onClick={() => onCardClick(deal)}
              onTogglePayment={
                onTogglePayment
                  ? (next) => onTogglePayment(deal, next)
                  : undefined
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
