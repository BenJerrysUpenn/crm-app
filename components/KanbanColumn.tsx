"use client";

import { useDroppable } from "@dnd-kit/core";
import type { Stage } from "@/lib/stages";
import { isTerminal } from "@/lib/stages";
import type { Deal } from "@/lib/types";
import DealCard from "./DealCard";

export default function KanbanColumn({
  stage,
  deals,
  onCardClick,
}: {
  stage: Stage;
  deals: Deal[];
  onCardClick: (deal: Deal) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const terminal = isTerminal(stage);

  return (
    <div
      ref={setNodeRef}
      className={`w-72 flex-shrink-0 flex flex-col rounded-lg border ${
        terminal
          ? "bg-stone-100 border-stone-300"
          : "bg-white border-stone-200"
      } ${isOver ? "ring-2 ring-stone-400" : ""}`}
    >
      <div className="px-3 py-2 border-b border-stone-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-stone-800">{stage}</h2>
        <span className="text-xs text-stone-500 bg-stone-100 rounded-full px-2 py-0.5">
          {deals.length}
        </span>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto min-h-[120px]">
        {deals.length === 0 ? (
          <div className="text-xs text-stone-400 italic text-center py-6">
            No deals
          </div>
        ) : (
          deals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              onClick={() => onCardClick(deal)}
            />
          ))
        )}
      </div>
    </div>
  );
}
