// The call-log routes write call_logs.called_at as naive UTC, whatever zone the
// server runs in.
//
// The drawer's datetime-local input holds Eastern wall-clock time
// ("2026-10-22T15:11" for a 3:11 PM call). Vercel runs these routes with
// TZ=UTC, so `new Date("2026-10-22T15:11")` there read the Eastern time as UTC
// and stored the caller's wall clock in a UTC column. Every case runs with the
// server in UTC and again in New York: the stored value must not change.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    dealNotesWrites: [] as string[],
    dealNotes: null as string | null,
  };

  const auth = {
    auth: {
      getUser: async () => ({ data: { user: { email: "caller1@example.com" } } }),
    },
  };

  const admin = {
    from(table: string) {
      if (table === "call_logs") {
        let row: Record<string, unknown> = {};
        const b = {
          insert: (r: Record<string, unknown>) => {
            state.inserts.push(r);
            row = r;
            return b;
          },
          update: (u: Record<string, unknown>) => {
            state.updates.push(u);
            row = u;
            return b;
          },
          eq: () => b,
          select: () => b,
          single: async () => ({ data: { id: 7, ...row }, error: null }),
        };
        return b;
      }
      if (table === "deals") {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { notes: state.dealNotes },
            error: null,
          }),
          update: (u: { notes: string }) => {
            state.dealNotesWrites.push(u.notes);
            return { eq: async () => ({ error: null }) };
          },
        };
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { state, auth, admin };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.auth }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.admin }));

const { POST } = await import("@/app/api/deals/[id]/calls/route");
const { PATCH } = await import("@/app/api/deals/[id]/calls/[callId]/route");

function req(body: unknown): Request {
  return new Request("http://crm.test/api/deals/25440/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function logCall(calledAt: string) {
  return POST(req({ called_at: calledAt, notes: "Voicemail" }), {
    params: { id: "25440" },
  });
}

async function editCall(body: Record<string, string>) {
  return PATCH(req(body), { params: { id: "25440", callId: "165" } });
}

for (const zone of ["UTC", "America/New_York"]) {
  describe(`server time zone ${zone}`, () => {
    const saved = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = zone;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });
    beforeEach(() => {
      db.state.inserts.length = 0;
      db.state.updates.length = 0;
      db.state.dealNotesWrites.length = 0;
      db.state.dealNotes = null;
    });

    describe("POST /api/deals/:id/calls", () => {
      it("stores an Eastern form time as naive UTC (EDT, UTC-4)", async () => {
        const res = await logCall("2026-10-22T15:11");
        expect(res.status).toBe(200);
        expect(db.state.inserts[0].called_at).toBe("2026-10-22T19:11:00");
      });

      it("stores an Eastern form time as naive UTC (EST, UTC-5)", async () => {
        await logCall("2026-12-15T15:00");
        expect(db.state.inserts[0].called_at).toBe("2026-12-15T20:00:00");
      });

      it("stamps the activity-log line with the Eastern time the caller entered", async () => {
        db.state.dealNotes = "[2026-10-15] Created by hand";
        await logCall("2026-10-22T15:11");
        expect(db.state.dealNotesWrites[0]).toBe(
          "[2026-10-15] Created by hand\n" +
            "[2026-10-22 15:11 ET] Call log (caller1@example.com): Voicemail",
        );
      });

      it("keeps the instant of a value that carries a Z or an offset", async () => {
        await logCall("2026-10-22T19:11:00.000Z");
        expect(db.state.inserts[0].called_at).toBe("2026-10-22T19:11:00");
        db.state.inserts.length = 0;
        await logCall("2026-10-22T15:11:00-04:00");
        expect(db.state.inserts[0].called_at).toBe("2026-10-22T19:11:00");
      });

      it("refuses a date that does not exist", async () => {
        const res = await logCall("2026-02-30T10:00");
        expect(res.status).toBe(400);
        expect(db.state.inserts).toHaveLength(0);
      });
    });

    describe("PATCH /api/deals/:id/calls/:callId", () => {
      it("stores an edited Eastern time as naive UTC", async () => {
        const res = await editCall({ called_at: "2026-10-22T16:30", notes: "Voicemail" });
        expect(res.status).toBe(200);
        expect(db.state.updates[0]).toEqual({
          called_at: "2026-10-22T20:30:00",
          notes: "Voicemail",
        });
      });

      it("leaves called_at out of the update when only the notes are sent", async () => {
        await editCall({ notes: "Left a message" });
        expect(db.state.updates[0]).toEqual({ notes: "Left a message" });
      });

      it("refuses a time that does not parse", async () => {
        const res = await editCall({ called_at: "2026-10-22T25:00", notes: "x" });
        expect(res.status).toBe(400);
        expect(db.state.updates).toHaveLength(0);
      });

      // America/New_York springs forward at 2026-03-08 02:00 EST (07:00Z) and
      // falls back at 2026-11-01 02:00 EDT (06:00Z).
      it.each([
        ["the last minute of EST before spring-forward", "2026-03-08T01:59", "2026-03-08T06:59:00"],
        ["the first minute of EDT after spring-forward", "2026-03-08T03:00", "2026-03-08T07:00:00"],
        ["a time skipped by spring-forward, read as the clock moved on (3:30 EDT)", "2026-03-08T02:30", "2026-03-08T07:30:00"],
        ["the repeated 1:30 at fall-back, read as the first (EDT) one", "2026-11-01T01:30", "2026-11-01T05:30:00"],
        ["the first minute of EST after fall-back", "2026-11-01T02:00", "2026-11-01T07:00:00"],
      ])("DST: %s", async (_label, input, stored) => {
        await editCall({ called_at: input, notes: "x" });
        expect(db.state.updates[0].called_at).toBe(stored);
      });
    });
  });
}
