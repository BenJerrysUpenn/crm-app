// PROTOTYPE — Email campaigns tab (v4, v5): the in-CRM sequence editor's data.
//
// One sequence per tier × category ("cold:everyone", "warm:corporate", ...).
// A step is one email and one dot on the tile. Seeds exist only for the Cold
// and Warm "Everyone" sequences; Offer and every category start empty.
//
// v5: each lane (tier) has its own signature and footer, editable in the
// editor. Merge tags are {{first_name}}, {{unsubscribe_link}}, {{offers_link}}
// and {{sender_name}}. Each step carries `sentAs`: the send-history keys
// (outreach_events.detail->>'template') that mean "this person already got
// this email", so nobody is sent the same email twice, whatever tier they are
// in now.
//
// Prototype persistence is localStorage (see useSequences in the component):
// nothing here is written to the database, Apollo or warm_sender.

import type { TierKey } from "./model";

export type SeqStep = {
  id: string;
  /** Days to wait after the previous step. Step 1: days after enrolment. */
  waitDays: number;
  subject: string;
  body: string;
  /** Send-history keys that count as having received this step. A step added
   * in the editor has none, so nobody has had it yet. */
  sentAs?: string[];
};

export type SequenceDoc = { name: string; steps: SeqStep[] };

// GENERATED VERBATIM COPY. Do not reword, reflow or "improve" any string in
// this block: the owners treat the copy as non-negotiable.
//   Cold: the owners' Cold Pilot A copy (Apollo), 2026-09-27.
//   Warm: Catering-Manager d3f782d outreach/warm_sender.py (SUBJECT and
//         BODY, approved 2026-08-26). BODY is one string there; it is split
//         here at its blank lines into body / signature / opt-out footer, and
//         its {first_name} placeholder is written as the editor's
//         {{first_name}} merge field. No other character differs.
//   v5: the footers' trailing link words ("Unsubscribe", "Yes, send me
//   offers") are stored as {{unsubscribe_link}} / {{offers_link}} in the
//   editable footer (SEED_LANE_BLOCKS), derived from these constants; the
//   preview renders each tag back as exactly those words.

export const COLD_SUBJECT = "Ice cream catering for holiday events";

export const COLD_BODY = "Hi {{first_name}},\n\nI'm Alina, the owner of the Ben & Jerry's in Philadelphia. I took over the shop in May and run it as a woman-owned small business.\n\nWe cater events across the Philadelphia area, and winter is coming! The cold-weather menu is hot chocolate floats, warmed cookie and brownie sundaes, and Belgian waffle sundaes, with toppings like crushed candy cane, gingersnaps, and hot fudge. We bring everything, scoop for your guests, and clean up. You tell us when, where, and how many.\n\nThe regular ice cream cup, cone, or sundae catering is open year round as well.\n\nIf you have a holiday party, wedding, staff appreciation event, bar/bat mitzvah coming up, I can turn a quote around the same day.\n\nLooking forward to hearing from you!";

export const COLD_SIGNATURE = "Alina Withers\nBen & Jerry's Philadelphia\n218 S 40th St, Philadelphia, PA 19104\nhttps://www.benjerry.com/philadelphia-ice-cream-catering/catering";

export const COLD_FOOTER_UNSUBSCRIBE = "No longer interested in these messages? Unsubscribe";

export const COLD_FOOTER_PROPOSED = "Not planning anything yet? I send a short seasonal menu with offers once a month. Yes, send me offers";

export const WARM_SUBJECT = "Ice cream catering for holiday events";

export const WARM_BODY = "Hi {{first_name}},\n\nI'm Alina, the owner of the Ben & Jerry's in Philadelphia. I took over the shop in May and run it as a woman-owned small business.\n\nWe cater events across the Philadelphia area, and winter is coming! The cold-weather menu is hot chocolate floats, warmed cookie and brownie sundaes, and Belgian waffle sundaes, with toppings like crushed candy cane, gingersnaps, and hot fudge. We bring everything, scoop for your guests, and clean up. You tell us when, where, and how many.\n\nThe regular ice cream cup, cone, or sundae catering is open year round as well.\n\nIf you have a holiday party, wedding, staff appreciation event, bar/bat mitzvah coming up, I can turn a quote around the same day.\n\nLooking forward to hearing from you!";

export const WARM_SIGNATURE = "Alina Withers\nOwner, Ben & Jerry's Philadelphia\n218 S 40th St, Philadelphia, PA 19104\n6093696808";

export const WARM_FOOTER_OPT_OUT = "If you'd rather not hear from me, reply \"no thanks\" and I'll take you off my list.";

// The one-click line warm_sender appends to the HTML part (bj-finance #440).
export const WARM_FOOTER_UNSUBSCRIBE = "Unsubscribe";

// --- merge tags -----------------------------------------------------------------

/** The supported merge tags. `sample` is what "Preview as recipient" shows; the
 * two link tags render as links whose text is the seeded verbatim link text. */
export const MERGE_TAGS: { tag: string; sample: string; link?: boolean; help: string }[] = [
  { tag: "first_name", sample: "Jordan", help: "The recipient's first name." },
  { tag: "unsubscribe_link", sample: "Unsubscribe", link: true, help: "One-click unsubscribe link." },
  {
    tag: "offers_link",
    sample: "Yes, send me offers",
    link: true,
    help: "Opt in to the monthly seasonal menu with offers (proposed, not live).",
  },
  { tag: "sender_name", sample: "Alina Withers", help: "The name on the sending mailbox." },
];

// --- lanes --------------------------------------------------------------------

