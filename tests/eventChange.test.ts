// Reschedule event and Cancel event on the deal drawer: the rules
// (lib/eventChange.ts planEventChange), what the dialog says before anyone
// confirms (components/EventChangeDialog.tsx confirmationLines), and which
// deals show the two buttons.
//
// The writes themselves, against stand-in tables, are
// tests/eventChangeRoute.test.ts.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  canChangeEvent,
  describeShiftTime,
  parseEventChangeBody,
  planEventChange,
  type CrewShift,
  type EventDeal,
  type EventPreview,
} from "@/lib/eventChange";
import { confirmationLines } from "@/components/EventChangeDialog";
import DealDetailDrawer from "@/components/DealDetailDrawer";
import type { Deal } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const NOW = new Date("2026-10-27T16:00:00Z");
const CTX = { now: NOW, actor: "manager@example.com" };

function mkDeal(overrides: Partial<EventDeal> = {}): EventDeal {
  return {
    id: 30001,
    stage: "Booked Paid",
    event_date: "2026-10-29",
    event_start_time: "12:00",
    event_end_time: "13:30",
    calendar_event_id: "evt_old_123",
    amount_paid: 515.2,
    notes: "[2026-10-09] Earlier line.",
    picklist_docx_path: "/drive/Catering/picklists/Synthetic_10_29_26_Checklist.docx",
    day_before_draft_sent_at: null,
    coi_sent_at: "2026-10-20T15:00:00",
    ...overrides,
  };
}

// 11:00-14:30 Eastern (EDT) on the event day: one hour before the 12:00 start.
const OPEN: CrewShift = {
  id: 601,
  starts_at: "2026-10-29T15:00:00+00:00",
  ends_at: "2026-10-29T18:30:00+00:00",
  employee_id: null,
  person: null,
};
const STAFFED: CrewShift = {
  id: 602,
  starts_at: "2026-10-29T15:00:00+00:00",
  ends_at: "2026-10-29T18:30:00+00:00",
  employee_id: "user-a",
  person: "Crew Member A",
};

function plan(
  deal: EventDeal,
  shifts: CrewShift[],
  request: Parameters<typeof planEventChange>[2],
) {
  const r = planEventChange(deal, shifts, request, CTX);
  if (!r.ok) throw new Error(`expected a plan, got ${r.status} ${r.error}`);
  return r.plan;
}

const TO_NOV_5 = {
  kind: "reschedule" as const,
  event_date: "2026-11-05",
  event_start_time: "12:00",
  event_end_time: "13:30",
};

