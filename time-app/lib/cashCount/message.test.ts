// The words of a cash count reminder (lib/cashCount/message.ts): written by
// Claude from the live cash count steps, checked, and replaced by a plain
// message whenever the AI step fails, so a reminder never goes missing.
// Claude is a stand-in here; lib/cashCount/run.test.ts drives the real SDK.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Message from "./message.ts";

const m = await loadAppModule<typeof Message>("lib/cashCount/message.ts");
const { fallbackMessage, validateReminder, writeReminder } = m;

const SAM = { token: "<@U0SAM>" };
const JO = { token: "<@U0JO>" };
const RULES = "Open: count the register and the cash box bundles, and post the counts here. Close: post the count, a photo of the printout, the bundles and the drop.";

type Request = { model: string; system: string; messages: { content: string }[]; output_config: { effort: string } };
function claudeSaying(text: string, stop_reason = "end_turn") {
  const seen: Request[] = [];
  return {
    seen,
    client: {
      messages: {
        create: async (req: Request) => {
          seen.push(req);
          return { content: [{ type: "text", text }], stop_reason };
        },
      },
    } as unknown as Message.ClaudeLike,
  };
}

test("a good reminder passes: the mention once, short, no numbers", () => {
  assert.deepEqual(validateReminder("Morning <@U0SAM>! Please post the register count and the cash box bundles here.", [SAM], "open"), { ok: true });
  assert.deepEqual(validateReminder("<@U0SAM> and <@U0JO>, nice close! Post the count, the printout photo, the bundles and the drop here.", [SAM, JO], "close"), { ok: true });
});

test("a reminder is rejected for a missing or doubled mention, other mentions, links, numbers, money or length", () => {
  const bad = (text: string, people = [SAM], phase: Message.Phase = "open") => validateReminder(text, people, phase).ok;
  assert.equal(bad("Please post the opening counts."), false, "no mention");
  assert.equal(bad("<@U0SAM> hi <@U0SAM>, post the counts."), false, "mention twice");
  assert.equal(bad("<@U0SAM> post the counts.", [SAM, JO], "close"), false, "one of two people missing");
  assert.equal(bad("<@U0SAM> post the counts, cc <@U0BOSS>."), false, "another person");
  assert.equal(bad("<@U0SAM> post the counts <!here>."), false, "@here");
  assert.equal(bad("<@U0SAM> post the counts, see https://example.test."), false, "a link");
  assert.equal(bad("<@U0SAM> make sure the drawer is $300 and post it."), false, "dollar amount");
  assert.equal(bad("<@U0SAM> post the counts, all 12 bundles."), false, "a number");
  assert.equal(bad("<@U0SAM> post the counts, three hundred dollars in bills."), false, "money in words");
  assert.equal(bad(`<@U0SAM> ${"please post the counts ".repeat(20)}`), false, "too long");
  assert.equal(bad("<@U0SAM>\npost\nthe\ncounts"), false, "too many lines");
});

test("an opening reminder may not ask for closing posts, and a closing one not for the bank run", () => {
  assert.equal(validateReminder("<@U0SAM> post the counts and the drop amount.", [SAM], "open").ok, false);
  assert.equal(validateReminder("<@U0SAM> post the counts and a photo of the printout.", [SAM], "open").ok, false);
  assert.equal(validateReminder("<@U0SAM> post the counts, then do the bank deposit.", [SAM], "close").ok, false);
});

test("Claude's message is used when it passes, written from the live steps with the mention and a small model", async () => {
  const claude = claudeSaying("Hey <@U0SAM>, thanks for opening! Post the register count and the cash box bundles when you can.");
  const out = await writeReminder({ claude: claude.client, rules: RULES, people: [SAM], phase: "open", occasion: "reminder", random: () => 0 });
  assert.deepEqual(out, { text: "Hey <@U0SAM>, thanks for opening! Post the register count and the cash box bundles when you can.", source: "ai" });
  const req = claude.seen[0];
  assert.equal(req.model, "claude-haiku-5-5");
  assert.equal(req.output_config.effort, "low");
  assert.match(req.messages[0].content, /<cash_count_steps>\nOpen: count the register/);
  assert.match(req.messages[0].content, /Mention text: <@U0SAM>/);
  assert.match(req.messages[0].content, /opening/);
});

test("the plain message goes out when there is no key, no rules, an API error, a refusal or a bad message", async () => {
  // Written out, not recomputed with fallbackMessage: a test that asks the code
  // for its expected value agrees with any change to it (CODING_STANDARDS 19).
  const plain = "<@U0SAM> the store just closed. Please post the closing cash counts here, as the cash count steps in this channel say.";
  assert.equal(fallbackMessage([SAM], "close", "reminder"), plain);
  assert.equal(validateReminder(plain, [SAM], "close").ok, true, "the plain message passes its own checks");

  const cases: [string, Parameters<typeof writeReminder>[0]][] = [
    ["no key", { claude: null, rules: RULES, people: [SAM], phase: "close", occasion: "reminder" }],
    ["no rules", { claude: claudeSaying("<@U0SAM> post it").client, rules: null, people: [SAM], phase: "close", occasion: "reminder" }],
    ["blank rules", { claude: claudeSaying("<@U0SAM> post it").client, rules: "  \n ", people: [SAM], phase: "close", occasion: "reminder" }],
    ["refusal", { claude: claudeSaying("", "refusal").client, rules: RULES, people: [SAM], phase: "close", occasion: "reminder" }],
    ["cut off", { claude: claudeSaying("<@U0SAM> po", "max_tokens").client, rules: RULES, people: [SAM], phase: "close", occasion: "reminder" }],
    ["invented amount", { claude: claudeSaying("<@U0SAM> the drawer should be $300, post the count.").client, rules: RULES, people: [SAM], phase: "close", occasion: "reminder" }],
    ["lost mention", { claude: claudeSaying("Great close team, post the counts!").client, rules: RULES, people: [SAM], phase: "close", occasion: "reminder" }],
    [
      "API throws",
      {
        claude: { messages: { create: async () => { throw new Error("socket hang up"); } } } as unknown as Message.ClaudeLike,
        rules: RULES,
        people: [SAM],
        phase: "close",
        occasion: "reminder",
      },
    ],
  ];
  for (const [name, args] of cases) {
    const out = await writeReminder(args);
    assert.equal(out.source, "fallback", name);
    assert.equal(out.text, plain, name);
    assert.ok(out.note, `${name} says why`);
  }
});

test("the follow-up's plain message mentions everyone it nudges", () => {
  const text = fallbackMessage([SAM, JO], "open", "followup");
  assert.match(text, /^<@U0SAM> and <@U0JO> /);
  assert.match(text, /opening cash counts are not posted yet/);
});
