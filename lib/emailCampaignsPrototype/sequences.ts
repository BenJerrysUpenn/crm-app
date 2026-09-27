// PROTOTYPE — Email campaigns tab (v4): the in-CRM sequence editor's data.
//
// One sequence per tier × category ("cold:everyone", "warm:corporate", ...).
// A step is one email and one dot on the tile. Seeds exist only for the Cold
// and Warm "Everyone" sequences; Offer and every category start empty.
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
};

export type SequenceDoc = { name: string; steps: SeqStep[] };

/** A footer line. `link` is the trailing part of `text` rendered as a link. */
export type FooterLine = { text: string; link?: string; proposed?: boolean; note?: string };

export type Lane = {
  sendsFrom: string;
  via: string;
  replyTo: string | null;
  signature: string | null;
  signatureNote: string;
  footer: FooterLine[];
  footerNote: string;
  mergeFields: string[];
  mergeNote: string;
  apolloUrl: string | null;
  /** Sample values for "Preview as recipient". */
  sample: { to: string; fields: Record<string, string> };
};

// GENERATED VERBATIM COPY. Do not reword, reflow or "improve" any string in
// this block: the owners treat the copy as non-negotiable.
//   Cold: the owners' Cold Pilot A copy (Apollo), 2026-09-27.
//   Warm: Catering-Manager origin/main outreach/warm_sender.py (SUBJECT and
//         BODY, approved 2026-08-26). BODY is one string there; it is split
//         here at its blank lines into body / signature / opt-out footer, and
//         its {first_name} placeholder is written as the editor's
//         {{first_name}} merge field. No other character differs.

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

// --- lanes --------------------------------------------------------------------

export const APOLLO_COLD_SEQUENCE_URL = "https://app.apollo.io#/sequences/6a8e3e0efc576b00100b1f93";

const SAMPLE = {
  to: "jordan.rivera@example.com",
  fields: { first_name: "Jordan", last_name: "Rivera", company: "Rivera & Co" },
};

export const LANES: Record<TierKey, Lane> = {
  cold: {
    sendsFrom: "alina@phillyicecreamcatering.com",
    via: "Apollo",
    replyTo: null,
    signature: COLD_SIGNATURE,
    signatureNote: "appended by Apollo",
    footer: [
      { text: COLD_FOOTER_PROPOSED, link: "Yes, send me offers", proposed: true, note: "proposed, not live yet" },
      { text: COLD_FOOTER_UNSUBSCRIBE, link: "Unsubscribe" },
    ],
    footerNote: "added by Apollo",
    mergeFields: ["first_name", "last_name", "company"],
    mergeNote: "Apollo fills these from the contact.",
    apolloUrl: APOLLO_COLD_SEQUENCE_URL,
    sample: SAMPLE,
  },
  warm: {
    sendsFrom: "news.benjerryphilly.com mailboxes",
    via: "warm_sender",
    replyTo: "catering@benjerryphilly.com",
    signature: WARM_SIGNATURE,
    signatureNote: "part of the warm_sender template",
    footer: [
      { text: WARM_FOOTER_OPT_OUT },
      {
        text: WARM_FOOTER_UNSUBSCRIBE,
        link: "Unsubscribe",
        note: "one-click link, added to the HTML part when one-click unsubscribe is configured (bj-finance #440)",
      },
    ],
    footerNote: "part of the warm_sender template",
    mergeFields: ["first_name"],
    mergeNote: "warm_sender fills only first_name.",
    apolloUrl: null,
    sample: SAMPLE,
  },
  offer: {
    sendsFrom: "TBD (mass email / Kit)",
    via: "no lane yet",
    replyTo: null,
    signature: null,
    signatureNote: "no lane yet, so no signature",
    footer: [],
    footerNote: "no lane yet, so no footer",
    mergeFields: ["first_name"],
    mergeNote: "Depends on the lane (TBD).",
    apolloUrl: null,
    sample: SAMPLE,
  },
};

// --- seeds --------------------------------------------------------------------

export const SEED_SEQUENCES: Record<string, SequenceDoc> = {
  "cold:everyone": {
    name: "Cold Pilot A",
    steps: [{ id: "seed-cold-1", waitDays: 0, subject: COLD_SUBJECT, body: COLD_BODY }],
  },
  "warm:everyone": {
    name: "warm_sender template",
    steps: [{ id: "seed-warm-1", waitDays: 0, subject: WARM_SUBJECT, body: WARM_BODY }],
  },
};

export const sequenceKey = (tier: TierKey, category: string) => `${tier}:${category}`;

/** Day offset of each step from enrolment. */
export function dayOffsets(steps: SeqStep[]): number[] {
  let d = 0;
  return steps.map((s) => (d += Math.max(0, s.waitDays)));
}

/** Split text into literal runs and {{merge_field}} tokens. */
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
