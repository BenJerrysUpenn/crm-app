// POST /api/email-campaigns/loop, the console's five writes to the weekly
// email loop, end to end against a stand-in database (supabase/crm/014).
// Only the Supabase client is faked: the route runs the real rpcFor. The
// stand-in keeps what the five functions promise: only a manager may call
// them (42501 otherwise), and approve, hold and release refuse a row that is
// not in the state they change (P0002).
//
//   * A manager's approve, hold, release, pause and resume each land, stamped
//     with her email, and the route answers {ok: true}.
//   * A refused write reaches the console as an error, never as {ok: true}:
//     403 for someone who is not a manager, 409 for a row in the wrong state.
//   * Signed out, malformed, or not one of the five: nothing is written.
//
// Invented people and rows; crm-app is public.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type PgError = { code: string; message: string };

const db = vi.hoisted(() => {
  const state = {
    user: { id: "user-1", email: "manager@example.test" } as { id: string; email: string } | null,
    manager: true,
    approaches: [] as Row[],
    drafts: [] as Row[],
    controls: { paused_at: null, paused_by: null, pause_reason: null } as Row,
  };
  const refuse = (code: string, message: string) => ({ data: null, error: { code, message } });
  const reasonOr = (p: unknown, fallback: string) => (typeof p === "string" && p.trim() ? p.trim() : fallback);

  async function rpc(fn: string, args: Record<string, unknown>): Promise<{ data: null; error: PgError | null }> {
    if (!state.manager) return refuse("42501", "Only managers can change the email loop");
    const who = state.user?.email ?? "";
    const now = "2026-11-17T20:00:00Z";
    switch (fn) {
      case "outreach_loop_approve": {
        const a = state.approaches.find((x) => x.id === args.p_approach && x.approved_at === null);
        if (!a) return refuse("P0002", `No approach ${String(args.p_approach)} waiting for approval`);
        Object.assign(a, { approved_at: now, approved_by: who });
        return { data: null, error: null };
      }
      case "outreach_loop_hold": {
        const d = state.drafts.find((x) => x.id === args.p_draft && x.status === "planned");
        if (!d) return refuse("P0002", `Email ${String(args.p_draft)} is not waiting to send`);
        Object.assign(d, { status: "held", held_by: who, held_reason: reasonOr(args.p_reason, "Held from the console") });
        return { data: null, error: null };
      }
      case "outreach_loop_release": {
        const d = state.drafts.find((x) => x.id === args.p_draft && x.status === "held");
        if (!d) return refuse("P0002", `Email ${String(args.p_draft)} is not held`);
        Object.assign(d, { status: "planned", held_by: null, held_reason: null });
        return { data: null, error: null };
      }
      case "outreach_loop_pause":
        if (state.controls.paused_at === null)
          state.controls = { paused_at: now, paused_by: who, pause_reason: reasonOr(args.p_reason, "Paused from the console") };
        return { data: null, error: null };
      case "outreach_loop_resume":
        state.controls = { paused_at: null, paused_by: null, pause_reason: null };
        return { data: null, error: null };
      default:
        return refuse("42883", `function ${fn} does not exist`);
    }
  }

  const client = {
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    rpc,
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.client }));

const { POST } = await import("@/app/api/email-campaigns/loop/route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/email-campaigns/loop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  db.state.user = { id: "user-1", email: "manager@example.test" };
  db.state.manager = true;
  db.state.approaches = [{ id: "party_first", approved_at: null, approved_by: null }];
  db.state.drafts = [
    { id: 12, status: "planned", held_by: null, held_reason: null },
    { id: 13, status: "held", held_by: "other@example.test", held_reason: "Wrong name" },
  ];
  db.state.controls = { paused_at: null, paused_by: null, pause_reason: null };
});

describe("a manager's writes", () => {
  it("approving a waiting approach saves it, stamped with her email", async () => {
    const res = await post({ action: "approve", approach: "party_first" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.state.approaches[0]).toMatchObject({ approved_at: "2026-11-17T20:00:00Z", approved_by: "manager@example.test" });
  });

  it("holding one email keeps her words on it, and releasing it puts it back to send", async () => {
    expect(await (await post({ action: "hold", draft: 12, reason: "  Wrong company  " })).json()).toEqual({ ok: true });
    expect(db.state.drafts[0]).toMatchObject({ status: "held", held_by: "manager@example.test", held_reason: "Wrong company" });

    expect(await (await post({ action: "release", draft: 12 })).json()).toEqual({ ok: true });
    expect(db.state.drafts[0]).toMatchObject({ status: "planned", held_by: null, held_reason: null });
  });

  it("pausing stops the loop with her reason, and resuming clears it", async () => {
    expect(await (await post({ action: "pause", reason: "Checking copy" })).json()).toEqual({ ok: true });
    expect(db.state.controls).toEqual({ paused_at: "2026-11-17T20:00:00Z", paused_by: "manager@example.test", pause_reason: "Checking copy" });

    expect(await (await post({ action: "resume" })).json()).toEqual({ ok: true });
    expect(db.state.controls).toEqual({ paused_at: null, paused_by: null, pause_reason: null });
  });
});

describe("a refused write is never reported as saved", () => {
  it("answers 409 with the database's words when the email is not waiting to send", async () => {
    const res = await post({ action: "hold", draft: 13, reason: "x" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Email 13 is not waiting to send" });
    expect(db.state.drafts[1]).toMatchObject({ status: "held", held_by: "other@example.test", held_reason: "Wrong name" });
  });

  it("answers 403 to someone signed in who is not a manager, and nothing changes", async () => {
    db.state.manager = false;
    const res = await post({ action: "approve", approach: "party_first" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only managers can change the email loop" });
    expect(db.state.approaches[0]).toMatchObject({ approved_at: null, approved_by: null });
  });
});

describe("nothing is written", () => {
  it("for a caller who is not signed in", async () => {
    db.state.user = null;
    const res = await post({ action: "pause", reason: "x" });

    expect(res.status).toBe(401);
    expect(db.state.controls.paused_at).toBeNull();
  });

  it.each([
    ["an action that is not one of the five", { action: "send", draft: 12 }],
    ["an email id that is not a whole number", { action: "hold", draft: "12", reason: "x" }],
    ["an approach id that is not a plain key", { action: "approve", approach: "party_first'; --" }],
  ])("for %s", async (_name, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(db.state.drafts[0].status).toBe("planned");
    expect(db.state.approaches[0].approved_at).toBeNull();
  });

  it("for a body that is not JSON", async () => {
    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad JSON" });
  });
});
