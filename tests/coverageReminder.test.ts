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
  type RecipientRow,
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
    deal_id: null,
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
    staffing: [],
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
    staff_count: null,
    ...over,
  };
}

describe("reminderWindow", () => {
  // bj-finance #753: the reminder runs every day. The schedule is made on
  // Wednesdays, so the window moves on a week each Thursday: the two Sun–Sat
  // weeks starting the Sunday after the most recent Thursday.
  it("is the next two full Sun–Sat weeks on a Thursday", () => {
    expect(reminderWindow("2026-10-15")).toEqual({
      weekStarts: ["2026-10-18", "2026-10-25"],
      start: "2026-10-18",
      end: "2026-10-31",
    });
  });

  it.each([
    ["Thu", "2026-10-22", "2026-10-25"],
    ["Fri", "2026-10-23", "2026-10-25"],
    ["Sat", "2026-10-24", "2026-10-25"],
  ])("%s %s checks the next two full weeks", (_day, runDate, first) => {
    expect(reminderWindow(runDate)).toEqual({
      weekStarts: [first, "2026-11-01"],
      start: first,
      end: "2026-11-07",
    });
  });

  it.each([
    ["Sun", "2026-10-25"],
    ["Mon", "2026-10-26"],
    ["Tue", "2026-10-27"],
    ["Wed", "2026-10-28"],
  ])("%s %s checks the current week from today on, and the next week", (_day, runDate) => {
    expect(reminderWindow(runDate)).toEqual({
      weekStarts: ["2026-10-25", "2026-11-01"],
      start: runDate,
      end: "2026-11-07",
    });
  });

  it("Wednesday still checks the current week; Thursday rolls on a week", () => {
    expect(reminderWindow("2026-10-28").weekStarts).toEqual(["2026-10-25", "2026-11-01"]);
    expect(reminderWindow("2026-10-29")).toEqual({
      weekStarts: ["2026-11-01", "2026-11-08"],
      start: "2026-11-01",
      end: "2026-11-14",
    });
  });

  it("Monday 2026-10-19 checks from the 19th through the week of the 25th", () => {
    expect(reminderWindow("2026-10-19")).toEqual({
      weekStarts: ["2026-10-18", "2026-10-25"],
      start: "2026-10-19",
      end: "2026-10-31",
    });
  });
});

