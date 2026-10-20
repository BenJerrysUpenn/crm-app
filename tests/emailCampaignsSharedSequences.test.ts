import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EmailCampaignsPrototype from "@/components/emailCampaignsPrototype/EmailCampaignsPrototype";
import SequenceEditor from "@/components/emailCampaignsPrototype/SequenceEditor";
import { compute, type RawData } from "@/lib/emailCampaignsPrototype/model";
import { SEED_LANE_BLOCKS, SEED_SEQUENCES, type SequenceDoc } from "@/lib/emailCampaignsPrototype/sequences";
import {
  LANE_STORAGE_PREFIX,
  RESCUED_PREFIX,
  SEQ_STORAGE_PREFIX,
  applyRescue,
  createMemoryRepo,
  emptyState,
  markUploaded,
  pendingLocalCopies,
  rescue,
  rescueMessage,
  resolveLane,
  resolveSequence,
  type StorageLike,
} from "@/lib/emailCampaignsPrototype/sharedSequences";

// The sequence editor's shared copy (supabase/crm/013). Before it, every edit
// lived in one browser's localStorage. On page load the browser uploads those
// copies (rescue): a blank copy never overwrites real work, a copy that
// differs from the shared row is kept as a conflict record, the localStorage
// keys stay as a backup, and no row means the seed.

const USER = "00000000-0000-0000-0000-000000000001";

const blank: SequenceDoc = { name: "", steps: [{ id: "s-1", waitDays: 0, subject: "", body: "" }] };
const work: SequenceDoc = {
  name: "Corporate holiday",
  steps: [
    { id: "s-a", waitDays: 0, subject: "Holiday parties", body: "Hi {{first_name}}, step one." },
    { id: "s-b", waitDays: 4, subject: "Following up", body: "Step two." },
  ],
};
const otherWork: SequenceDoc = {
  name: "Corporate holiday (draft 2)",
  steps: [{ id: "s-c", waitDays: 0, subject: "Office treats", body: "A different first step." }],
};

function fakeStorage(init: Record<string, string>): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("rescue: a blank browser copy is skipped", () => {
  it("does not upload a sequence whose every step has an empty subject and body", async () => {
    const repo = createMemoryRepo();
    const out = await rescue([{ kind: "sequence", key: "warm:corporate", doc: blank }], repo, USER);
    expect(out).toEqual([{ kind: "sequence", key: "warm:corporate", result: "blank" }]);
    expect(repo.rows.sequence.has("warm:corporate")).toBe(false);
    expect(repo.conflictRows).toHaveLength(0);
  });

  it("treats whitespace-only steps as blank too", async () => {
    const repo = createMemoryRepo();
    const doc = { name: "x", steps: [{ id: "1", waitDays: 0, subject: "  ", body: "\n" }] };
    const [o] = await rescue([{ kind: "sequence", key: "warm:corporate", doc }], repo, USER);
    expect(o.result).toBe("blank");
  });

  it("leaves real work in place when a blank copy for the same key arrives later", async () => {
    const repo = createMemoryRepo();
    await rescue([{ kind: "sequence", key: "warm:corporate", doc: work }], repo, USER);
    const [o] = await rescue([{ kind: "sequence", key: "warm:corporate", doc: blank }], repo, USER);
    expect(o.result).toBe("blank");
    expect(await repo.get("sequence", "warm:corporate")).toEqual(work);
    expect(repo.conflictRows).toHaveLength(0);
  });

  it("lets real work in when a blank copy arrived first", async () => {
    const repo = createMemoryRepo();
    await rescue([{ kind: "sequence", key: "warm:corporate", doc: blank }], repo, USER);
    const [o] = await rescue([{ kind: "sequence", key: "warm:corporate", doc: work }], repo, USER);
    expect(o.result).toBe("saved");
    expect(await repo.get("sequence", "warm:corporate")).toEqual(work);
  });

  it("skips a lane whose signature and footer are both empty", async () => {
    const repo = createMemoryRepo();
    const [o] = await rescue([{ kind: "lane", key: "cold", doc: { signature: " ", footer: "" } }], repo, USER);
    expect(o.result).toBe("blank");
    expect(repo.rows.lane.size).toBe(0);
  });

  it("skips a copy identical to its seed: there is nothing to keep", async () => {
    const repo = createMemoryRepo();
    const out = await rescue(
      [
        { kind: "sequence", key: "cold:everyone", doc: SEED_SEQUENCES["cold:everyone"] },
        { kind: "lane", key: "warm", doc: SEED_LANE_BLOCKS.warm },
      ],
      repo,
      USER,
    );
    expect(out.map((o) => o.result)).toEqual(["seed", "seed"]);
    expect(repo.rows.sequence.size + repo.rows.lane.size).toBe(0);
  });
});

