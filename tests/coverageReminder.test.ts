// The schedule coverage reminder (bj-finance #709): the pure part. Given a
// run date and a snapshot of the schedule, which lines go in the email?
//
// Every run date below is Thursday 2026-10-15, so the window is the next two
// full Sun–Sat weeks: Sun Oct 18 – Sat Oct 24 and Sun Oct 25 – Sat Oct 31.
// Store hours are set for Saturdays only (2:00–6:00 PM), so every other
// weekday has no hours row and is not checked.
//
// Shift instants carry an explicit -04:00 (EDT), so each test says exactly
// which instant it means.

import { describe, expect, it } from "vitest";
import {
  buildReminder,
  reminderEmail,
  reminderWindow,
  selectRecipients,
  type ReminderSnapshot,
} from "@/lib/coverageReminder";

const RUN_DATE = "2026-10-15"; // a Thursday

const SAT_HOURS = [{ weekday: 6, is_closed: false, opens: "14:00:00", closes: "18:00:00" }];
const SHIFT_TYPES = [
  { name: "PENN Closer", in_store: true },
  { name: "Catering", in_store: false },
  { name: "Marketing", in_store: false },
];

function shift(starts: string, ends: string, over: Record<string, unknown> = {}) {
  return {
    starts_at: starts,
    ends_at: ends,
    employee_id: "emp-1",
    position: "PENN Closer",
    published: true,
    ...over,
  };
}

// Saturday Oct 31 covered 2–6 PM, so by default only Sat Oct 24 is a gap.
const SAT_31_COVERED = shift("2026-10-31T14:00:00-04:00", "2026-10-31T18:00:00-04:00");

function snapshot(over: Partial<ReminderSnapshot> = {}): ReminderSnapshot {
  return {
    storeHours: SAT_HOURS,
    exceptions: [],
    closedRanges: [],
    shiftTypes: SHIFT_TYPES,
    shifts: [SAT_31_COVERED],
    deals: [],
    dealShifts: [],
    ...over,
  };
}

function deal(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    stage: "Booked Paid",
    archived: 0,
    event_date: "2026-10-24",
    event_start_time: "14:00",
    event_end_time: "18:00",
    ...over,
  };
}

describe("reminderWindow", () => {
  it("is the next two full Sun–Sat weeks after the run date", () => {
    expect(reminderWindow("2026-10-15")).toEqual({
      weekStarts: ["2026-10-18", "2026-10-25"],
      start: "2026-10-18",
      end: "2026-10-31",
    });
  });

  it("Thursday and Friday check the same two weeks", () => {
    expect(reminderWindow("2026-10-16")).toEqual(reminderWindow("2026-10-15"));
  });
});

describe("store hours", () => {
  it("an open hour nobody is scheduled for is one line", () => {
    expect(buildReminder(snapshot(), RUN_DATE)).toEqual(["Sat Oct 24, 2:00–6:00 PM"]);
  });

  it("a partly covered day lists only the uncovered stretch, AM to PM spelled out", () => {
    const hours = [{ weekday: 6, is_closed: false, opens: "11:00", closes: "18:00" }];
    const lines = buildReminder(
      snapshot({
        storeHours: hours,
        shifts: [
          shift("2026-10-24T14:00:00-04:00", "2026-10-24T18:00:00-04:00"),
          shift("2026-10-31T11:00:00-04:00", "2026-10-31T18:00:00-04:00"),
        ],
      }),
      RUN_DATE,
    );
    expect(lines).toEqual(["Sat Oct 24, 11:00 AM–2:00 PM"]);
  });

  it("a day closed by a Business closed annotation needs nobody", () => {
    const closedRanges = [{ start_date: "2026-10-24", end_date: "2026-10-24", title: "Closed" }];
    expect(buildReminder(snapshot({ closedRanges }), RUN_DATE)).toEqual([]);
  });

  it("a closed exception beats the weekday pattern", () => {
    const exceptions = [{ date: "2026-10-24", is_closed: true }];
    expect(buildReminder(snapshot({ exceptions }), RUN_DATE)).toEqual([]);
  });

  it("a weekday with no hours row is not checked", () => {
    // Only Saturdays have hours; an empty Sunday Oct 18 produces no line.
    const lines = buildReminder(snapshot({ shifts: [SAT_31_COVERED] }), RUN_DATE);
    expect(lines.some((l) => l.startsWith("Sun"))).toBe(false);
  });

  it("only published, assigned, in-store shifts cover", () => {
    const sat24 = ["2026-10-24T14:00:00-04:00", "2026-10-24T18:00:00-04:00"] as const;
    for (const over of [{ published: false }, { employee_id: null }, { position: "Catering" }]) {
      const lines = buildReminder(snapshot({ shifts: [SAT_31_COVERED, shift(...sat24, over)] }), RUN_DATE);
      expect(lines).toEqual(["Sat Oct 24, 2:00–6:00 PM"]);
    }
    const covered = buildReminder(snapshot({ shifts: [SAT_31_COVERED, shift(...sat24)] }), RUN_DATE);
    expect(covered).toEqual([]);
  });

  it("checks Sunday to Saturday: the run week and the week after the window are not checked", () => {
    const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      is_closed: false,
      opens: "14:00",
      closes: "18:00",
    }));
    const lines = buildReminder(snapshot({ storeHours: everyDay, shifts: [] }), RUN_DATE);
    expect(lines).toHaveLength(14);
    expect(lines[0]).toBe("Sun Oct 18, 2:00–6:00 PM");
    expect(lines[13]).toBe("Sat Oct 31, 2:00–6:00 PM");
  });
});