describe("a Sunday-to-Wednesday run", () => {
  // Monday Oct 19: the weeks of Oct 18 and Oct 25, from the 19th on.
  const MONDAY = "2026-10-19";
  const SUN_MON_AND_SAT_HOURS = [
    { weekday: 0, is_closed: false, opens: "14:00:00", closes: "18:00:00" },
    { weekday: 1, is_closed: false, opens: "14:00:00", closes: "18:00:00" },
    ...SAT_HOURS,
  ];

  it("leaves out store hours already past and keeps today and later", () => {
    const lines = buildReminder(snapshot({ storeHours: SUN_MON_AND_SAT_HOURS }), MONDAY);
    // Sun Oct 18 is yesterday: left out. Mon Oct 19 is today: kept.
    // Sat Oct 31 is covered.
    expect(lines).toEqual([
      "Mon Oct 19, 2:00–6:00 PM",
      "Sat Oct 24, 2:00–6:00 PM",
      "Sun Oct 25, 2:00–6:00 PM",
      "Mon Oct 26, 2:00–6:00 PM",
    ]);
  });

  it("leaves out catering events already past and keeps today's", () => {
    const deals = [
      deal({ id: 1, event_date: "2026-10-18", event_start_time: "12:00", event_end_time: "13:00" }),
      deal({ id: 2, event_date: "2026-10-19", event_start_time: "12:00", event_end_time: "13:00" }),
    ];
    expect(buildReminder(snapshot({ deals }), MONDAY)).toEqual([
      "Mon Oct 19, 12:00–1:00 PM (catering)",
      "Sat Oct 24, 2:00–6:00 PM",
    ]);
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

  // Store-hours seasons (migration 47, bj-finance #742): lib/coverageReminderPg.ts
  // reads them into storeHours as rows carrying effective_from. From its first
  // day a season's row replaces its weekday's standing hours; before it, the
  // standing hours apply.
  it("from a season's first day the reminder checks the season's hours, and the standing hours before it", () => {
    const longerSaturdays = [{ weekday: 6, is_closed: false, opens: "12:00:00", closes: "18:00:00", effective_from: "2026-10-25" }];
    const lines = buildReminder(snapshot({ storeHours: [...SAT_HOURS, ...longerSaturdays] }), RUN_DATE);
    expect(lines).toEqual(["Sat Oct 24, 2:00–6:00 PM", "Sat Oct 31, 12:00–2:00 PM"]);
  });

  it("a season that closes a weekday needs nobody on it from its first day", () => {
    const closedSaturdays = [{ weekday: 6, is_closed: true, opens: null, closes: null, effective_from: "2026-10-18" }];
    expect(buildReminder(snapshot({ storeHours: [...SAT_HOURS, ...closedSaturdays], shifts: [] }), RUN_DATE)).toEqual([]);
  });

  // Staffed hours (bj-finance #742 follow-up, ruled 2026-10-19): the open
  // hours plus the open-up minutes before and the close-down minutes after,
  // as the Check week button measures them. The minutes here are invented.
  const minutes = (key: string, value: number, effective_from = "2026-01-01") => ({
    id: value + (key.includes("open_up") ? 1000 : 2000), key, value, effective_from, recorded_at: `${effective_from}T00:00:00Z`,
  });

  it("checks staffed hours: the open-up and close-down minutes either side of the open hours", () => {
    const staffing = [minutes("staffing.open_up_minutes", 45), minutes("staffing.close_down_minutes", 15)];
    expect(buildReminder(snapshot({ staffing }), RUN_DATE)).toEqual([
      "Sat Oct 24, 1:15–6:15 PM",
      "Sat Oct 31, 1:15–2:00 PM",
      "Sat Oct 31, 6:00–6:15 PM",
    ]);
  });

  it("uses the minutes in force on each day, and open hours before any are set", () => {
    const staffing = [minutes("staffing.open_up_minutes", 45, "2026-10-25"), minutes("staffing.close_down_minutes", 0, "2026-10-25")];
    expect(buildReminder(snapshot({ staffing }), RUN_DATE)).toEqual(["Sat Oct 24, 2:00–6:00 PM", "Sat Oct 31, 1:15–2:00 PM"]);
  });

  it("a closed day stays closed whatever the minutes", () => {
    const staffing = [minutes("staffing.open_up_minutes", 45), minutes("staffing.close_down_minutes", 45)];
    const exceptions = [{ date: "2026-10-24", is_closed: true }];
    expect(buildReminder(snapshot({ staffing, exceptions, shifts: [shift("2026-10-31T13:15:00-04:00", "2026-10-31T18:45:00-04:00")] }), RUN_DATE)).toEqual([]);
  });

  it("a weekday with no hours row is not checked", () => {
    // Only Saturdays have hours and nobody works all fortnight: the twelve
    // days with no hours row produce no line, only the two Saturdays do.
    expect(buildReminder(snapshot({ shifts: [] }), RUN_DATE)).toEqual([
      "Sat Oct 24, 2:00–6:00 PM",
      "Sat Oct 31, 2:00–6:00 PM",
    ]);
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

  it("a shift type with no in_store answer counts as in-store, so it never excuses a gap", () => {
    const sat24 = shift("2026-10-24T14:00:00-04:00", "2026-10-24T18:00:00-04:00", { position: "Unclassified" });
    const shiftTypes = [...SHIFT_TYPES, { name: "Unclassified", in_store: null }];
    expect(buildReminder(snapshot({ shiftTypes, shifts: [SAT_31_COVERED, sat24] }), RUN_DATE)).toEqual([]);
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

  // Owner decision, 2026-11-02: exactly 0 means the deal needs nobody (a customer
  // pickup at the store). No count recorded is not the same answer.
  describe("staff count", () => {
    const gap = ["Sat Oct 24, 2:00–6:00 PM (catering)"];

    it("a staff count of 0 needs nobody, so no line", () => {
      const pickup = deal({ stage: "Booked Unpaid", staff_count: 0 });
      expect(buildReminder(snapshot({ storeHours: [], deals: [pickup] }), RUN_DATE)).toEqual([]);
    });

    it("no staff count recorded is still a gap", () => {
      const marketing = deal({ stage: "Closed Marketing Event", staff_count: null });
      expect(buildReminder(snapshot({ storeHours: [], deals: [marketing] }), RUN_DATE)).toEqual(gap);
    });

    it("a positive staff count with nobody on it is a gap", () => {
      expect(buildReminder(snapshot({ storeHours: [], deals: [deal({ staff_count: 2 })] }), RUN_DATE)).toEqual(gap);
    });
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

  it("a finished event stays out: the same event Booked Paid is a gap, at Event Complete it is not", () => {
    const booked = deal({ id: 1, stage: "Booked Paid" });
    const finished = deal({ id: 1, stage: "Event Complete" });
    expect(buildReminder(snapshot({ storeHours: [], deals: [booked] }), RUN_DATE)).toEqual(["Sat Oct 24, 2:00–6:00 PM (catering)"]);
    expect(buildReminder(snapshot({ storeHours: [], deals: [finished] }), RUN_DATE)).toEqual([]);
  });

  it("only events from the first Sunday to the last Saturday are checked; an undated event is not", () => {
    const deals = ["2026-10-17", "2026-10-18", "2026-10-31", "2026-11-01", null].map((event_date, i) =>
      deal({ id: i + 1, event_date }),
    );
    expect(buildReminder(snapshot({ storeHours: [], deals }), RUN_DATE)).toEqual([
      "Sun Oct 18, 2:00–6:00 PM (catering)",
      "Sat Oct 31, 2:00–6:00 PM (catering)",
    ]);
  });

  it("store and catering lines interleave in date and time order", () => {
    const deals = [
      deal({ id: 1, event_date: "2026-10-24", event_start_time: "19:00", event_end_time: "21:00" }),
      deal({ id: 2, event_date: "2026-10-24", event_start_time: "12:00", event_end_time: "13:00" }),
      deal({ id: 3, event_date: "2026-10-20", event_start_time: "19:00", event_end_time: "21:00" }),
    ];
    expect(buildReminder(snapshot({ deals }), RUN_DATE)).toEqual([
      "Tue Oct 20, 7:00–9:00 PM (catering)",
      "Sat Oct 24, 12:00–1:00 PM (catering)",
      "Sat Oct 24, 2:00–6:00 PM",
      "Sat Oct 24, 7:00–9:00 PM (catering)",
    ]);
  });

  it("an event with no time comes last on its day", () => {
    const deals = [deal({ event_start_time: null, event_end_time: null })];
    expect(buildReminder(snapshot({ deals }), RUN_DATE)).toEqual([
      "Sat Oct 24, 2:00–6:00 PM",
      "Sat Oct 24 (catering, time not set)",
    ]);
  });

  it("an event and a store gap starting at the same time list the event first", () => {
    // Both start Sat Oct 24 at 2:00 PM; the store gap is 2–6 PM, the event 2–4 PM.
    const deals = [deal({ event_start_time: "14:00", event_end_time: "16:00" })];
    expect(buildReminder(snapshot({ deals }), RUN_DATE)).toEqual([
      "Sat Oct 24, 2:00–4:00 PM (catering)",
      "Sat Oct 24, 2:00–6:00 PM",
    ]);
  });
  // A manager can place crew by hand: a published Catering shift with a person
  // and no deal_id. It covers an event only if it spans the whole event, and
  // only one event. Every name and id here is made up: this repository is public.
  describe("hand-placed Catering shifts", () => {
    const sat24 = (hhmm: string) => `2026-10-24T${hhmm}:00-04:00`;
    const handPlaced = (from: string, to: string, over: Record<string, unknown> = {}) =>
      shift(from, to, { position: "Catering", deal_id: null, ...over });
    const satHandPlaced = (from: string, to: string, over: Record<string, unknown> = {}) =>
      handPlaced(sat24(from), sat24(to), over);
    const satDeal = (from: string | null, to: string | null, over: Record<string, unknown> = {}) =>
      deal({ event_start_time: from, event_end_time: to, ...over });

    function lines(
      deals: ReturnType<typeof deal>[],
      shifts: ReturnType<typeof shift>[],
      dealShifts: ReminderSnapshot["dealShifts"] = [],
      runDate = RUN_DATE,
    ) {
      return buildReminder(snapshot({ storeHours: [], deals, shifts, dealShifts }), runDate);
    }

    it("three people spanning the event cover it, with its open auto-created shifts beside them", () => {
      const event = satDeal("14:30", "15:30");
      const open = (slot: number) =>
        shift(sat24("13:00"), sat24("17:00"), { employee_id: null, position: "Catering", deal_id: 1, deal_slot: slot });
      const shifts = [
        satHandPlaced("12:30", "16:00", { employee_id: "emp-1" }),
        satHandPlaced("12:30", "16:00", { employee_id: "emp-2" }),
        satHandPlaced("12:30", "16:00", { employee_id: "emp-3" }),
        open(1),
        open(2),
        open(3),
      ];
      const dealShifts = [1, 2, 3].map(() => ({ deal_id: 1, employee_id: null, published: true }));
      expect(lines([event], shifts, dealShifts)).toEqual([]);
    });

    it("a shift that ends before the event does stays a gap", () => {
      const event = satDeal("19:30", "21:00");
      expect(lines([event], [satHandPlaced("15:00", "20:00")])).toEqual(["Sat Oct 24, 7:30–9:00 PM (catering)"]);
    });

    it("a shift that starts after the event does stays a gap", () => {
      const event = satDeal("14:00", "15:00");
      expect(lines([event], [satHandPlaced("14:30", "18:00")])).toEqual(["Sat Oct 24, 2:00–3:00 PM (catering)"]);
    });

    it("a shift matching the event to the minute covers it; a minute short either way does not", () => {
      const event = satDeal("14:00", "15:00");
      expect(lines([event], [satHandPlaced("14:00", "15:00")])).toEqual([]);
      const gap = ["Sat Oct 24, 2:00–3:00 PM (catering)"];
      expect(lines([event], [satHandPlaced("14:01", "15:00")])).toEqual(gap);
      expect(lines([event], [satHandPlaced("14:00", "14:59")])).toEqual(gap);
    });

    it("a marketing event with a person on any linked shift is not a gap: the reminder never reads the linked shift's position", () => {
      const marketing = satDeal("14:00", "15:00", { stage: "Closed Marketing Event" });
      expect(lines([marketing], [], [{ deal_id: 1, employee_id: "emp-1", published: true }])).toEqual([]);
      expect(lines([marketing], [], [])).toEqual(["Sat Oct 24, 2:00–3:00 PM (catering)"]);
    });

    it("an open shift linked to the event, and nobody else, is a gap", () => {
      const open = shift(sat24("13:00"), sat24("17:00"), { employee_id: null, position: "Catering", deal_id: 1 });
      const dealShifts = [{ deal_id: 1, employee_id: null, published: true }];
      expect(lines([satDeal("14:00", "15:00")], [open], dealShifts)).toEqual(["Sat Oct 24, 2:00–3:00 PM (catering)"]);
    });

    it.each([
      ["linked to another deal", { deal_id: 99 }],
      ["unpublished", { published: false }],
      ["with no person", { employee_id: null }],
      ["in-store", { position: "PENN Closer" }],
      ["for a marketing shift", { position: "Marketing" }],
      ["with no position", { position: null }],
    ])("a spanning shift %s does not count", (_what, over) => {
      const dealShifts = "deal_id" in over ? [{ deal_id: 99, employee_id: "emp-1", published: true }] : [];
      expect(lines([satDeal("14:00", "15:00")], [satHandPlaced("12:00", "18:00", over)], dealShifts)).toEqual([
        "Sat Oct 24, 2:00–3:00 PM (catering)",
      ]);
    });

    it("a Catering position typed with stray spaces still covers", () => {
      expect(lines([satDeal("14:00", "15:00")], [satHandPlaced("12:00", "18:00", { position: " Catering\n" })])).toEqual([]);
    });

    it("the same times on another day do not count", () => {
      const friday = handPlaced("2026-10-23T12:00:00-04:00", "2026-10-23T18:00:00-04:00");
      expect(lines([satDeal("14:00", "15:00")], [friday])).toEqual(["Sat Oct 24, 2:00–3:00 PM (catering)"]);
    });

    it("one shift covers the earlier of two overlapping events, whatever order they are read in", () => {
      const early = satDeal("14:00", "15:00", { id: 2 });
      const late = satDeal("14:30", "15:30", { id: 1 });
      const shifts = [satHandPlaced("12:00", "18:00")];
      expect(lines([late, early], shifts)).toEqual(["Sat Oct 24, 2:30–3:30 PM (catering)"]);
      expect(lines([early, late], shifts)).toEqual(["Sat Oct 24, 2:30–3:30 PM (catering)"]);
    });

    it("one shift covers only one event even when the events do not overlap", () => {
      const deals = [satDeal("13:00", "14:00", { id: 1 }), satDeal("16:00", "17:00", { id: 2 })];
      expect(lines(deals, [satHandPlaced("12:00", "18:00")])).toEqual(["Sat Oct 24, 4:00–5:00 PM (catering)"]);
    });

    it("two shifts cover two overlapping events", () => {
      const deals = [satDeal("14:00", "15:00", { id: 1 }), satDeal("14:30", "15:30", { id: 2 })];
      const shifts = [satHandPlaced("12:00", "18:00", { employee_id: "emp-1" }), satHandPlaced("12:00", "18:00", { employee_id: "emp-2" })];
      expect(lines(deals, shifts)).toEqual([]);
    });

    it("an event takes the shift that ends soonest, leaving the longer one for the event that needs it", () => {
      const deals = [satDeal("14:00", "15:00", { id: 1 }), satDeal("14:30", "19:00", { id: 2 })];
      const shifts = [satHandPlaced("13:00", "20:00", { employee_id: "emp-1" }), satHandPlaced("13:00", "16:00", { employee_id: "emp-2" })];
      expect(lines(deals, shifts)).toEqual([]);
    });

    it("an event covered by its own shift leaves the hand-placed shift for another event", () => {
      const deals = [satDeal("14:00", "15:00", { id: 1 }), satDeal("14:30", "15:30", { id: 2 })];
      const dealShifts = [{ deal_id: 1, employee_id: "emp-2", published: true }];
      expect(lines(deals, [satHandPlaced("12:00", "18:00")], dealShifts)).toEqual([]);
    });

    it("an event the reminder does not check leaves the shift alone", () => {
      const deals = [
        satDeal("13:00", "14:00", { id: 1, stage: "Closed Lost" }),
        satDeal("13:30", "14:30", { id: 2, archived: 1 }),
        satDeal("14:00", "15:00", { id: 3 }),
      ];
      expect(lines(deals, [satHandPlaced("12:00", "18:00")])).toEqual([]);
    });

    it("a staff count of 0 does not use up the shift another event in the same window needs", () => {
      // The pickup comes first in time order, so it would take the only shift.
      const deals = [satDeal("14:00", "14:15", { id: 1, staff_count: 0 }), satDeal("14:30", "15:30", { id: 2, staff_count: 1 })];
      expect(lines(deals, [satHandPlaced("12:00", "18:00")])).toEqual([]);
    });

    it("hand-placed crew still covers an event with no staff count recorded", () => {
      expect(lines([satDeal("14:00", "15:00", { staff_count: null })], [satHandPlaced("12:00", "18:00")])).toEqual([]);
    });

    describe("an event with no end time", () => {
      const event = satDeal("14:00", null);
      const gap = ["Sat Oct 24, 2:00 PM (catering)"];

      it("is covered by a shift spanning its start", () => {
        expect(lines([event], [satHandPlaced("13:00", "14:30")])).toEqual([]);
        expect(lines([event], [satHandPlaced("14:00", "14:30")])).toEqual([]);
      });

      it("stays a gap when the shift ends at the start or starts after it", () => {
        expect(lines([event], [satHandPlaced("12:00", "14:00")])).toEqual(gap);
        expect(lines([event], [satHandPlaced("14:01", "18:00")])).toEqual(gap);
      });
    });

    describe("an event with no start time", () => {
      it("cannot be judged, so it stays a gap, with or without an end time", () => {
        const allDay = satHandPlaced("00:00", "23:00");
        expect(lines([satDeal(null, null)], [allDay])).toEqual(["Sat Oct 24 (catering, time not set)"]);
        expect(lines([satDeal(null, "15:00")], [allDay])).toEqual(["Sat Oct 24 (catering, time not set)"]);
      });

      it("does not use up the shift", () => {
        const deals = [satDeal(null, null, { id: 1 }), satDeal("14:00", "15:00", { id: 2 })];
        expect(lines(deals, [satHandPlaced("12:00", "18:00")])).toEqual(["Sat Oct 24 (catering, time not set)"]);
      });
    });

    describe("in New York time", () => {
      it("reads a shift stored in UTC on its New York clock, across the UTC date", () => {
        // 2:00–9:00 PM EDT on Oct 24 ends on Oct 25 in UTC.
        const utc = handPlaced("2026-10-24T18:00:00Z", "2026-10-25T01:00:00Z");
        expect(lines([satDeal("19:30", "21:00")], [utc])).toEqual([]);
        // 2:00–8:00 PM EDT.
        const short = handPlaced("2026-10-24T18:00:00Z", "2026-10-25T00:00:00Z");
        expect(lines([satDeal("19:30", "21:00")], [short])).toEqual(["Sat Oct 24, 7:30–9:00 PM (catering)"]);
      });

      it("a shift crossing midnight covers an event just after midnight", () => {
        const overnight = handPlaced("2026-10-23T22:00:00-04:00", "2026-10-24T02:00:00-04:00");
        expect(lines([satDeal("00:30", "01:30")], [overnight])).toEqual([]);
        expect(lines([satDeal("01:30", "02:30")], [overnight])).toEqual(["Sat Oct 24, 1:30–2:30 AM (catering)"]);
      });

      it("an event ending after midnight ends the next day", () => {
        const event = satDeal("22:00", "00:30");
        const through = handPlaced(sat24("21:00"), "2026-10-25T01:00:00-04:00");
        expect(lines([event], [through])).toEqual([]);
        expect(lines([event], [satHandPlaced("21:00", "23:59")])).toEqual(["Sat Oct 24, 10:00 PM–12:30 AM (catering)"]);
      });

      // Thursday Oct 29 checks from Sunday Nov 1, when the clocks go back at 2 AM.
      describe("on the day the clocks go back", () => {
        const THURSDAY = "2026-10-29";
        const est = (hhmm: string) => `2026-11-01T${hhmm}:00-05:00`;
        const nov1 = (from: string, to: string) => deal({ event_date: "2026-11-01", event_start_time: from, event_end_time: to });

        it("compares the afternoon on the winter clock", () => {
          expect(lines([nov1("14:30", "15:30")], [handPlaced(est("12:30"), est("16:00"))], [], THURSDAY)).toEqual([]);
          expect(lines([nov1("14:30", "15:30")], [handPlaced(est("11:30"), est("15:00"))], [], THURSDAY)).toEqual([
            "Sun Nov 1, 2:30–3:30 PM (catering)",
          ]);
        });

        it("compares the small hours right after the change", () => {
          expect(lines([nov1("03:00", "04:00")], [handPlaced(est("02:30"), est("05:00"))], [], THURSDAY)).toEqual([]);
          expect(lines([nov1("03:00", "04:00")], [handPlaced(est("03:30"), est("05:00"))], [], THURSDAY)).toEqual([
            "Sun Nov 1, 3:00–4:00 AM (catering)",
          ]);
        });
      });

      // Thursday Mar 11 checks from Sunday Mar 14, when the clocks go forward at 2 AM.
      describe("on the day the clocks go forward", () => {
        const THURSDAY = "2027-03-11";
        const edt = (hhmm: string) => `2027-03-14T${hhmm}:00-04:00`;
        const mar14 = (from: string, to: string) => deal({ event_date: "2027-03-14", event_start_time: from, event_end_time: to });

        it("compares the afternoon on the summer clock", () => {
          expect(lines([mar14("14:30", "15:30")], [handPlaced(edt("12:30"), edt("16:00"))], [], THURSDAY)).toEqual([]);
          expect(lines([mar14("14:30", "15:30")], [handPlaced(edt("11:00"), edt("15:00"))], [], THURSDAY)).toEqual([
            "Sun Mar 14, 2:30–3:30 PM (catering)",
          ]);
        });

        it("a shift from before midnight across the change covers an event right after it", () => {
          const overnight = handPlaced("2027-03-13T23:00:00-05:00", edt("04:00"));
          expect(lines([mar14("03:30", "03:45")], [overnight], [], THURSDAY)).toEqual([]);
          expect(lines([mar14("03:30", "04:30")], [overnight], [], THURSDAY)).toEqual([
            "Sun Mar 14, 3:30–4:30 AM (catering)",
          ]);
        });
      });
    });
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
    return { email, role: "employee", archived_at: null, banned_until: null, ...over } as RecipientRow;
  }

  it("owners only: a manager on the schedule is not a recipient (owner decision, 2026-11-02)", () => {
    const rows = [
      person("owner-a@example.test", { role: "owner" }),
      person("owner-b@example.test", { role: "owner" }),
      // An active manager is still left out.
      person("manager-a@example.test", { role: "manager", active: true }),
      person("staff@example.test"),
    ];
    expect(selectRecipients(rows)).toEqual(["owner-a@example.test", "owner-b@example.test"]);
  });

  it("no owners means nobody, even with managers on file", () => {
    expect(selectRecipients([person("manager-a@example.test", { role: "manager", active: true })])).toEqual([]);
  });

  it("leaves out an archived or banned owner", () => {
    const rows = [
      person("owner-a@example.test", { role: "owner" }),
      person("banned-owner@example.test", { role: "owner", banned_until: "2999-01-01T00:00:00Z" }),
      person("archived-owner@example.test", { role: "owner", archived_at: "2026-09-01T00:00:00Z" }),
    ];
    expect(selectRecipients(rows)).toEqual(["owner-a@example.test"]);
  });

  it("each address once, trimmed, and a row with no address is skipped", () => {
    const rows = [
      person(" owner-a@example.test\n", { role: "owner" }),
      person("owner-a@example.test", { role: "owner" }),
      person("", { role: "owner" }),
      { ...person("", { role: "owner" }), email: null },
    ];
    expect(selectRecipients(rows)).toEqual(["owner-a@example.test"]);
  });
});
