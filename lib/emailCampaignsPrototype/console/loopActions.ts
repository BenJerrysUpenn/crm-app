// The five things the console may do to the weekly email loop, as the API
// route (app/api/email-campaigns/loop) takes them. Each one is a database
// function from supabase/crm/014 run as the signed-in manager.

export type LoopAction =
  | { action: "approve"; approach: string }
  | { action: "hold"; draft: number; reason: string }
  | { action: "release"; draft: number }
  | { action: "pause"; reason: string }
  | { action: "resume" };

export type LoopAct = (a: LoopAction) => Promise<boolean>;

/** The function and its arguments for one action; null when malformed. */
export function rpcFor(body: unknown): { fn: string; args: Record<string, unknown> } | null {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const text = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 500) : "");
  const id = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x > 0 ? x : null);
  switch (b.action) {
    case "approve":
      return typeof b.approach === "string" && /^[a-z0-9_]+$/.test(b.approach) ? { fn: "outreach_loop_approve", args: { p_approach: b.approach } } : null;
    case "hold":
      return id(b.draft) ? { fn: "outreach_loop_hold", args: { p_draft: b.draft, p_reason: text(b.reason) } } : null;
    case "release":
      return id(b.draft) ? { fn: "outreach_loop_release", args: { p_draft: b.draft } } : null;
    case "pause":
      return { fn: "outreach_loop_pause", args: { p_reason: text(b.reason) } };
    case "resume":
      return { fn: "outreach_loop_resume", args: {} };
    default:
      return null;
  }
}

/** What the toast says once an action is saved. */
export function doneWords(a: LoopAction): string {
  switch (a.action) {
    case "approve":
      return "Approved. Its emails go out in their next send times.";
    case "hold":
      return "Held. This email will not send unless you release it.";
    case "release":
      return "Released. It goes out in its next send time.";
    case "pause":
      return "Paused. The sender sends nothing until you resume.";
    case "resume":
      return "Resumed. The sender picks up at its next send time.";
  }
}