describe("Reschedule event, to a new date", () => {
  it("writes the new date and times, clears the calendar link and the old date's stamps, in one deal update", () => {
    const p = plan(mkDeal(), [OPEN, STAFFED], TO_NOV_5);
    expect(p.dealPatch).toMatchObject({
      event_date: "2026-11-05",
      event_start_time: "12:00",
      event_end_time: "13:30",
      calendar_event_id: null,
      calendar_event_payload_hash: null,
      picklist_docx_path: null,
      day_before_draft_sent_at: null,
      coi_sent_at: null,
      updated_at: NOW.toISOString(),
    });
    expect(p.dealPatch).not.toHaveProperty("stage");
    expect(p.deleteCalendarEventId).toBe("evt_old_123");
    expect(p.deletes).toEqual([]);
  });

  it("moves every crew shift with the event, keeping its offset from the start, across the end of daylight time", () => {
    const p = plan(mkDeal(), [OPEN, STAFFED], TO_NOV_5);
    // 11:00 EDT on Oct 29 becomes 11:00 EST on Nov 5: an hour before 12:00 still.
    expect(p.moves).toEqual([
      { id: 601, starts_at: "2026-11-05T16:00:00.000Z", ends_at: "2026-11-05T19:30:00.000Z" },
      { id: 602, starts_at: "2026-11-05T16:00:00.000Z", ends_at: "2026-11-05T19:30:00.000Z" },
    ]);
    expect(describeShiftTime(p.moves[0].starts_at, p.moves[0].ends_at)).toBe("Thu 2026-11-05 11:00-14:30");
  });

  it("follows a new start time: a shift an hour before noon is an hour before 3 PM", () => {
    const p = plan(mkDeal(), [STAFFED], { ...TO_NOV_5, event_date: "2026-10-29", event_start_time: "15:00", event_end_time: "16:30" });
    expect(p.moves).toEqual([
      { id: 602, starts_at: "2026-10-29T18:00:00.000Z", ends_at: "2026-10-29T21:30:00.000Z" },
    ]);
  });

  it("describes a shift that runs past midnight with its end day", () => {
    // 20:00 EDT on Oct 29 to 01:00 EDT on Oct 30.
    expect(describeShiftTime("2026-10-30T00:00:00Z", "2026-10-30T05:00:00Z")).toBe(
      "Thu 2026-10-29 20:00-Fri 2026-10-30 01:00",
    );
  });

  it("moves nothing when only the end time changes", () => {
    const p = plan(mkDeal(), [OPEN], { ...TO_NOV_5, event_date: "2026-10-29", event_end_time: "14:00" });
    expect(p.moves).toEqual([]);
    expect(p.dealPatch.event_end_time).toBe("14:00");
  });

  it("with no old start time, keeps each shift's time of day and changes its day", () => {
    const p = plan(mkDeal({ event_start_time: null }), [OPEN], { ...TO_NOV_5, event_date: "2026-10-30" });
    expect(p.moves).toEqual([
      { id: 601, starts_at: "2026-10-30T15:00:00.000Z", ends_at: "2026-10-30T18:30:00.000Z" },
    ]);
  });

  it("with no old date, leaves the shifts where they are and says so", () => {
    const p = plan(mkDeal({ event_date: null, calendar_event_id: null }), [OPEN], TO_NOV_5);
    expect(p.moves).toEqual([]);
    expect(p.deletes).toEqual([]);
    expect(p.noteLine).toContain("1 crew shift left where it was: the deal had no date to move them from.");
    expect(p.deleteCalendarEventId).toBeNull();
  });

  it("appends a note saying what moved, from what to what", () => {
    const p = plan(mkDeal(), [OPEN, STAFFED], TO_NOV_5);
    expect(p.noteLine).toBe(
      "[2026-10-27] Rescheduled (manager@example.com): Thu 2026-10-29 12:00-13:30 to Thu 2026-11-05 12:00-13:30. " +
        "Calendar event queued for deletion and its link cleared. A fresh event is created on the new date by the calendar reconcile. " +
        "Crew shifts moved with it: open Thu 2026-10-29 11:00-14:30 to Thu 2026-11-05 11:00-14:30; " +
        "Crew Member A Thu 2026-10-29 11:00-14:30 to Thu 2026-11-05 11:00-14:30. " +
        "Cleared for the old date: picklist, COI sent stamp. Regenerate the picklist.",
    );
    expect(p.dealPatch.notes).toBe(`[2026-10-09] Earlier line.\n${p.noteLine}`);
  });

  it("says a Closed Marketing Event deal gets no new calendar event", () => {
    const p = plan(mkDeal({ stage: "Closed Marketing Event" }), [], TO_NOV_5);
    expect(p.noteLine).toContain("A Closed Marketing Event deal gets no calendar event.");
    expect(p.deleteCalendarEventId).toBe("evt_old_123");
  });

  it("queues no calendar delete when no event was linked", () => {
    const p = plan(mkDeal({ calendar_event_id: null }), [], TO_NOV_5);
    expect(p.deleteCalendarEventId).toBeNull();
    expect(p.noteLine).toContain("No calendar event was linked.");
  });

  it("refuses the date and times the event already has", () => {
    const r = planEventChange(mkDeal(), [], { ...TO_NOV_5, event_date: "2026-10-29" }, CTX);
    expect(r).toEqual({ ok: false, status: 400, error: "That is the date and time the event already has." });
  });
});

