// The shared sequence copy's routes and Supabase repo (supabase/crm/013).
//
//   * POST /api/email-campaigns/sequences/rescue applies the rescue rules
//     end to end: blank skipped, new saved, different kept as a conflict.
//   * PUT saves one row; DELETE (reset) removes it so the seed shows again.
//   * Both refuse a caller who is not signed in, and a bad key.
//   * supabaseSequenceRepo treats a unique violation as "a row is already
//     there" (insert) and "this copy is already kept" (conflict), never as
//     a reason to overwrite.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRepo, resolveSequence, type MemoryRepo } from "@/lib/emailCampaignsPrototype/sharedSequences";
import { SEED_SEQUENCES } from "@/lib/emailCampaignsPrototype/sequences";

const ctx = vi.hoisted(() => ({ repo: null as unknown, signedIn: true }));

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/emailCampaignsPrototype/sequenceRepo", async (orig) => ({
  ...(await orig<typeof import("@/lib/emailCampaignsPrototype/sequenceRepo")>()),
  sequenceRepoForRequest: async () => (ctx.signedIn ? { repo: ctx.repo, userId: "user-1" } : null),
}));

import { POST as rescuePOST } from "@/app/api/email-campaigns/sequences/rescue/route";
import { DELETE, PUT } from "@/app/api/email-campaigns/sequences/route";
import { supabaseSequenceRepo } from "@/lib/emailCampaignsPrototype/sequenceRepo";

const req = (method: string, body: unknown) =>
  new Request("http://localhost/api/email-campaigns/sequences", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const work = { name: "Corporate", steps: [{ id: "a", waitDays: 0, subject: "Hello", body: "Real work" }] };
const other = { name: "Corporate", steps: [{ id: "b", waitDays: 0, subject: "Hi", body: "Other work" }] };
const blank = { name: "", steps: [{ id: "c", waitDays: 0, subject: "", body: "" }] };

let repo: MemoryRepo;
beforeEach(() => {
  repo = createMemoryRepo();
  ctx.repo = repo;
  ctx.signedIn = true;
});

describe("POST /api/email-campaigns/sequences/rescue", () => {
  it("skips the blank copy, saves the new one, keeps the different one as a conflict", async () => {
    await repo.put("sequence", "warm:wedding", work, "someone");
    const res = await rescuePOST(
      req("POST", {
        items: [
          { kind: "sequence", key: "warm:corporate", doc: blank },
          { kind: "sequence", key: "warm:school", doc: work },
          { kind: "sequence", key: "warm:wedding", doc: other },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { outcomes } = (await res.json()) as { outcomes: { key: string; result: string }[] };
    expect(outcomes.map((o) => `${o.key}=${o.result}`)).toEqual([
      "warm:corporate=blank",
      "warm:school=saved",
      "warm:wedding=conflict",
    ]);
    expect(await repo.get("sequence", "warm:wedding")).toEqual(work);
    expect(repo.conflictRows.map((c) => c.doc)).toEqual([other]);
    expect(repo.rows.sequence.has("warm:corporate")).toBe(false);
  });

  it("refuses a caller who is not signed in", async () => {
    ctx.signedIn = false;
    const res = await rescuePOST(req("POST", { items: [{ kind: "sequence", key: "warm:school", doc: work }] }));
    expect(res.status).toBe(401);
    expect(repo.rows.sequence.size).toBe(0);
  });

  it("refuses a body without an items array", async () => {
    expect((await rescuePOST(req("POST", { items: "x" }))).status).toBe(400);
  });
});

describe("PUT and DELETE /api/email-campaigns/sequences", () => {
  it("saves a sequence, and reset deletes the row so the seed shows again", async () => {
    let res = await PUT(req("PUT", { kind: "sequence", key: "cold:everyone", doc: work }));
    expect(res.status).toBe(200);
    expect(resolveSequence(await repo.load(), "cold:everyone")).toEqual(work);
    res = await DELETE(req("DELETE", { kind: "sequence", key: "cold:everyone" }));
    expect(res.status).toBe(200);
    expect(repo.rows.sequence.has("cold:everyone")).toBe(false);
    expect(resolveSequence(await repo.load(), "cold:everyone")).toBe(SEED_SEQUENCES["cold:everyone"]);
  });

  it("saves a lane's signature and footer", async () => {
    const res = await PUT(req("PUT", { kind: "lane", key: "warm", doc: { signature: "S", footer: "F" } }));
    expect(res.status).toBe(200);
    expect(await repo.get("lane", "warm")).toEqual({ signature: "S", footer: "F" });
  });

  it("refuses a bad key or document", async () => {
    expect((await PUT(req("PUT", { kind: "sequence", key: "nope", doc: work }))).status).toBe(400);
    expect((await PUT(req("PUT", { kind: "lane", key: "pink", doc: { signature: "", footer: "" } }))).status).toBe(400);
    expect((await PUT(req("PUT", { kind: "sequence", key: "warm:x", doc: { steps: 3 } }))).status).toBe(400);
    expect((await DELETE(req("DELETE", { kind: "table", key: "warm:x" }))).status).toBe(400);
    expect(repo.rows.sequence.size + repo.rows.lane.size).toBe(0);
  });

  it("refuses a caller who is not signed in", async () => {
    ctx.signedIn = false;
    expect((await PUT(req("PUT", { kind: "sequence", key: "warm:x", doc: work }))).status).toBe(401);
    expect((await DELETE(req("DELETE", { kind: "sequence", key: "warm:x" }))).status).toBe(401);
  });
});

describe("supabaseSequenceRepo", () => {
  function stub(insertError: { code: string; message: string } | null) {
    const calls: { table: string; op: string; row?: unknown }[] = [];
    const client = {
      from(table: string) {
        return {
          insert: async (row: unknown) => {
            calls.push({ table, op: "insert", row });
            return { error: insertError };
          },
          upsert: async (row: unknown) => {
            calls.push({ table, op: "upsert", row });
            return { error: null };
          },
        };
      },
    };
    return { calls, repo: supabaseSequenceRepo(client as never) };
  }

  it("insertIfAbsent answers false on a unique violation and never upserts", async () => {
    const { calls, repo } = stub({ code: "23505", message: "duplicate key" });
    expect(await repo.insertIfAbsent("sequence", "warm:corporate", work, "u")).toBe(false);
    expect(calls.map((c) => c.op)).toEqual(["insert"]);
  });

  it("insertIfAbsent answers true when the insert goes through, with who saved it", async () => {
    const { calls, repo } = stub(null);
    expect(await repo.insertIfAbsent("sequence", "warm:corporate", work, "u")).toBe(true);
    expect(calls[0]).toMatchObject({
      table: "email_campaign_sequences",
      row: { key: "warm:corporate", name: work.name, steps: work.steps, updated_by: "u" },
    });
  });

  it("recordConflict treats a unique violation as already kept, and throws on any other error", async () => {
    await expect(stub({ code: "23505", message: "dup" }).repo.recordConflict("sequence", "warm:x", work, other, "u")).resolves.toBeUndefined();
    await expect(stub({ code: "42501", message: "denied" }).repo.recordConflict("sequence", "warm:x", work, other, "u")).rejects.toThrow(/denied/);
  });

  it("writes a lane to the lane table keyed by tier", async () => {
    const { calls, repo } = stub(null);
    await repo.put("lane", "cold", { signature: "S", footer: "F" }, "u");
    expect(calls[0]).toMatchObject({ table: "email_campaign_lane_blocks", op: "upsert", row: { tier: "cold", signature: "S", footer: "F" } });
  });
});