describe("rescue: a shared row is never overwritten; the browser copy is kept as a conflict", () => {
  it("saves a copy when no row exists", async () => {
    const repo = createMemoryRepo();
    const [o] = await rescue([{ kind: "sequence", key: "warm:corporate", doc: work }], repo, USER);
    expect(o).toMatchObject({ result: "saved", doc: work });
    expect(await repo.get("sequence", "warm:corporate")).toEqual(work);
  });

  it("keeps the row and stores the different browser copy beside it", async () => {
    const repo = createMemoryRepo();
    await repo.put("sequence", "warm:corporate", work, USER);
    const [o] = await rescue([{ kind: "sequence", key: "warm:corporate", doc: otherWork }], repo, USER);
    expect(o.result).toBe("conflict");
    expect(await repo.get("sequence", "warm:corporate")).toEqual(work);
    expect(repo.conflictRows).toHaveLength(1);
    expect(repo.conflictRows[0]).toMatchObject({ kind: "sequence", key: "warm:corporate", doc: otherWork, shared_doc: work });
  });

  it("stores the same conflicting copy once, however often the page loads", async () => {
    const repo = createMemoryRepo();
    await repo.put("sequence", "warm:corporate", work, USER);
    for (let i = 0; i < 3; i++) await rescue([{ kind: "sequence", key: "warm:corporate", doc: otherWork }], repo, USER);
    expect(repo.conflictRows).toHaveLength(1);
  });

  it("does nothing for a copy identical to the row, whatever its key order", async () => {
    const repo = createMemoryRepo();
    await repo.put("sequence", "warm:corporate", work, USER);
    const reordered = { steps: work.steps.map((s) => ({ body: s.body, subject: s.subject, waitDays: s.waitDays, id: s.id })), name: work.name };
    const [o] = await rescue([{ kind: "sequence", key: "warm:corporate", doc: reordered }], repo, USER);
    expect(o.result).toBe("same");
    expect(repo.conflictRows).toHaveLength(0);
  });

  it("keeps a lane's different signature as a conflict too", async () => {
    const repo = createMemoryRepo();
    await repo.put("lane", "warm", { signature: "Shared sig", footer: "Shared foot" }, USER);
    const [o] = await rescue([{ kind: "lane", key: "warm", doc: { signature: "Browser sig", footer: "Shared foot" } }], repo, USER);
    expect(o.result).toBe("conflict");
    expect(await repo.get("lane", "warm")).toEqual({ signature: "Shared sig", footer: "Shared foot" });
    expect(repo.conflictRows[0]).toMatchObject({ kind: "lane", key: "warm" });
  });

  it("refuses a malformed copy or key without writing anything", async () => {
    const repo = createMemoryRepo();
    const out = await rescue(
      [
        { kind: "sequence", key: "warm:corporate", doc: { name: "x", steps: "nope" } },
        { kind: "sequence", key: "nonsense", doc: work },
        { kind: "lane", key: "purple", doc: { signature: "a", footer: "b" } },
      ],
      repo,
      USER,
    );
    expect(out.map((o) => o.result)).toEqual(["invalid", "invalid", "invalid"]);
    expect(repo.rows.sequence.size + repo.rows.lane.size + repo.conflictRows.length).toBe(0);
  });

  it("puts saved copies on the page and a notice for each conflict", async () => {
    const repo = createMemoryRepo();
    await repo.put("sequence", "warm:wedding", work, USER);
    const out = await rescue(
      [
        { kind: "sequence", key: "warm:corporate", doc: work },
        { kind: "sequence", key: "warm:school", doc: otherWork },
        { kind: "sequence", key: "warm:wedding", doc: otherWork },
        { kind: "sequence", key: "cold:corporate", doc: blank },
        { kind: "lane", key: "cold", doc: { signature: "New sig", footer: "" } },
      ],
      repo,
      USER,
    );
    expect(rescueMessage(out)).toBe(
      "Saved 2 sequences and 1 lane's signature and footer from this browser to the shared copy",
    );
    const state = applyRescue(emptyState(), out, "2026-10-20T12:00:00Z");
    expect(Object.keys(state.sequences).sort()).toEqual(["warm:corporate", "warm:school"]);
    expect(state.lanes.cold).toEqual({ signature: "New sig", footer: "" });
    expect(state.conflicts).toEqual([{ kind: "sequence", key: "warm:wedding", created_at: "2026-10-20T12:00:00Z" }]);
  });

  it("says nothing when nothing was saved", () => {
    expect(rescueMessage([{ kind: "sequence", key: "warm:corporate", result: "blank" }])).toBeNull();
    expect(rescueMessage([{ kind: "sequence", key: "warm:corporate", result: "saved", doc: work }])).toBe(
      "Saved 1 sequence from this browser to the shared copy",
    );
  });
});

