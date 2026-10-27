// /api/deals/:id/event-change end to end, through the service-role
// supabase-js store, against stand-in deals, shifts, profiles and
// pending_calendar_actions tables (tests/support/fakeSupabase.ts).
//
// What it pins: the deal's columns after each action, which shifts move or
// go (and that another deal's do not), the calendar delete queued for the
// imap_idle daemon to drain and the open create / patch rows it supersedes,
// and that a crew or deal that changed since the dialog read it is refused
// with nothing written.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, fakeClient, type FakeDb } from "./support/fakeSupabase";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  user: { id: "manager-1", email: "manager@example.com" } as { id: string; email?: string } | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeClient(h.db, () => h.user),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => fakeClient(h.db, () => h.user),
}));

const { GET, POST } = await import("@/app/api/deals/[id]/event-change/route");
const { supabaseEventChangeStore } = await import("@/lib/eventChange");

const DEAL_ID = 30001;

function seed() {
  h.db = makeFakeDb();
  h.db.tables.deals = [
    {
      id: DEAL_ID,
      stage: "Booked Paid",
      payment_status: "Paid in Full",
      is_active: 1,
      event_date: "2026-10-29",
      event_start_time: "12:00",
      event_end_time: "13:30",
      calendar_event_id: "evt_old_123",
      calendar_event_payload_hash: "hash-old",
      amount_paid: 515.2,
      notes: "[2026-10-09] Earlier line.",
      picklist_docx_path: "/drive/Catering/picklists/Synthetic_10_29_26_Checklist.docx",
      day_before_draft_sent_at: "2026-10-28T14:00:00",
      coi_sent_at: null,
      departure_time: "10:45",
      departure_time_derived: "10:45",
      arrival_time: "11:15",
      arrival_time_derived: "11:15",
      updated_at: "2026-10-20T12:00:00",
    },
  ];
  h.db.tables.shifts = [
    { id: 601, deal_id: DEAL_ID, employee_id: null, starts_at: "2026-10-29T15:00:00+00:00", ends_at: "2026-10-29T18:30:00+00:00" },
    { id: 602, deal_id: DEAL_ID, employee_id: "user-a", starts_at: "2026-10-29T15:00:00+00:00", ends_at: "2026-10-29T18:30:00+00:00" },
    // Another deal's shift: never touched.
    { id: 700, deal_id: 30002, employee_id: null, starts_at: "2026-10-29T15:00:00+00:00", ends_at: "2026-10-29T18:30:00+00:00" },
  ];
  h.db.tables.profiles = [{ id: "user-a", full_name: "Crew Member A Fullname", preferred_name: "Crew Member A" }];
  h.db.tables.pending_calendar_actions = [
    // An open patch built from the old date's payload: superseded.
    { id: 10, deal_id: DEAL_ID, action: "patch", event_id: "evt_old_123", processed_at: null, source: "imap_idle" },
    // An open delete of an earlier event: left to run.
    { id: 11, deal_id: DEAL_ID, action: "delete", event_id: "evt_older", processed_at: null, source: "crm-app" },
    // Another deal's open row: untouched.
    { id: 12, deal_id: 30002, action: "create", event_id: null, processed_at: null, source: "imap_idle" },
  ];
}

function post(body: unknown) {
  return POST(
    new Request(`https://crm.test/api/deals/${DEAL_ID}/event-change`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { id: String(DEAL_ID) } },
  );
}

const deal = () => h.db.tables.deals.find((d) => d.id === DEAL_ID)!;
const shift = (id: number) => h.db.tables.shifts.find((s) => s.id === id);
const queue = () => h.db.tables.pending_calendar_actions;
const queuedDeletes = () => queue().filter((r) => r.action === "delete" && r.source === "crm-app" && r.id !== 11);

beforeEach(() => {
  seed();
  h.user = { id: "manager-1", email: "manager@example.com" };
});

