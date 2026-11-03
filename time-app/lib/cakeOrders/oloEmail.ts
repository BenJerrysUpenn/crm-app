// Reading Olo's per-order email ("Send Redundant Order Email", store settings
// PA013, on since 2026-11-03): which emails are cake orders, and what the post
// says about each. THIS IS THE SEAM the rest of lib/cakeOrders/ is built
// around, and it is not built yet.
//
// WAITING ON THE FIRST REAL EMAIL (crm-app #142). No Olo order email had
// reached the order address when this was written, so its format is unknown
// and is not guessed here. Until it is built, parseOloOrderEmail answers
// "unrecognised" for every email, and the job posts nothing: it cannot post
// an order it cannot read. The run reports how many emails it read and could
// not recognise, and a dry run lists their senders and subjects, so the first
// real one shows up there.
//
// TO BUILD IT, from the first real Olo order email:
//   1. Save its raw bytes (Gmail "Show original", or the IMAP fetch the job
//      makes) as a fixture under time-app/lib/cakeOrders/fixtures/, with the
//      customer's name, phone, email and any card digits replaced by
//      placeholders: crm-app is a public repo (README "This repo is public").
//      Keep everything else byte for byte, MIME boundaries and encodings
//      included.
//   2. Fill in parseOloOrderEmail against that fixture, test first
//      (oloEmail.test.ts has the waiting test):
//        * not from Olo, or an Olo email that is not an order: "not_cake";
//        * an Olo order from a marketplace (DoorDash and the others Olo
//          routes) or with no cake on it: "not_cake";
//        * a cake order: "cake_order", with the order's own id as `key` (so a
//          resent email is the same order), the customer, the pickup time as
//          an instant when the email gives one (`pickupAt`) and as the email
//          writes it (`pickupText`), and one line per cake item with its
//          options and message (`cake`);
//        * anything it cannot read with confidence: "unrecognised", never a
//          guess.
//   3. Narrow orderMailQuery to Olo's sender once it is known, so the job
//      fetches only Olo mail. The order address is a Google group, and the
//      group rewrites From to "'<name>' via Admin" <the group's address>; the
//      real sender is in X-Original-From and X-Original-Sender (seen on the
//      group's mail 2026-11-03). Gmail's from: search matches the rewritten
//      From, so match Olo on X-Original-Sender in the parser, and narrow the
//      search by subject if the From is no help.
//   4. Set PARSER_READY to true.
// Olo only sends above a dollar threshold B&J corporate sets; the first real
// cake order also confirms cakes clear it.

/** False until parseOloOrderEmail is built from a real Olo order email. */
export const PARSER_READY = false;

export const WAITING_NOTE = "the Olo email parser waits on the first real order email (crm-app #142)";

/** One cake order, as the post shows it. */
export type CakeOrder = {
  /** The order's own id in the email: the same order emailed twice is posted once. */
  key: string;
  customer: string;
  /** The pickup time as an instant (ISO), when the email gives one. */
  pickupAt: string | null;
  /** The pickup time as the email writes it. */
  pickupText: string;
  /** One line per cake item: size, flavour, options, the message on it. */
  cake: string[];
};

export type ParsedEmail =
  | { kind: "cake_order"; order: CakeOrder }
  | { kind: "not_cake"; why: string }
  | { kind: "unrecognised"; why: string };

/** Turn one raw RFC 5322 email into a cake order, or say why it is not one. */
export type ParseEmail = (raw: string) => ParsedEmail;

/** See TO BUILD IT above. Until then: unrecognised, always. */
export const parseOloOrderEmail: ParseEmail = () => ({ kind: "unrecognised", why: WAITING_NOTE });

/**
 * The Gmail search (IMAP X-GM-RAW) for order emails: mail to the address Olo
 * sends to, received in the last `days` days. The address comes from the
 * environment (CAKE_ORDERS_ORDER_ADDRESS, set in the bj-box unit), not from
 * this public repo.
 */
export function orderMailQuery(orderAddress: string, days: number): string {
  return `to:${orderAddress} newer_than:${days}d`;
}