describe("Reschedule event, date not set yet", () => {
  it("clears the date and keeps the times, clears the calendar link and the stamps, and removes every crew shift", () => {
    const p = plan(mkDeal(), [OPEN, STAFFED], { kind: "reschedule_tbd" });
    expect(p.dealPatch).toMatchObject({
      event_date: null,
      calendar_event_id: null,
      calendar_event_payload_hash: null,
      picklist_docx_path: null,
      day_before_draft_sent_at: null,
      coi_sent_at: null,
    });
    expect(p.dealPatch).not.toHaveProperty("event_start_time");
    expect(p.dealPatch).not.toHaveProperty("event_end_time");
    expect(p.dealPatch).not.toHaveProperty("stage");
    expect(p.deletes).toEqual([601, 602]);
    expect(p.moves).toEqual([]);
    expect(p.deleteCalendarEventId).toBe("evt_old_123");
    expect(p.noteLine).toBe(
      "[2026-10-27] Rescheduled, new date not set (manager@example.com). Was Thu 2026-10-29 12:00-13:30. " +
        "Calendar event queued for deletion and its link cleared. " +
        "Crew shifts removed: open Thu 2026-10-29 11:00-14:30; Crew Member A Thu 2026-10-29 11:00-14:30. " +
        "Cleared for the old date: picklist, COI sent stamp. Regenerate the picklist.",
    );
  });
});

describe("Cancel event", () => {
  it("moves the deal to Closed Lost, clears the calendar link and removes every crew shift", () => {
    const p = plan(mkDeal(), [OPEN, STAFFED], { kind: "cancel" });
    expect(p.dealPatch).toMatchObject({
      stage: "Closed Lost",
      is_active: 0,
      calendar_event_id: null,
      calendar_event_payload_hash: null,
    });
    // A cancel does not reschedule: the date and its stamps stay as they were.
    expect(p.dealPatch).not.toHaveProperty("event_date");
    expect(p.dealPatch).not.toHaveProperty("picklist_docx_path");
    expect(p.deletes).toEqual([601, 602]);
    expect(p.deleteCalendarEventId).toBe("evt_old_123");
    expect(p.noteLine).toBe(
      "[2026-10-27] Event cancelled (manager@example.com): Thu 2026-10-29 12:00-13:30, Booked Paid to Closed Lost. " +
        "Calendar event queued for deletion and its link cleared. " +
        "Crew shifts removed: open Thu 2026-10-29 11:00-14:30; Crew Member A Thu 2026-10-29 11:00-14:30. " +
        "Paid $515.20; any refund is done by hand in Square.",
    );
  });

  it("says nothing about a refund when nothing was paid", () => {
    const p = plan(mkDeal({ amount_paid: 0 }), [], { kind: "cancel" });
    expect(p.noteLine).not.toContain("refund");
  });
});

describe("which deals can be changed", () => {
  it("is Booked Unpaid, Booked Paid and Closed Marketing Event only", () => {
    expect(["Booked Unpaid", "Booked Paid", "Closed Marketing Event"].every(canChangeEvent)).toBe(true);
    for (const s of ["Open", "Quote Review", "Sent Quote", "Event Complete", "Closed Lost", "Closed Below Min"]) {
      expect(canChangeEvent(s)).toBe(false);
      const r = planEventChange(mkDeal({ stage: s }), [], { kind: "cancel" }, CTX);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    }
  });

  function drawer(stage: string): string {
    const deal = { id: 1, stage, company: "Synthetic Co", event_date: "2026-11-05" } as Deal;
    return renderToStaticMarkup(createElement(DealDetailDrawer, { deal, onClose: () => {} }));
  }

  it("shows both buttons on a booked deal and neither on any other", () => {
    for (const s of ["Booked Unpaid", "Booked Paid", "Closed Marketing Event"]) {
      expect(drawer(s)).toContain("Reschedule event");
      expect(drawer(s)).toContain("Cancel event");
    }
    for (const s of ["Open", "Sent Quote", "Event Complete", "Closed Lost"]) {
      expect(drawer(s)).not.toContain("Reschedule event");
      expect(drawer(s)).not.toContain("Cancel event");
    }
  });
});

