"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { createClient } from "@/lib/supabase/client";
import { STAGES, isTerminal, type Stage } from "@/lib/stages";
import type { Deal } from "@/lib/types";
import KanbanColumn from "./KanbanColumn";
import DealCard from "./DealCard";
import DealDetailDrawer from "./DealDetailDrawer";
import Toast from "./Toast";

export default function KanbanBoard({
  initialDeals,
}: {
  initialDeals: Deal[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [deals, setDeals] = useState<Deal[]>(initialDeals);
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    kind: "error" | "info";
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Refetch on window focus (cheap alternative to realtime).
  useEffect(() => {
    function onFocus() {
      supabase
        .from("deals")
        .select("*")
        .eq("archived", 0)
        .order("event_date", { ascending: true })
        .then(({ data, error }) => {
          if (!error && data) setDeals(data as Deal[]);
        });
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [supabase]);

  const byStage = useMemo(() => {
    const map = new Map<Stage, Deal[]>();
    for (const stage of STAGES) map.set(stage, []);
    for (const deal of deals) {
      const bucket = map.get(deal.stage as Stage);
      if (bucket) bucket.push(deal);
    }
    for (const stage of STAGES) {
      map.get(stage)!.sort((a, b) => {
        const ad = a.event_date ?? "9999-12-31";
        const bd = b.event_date ?? "9999-12-31";
        return ad.localeCompare(bd);
      });
    }
    return map;
  }, [deals]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = Number(event.active.id);
      const deal = deals.find((d) => d.id === id);
      if (deal) setActiveDeal(deal);
    },
    [deals],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDeal(null);
      const { active, over } = event;
      if (!over) return;
      const dealId = Number(active.id);
      const newStage = String(over.id) as Stage;
      const deal = deals.find((d) => d.id === dealId);
      if (!deal || deal.stage === newStage) return;
      if (!STAGES.includes(newStage)) return;

      const previousStage = deal.stage;
      const previousBoomerang = deal.boomerang_reason;
      const previousActive = deal.is_active;
      const nowIso = new Date().toISOString();
      const newIsActive = isTerminal(newStage) ? 0 : 1;

      // Optimistic update.
      setDeals((prev) =>
        prev.map((d) =>
          d.id === dealId
            ? {
                ...d,
                stage: newStage,
                boomerang_reason: null,
                is_active: newIsActive,
                updated_at: nowIso,
              }
            : d,
        ),
      );

      const { error } = await supabase
        .from("deals")
        .update({
          stage: newStage,
          boomerang_reason: null,
          is_active: newIsActive,
          updated_at: nowIso,
        })
        .eq("id", dealId);

      if (error) {
        // Roll back.
        setDeals((prev) =>
          prev.map((d) =>
            d.id === dealId
              ? {
                  ...d,
                  stage: previousStage,
                  boomerang_reason: previousBoomerang,
                  is_active: previousActive,
                }
              : d,
          ),
        );
        setToast({
          message: `Could not move deal: ${error.message}`,
          kind: "error",
        });
      }
    },
    [deals, supabase],
  );

  return (
    <>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="h-full overflow-x-auto px-4 py-4">
          <div className="flex gap-3 min-w-max h-full">
            {STAGES.map((stage) => (
              <KanbanColumn
                key={stage}
                stage={stage}
                deals={byStage.get(stage) ?? []}
                onCardClick={setSelectedDeal}
              />
            ))}
          </div>
        </div>
        <DragOverlay>
          {activeDeal ? <DealCard deal={activeDeal} dragging /> : null}
        </DragOverlay>
      </DndContext>

      {selectedDeal && (
        <DealDetailDrawer
          deal={selectedDeal}
          onClose={() => setSelectedDeal(null)}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          kind={toast.kind}
          onDismiss={() => setToast(null)}
        />
      )}
    </>
  );
}
