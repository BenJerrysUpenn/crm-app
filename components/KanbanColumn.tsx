"use client";

import { useDroppable } from "@dnd-kit/core";
import { STAGE_COLOURS, isTerminal, type Stage } from "@/lib/stages";
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
  const colour = STAGE_COLOURS[stage];
  const terminal = isTerminal(stage);

  return (
    <div
      ref={setNodeRef}
      className={`w-72 flex-shrink-0 flex flex-col rounded-lg border bg-zinc-900 border-zinc-800 overflow-hidden transition ${
        terminal ? "opacity-90" : ""
      } ${isOver ? "ring-2 ring-zinc-400" : ""}`}
    >
      <div className={`h-1 ${colour.strip}`} />
      <div className="px-3 py-2 flex items-center justify-between border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${colour.dot}`} />
          <h2 className="text-sm font-semibold text-zinc-100">{stage}</h2>
        </div>
        <span className="text-xs text-zinc-400 bg-zinc-800 rounded-full px-2 py-0.5">
          {deals.length}
        </span>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto min-h-[120px]">
        {deals.length === 0 ? (
          <div className="text-xs text-zinc-600 italic text-center py-6">
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