describe("the request body", () => {
  it("reads a reschedule, a date-not-set and a cancel", () => {
    expect(
      parseEventChangeBody({
        action: "reschedule",
        event_date: "2026-11-05",
        event_start_time: "12:00",
        event_end_time: "13:30",
        staffed_shift_ids: [602],
      }),
    ).toEqual({ ok: true, request: TO_NOV_5, staffedShiftIds: [602] });
    expect(parseEventChangeBody({ action: "reschedule", date_not_set: true, staffed_shift_ids: [] })).toEqual({
      ok: true,
      request: { kind: "reschedule_tbd" },
      staffedShiftIds: [],
    });
    expect(parseEventChangeBody({ action: "cancel", staffed_shift_ids: [] })).toEqual({
      ok: true,
      request: { kind: "cancel" },
      staffedShiftIds: [],
    });
  });

  it("refuses a missing or impossible date or time, equal times, and no crew list", () => {
    const base = { action: "reschedule", event_date: "2026-11-05", event_start_time: "12:00", event_end_time: "13:30", staffed_shift_ids: [] };
    expect(parseEventChangeBody({ ...base, event_date: "2026-02-30" }).ok).toBe(false);
    expect(parseEventChangeBody({ ...base, event_date: "" }).ok).toBe(false);
    expect(parseEventChangeBody({ ...base, event_start_time: "25:00" }).ok).toBe(false);
    expect(parseEventChangeBody({ ...base, event_end_time: "" }).ok).toBe(false);
    expect(parseEventChangeBody({ ...base, event_end_time: "12:00" }).ok).toBe(false);
    expect(parseEventChangeBody({ action: "cancel" }).ok).toBe(false);
    expect(parseEventChangeBody({ action: "delete", staffed_shift_ids: [] }).ok).toBe(false);
  });
});

describe("what the dialog says before anyone confirms", () => {
  function preview(shifts: CrewShift[], amountPaid: number | null = 515.2, eventDate: string | null = "2026-10-29"): EventPreview {
    return {
      deal: {
        id: 30001,
        stage: "Booked Paid",
        can_change: true,
        event_date: eventDate,
        event_start_time: "12:00",
        event_end_time: "13:30",
        amount_paid: amountPaid,
        has_calendar_event: true,
      },
      shifts,
    };
  }

  it("names each person and their shift on a reschedule, and says the shifts move", () => {
    expect(confirmationLines(preview([OPEN, STAFFED]), "reschedule", false)).toEqual([
      "On the crew: Crew Member A (Thu 2026-10-29 11:00-14:30). Their shifts move with the event. Tell them yourself; nothing is sent.",
      "1 open shift moves with it.",
    ]);
  });

  it("says the shifts are removed when the date is not set", () => {
    expect(confirmationLines(preview([OPEN, STAFFED]), "reschedule", true)).toEqual([
      "The date is cleared and the calendar event is deleted.",
      "On the crew: Crew Member A (Thu 2026-10-29 11:00-14:30). Their shifts are removed. Tell them yourself; nothing is sent.",
      "1 open shift is removed.",
    ]);
  });

  it("says a deal with no date keeps its shifts where they are, naming who is on them", () => {
    expect(confirmationLines(preview([OPEN, STAFFED], 515.2, null), "reschedule", false)).toEqual([
      "The deal has no date to move its shifts from, so 2 shifts stay where they are (Crew Member A (Thu 2026-10-29 11:00-14:30)).",
    ]);
    expect(confirmationLines(preview([OPEN], 515.2, null), "reschedule", false)).toEqual([
      "The deal has no date to move its shifts from, so 1 shift stays where it is.",
    ]);
  });

  it("names everyone on a cancel and shows the amount paid with the refund line and nothing more", () => {
    expect(confirmationLines(preview([STAFFED]), "cancel", false)).toEqual([
      "The deal moves to Closed Lost and its calendar event is deleted.",
      "On the crew: Crew Member A (Thu 2026-10-29 11:00-14:30). Their shifts are removed. Tell them yourself; nothing is sent.",
      "Paid $515.20. Any refund is done by hand in Square.",
    ]);
    expect(confirmationLines(preview([], 0), "cancel", false)).toEqual([
      "The deal moves to Closed Lost and its calendar event is deleted.",
    ]);
  });
});
