// The review-by chip on every stored value of the control board and the Team
// page's salaries: green while review-by is more than a month off, yellow
// within a month of it, red once it has passed (lib/controlBoard/settings.ts).
// No reminder is ever sent; the chip is the reminder.

import { reviewState, type ReviewState } from "@/lib/controlBoard/settings";
import { shortDate } from "@/lib/controlBoard/format";

const CHIP: Record<ReviewState, string> = {
  ok: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800",
  soon: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
  overdue: "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800",
};
const DOT: Record<ReviewState, string> = { ok: "bg-emerald-500", soon: "bg-amber-500", overdue: "bg-rose-500" };
const WORD: Record<ReviewState, string> = { ok: "review by", soon: "review soon", overdue: "review overdue" };

export default function ReviewChip({ reviewBy, today, compact = false }: { reviewBy: string; today: string; compact?: boolean }) {
  const s = reviewState(reviewBy, today);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${CHIP[s]}`} title={`${WORD[s]} ${shortDate(reviewBy)}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[s]}`} />
      {compact ? shortDate(reviewBy) : `${WORD[s]} ${shortDate(reviewBy)}`}
    </span>
  );
}
