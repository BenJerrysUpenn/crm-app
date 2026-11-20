// The drawer's Calls list shows call_logs.called_at (naive UTC) in Eastern time,
// and its edit form round-trips the value without moving it, whatever the
// browser's time zone.
//
// The list reads the naive value as UTC, not with `new Date()`, which would take
// it as the browser's local time. The edit form's datetime-local input holds
// Eastern wall-clock time, so a caller in any zone sees and types the same
// Eastern time, and an edit that leaves the time alone never sends it.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CallLogHeading } from "@/components/DealDetailDrawer";
import { calledAtFormValue, callEditBody } from "@/lib/callLog";
import { easternInputValue } from "@/lib/dateFormat";

const db = vi.hoisted(() => {
  const state = { updates: [] as Array<Record<string, unknown>> };
  const auth = {
    auth: {
      getUser: async () => ({ data: { user: { email: "caller1@example.com" } } }),
    },
  };
  const admin = {
    from(table: string) {
      if (table !== "call_logs") throw new Error(`unexpected table ${table}`);
      let row: Record<string, unknown> = {};
      const b = {
        update: (u: Record<string, unknown>) => {
          state.updates.push(u);
          row = u;
          return b;
        },
        eq: () => b,
        select: () => b,
        single: async () => ({ data: { id: 165, ...row }, error: null }),
      };
      return b;
    },
  };
  return { state, auth, admin };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => db.auth }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.admin }));

const { PATCH } = await import("@/app/api/deals/[id]/calls/[callId]/route");

// The browser's zone (the form) and the server's zone (the route) are set
// separately: the route always runs as Vercel does, in UTC.
function inZone<T>(zone: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

async function patchOnUtcServer(body: Record<string, string>) {
  const saved = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    return await PATCH(
      new Request("http://crm.test/api/deals/25440/calls/165", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: { id: "25440", callId: "165" } },
    );
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

function heading(calledAt: string): string {
  return renderToStaticMarkup(
    createElement(CallLogHeading, {
      call: { called_at: calledAt, created_by: "chavi@withers-ventures.com" },
    }),
  );
}

// Asia/Dubai is UTC+4 all year, the zone the call desk's own browser reported.
const BROWSER_ZONES = [
  "America/New_York",
  "UTC",
  "America/Los_Angeles",
  "Asia/Dubai",
];

for (const zone of BROWSER_ZONES) {
  describe(`browser time zone ${zone}`, () => {
    beforeEach(() => {
      db.state.updates.length = 0;
    });

    describe("Calls list", () => {
      it("shows a naive-UTC called_at in Eastern time (EDT)", () => {
        const html = inZone(zone, () => heading("2026-10-22T19:11:00"));
        expect(html).toContain("Oct 22, 2026, 3:11 PM");
        expect(html).toContain("chavi@withers-ventures.com");
      });

      it("shows a winter called_at in Eastern time (EST)", () => {
        expect(inZone(zone, () => heading("2026-12-15T20:00:00"))).toContain(
          "Dec 15, 2026, 3:00 PM",
        );
      });

      it("shows both 1:30 AMs of the fall-back night as 1:30 AM", () => {
        expect(inZone(zone, () => heading("2026-11-01T05:30:00"))).toContain(
          "Nov 1, 2026, 1:30 AM",
        );
        expect(inZone(zone, () => heading("2026-11-01T06:30:00"))).toContain(
          "Nov 1, 2026, 1:30 AM",
        );
      });

      it("shows the first EDT minute after spring-forward as 3:00 AM", () => {
        expect(inZone(zone, () => heading("2026-03-08T07:00:00"))).toContain(
          "Mar 8, 2026, 3:00 AM",
        );
      });
    });

    describe("edit form", () => {
      it("opens on the Eastern wall-clock time of the stored instant", () => {
        expect(inZone(zone, () => calledAtFormValue("2026-10-22T19:11:00"))).toBe(
          "2026-10-22T15:11",
        );
        expect(inZone(zone, () => calledAtFormValue("2026-12-15T20:00:00"))).toBe(
          "2026-12-15T15:00",
        );
        expect(inZone(zone, () => calledAtFormValue("2026-11-01T06:30:00"))).toBe(
          "2026-11-01T01:30",
        );
      });

      it("fills Now with the current Eastern time", () => {
        expect(
          inZone(zone, () => easternInputValue(new Date("2026-10-22T19:11:42Z"))),
        ).toBe("2026-10-22T15:11");
        expect(
          inZone(zone, () => easternInputValue(new Date("2026-03-08T07:00:00Z"))),
        ).toBe("2026-03-08T03:00");
      });

      it.each([
        ["a daytime EDT call", "2026-10-22T19:11:00"],
        ["a value with seconds", "2026-10-22T19:11:42"],
        ["the second 1:30 AM of the fall-back night", "2026-11-01T06:30:00"],
      ])("saving %s unchanged leaves called_at untouched", async (_label, stored) => {
        const body = inZone(zone, () => {
          const opened = calledAtFormValue(stored);
          return callEditBody(opened, opened, "Voicemail");
        });
        const res = await patchOnUtcServer(body);
        expect(res.status).toBe(200);
        expect(db.state.updates[0]).toEqual({ notes: "Voicemail" });
      });

      it("resending an unchanged time still stores the same value", async () => {
        const opened = inZone(zone, () => calledAtFormValue("2026-10-22T19:11:00"));
        await patchOnUtcServer({ called_at: opened, notes: "Voicemail" });
        expect(db.state.updates[0].called_at).toBe("2026-10-22T19:11:00");
      });

      it("saving a new Eastern time stores its UTC instant", async () => {
        const body = inZone(zone, () =>
          callEditBody(
            calledAtFormValue("2026-10-22T19:11:00"),
            "2026-10-22T16:45",
            "Voicemail",
          ),
        );
        expect(body).toEqual({ called_at: "2026-10-22T16:45", notes: "Voicemail" });
        await patchOnUtcServer(body);
        expect(db.state.updates[0]).toEqual({
          called_at: "2026-10-22T20:45:00",
          notes: "Voicemail",
        });
      });

      it("saving a new time across a DST change uses that date's offset", async () => {
        const body = inZone(zone, () =>
          callEditBody(
            calledAtFormValue("2026-10-22T19:11:00"),
            "2026-11-02T09:00",
            "Voicemail",
          ),
        );
        await patchOnUtcServer(body);
        expect(db.state.updates[0].called_at).toBe("2026-11-02T14:00:00");
      });
    });
  });
}

describe("called_at that cannot be read", () => {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it("opens the edit form empty", () => {
    expect(calledAtFormValue("")).toBe("");
    expect(calledAtFormValue("not a time")).toBe("");
  });

  it("shows the stored text in the list as it was", () => {
    expect(heading("not a time")).toContain("not a time");
  });
});
