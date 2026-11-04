// The words of a cake order post and its follow-up. As the cash count
// reminders (lib/cashCount/message.ts), each one is written fresh by Claude
// (claude-haiku-5-5, through Claude Code on the owner's subscription:
// lib/cashCount/claudeCli.ts), checked, and replaced by a plain message on
// any failure, so a post never goes missing because of the AI step. The row
// records which one went out (post_source, followup_source).
//
// THE POST is two parts. Claude writes only the first line: the mentions and
// the ask (pack it, then react or reply when done). Below it is the
// customer's name and nothing else (the owner's ruling, 2026-11-04: the name
// is how the shop identifies a cake; the cake itself is on the tablet and
// the wall). The name is copied from the email by this code, never by
// Claude, so it cannot be changed in the retelling. Claude is not shown the
// order at all.
//
// THE FOLLOW-UP is a reply in the post's thread with NO mention (the owner's
// ruling, 2026-11-03): the people mentioned in the post follow its thread, so
// the reply reaches only them.
//
// VALIDATION. The post's first line: every person's mention exactly once; at
// most 240 characters and two lines; no other mentions, @here/@channel,
// links, digits or dollar signs (so no invented times or prices); and it asks
// them to pack it and to react or reply. The follow-up: no mention at all,
// the same limits, and it asks the same.

import { joinTokens, type Addressee } from "../cashCount/message";
import type { AskClaude } from "../cashCount/claudeCli";
import type { CakeOrder } from "./oloEmail";

export type { Addressee };
export type Occasion = "post" | "followup";

export const MAX_LEAD_CHARS = 240;
const MAX_LEAD_LINES = 2;
/** A name longer than this is cut, so one odd email cannot flood the channel. */
const MAX_NAME_CHARS = 80;

const TONES = ["upbeat", "warm", "casual", "cheerful", "relaxed", "brief and kind", "playful", "thankful"];

export type Validation = { ok: true } | { ok: false; reason: string };

