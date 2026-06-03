export const STAGES = [
  "Open",
  "Quote Review",
  "Sent Quote",
  "Booked Unpaid",
  "Booked Paid",
  "Event Complete",
  "Closed Lost",
  "Closed Below Min",
  "Closed Marketing Event",
] as const;

export type Stage = (typeof STAGES)[number];

export const TERMINAL_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "Event Complete",
  "Closed Lost",
  "Closed Below Min",
  "Closed Marketing Event",
]);

export function isTerminal(stage: string): boolean {
  return TERMINAL_STAGES.has(stage as Stage);
}

// Stages visible by default: the working pipeline only.
export const DEFAULT_VISIBLE: ReadonlyArray<Stage> = [
  "Open",
  "Quote Review",
  "Sent Quote",
  "Booked Unpaid",
  "Booked Paid",
];

// Colour swatch per stage. Used as the column header strip and tag.
// Keys are stage names; values are Tailwind classes.
export const STAGE_COLOURS: Record<
  Stage,
  { strip: string; chip: string; dot: string }
> = {
  Open: {
    strip: "bg-sky-500",
    chip: "bg-sky-500/20 text-sky-300 border-sky-500/30",
    dot: "bg-sky-500",
  },
  "Quote Review": {
    strip: "bg-amber-400",
    chip: "bg-amber-400/20 text-amber-300 border-amber-400/30",
    dot: "bg-amber-400",
  },
  "Sent Quote": {
    strip: "bg-violet-500",
    chip: "bg-violet-500/20 text-violet-300 border-violet-500/30",
    dot: "bg-violet-500",
  },
  "Booked Unpaid": {
    strip: "bg-orange-500",
    chip: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    dot: "bg-orange-500",
  },
  "Booked Paid": {
    strip: "bg-emerald-500",
    chip: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    dot: "bg-emerald-500",
  },
  "Event Complete": {
    strip: "bg-teal-600",
    chip: "bg-teal-600/20 text-teal-300 border-teal-600/30",
    dot: "bg-teal-600",
  },
  "Closed Lost": {
    strip: "bg-rose-500",
    chip: "bg-rose-500/20 text-rose-300 border-rose-500/30",
    dot: "bg-rose-500",
  },
  "Closed Below Min": {
    strip: "bg-pink-500",
    chip: "bg-pink-500/20 text-pink-300 border-pink-500/30",
    dot: "bg-pink-500",
  },
  "Closed Marketing Event": {
    strip: "bg-zinc-500",
    chip: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
    dot: "bg-zinc-500",
  },
};
