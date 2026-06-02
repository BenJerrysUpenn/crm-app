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