function checkCommon(rest: string): Validation {
  if (/<[@!#]/.test(rest) || /@(here|channel|everyone)\b/i.test(rest)) return { ok: false, reason: "a mention" };
  if (/https?:\/\/|www\./i.test(rest)) return { ok: false, reason: "a link" };
  if (/\$/.test(rest)) return { ok: false, reason: "a dollar sign" };
  if (/\d/.test(rest)) return { ok: false, reason: "a number" };
  if (!/\bpack/i.test(rest)) return { ok: false, reason: "does not ask them to pack it" };
  if (!/\b(react|reaction|repl(y|ies)|respond)/i.test(rest)) return { ok: false, reason: "does not ask them to react or reply" };
  return { ok: true };
}

function checkShape(message: string): Validation {
  if (!message) return { ok: false, reason: "empty" };
  if (message.length > MAX_LEAD_CHARS) return { ok: false, reason: `longer than ${MAX_LEAD_CHARS} characters` };
  if (message.split("\n").length > MAX_LEAD_LINES) return { ok: false, reason: `more than ${MAX_LEAD_LINES} lines` };
  return { ok: true };
}

/** The post's first line, as Claude wrote it. */
export function validateLead(text: string, people: Addressee[]): Validation {
  const message = text.trim();
  const shape = checkShape(message);
  if (!shape.ok) return shape;
  let rest = message;
  for (const p of people) {
    const count = message.split(p.token).length - 1;
    if (count !== 1) return { ok: false, reason: `mention ${p.token} appears ${count} times` };
    rest = rest.split(p.token).join(" ");
  }
  const common = checkCommon(rest);
  return common.ok ? common : { ok: false, reason: common.reason === "a mention" ? "another mention" : common.reason };
}

/** The thread reply, as Claude wrote it: no mention at all. */
export function validateFollowup(text: string): Validation {
  const message = text.trim();
  const shape = checkShape(message);
  return shape.ok ? checkCommon(message) : shape;
}

/** The plain first line used when the AI step fails. */
export function fallbackLead(people: Addressee[]): string {
  return `${joinTokens(people)} a new custom cake order just came in. Please pack it, then react to this message or reply in the thread when it is done.`;
}

/** The plain thread reply used when the AI step fails. */
export const FALLBACK_FOLLOWUP = "Friendly reminder: this custom cake is not marked packed yet. Please pack it, then react to the message above or reply here when it is done.";

/** Slack's three escapes: the name is the customer's own words. */
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The line under Claude's: the customer's name, bold, copied from the email. */
export function orderName(order: CakeOrder): string {
  const flat = order.customer.replace(/\s+/g, " ").trim();
  const name = flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS - 1)}…` : flat;
  return `*${slackEscape(name)}*`;
}

export const SYSTEM_POST = `You write the first line of a Slack message in the #cake-orders-and-ideas channel of an ice cream shop. A customer has ordered a custom ice cream cake; the staff on shift need to pack it. The customer's name is added below your line by the shop's system; you do not see it and must not describe the cake.

The line:
- One or two short sentences, friendly and casual, under 200 characters.
- Addresses the people with the mention text exactly as given, once each, character for character. Never change it or add another mention.
- Says a new custom cake order came in and asks them to pack it, then react to the message or reply in the thread when it is done.
- Contains no numbers, no times, no prices, no links and no @here or @channel. An emoji or two is fine.
- Varies its wording; it does not have to start with the mention.

Reply with the line only.`;

export const SYSTEM_FOLLOWUP = `You write one short Slack reply in the thread of a cake order message in an ice cream shop's #cake-orders-and-ideas channel. The order was posted an hour ago and nobody has marked it packed yet. The people on shift follow the thread.

The reply:
- One or two short sentences, friendly and gentle, under 200 characters.
- Contains no mention of anyone (no @ names, no @here or @channel): the right people already follow the thread.
- Asks them to pack the cake if it is not packed yet, then react to the message above or reply here when it is done.
- Contains no numbers, no times, no prices and no links. An emoji is fine.
- Varies its wording.

Reply with the reply text only.`;

export type Written = { text: string; source: "ai" | "fallback"; note?: string };

/** Write the post: Claude's first line (or the plain one), then the customer's name. */
export async function writePost(args: { ask: AskClaude | null; people: Addressee[]; order: CakeOrder; random?: () => number }): Promise<Written> {
  const { ask, people, order } = args;
  const details = orderName(order);
  const fallback = (note: string): Written => ({ text: `${fallbackLead(people)}\n${details}`, source: "fallback", note });
  if (!ask) return fallback("no Claude subscription token");
  const tone = TONES[Math.floor((args.random ?? Math.random)() * TONES.length)];
  const answer = await ask({ system: SYSTEM_POST, prompt: `Mention text: ${joinTokens(people)}\nTone: ${tone}.` });
  if (!answer.ok) return fallback(answer.reason);
  const lead = answer.text.trim();
  const check = validateLead(lead, people);
  if (!check.ok) return fallback(`AI message rejected: ${check.reason}`);
  return { text: `${lead}\n${details}`, source: "ai" };
}

/** Write the thread reply, falling back to the plain one on any failure. */
export async function writeFollowup(args: { ask: AskClaude | null; random?: () => number }): Promise<Written> {
  const fallback = (note: string): Written => ({ text: FALLBACK_FOLLOWUP, source: "fallback", note });
  if (!args.ask) return fallback("no Claude subscription token");
  const tone = TONES[Math.floor((args.random ?? Math.random)() * TONES.length)];
  const answer = await args.ask({ system: SYSTEM_FOLLOWUP, prompt: `Tone: ${tone}.` });
  if (!answer.ok) return fallback(answer.reason);
  const text = answer.text.trim();
  const check = validateFollowup(text);
  if (!check.ok) return fallback(`AI message rejected: ${check.reason}`);
  return { text, source: "ai" };
}
