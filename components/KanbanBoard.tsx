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
import {
  STAGES,
  DEFAULT_VISIBLE,
  isTerminal,
  type Stage,
} from "@/lib/stages";
import type { Deal } from "@/lib/types";
import KanbanColumn from "./KanbanColumn";
import DealCard from "./DealCard";
import DealDetailDrawer from "./DealDetailDrawer";
import Toast from "./Toast";
import ColumnFilter from "./ColumnFilter";

const STORAGE_KEY = "withers-crm:visible-stages";

function loadVisible(): Stage[] {
  if (typeof window === "undefined") return [...DEFAULT_VISIBLE];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_VISIBLE];
    const parsed = JSON.parse(raw) as string[];
    const valid = parsed.filter((s): s is Stage =>
      (STAGES as readonly string[]).includes(s),
    );
    return valid.length > 0 ? valid : [...DEFAULT_VISIBLE];
  } catch {
    return [...DEFAULT_VISIBLE];
  }
}

export default function KanbanBoard({
  initialDeals,
}: {
  initialDeals: Deal[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [deals, setDeals] = useState<Deal[]>(initialDeals);
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [visibleStages, setVisibleStages] = useState<Stage[]>([
    ...DEFAULT_VISIBLE,
  ]);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    kind: "error" | "info";
  } | null>(null);

  // Hydrate the visible-stages set from localStorage after first paint.
  // (Defers reading localStorage so SSR markup matches initial client paint.)
  useEffect(() => {
    setVisibleStages(loadVisible());
    setHydrated(true);
  }, []);

  // Persist visible stages on change.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleStages));
    } catch {
      // ignore quota / disabled storage
    }
  }, [visibleStages, hydrated]);

  const visibleSet = useMemo(() => new Set(visibleStages), [visibleStages]);

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
      if (!(STAGES as readonly string[]).includes(newStage)) return;

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

  const totalShown = visibleStages.reduce(
    (sum, s) => sum + (byStage.get(s)?.length ?? 0),
    0,
  );

  return (
    <>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="h-full flex flex-col">
          <div className="px-4 py-2 flex items-center justify-between gap-3 border-b border-zinc-800">
            <div className="text-sm text-zinc-400">
              {totalShown} {totalShown === 1 ? "deal" : "deals"} shown
              {visibleStages.length < STAGES.length && (
                <span className="text-zinc-500">
                  {" "}
                  · {deals.length - totalShown} hidden
                </span>
              )}
            </div>
            <ColumnFilter visible={visibleSet} onChange={setVisibleStages} />
          </div>
          <div className="flex-1 overflow-x-auto overflow-y-hidden px-4 py-4">
            <div className="flex gap-3 min-w-max h-full">
              {visibleStages.length === 0 ? (
                <div className="text-sm text-zinc-500 italic px-4 py-8">
                  No columns selected. Click <span className="font-semibold">Columns</span> top right to pick stages to show.
                </div>
              ) : (
                visibleStages.map((stage) => (
                  <KanbanColumn
                    key={stage}
                    stage={stage}
                    deals={byStage.get(stage) ?? []}
                    onCardClick={setSelectedDeal}
                  />
                ))
              )}
            </div>
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
