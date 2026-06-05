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
import { STAGES, DEFAULT_VISIBLE, type Stage } from "@/lib/stages";
import type { Deal } from "@/lib/types";
import { buildStagePatch, writeStageChange } from "@/lib/dealUpdate";
import { matchesQuery } from "@/lib/search";
import KanbanColumn from "./KanbanColumn";
import DealCard from "./DealCard";
import DealDetailDrawer from "./DealDetailDrawer";
import Toast from "./Toast";
import ColumnFilter from "./ColumnFilter";
import SearchBar from "./SearchBar";

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
  userEmail,
}: {
  initialDeals: Deal[];
  userEmail?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [deals, setDeals] = useState<Deal[]>(initialDeals);
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [selectedDealId, setSelectedDealId] = useState<number | null>(null);
  const [visibleStages, setVisibleStages] = useState<Stage[]>([
    ...DEFAULT_VISIBLE,
  ]);
  const [searchQuery, setSearchQuery] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    kind: "error" | "info";
  } | null>(null);

  useEffect(() => {
    setVisibleStages(loadVisible());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleStages));
    } catch {
      // ignore
    }
  }, [visibleStages, hydrated]);

  const visibleSet = useMemo(() => new Set(visibleStages), [visibleStages]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

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

  // Apply search filter first, then bucket by stage.
  const filteredDeals = useMemo(
    () => deals.filter((d) => matchesQuery(d, searchQuery)),
    [deals, searchQuery],
  );

  const byStage = useMemo(() => {
    const map = new Map<Stage, Deal[]>();
    for (const stage of STAGES) map.set(stage, []);
    for (const deal of filteredDeals) {
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
  }, [filteredDeals]);

  // Inline payment-status toggle (click the Deposit/Paid pill on a
  // card). Optimistic update with rollback on error.
  const togglePaymentStatus = useCallback(
    async (deal: Deal, next: "Deposit Paid" | "Paid in Full") => {
      if (deal.payment_status === next) return;
      const previous = deal.payment_status;
      setDeals((prev) =>
        prev.map((d) =>
          d.id === deal.id ? { ...d, payment_status: next } : d,
        ),
      );
      const { error } = await supabase
        .from("deals")
        .update({
          payment_status: next,
          updated_at: new Date().toISOString(),
        })
        .eq("id", deal.id);
      if (error) {
        setDeals((prev) =>
          prev.map((d) =>
            d.id === deal.id ? { ...d, payment_status: previous } : d,
          ),
        );
        setToast({
          message: `Could not update payment: ${error.message}`,
          kind: "error",
        });
      }
    },
    [supabase],
  );

  // Unified stage-change handler used by drag-drop and the drawer dropdown.
  const moveDealToStage = useCallback(
    async (deal: Deal, newStage: Stage) => {
      if (deal.stage === newStage) return;
      if (!(STAGES as readonly string[]).includes(newStage)) return;

      const previousStage = deal.stage;
      const previousBoomerang = deal.boomerang_reason;
      const previousActive = deal.is_active;
      const previousPaymentStatus = deal.payment_status;
      const patch = buildStagePatch(newStage, deal.payment_status);

      setDeals((prev) =>
        prev.map((d) =>
          d.id === deal.id
            ? {
                ...d,
                stage: patch.stage,
                boomerang_reason: patch.boomerang_reason,
                is_active: patch.is_active,
                updated_at: patch.updated_at,
                payment_status: patch.payment_status ?? d.payment_status,
              }
            : d,
        ),
      );

      const { error } = await writeStageChange(supabase, deal.id, patch);

      if (error) {
        setDeals((prev) =>
          prev.map((d) =>
            d.id === deal.id
              ? {
                  ...d,
                  stage: previousStage,
                  boomerang_reason: previousBoomerang,
                  is_active: previousActive,
                  payment_status: previousPaymentStatus,
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
    [supabase],
  );

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
      if (!deal) return;
      await moveDealToStage(deal, newStage);
    },
    [deals, moveDealToStage],
  );

  const totalShown = visibleStages.reduce(
    (sum, s) => sum + (byStage.get(s)?.length ?? 0),
    0,
  );

  // Selected deal is looked up fresh each render so the drawer always shows
  // the current stage even after an in-drawer change.
  const selectedDeal =
    selectedDealId != null
      ? deals.find((d) => d.id === selectedDealId) ?? null
      : null;

  return (
    <>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="h-full flex flex-col">
          <div className="px-4 py-2 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950">
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search deals..."
            />
            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-400 whitespace-nowrap">
                {totalShown} {totalShown === 1 ? "deal" : "deals"}
                {(visibleStages.length < STAGES.length ||
                  searchQuery.trim() !== "") && (
                  <span className="text-slate-500">
                    {" "}
                    · {deals.length - totalShown} hidden
                  </span>
                )}
              </div>
              <ColumnFilter visible={visibleSet} onChange={setVisibleStages} />
            </div>
          </div>
          <div className="flex-1 overflow-x-auto overflow-y-hidden px-4 py-4">
            <div className="flex gap-3 min-w-max h-full">
              {visibleStages.length === 0 ? (
                <div className="text-sm text-slate-500 italic px-4 py-8">
                  No columns selected. Click <span className="font-semibold">Columns</span> top right to pick stages to show.
                </div>
              ) : (
                visibleStages.map((stage) => (
                  <KanbanColumn
                    key={stage}
                    stage={stage}
                    deals={byStage.get(stage) ?? []}
                    onCardClick={(deal) => setSelectedDealId(deal.id)}
                    onTogglePayment={togglePaymentStatus}
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
          key={selectedDeal.id}
          deal={selectedDeal}
          onClose={() => setSelectedDealId(null)}
          onStageChange={moveDealToStage}
          onDealUpdate={(updated) =>
            setDeals((prev) =>
              prev.map((d) => (d.id === updated.id ? updated : d)),
            )
          }
          userEmail={userEmail}
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
