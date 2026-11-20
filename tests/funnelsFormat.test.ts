// The Funnels tab's display helpers (components/funnels/format.ts): what a
// manager reads for money, shares, waiting ages, "last activity" and the Gmail
// link behind each exception-queue item. Expected strings are literals.

import { describe, expect, it } from "vitest";
import {
  ageLabel,
  ago,
  gmailLink,
  money,
  pctLabel,
} from "@/components/funnels/format";

const NOW = Date.parse("2026-09-25T12:00:00Z");

describe("money", () => {
  it("shows whole US dollars with thousands separators", () => {
    expect(money(12345.6)).toBe("$12,346");
  });

  it("shows $0 when there is no value", () => {
    expect(money(null)).toBe("$0");
  });
});

describe("pctLabel", () => {
  it("shows a share as a percent", () => {
    expect(pctLabel(42.5)).toBe("42.5%");
  });

  it("shows a dash, not 0%, when the share is undefined", () => {
    expect(pctLabel(null)).toBe("—");
  });
});

describe("ageLabel", () => {
  it("shows a dash when the age is unknown", () => {
    expect(ageLabel(undefined)).toBe("—");
  });

  it("shows <1h under an hour", () => {
    expect(ageLabel(0.5)).toBe("<1h");
  });

  it("shows hours up to two days", () => {
    expect(ageLabel(47.4)).toBe("47h");
  });

  it("switches to days at 48 hours", () => {
    expect(ageLabel(48)).toBe("2d");
  });
});

describe("ago", () => {
  it("says never when there is no instant", () => {
    expect(ago(null, NOW)).toBe("never");
  });

  it("says unknown for an unreadable instant", () => {
    expect(ago("not a date", NOW)).toBe("unknown");
  });

  it("says just now inside the first half-minute", () => {
    expect(ago("2026-09-25T11:59:45Z", NOW)).toBe("just now");
  });

  it("counts minutes under an hour", () => {
    expect(ago("2026-09-25T11:15:00Z", NOW)).toBe("45m ago");
  });

  it("counts hours from the hour mark up to two days", () => {
    expect(ago("2026-09-25T11:00:00Z", NOW)).toBe("1h ago");
    expect(ago("2026-09-23T13:00:00Z", NOW)).toBe("47h ago");
  });

  it("switches to days at 48 hours", () => {
    expect(ago("2026-09-23T12:00:00Z", NOW)).toBe("2d ago");
  });

  it("measures from the clock it is given, not the wall clock", () => {
    expect(ago("2026-09-25T11:00:00Z", Date.parse("2026-09-25T11:30:00Z"))).toBe(
      "30m ago",
    );
  });
});

describe("gmailLink", () => {
  it("opens the thread when there is a thread id", () => {
    expect(gmailLink("18c2f0a", "ana@beta.com")).toBe(
      "https://mail.google.com/mail/u/0/#all/18c2f0a",
    );
  });

  it("searches on the encoded address when there is no thread id", () => {
    expect(gmailLink(null, "a+b@beta.com")).toBe(
      "https://mail.google.com/mail/u/0/#search/a%2Bb%40beta.com",
    );
  });

  it("falls back to All Mail with neither", () => {
    expect(gmailLink(null, null)).toBe("https://mail.google.com/mail/u/0/#all");
  });
});