export type Lane = {
  sendsFrom: string;
  via: string;
  replyTo: string | null;
  signatureNote: string;
  footerNote: string;
  /** Footer lines containing one of these tags are shown as "proposed". */
  proposedTags: string[];
  apolloUrl: string | null;
  /** Sample recipient for "Preview as recipient". */
  sample: { to: string; name: string };
};

/** A lane's editable blocks. Plain text; merge tags as {{tag}}. */
export type LaneBlocks = { signature: string; footer: string };

export const APOLLO_COLD_SEQUENCE_URL = "https://app.apollo.io#/sequences/6a8e3e0efc576b00100b1f93";

const SAMPLE = { to: "jordan.rivera@example.com", name: "Jordan Rivera" };

export const LANES: Record<TierKey, Lane> = {
  cold: {
    sendsFrom: "alina@phillyicecreamcatering.com",
    via: "Apollo",
    replyTo: null,
    signatureNote: "appended by Apollo",
    footerNote: "added by Apollo",
    proposedTags: ["offers_link"],
    apolloUrl: APOLLO_COLD_SEQUENCE_URL,
    sample: SAMPLE,
  },
  warm: {
    sendsFrom: "news.benjerryphilly.com mailboxes",
    via: "warm_sender",
    replyTo: "catering@benjerryphilly.com",
    signatureNote: "part of the warm_sender template",
    footerNote: "part of the warm_sender template; Unsubscribe link once one-click is configured (#440)",
    proposedTags: [],
    apolloUrl: null,
    sample: SAMPLE,
  },
  offer: {
    sendsFrom: "TBD (mass email / Kit)",
    via: "no lane yet",
    replyTo: null,
    signatureNote: "no lane yet",
    footerNote: "no lane yet",
    proposedTags: [],
    apolloUrl: null,
    sample: SAMPLE,
  },
};

/** Replace a trailing link text with its merge tag. The preview renders the tag
 * back as exactly that text, so what the recipient sees stays verbatim. */
function tagTail(line: string, linkText: string, tag: string): string {
  if (!line.endsWith(linkText)) throw new Error(`seed footer line does not end with "${linkText}"`);
  return line.slice(0, line.length - linkText.length) + `{{${tag}}}`;
}

/** Seeded signature and footer per lane. Cold = Apollo's, warm = warm_sender's
 * (verbatim, see above), offer = empty. Footer lines are separated by a blank
 * line. */
export const SEED_LANE_BLOCKS: Record<TierKey, LaneBlocks> = {
  cold: {
    signature: COLD_SIGNATURE,
    footer: [
      tagTail(COLD_FOOTER_PROPOSED, "Yes, send me offers", "offers_link"),
      tagTail(COLD_FOOTER_UNSUBSCRIBE, "Unsubscribe", "unsubscribe_link"),
    ].join("\n\n"),
  },
  warm: {
    signature: WARM_SIGNATURE,
    footer: [WARM_FOOTER_OPT_OUT, tagTail(WARM_FOOTER_UNSUBSCRIBE, "Unsubscribe", "unsubscribe_link")].join("\n\n"),
  },
  offer: { signature: "", footer: "" },
};

// --- seeds --------------------------------------------------------------------

// Send-history keys. warm_sender writes detail.template = "warm_holiday_2026"
// on every 'sequenced' outreach_events row. Apollo sends are not logged in
// outreach_events yet (Cold Pilot A has 0 contacts); this is the key a cold
// send would carry. Cold Pilot A step 1 and the warm_sender email are the same
// copy, so each counts as the other: nobody gets that email twice.
export const WARM_TEMPLATE_KEY = "warm_holiday_2026";
export const COLD_TEMPLATE_KEY = "apollo:cold_pilot_a:1";

export const SEED_SEQUENCES: Record<string, SequenceDoc> = {
  "cold:everyone": {
    name: "Cold Pilot A",
    steps: [
      {
        id: "seed-cold-1",
        waitDays: 0,
        subject: COLD_SUBJECT,
        body: COLD_BODY,
        sentAs: [COLD_TEMPLATE_KEY, WARM_TEMPLATE_KEY],
      },
    ],
  },
  "warm:everyone": {
    name: "warm_sender template",
    steps: [
      {
        id: "seed-warm-1",
        waitDays: 0,
        subject: WARM_SUBJECT,
        body: WARM_BODY,
        sentAs: [WARM_TEMPLATE_KEY, COLD_TEMPLATE_KEY],
      },
    ],
  },
};

const SEED_SENT_AS: Record<string, string[]> = Object.fromEntries(
  Object.values(SEED_SEQUENCES).flatMap((d) => d.steps.map((s) => [s.id, s.sentAs ?? []])),
);

/** The history keys that mean "already received this step". v4 edits stored
 * in localStorage have no sentAs, so seed ids fall back to the seed's keys. */
export function stepKeys(s: SeqStep): string[] {
  return s.sentAs ?? SEED_SENT_AS[s.id] ?? [s.id];
}

export const sequenceKey = (tier: TierKey, category: string) => `${tier}:${category}`;

/** Day offset of each step from enrolment. */
export function dayOffsets(steps: SeqStep[]): number[] {
  let d = 0;
  return steps.map((s) => (d += Math.max(0, s.waitDays)));
}

/** Split text into literal runs and {{merge_tag}} tokens. */
export function splitMerge(text: string): { text: string; field?: string }[] {
  const out: { text: string; field?: string }[] = [];
  const re = /\{\{\s*([a-z_]+)\s*\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], field: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Plain text as the recipient reads it (tags replaced by their samples). */
export function renderPlain(text: string): string {
  return splitMerge(text)
    .map((p) => (p.field ? (MERGE_TAGS.find((t) => t.tag === p.field)?.sample ?? `[${p.field}?]`) : p.text))
    .join("");
}
