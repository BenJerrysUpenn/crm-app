import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// POST /api/email-campaigns/check-contact — PROTOTYPE (branch
// prototype/email-campaigns, never main).
//
// The "+ Add contacts" form on the Cold tier calls this to show what WOULD
// happen if the contact were added. It is READ-ONLY: two selects, as the
// signed-in manager (RLS `(select is_manager())`), and nothing is written.
//
//   * Duplicate check against outreach_prospects by email, and by LinkedIn
//     URL. There is no LinkedIn column yet, so the URL is looked for in
//     website, notes and source_detail.
//   * Suppression check against outreach_suppression by email.
//
// The body carries the email and URL (never the query string).

type Match = { id: number; name: string | null; engine: string | null; status: string; on: "email" | "LinkedIn URL" };
export type CheckResult = {
  matches: Match[];
  suppressed: { reason: string | null } | null;
  linkedinKey: string | null;
};

/** "https://www.linkedin.com/in/jane-doe-123/?x=y" -> "linkedin.com/in/jane-doe-123" */
function linkedinKey(url: string): string | null {
  const m = url.trim().toLowerCase().match(/linkedin\.com\/(in|pub)\/([^/?#\s]+)/);
  return m ? `linkedin.com/${m[1]}/${m[2]}` : null;
}

/** Escape ilike wildcards so user input is matched literally. */
const lit = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type FixtureRow = {
  id: number;
  name: string | null;
  email: string | null;
  engine: string | null;
  status: string;
  website?: string | null;
  notes?: string | null;
  source_detail?: string | null;
};

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { email?: unknown; linkedin?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const li = typeof body.linkedin === "string" ? linkedinKey(body.linkedin) : null;
  if (!email && !li) return NextResponse.json({ error: "Give an email or a LinkedIn URL" }, { status: 400 });

  const result: CheckResult = { matches: [], suppressed: null, linkedinKey: li };

  // Local dev only: check against the same JSON dump the page renders from.
  if (process.env.NODE_ENV === "development" && process.env.EMAIL_CAMPAIGNS_FIXTURE) {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(process.env.EMAIL_CAMPAIGNS_FIXTURE, "utf8")) as {
      prospects: FixtureRow[];
      suppressedEmails: string[];
    };
    for (const p of raw.prospects) {
      const byEmail = !!email && (p.email ?? "").toLowerCase() === email;
      const byLi = !!li && [p.website, p.notes, p.source_detail].some((v) => (v ?? "").toLowerCase().includes(li));
      if (byEmail || byLi)
        result.matches.push({ id: p.id, name: p.name, engine: p.engine, status: p.status, on: byEmail ? "email" : "LinkedIn URL" });
    }
    if (email) {
      if (raw.suppressedEmails.some((e) => e.toLowerCase() === email)) result.suppressed = { reason: null };
    }
    return NextResponse.json(result);
  }

  const cols = "id,name,engine,status";
  const queries: PromiseLike<{ on: Match["on"]; rows: Omit<Match, "on">[]; error: unknown }>[] = [];
  if (email) {
    queries.push(
      supabase
        .from("outreach_prospects")
        .select(cols)
        .ilike("email", lit(email))
        .limit(5)
        .then((r) => ({ on: "email" as const, rows: (r.data ?? []) as Omit<Match, "on">[], error: r.error })),
    );
  }
  if (li) {
    for (const col of ["website", "notes", "source_detail"]) {
      queries.push(
        supabase
          .from("outreach_prospects")
          .select(cols)
          .ilike(col, `%${lit(li)}%`)
          .limit(5)
          .then((r) => ({ on: "LinkedIn URL" as const, rows: (r.data ?? []) as Omit<Match, "on">[], error: r.error })),
      );
    }
  }
  const found = await Promise.all(queries);
  for (const f of found) {
    if (f.error) return NextResponse.json({ error: String((f.error as { message?: string }).message ?? f.error) }, { status: 500 });
    for (const row of f.rows)
      if (!result.matches.some((m) => m.id === row.id)) result.matches.push({ ...row, on: f.on });
  }

  if (email) {
    const { data, error } = await supabase
      .from("outreach_suppression")
      .select("reason")
      .ilike("email", lit(email))
      .limit(1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (data && data.length) result.suppressed = { reason: (data[0] as { reason: string | null }).reason };
  }

  return NextResponse.json(result);
}