describe("GET: what the dialog shows", () => {
  it("returns the event, the amount paid and every crew shift with the person's name", async () => {
    const res = await GET(new Request("https://crm.test"), { params: { id: String(DEAL_ID) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deal).toMatchObject({
      id: DEAL_ID,
      can_change: true,
      event_date: "2026-10-29",
      amount_paid: 515.2,
      has_calendar_event: true,
    });
    expect(body.shifts.map((s: { id: number; person: string | null }) => [s.id, s.person])).toEqual([
      [601, null],
      [602, "Crew Member A"],
    ]);
  });

  it("answers 401 signed out", async () => {
    h.user = null;
    const res = await GET(new Request("https://crm.test"), { params: { id: String(DEAL_ID) } });
    expect(res.status).toBe(401);
  });

  it("answers 404 for a deal that does not exist", async () => {
    const res = await GET(new Request("https://crm.test"), { params: { id: "99999" } });
    expect(res.status).toBe(404);
  });

  it("answers 400 for a deal id that is not a number", async () => {
    const res = await GET(new Request("https://crm.test"), { params: { id: "abc" } });
    expect(res.status).toBe(400);
  });
});

describe("POST refusals before any write", () => {
  it("answers 401 signed out, writing nothing", async () => {
    h.user = null;
    const before = JSON.stringify(h.db.tables);
    const res = await post({ action: "cancel", staffed_shift_ids: [602] });
    expect(res.status).toBe(401);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it("answers 400 with the reason for a body it cannot read, writing nothing", async () => {
    const before = JSON.stringify(h.db.tables);
    const res = await post({ action: "reschedule", event_date: "2026-02-30", event_start_time: "12:00", event_end_time: "13:30", staffed_shift_ids: [602] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Pick the new date, or tick Date not set yet.");
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it("answers 400 for a deal id that is not a number, writing nothing", async () => {
    const before = JSON.stringify(h.db.tables);
    const res = await POST(
      new Request("https://crm.test/api/deals/abc/event-change", {
        method: "POST",
        body: JSON.stringify({ action: "cancel", staffed_shift_ids: [602] }),
      }),
      { params: { id: "abc" } },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it("answers 404 for a deal that does not exist", async () => {
    const res = await POST(
      new Request("https://crm.test/api/deals/99999/event-change", {
        method: "POST",
        body: JSON.stringify({ action: "cancel", staffed_shift_ids: [] }),
      }),
      { params: { id: "99999" } },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST reschedule to a new date", () => {
  const body = {
    action: "reschedule",
    event_date: "2026-11-05",
    event_start_time: "13:00",
    event_end_time: "14:30",
    staffed_shift_ids: [602],
  };

  it("writes the deal, moves the deal's shifts, queues the old event's delete and supersedes stale calendar writes", async () => {
    const res = await post(body);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, moved: 2, removed: 0 });

    expect(deal()).toMatchObject({
      stage: "Booked Paid",
      event_date: "2026-11-05",
      event_start_time: "13:00",
      event_end_time: "14:30",
      calendar_event_id: null,
      calendar_event_payload_hash: null,
      picklist_docx_path: null,
      day_before_draft_sent_at: null,
      coi_sent_at: null,
      // The start moved from 12:00 to 13:00: the times derived from it go.
      departure_time: null,
      departure_time_derived: null,
      arrival_time: null,
      arrival_time_derived: null,
    });
    expect(String(deal().notes)).toBe(`[2026-10-09] Earlier line.\n${out.noteLine}`);
    expect(out.noteLine).toContain("Logistics times cleared (were departure 10:45, arrival 11:15)");
    expect(out.noteLine).toContain("Thu 2026-10-29 12:00-13:30 to Thu 2026-11-05 13:00-14:30");

    // An hour before 1 PM EST on Nov 5, both of them.
    for (const id of [601, 602]) {
      expect(shift(id)).toMatchObject({
        starts_at: "2026-11-05T17:00:00.000Z",
        ends_at: "2026-11-05T20:30:00.000Z",
      });
    }
    expect(shift(602)!.employee_id).toBe("user-a");
    expect(shift(700)!.starts_at).toBe("2026-10-29T15:00:00+00:00");

    expect(queuedDeletes()).toEqual([
      expect.objectContaining({
        deal_id: DEAL_ID,
        action: "delete",
        event_id: "evt_old_123",
        payload: {},
        new_hash: null,
      }),
    ]);
    const row = (id: number) => queue().find((r) => r.id === id)!;
    expect(row(10).processed_at).toBeTruthy();
    expect(row(10).source).toBe("imap_idle (superseded)");
    expect(row(11).processed_at).toBeNull();
    expect(row(12).processed_at).toBeNull();
  });

  it("keeps the logistics times on a date-only change", async () => {
    const res = await post({ ...body, event_start_time: "12:00", event_end_time: "13:30" });
    expect(res.status).toBe(200);
    expect(deal()).toMatchObject({
      event_date: "2026-11-05",
      departure_time: "10:45",
      departure_time_derived: "10:45",
      arrival_time: "11:15",
      arrival_time_derived: "11:15",
    });
  });

  it("clears the live times and still moves the shifts on a database without migration 016's twins", async () => {
    delete deal().departure_time_derived;
    delete deal().arrival_time_derived;
    h.db.missingColumns.deals = ["departure_time_derived", "arrival_time_derived"];
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, moved: 2 });
    expect(deal()).toMatchObject({ event_start_time: "13:00", departure_time: null, arrival_time: null });
    expect(deal()).not.toHaveProperty("departure_time_derived");
    expect(shift(601)!.starts_at).toBe("2026-11-05T17:00:00.000Z");
  });

  it("queues no calendar delete when the deal had no event", async () => {
    deal().calendar_event_id = null;
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(queuedDeletes()).toEqual([]);
  });

  it("refuses, writing nothing, when the crew changed since the dialog read it", async () => {
    shift(601)!.employee_id = "user-b";
    const before = JSON.stringify(h.db.tables);
    const res = await post(body);
    expect(res.status).toBe(409);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it("refuses a deal at any other stage, writing nothing", async () => {
    deal().stage = "Sent Quote";
    const before = JSON.stringify(h.db.tables);
    const res = await post(body);
    expect(res.status).toBe(409);
    expect(JSON.stringify(h.db.tables)).toBe(before);
  });

  it("says what is left to do by hand when the calendar delete cannot be queued", async () => {
    h.db.failWrites.pending_calendar_actions = "permission denied";
    // The supersede update is the first write to the queue; let it through
    // by removing the open patch, so the failure lands on the insert.
    h.db.tables.pending_calendar_actions = [];
    const res = await post(body);
    expect(res.status).toBe(500);
    const out = await res.json();
    expect(out.error).toContain("The deal was saved, but the old calendar event (evt_old_123) could not be queued for deletion");
    expect(deal().event_date).toBe("2026-11-05");
    expect(shift(601)!.starts_at).toBe("2026-11-05T17:00:00.000Z");
  });

  it("says which shift to move by hand when one cannot be moved, and still moves the rest", async () => {
    // The first write to shifts is the move of 601.
    h.db.failWrites.shifts = "permission denied";
    const res = await post(body);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(
      "The deal was saved, but shift 601 did not move (permission denied); move it on the Schedule page.",
    );
    expect(deal().event_date).toBe("2026-11-05");
    expect(shift(601)!.starts_at).toBe("2026-10-29T15:00:00+00:00");
    expect(shift(602)!.starts_at).toBe("2026-11-05T17:00:00.000Z");
  });
});

describe("POST reschedule, date not set yet", () => {
  it("clears the date, keeps the times, removes the deal's shifts and queues the old event's delete", async () => {
    const res = await post({ action: "reschedule", date_not_set: true, staffed_shift_ids: [602] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, moved: 0, removed: 2 });
    expect(deal()).toMatchObject({
      stage: "Booked Paid",
      event_date: null,
      event_start_time: "12:00",
      event_end_time: "13:30",
      calendar_event_id: null,
      calendar_event_payload_hash: null,
      picklist_docx_path: null,
      day_before_draft_sent_at: null,
      departure_time: null,
      departure_time_derived: null,
      arrival_time: null,
      arrival_time_derived: null,
    });
    expect(String(deal().notes)).toContain("Rescheduled, new date not set (manager@example.com). Was Thu 2026-10-29 12:00-13:30.");
    expect(h.db.tables.shifts.map((s) => s.id)).toEqual([700]);
    expect(queuedDeletes()).toHaveLength(1);
    expect(queuedDeletes()[0].event_id).toBe("evt_old_123");
  });
});

describe("POST cancel", () => {
  it("moves the deal to Closed Lost, removes the deal's shifts and queues the old event's delete", async () => {
    const res = await post({ action: "cancel", staffed_shift_ids: [602] });
    expect(res.status).toBe(200);
    expect(deal()).toMatchObject({
      stage: "Closed Lost",
      is_active: 0,
      payment_status: "Paid in Full",
      event_date: "2026-10-29",
      calendar_event_id: null,
      calendar_event_payload_hash: null,
    });
    expect(String(deal().notes)).toContain("Paid $515.20; any refund is done by hand in Square.");
    expect(h.db.tables.shifts.map((s) => s.id)).toEqual([700]);
    expect(queuedDeletes()).toHaveLength(1);
  });

  it("says which shifts to remove by hand when they cannot be removed", async () => {
    h.db.failWrites.shifts = "permission denied";
    const res = await post({ action: "cancel", staffed_shift_ids: [602] });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(
      "The deal was saved, but the crew shifts (601, 602) were not removed (permission denied); remove them on the Schedule page.",
    );
    expect(deal().stage).toBe("Closed Lost");
    expect(h.db.tables.shifts.map((s) => s.id)).toEqual([601, 602, 700]);
  });

  it("refuses when someone was put on the crew after the dialog opened", async () => {
    const res = await post({ action: "cancel", staffed_shift_ids: [] });
    expect(res.status).toBe(409);
    expect(deal().stage).toBe("Booked Paid");
    expect(h.db.tables.shifts).toHaveLength(3);
  });
});

describe("the store's guarded deal update", () => {
  it("writes nothing when the deal's date or calendar event changed since it was read", async () => {
    const store = supabaseEventChangeStore(fakeClient(h.db, () => h.user) as never);
    const read = (await store.readDeal(DEAL_ID))!;
    deal().calendar_event_id = "evt_made_by_the_daemon";
    expect(await store.updateDealIfUnchanged(read, { event_date: null })).toBe(false);
    expect(deal().event_date).toBe("2026-10-29");

    deal().calendar_event_id = "evt_old_123";
    deal().event_date = "2026-10-30";
    expect(await store.updateDealIfUnchanged(read, { event_date: null })).toBe(false);

    deal().event_date = "2026-10-29";
    expect(await store.updateDealIfUnchanged(read, { event_date: null })).toBe(true);
    expect(deal().event_date).toBeNull();
  });

  it("refuses with 409, removing no shifts and queuing no delete, when the deal changes between the read and the write", async () => {
    // A store whose read is stale: the row changes between the read and the write.
    const { applyEventChange } = await import("@/lib/eventChange");
    const store = supabaseEventChangeStore(fakeClient(h.db, () => h.user) as never);
    const staleRead = store.readDeal.bind(store);
    store.readDeal = async (id) => {
      const d = await staleRead(id);
      deal().calendar_event_id = "evt_made_by_the_daemon";
      return d;
    };
    const r = await applyEventChange(store, DEAL_ID, { kind: "reschedule_tbd" }, [602], {
      now: new Date("2026-10-27T16:00:00Z"),
      actor: "manager@example.com",
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(deal().event_date).toBe("2026-10-29");
    expect(h.db.tables.shifts).toHaveLength(3);
    expect(queuedDeletes()).toEqual([]);
  });
});
