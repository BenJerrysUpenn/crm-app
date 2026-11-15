// PROTOTYPE (bj-finance #811), throwaway. The scenario switch (spec section
// 8.5): injects spec section 3's four scenarios over the real facts, so a
// quiet week still shows what each badge does. Every injected value is
// synthetic, marked `synthetic`, and names no real person or address beyond
// the business's own sending mailboxes. attentionItems() then runs on the
// changed facts exactly as it does on real ones.

import type { Facts } from "./facts";
import type { LoopFacts } from "./loop";
import { minusBusinessMinutes } from "./time";

export type ScenarioKey = "none" | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
export const SCENARIOS: { key: ScenarioKey; label: string }[] = [
  { key: "none", label: "Real data only" },
  { key: "A", label: "A · a mailbox stops delivering" },
  { key: "B", label: "B · a reply has waited 3 hours" },
  { key: "C", label: "C · people due a step with no copy" },
  { key: "D", label: "D · a seed test is overdue" },
  { key: "E", label: "E · the Monday run did not happen" },
  { key: "F", label: "F · LinkedIn research halted" },
  { key: "G", label: "G · the sender did not send" },
  { key: "H", label: "H · you flagged an email" },
];

export const parseScenario = (s: string | string[] | undefined): ScenarioKey => {
  const v = (Array.isArray(s) ? s[0] : s ?? "").toUpperCase();
  return (["A", "B", "C", "D", "E", "F", "G", "H"] as const).find((k) => k === v) ?? "none";
};

const TAG = "synthetic (scenario switch)";
const DAY = 86_400_000;

export function applyScenario(base: Facts, key: ScenarioKey): Facts {
  if (key === "none") return base;
  const f: Facts = structuredClone(base);
  const now = new Date(f.now);

  if (key === "A") {
    // Box on the news.* domain stops: three Gmail auth rejections, paused by the rules.
    const news = f.domains.find((d) => d.domain.startsWith("news.")) ?? f.domains.find((d) => d.lane === "warm");
    const m = f.mailboxes.find((x) => x.domainId === news?.id && !x.frozen);
    if (m) {
      m.frozen = true;
      m.frozenBy = "rules";
      m.frozenAt = new Date(now.getTime() - 40 * 60_000).toISOString();
      m.frozenReason = '3 Gmail rejections "5.7.26 unauthenticated" in 12 minutes';
      m.fixes = ["Check DNS now", "Move 18 to other boxes", "Shelve…"];
      m.waiting = [
        { lane: "warm", n: 12 },
        { lane: "wedding", n: 6 },
      ];
      m.synthetic = TAG;
      for (const l of f.lanes) {
        const w = m.waiting.find((x) => x.lane === l.key);
        if (w) l.waitingOn.push({ mailboxId: m.id, n: w.n });
      }
    }
  }

  if (key === "B") {
    // A Wedding lead replied to step 1, 3h 02m of business time ago.
    f.replies.push({
      id: "rs1",
      lane: "wedding",
      step: 1,
      at: minusBusinessMinutes(now, 182).toISOString(),
      handledAt: null,
      example: "Do you do sundae bars for about 120 guests?",
      synthetic: TAG,
    });
  }

  if (key === "C") {
    // The Wedding lane's first step with no copy: 14 people due in 3 days.
    const l = f.lanes.find((x) => x.key === "wedding");
    const s = l?.steps.find((x) => !x.written);
    if (s && s.due) {
      s.due = { soon: 14, later: 17, firstDue: new Date(now.getTime() + 3 * DAY).toISOString() };
      s.synthetic = TAG;
    }
  }

  if (key === "D") {
    // The news.* domain's last seed test was 15 days ago (due every 14).
    const d = f.domains.find((x) => x.domain.startsWith("news.")) ?? f.domains[0];
    const c = d?.checks.find((x) => x.kind === "seed");
    if (c) {
      c.nodata = false;
      c.lastRunAt = new Date(now.getTime() - 15 * DAY).toISOString();
      c.result = "Gmail 9 of 10 inbox · Microsoft 7 of 10 · Yahoo 10 of 10";
      c.synthetic = TAG;
    }
  }

  return f;
}

/** Round 3: the loop's scenarios (spec 10.4). A to D leave the loop alone. */
export function applyLoopScenario(base: LoopFacts, key: ScenarioKey): LoopFacts {
  if (!["E", "F", "G", "H"].includes(key)) return base;
  const L: LoopFacts = structuredClone(base);
  L.synthetic = TAG;
  if (key === "E") {
    L.run = null;
    L.runs = L.runs.slice(1);
    L.drafts = [];
    for (const t of L.types) t.emailsThisWeek = 0;
    // Monday after 9am, so the run is late (L1).
    L.today = L.weekStart;
    L.now = new Date(`${L.weekStart}T15:30:00Z`).toISOString();
  } else if (key === "F") {
    L.research.halt = {
      at: new Date(new Date(L.now).getTime() - 3 * 3_600_000).toISOString(),
      note: "LinkedIn showed 'unusual activity' on page 17 of 40. Stopped at once, signed in as before, nothing retried.",
    };
  } else if (key === "G") {
    // Monday 3pm, week approved, Monday's emails still planned (L3).
    L.today = L.weekStart;
    L.now = new Date(`${L.weekStart}T20:00:00Z`).toISOString();
    if (L.run) L.run.approvedAt = new Date(`${L.weekStart}T13:40:00Z`).toISOString();
    for (const d of L.drafts) d.status = "planned";
  } else if (key === "H") {
    const d = L.drafts.find((x) => x.status === "planned" && x.approachId === "hcf_picture");
    if (d) {
      d.status = "held";
      L.flagged = [{ draftId: d.id, words: null }];
    }
  }
  return L;
}