describe("catering", () => {
  it("a booked event with no shifts yet is a gap, timed from the deal", () => {
    const lines = buildReminder(snapshot({ storeHours: [], deals: [deal()] }), RUN_DATE);
    expect(lines).toEqual(["Sat Oct 24, 2:00–6:00 PM (catering)"]);
  });

  it("an event is covered when one of its three slots has a person", () => {
    const slots = [
      { deal_id: 1, employee_id: null, published: true },
      { deal_id: 1, employee_id: "emp-2", published: true },
      { deal_id: 1, employee_id: null, published: true },
    ];
    expect(buildReminder(snapshot({ storeHours: [], deals: [deal()], dealShifts: slots }), RUN_DATE)).toEqual([]);
  });

  it("an event whose only assigned shift is unpublished is still a gap, once", () => {
    const slots = [
      { deal_id: 1, employee_id: "emp-2", published: false },
      { deal_id: 1, employee_id: null, published: true },
      { deal_id: 1, employee_id: null, published: true },
    ];
    expect(buildReminder(snapshot({ storeHours: [], deals: [deal()], dealShifts: slots }), RUN_DATE)).toEqual([
      "Sat Oct 24, 2:00–6:00 PM (catering)",
    ]);
  });

  it("an event with no times shows the date and says the time is not set", () => {
    const d = deal({ event_start_time: null, event_end_time: "" });
    expect(buildReminder(snapshot({ storeHours: [], deals: [d] }), RUN_DATE)).toEqual([
      "Sat Oct 24 (catering, time not set)",
    ]);
  });

  it("an event with only a start time shows that time", () => {
    const d = deal({ event_end_time: null });
    expect(buildReminder(snapshot({ storeHours: [], deals: [d] }), RUN_DATE)).toEqual([
      "Sat Oct 24, 2:00 PM (catering)",
    ]);
  });

  it("Booked Unpaid and Closed Marketing Event count; Closed Lost, Open and archived do not", () => {
    const deals = [
      deal({ id: 1, stage: "Booked Unpaid", event_date: "2026-10-19", event_start_time: "12:00", event_end_time: "13:00" }),
      deal({ id: 2, stage: "Closed Marketing Event", event_date: "2026-10-21", event_start_time: "19:00", event_end_time: "22:00" }),
      deal({ id: 3, stage: "Closed Lost" }),
      deal({ id: 4, stage: "Open" }),
      deal({ id: 5, stage: "Event Complete" }),
      deal({ id: 6, archived: 1 }),
    ];
    expect(buildReminder(snapshot({ storeHours: [], deals }), RUN_DATE)).toEqual([
      "Mon Oct 19, 12:00–1:00 PM (catering)",
      "Wed Oct 21, 7:00–10:00 PM (catering)",
    ]);
  });

  it("only events from the first Sunday to the last Saturday are checked", () => {
    const deals = ["2026-10-17", "2026-10-18", "2026-10-31", "2026-11-01"].map((event_date, i) =>
      deal({ id: i + 1, event_date }),
    );
    expect(buildReminder(snapshot({ storeHours: [], deals }), RUN_DATE)).toEqual([
      "Sun Oct 18, 2:00–6:00 PM (catering)",
      "Sat Oct 31, 2:00–6:00 PM (catering)",
    ]);
  });

  it("store and catering lines interleave in date and time order", () => {
    const deals = [
      deal({ id: 1, event_date: "2026-10-24", event_start_time: "12:00", event_end_time: "13:00" }),
      deal({ id: 2, event_date: "2026-10-20", event_start_time: "19:00", event_end_time: "21:00" }),
    ];
    expect(buildReminder(snapshot({ deals }), RUN_DATE)).toEqual([
      "Tue Oct 20, 7:00–9:00 PM (catering)",
      "Sat Oct 24, 12:00–1:00 PM (catering)",
      "Sat Oct 24, 2:00–6:00 PM",
    ]);
  });
});

describe("reminderEmail", () => {
  it("no gaps means no email", () => {
    expect(reminderEmail([])).toBeNull();
  });

  it("subject Schedule gaps, one line per gap and nothing else", () => {
    expect(reminderEmail(["Sat Oct 24, 2:00–6:00 PM", "Sat Oct 24, 2:00–6:00 PM (catering)"])).toEqual({
      subject: "Schedule gaps",
      body: "Sat Oct 24, 2:00–6:00 PM\nSat Oct 24, 2:00–6:00 PM (catering)\n",
    });
  });
});

describe("selectRecipients", () => {
  // Fake addresses only: this repository is public.
  function person(email: string, over: Record<string, unknown> = {}) {
    return { email, role: "employee", active: true, archived_at: null, banned_until: null, ...over };
  }

  it("owners and on-schedule managers, nobody else", () => {
    const rows = [
      // Owners are active = false by design (they are not on the schedule);
      // a blanket active filter would drop them.
      person("owner-a@example.test", { role: "owner", active: false }),
      person("owner-b@example.test", { role: "owner", active: false }),
      person("manager-a@example.test", { role: "manager" }),
      person("manager-b@example.test", { role: "manager" }),
      // A manager who is off the schedule.
      person("manager-off@example.test", { role: "manager", active: false }),
      person("archived-manager@example.test", { role: "manager", archived_at: "2026-09-01T00:00:00Z" }),
      person("banned-owner@example.test", { role: "owner", banned_until: "2999-01-01T00:00:00Z" }),
      person("archived-owner@example.test", { role: "owner", active: false, archived_at: "2026-09-01T00:00:00Z" }),
      person("staff@example.test"),
      person("", { role: "manager" }),
    ];
    expect(selectRecipients(rows)).toEqual([
      "manager-a@example.test",
      "manager-b@example.test",
      "owner-a@example.test",
      "owner-b@example.test",
    ]);
  });
});