describe("rescue: the browser's copies stay in localStorage", () => {
  const init = () =>
    fakeStorage({
      [SEQ_STORAGE_PREFIX + "warm:corporate"]: JSON.stringify(work),
      [SEQ_STORAGE_PREFIX + "cold:corporate"]: JSON.stringify(blank),
      [LANE_STORAGE_PREFIX + "warm"]: JSON.stringify({ signature: "Sig", footer: "Foot" }),
      "email-campaigns-proto:note:v1:x": JSON.stringify({ text: "a note" }),
      [SEQ_STORAGE_PREFIX + "warm:broken"]: "{not json",
    });

  it("finds the sequence and lane copies, not notes or unparseable values", () => {
    const copies = pendingLocalCopies(init());
    expect(copies.map((c) => `${c.kind}:${c.key}`).sort()).toEqual(["lane:warm", "sequence:cold:corporate", "sequence:warm:corporate"]);
  });

  it("never deletes a key, and does not send a copy twice once the server has it", async () => {
    const storage = init();
    const before = new Map(storage.data);
    const repo = createMemoryRepo();
    const copies = pendingLocalCopies(storage);
    const out = await rescue(copies, repo, USER);
    markUploaded(storage, copies, out);
    for (const [k, v] of before) expect(storage.data.get(k)).toBe(v);
    expect(storage.data.get(RESCUED_PREFIX + SEQ_STORAGE_PREFIX + "warm:corporate")).toBe(JSON.stringify(work));
    expect(pendingLocalCopies(storage)).toEqual([]);
  });

  it("sends a copy again if it changed after it was uploaded", () => {
    const storage = init();
    const copies = pendingLocalCopies(storage);
    markUploaded(storage, copies, copies.map((c) => ({ kind: c.kind, key: c.key, result: "saved" as const })));
    storage.setItem(SEQ_STORAGE_PREFIX + "warm:corporate", JSON.stringify(otherWork));
    expect(pendingLocalCopies(storage).map((c) => c.key)).toEqual(["warm:corporate"]);
  });
});

