"use client";

// The local preview's page (bj-finance #742): the Labor Hours Planning card
// drawn by the Metrics board's own WidgetCard, as one widget of a view, with
// the slider kept in this page's state instead of a saved view. A banner
// says where the data came from. Below it, the Targets tab's planning inputs
// editor, saving to the local inputs file so the card reflects an edit.
// Rendered only under LOCAL_PREVIEW=1 in dev.

import { useState } from "react";
import { WidgetCard } from "./MetricsBoard";
import { cleanSettings } from "@/lib/metrics/views";
import type { WidgetConfig } from "@/lib/metrics/widgets";
import type { PreviewData } from "@/lib/metrics/laborPlanningPreview";
import PlanningInputs from "@/components/finance/targets/PlanningInputs";

export default function LaborPlanningPreview({ preview, asOwner }: { preview: PreviewData; asOwner: boolean }) {
  const [widget, setWidget] = useState<WidgetConfig>({ id: "preview", metric: "labor_hours_planning", settings: cleanSettings("labor_hours_planning", {}) });
  const { data, sources } = preview;
  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 px-4 py-6">
      <div className="metrics-root max-w-6xl mx-auto space-y-4">
        <div role="note" className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <p className="font-semibold">Local preview, not live. Nothing here is saved to the app.</p>
          <p className="mt-1">
            Sales, the control board, the team, store hours, closures and catering bookings are read from the live database
            (read-only) at {new Date(sources.dbReadAt).toLocaleString("en-US", { timeZone: "America/New_York" })}. Store-hours
            seasons, concession events and Free Cone Day come from <code className="font-mono text-xs">{sources.seed}</code>; last
            year&rsquo;s catering hours from <code className="font-mono text-xs">{sources.history}</code>
            {sources.historySpan ? ` (When I Work, ${sources.historySpan}; the time app's Catering shifts after that)` : ""}.
          </p>
        </div>
        {data.problems.length > 0 && (
          <ul className="text-sm text-amber-900 dark:text-amber-200 list-disc pl-5">
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <WidgetCard
          widget={widget}
          data={data}
          editing={false}
          first
          last
          onSettings={(s) => setWidget((w) => ({ ...w, settings: cleanSettings(w.metric, { ...w.settings, ...s }) }))}
          onMove={() => {}}
          onRemove={() => {}}
        />
        <div className="text-xs text-slate-500">
          Viewing the inputs as {asOwner ? "an owner" : "a manager who is not an owner"}.{" "}
          <a href={asOwner ? "?as=manager" : "?"} className="underline">{asOwner ? "See it as a manager" : "See it as an owner"}</a>
        </div>
        <PlanningInputs data={preview.inputs} today={data.today} viewerIsOwner={asOwner} preview={{ liveClosedDays: preview.liveClosedDays }} />
      </div>
    </main>
  );
}
