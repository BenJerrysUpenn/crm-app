import { notFound } from "next/navigation";
import LaborPlanningPreview from "@/components/metrics/LaborPlanningPreview";
import { loadPreviewData, previewEnabled } from "@/lib/metrics/laborPlanningPreview";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// LOCAL PREVIEW ONLY (bj-finance #742): the Labor Hours Planning card on real
// data, read-only, before migration 47 or anything else goes live. A 404
// unless the dev server runs with LOCAL_PREVIEW=1 (`next dev` only: a
// production build is NODE_ENV=production, so this is always a 404 there).
// See lib/metrics/laborPlanningPreview.ts for where each number comes from.
export default async function LaborHoursPlanningPreviewPage() {
  if (!previewEnabled()) notFound();
  const preview = await loadPreviewData();
  return <LaborPlanningPreview preview={preview} />;
}