describe("shared copy: seed fallback and reset", () => {
  it("shows the seed when a key has no row, and nothing when there is no seed", () => {
    const s = emptyState();
    expect(resolveSequence(s, "cold:everyone")).toBe(SEED_SEQUENCES["cold:everyone"]);
    expect(resolveSequence(s, "warm:everyone")).toBe(SEED_SEQUENCES["warm:everyone"]);
    expect(resolveSequence(s, "warm:corporate")).toBeNull();
    expect(resolveLane(s, "cold")).toBe(SEED_LANE_BLOCKS.cold);
    expect(resolveLane(s, "offer")).toEqual({ signature: "", footer: "" });
  });

  it("shows the row over the seed, an emptied seed included", async () => {
    const repo = createMemoryRepo();
    await repo.put("sequence", "cold:everyone", { name: "Cold Pilot A", steps: [] }, USER);
    await repo.put("lane", "warm", { signature: "Edited", footer: "" }, USER);
    const s = await repo.load();
    expect(resolveSequence(s, "cold:everyone")).toEqual({ name: "Cold Pilot A", steps: [] });
    expect(resolveLane(s, "warm")).toEqual({ signature: "Edited", footer: "" });
  });

  it("reset deletes the row, so the seed shows again", async () => {
    const repo = createMemoryRepo();
    await repo.put("sequence", "cold:everyone", work, USER);
    await repo.put("lane", "cold", { signature: "Edited", footer: "" }, USER);
    await repo.remove("sequence", "cold:everyone");
    await repo.remove("lane", "cold");
    const s = await repo.load();
    expect(s.sequences).toEqual({});
    expect(s.lanes).toEqual({});
    expect(resolveSequence(s, "cold:everyone")).toBe(SEED_SEQUENCES["cold:everyone"]);
    expect(resolveLane(s, "cold")).toBe(SEED_LANE_BLOCKS.cold);
  });

  it("reset of a sequence with no seed leaves nothing, not a blank row", async () => {
    const repo = createMemoryRepo();
    await repo.put("sequence", "warm:corporate", work, USER);
    await repo.remove("sequence", "warm:corporate");
    expect(resolveSequence(await repo.load(), "warm:corporate")).toBeNull();
  });
});

describe("page copy: edits are shared, sending is unchanged", () => {
  const raw: RawData = { prospects: [], deals: [], sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] };
  const payload = compute(raw, new Date("2026-10-20T12:00:00Z"));

  it("says sequence edits are shared, and shows a notice per conflict", () => {
    const html = renderToStaticMarkup(
      createElement(EmailCampaignsPrototype, {
        payload,
        shared: { ...emptyState(), conflicts: [{ kind: "sequence", key: "warm:everyone", created_at: "2026-10-20T12:00:00Z" }] },
        sharedError: null,
      }),
    );
    expect(html).toContain("Sequence edits are shared and saved for everyone");
    expect(html).not.toContain("Notes and sequence edits are saved in this browser only");
    expect(html).toContain("Warm › Everyone");
    expect(html).toContain("kept aside; the shared copy was not changed");
  });

  it("the editor banner says edits are shared and still do not change what Apollo or the warm sender sends", () => {
    const tier = payload.tiers.find((t) => t.key === "warm")!;
    const html = renderToStaticMarkup(
      createElement(SequenceEditor, {
        target: { tier, catKey: "everyone", catLabel: "Everyone", cadence: tier.defaultCadence },
        doc: SEED_SEQUENCES["warm:everyone"],
        seed: SEED_SEQUENCES["warm:everyone"],
        edited: false,
        onChange: () => {},
        onReset: () => {},
        blocks: SEED_LANE_BLOCKS.warm,
        blocksEdited: false,
        onBlocksChange: () => {},
        onBlocksReset: () => {},
        conflicts: [],
        onClose: () => {},
      }),
    );
    expect(html).toContain("saved to the shared copy, which everyone on this page sees");
    expect(html).toContain("They do not change what Apollo or the warm sender sends.");
    expect(html).not.toContain("saved in this browser only");
  });
});
