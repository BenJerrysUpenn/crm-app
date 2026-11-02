// Closing a deal as lost from the call desk writes deal_events like every other
// stage move, as the signed-in caller. It runs on the session client, not the
// service role (docs/call-desk.md: the caller identity is the point), and
// deal_events and deals carry the same manager policy, so whoever may close the
// deal may write its history.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    dealStage: "Sent Quote",
    insertError: null as string | null,
    inserts: [] as Array<Record<string, unknown>>,
    dealUpdates: [] as Array<Record<string, unknown>>,
    adminUsed: false,
  };
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: { email: "caller1@example.com" } },
        error: null,
      }),
    },
    rpc: async () => ({ error: null }),
    from(table: string) {
      if (table === "outreach_events") {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { id: 5, prospect_id: 9, event: "called", detail: {} },
            error: null,
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
        return b;
      }
      if (table === "outreach_prospects") {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { email: "sam@acme.com" },
            error: null,
          }),
        };
        return b;
      }
      if (table === "deals") {
        const write = {
          eq: () => write,
          select: async () => ({ data: [{ id: 77 }], error: null }),
          then: (done: (r: unknown) => unknown) => done({ error: null }),
        };
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: {
              id: 77,
              stage: state.dealStage,
              is_active: 1,
              contact_email: "sam@acme.com",
            },
            error: null,
          }),
          update: (u: Record<string, unknown>) => {
            state.dealUpdates.push(u);
            return write;
          },
        };
        return b;
      }
      if (table === "deal_events") {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            state.inserts.push(...rows);
            return {
              error: state.insertError ? { message: state.insertError } : null,
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.client }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    db.state.adminUsed = true;
    throw new Error("the call desk must not use the service role");
  },
}));

import { PATCH } from "@/app/api/call-desk/calls/[eventId]/route";

function closeAsLost() {
  return PATCH(
    new Request("http://crm.test/api/call-desk/calls/5", {
      method: "PATCH",
      body: JSON.stringify({ disposition: "lost", close_deal_id: 77 }),
    }),
    { params: { eventId: "5" } },
  );
}

describe("call desk close-as-lost", () => {
  beforeEach(() => {
    db.state.dealStage = "Sent Quote";
    db.state.insertError = null;
    db.state.inserts = [];
    db.state.dealUpdates = [];
    db.state.adminUsed = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("writes the history as the signed-in caller, on the session client", async () => {
    const res = await closeAsLost();
    expect(res.status).toBe(200);
    expect(db.state.dealUpdates).toHaveLength(1);
    expect(db.state.dealUpdates[0].stage).toBe("Closed Lost");
    expect(db.state.inserts.map((r) => [r.field, r.old_value, r.new_value])).toEqual([
      ["stage", "Sent Quote", "Closed Lost"],
      ["is_active", "1", "0"],
    ]);
    expect(db.state.inserts[0]).toMatchObject({
      deal_id: 77,
      actor: "crm:caller1@example.com",
      source: "crm-app",
    });
    expect(db.state.adminUsed).toBe(false);
  });

  it("says so when the deal closed but the history did not write", async () => {
    db.state.insertError = "permission denied for table deal_events";
    const res = await closeAsLost();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toContain("closed");
    expect(body.error).toContain("history");
    expect(body.error).toContain("permission denied");
    expect(db.state.dealUpdates).toHaveLength(1);
  });

  it("does not move or log a deal that is already decided", async () => {
    db.state.dealStage = "Booked Paid";
    const res = await closeAsLost();
    expect(res.status).toBe(409);
    expect(db.state.dealUpdates).toEqual([]);
    expect(db.state.inserts).toEqual([]);
  });
});
