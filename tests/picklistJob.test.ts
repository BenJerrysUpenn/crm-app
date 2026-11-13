import { describe, expect, it } from "vitest";
import { lastPicklistFailure } from "@/lib/picklistJob";

// The picklist worker writes processed_at with a Z (quote_worker._now_iso)
// and an error_message of the form "<ExceptionClass>: <message>".
const failed = {
  kind: "picklist" as const,
  status: "error" as const,
  created_at: "2026-11-13T01:40:58.10Z",
  processed_at: "2026-11-13T01:41:03.52Z",
  error_message:
    "RuntimeError: Picklist refused to render: #931: can't count everything " +
    "on the sheet: no quantity rule for Hot Chocolate Cambros, Marshmallows",
};

describe("lastPicklistFailure", () => {
  it("gives the Eastern date and time of a failed picklist and its reason", () => {
    expect(lastPicklistFailure(failed)).toEqual({
      at: "Nov 12, 2026, 8:41 PM",
      reason:
        "can't count everything on the sheet: no quantity rule for " +
        "Hot Chocolate Cambros, Marshmallows",
    });
  });

  it("is nothing when the last picklist did not fail", () => {
    for (const status of ["done", "pending", "running"] as const) {
      expect(lastPicklistFailure({ ...failed, status })).toBeNull();
    }
  });

  it("is nothing when there is no picklist job, or the job is another kind", () => {
    expect(lastPicklistFailure(null)).toBeNull();
    expect(lastPicklistFailure({ ...failed, kind: "quote" })).toBeNull();
  });

  it("falls back to when the job was asked for when it has no processed time", () => {
    expect(lastPicklistFailure({ ...failed, processed_at: null })?.at).toBe(
      "Nov 12, 2026, 8:40 PM",
    );
  });

  it("keeps a message that does not have the worker's prefixes as it is", () => {
    expect(
      lastPicklistFailure({ ...failed, error_message: "DOCX not found" })?.reason,
    ).toBe("DOCX not found");
    expect(
      lastPicklistFailure({ ...failed, error_message: null })?.reason,
    ).toBe("no reason recorded");
  });
});
