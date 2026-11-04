// Reading Olo's per-order email ("Send Redundant Order Email", store settings
// PA013, on since 2026-11-03): which emails are custom cake orders, and what the post
// says about each. Built from the first real ones (crm-app #142), saved
// redacted under fixtures/.
//
// THE EMAIL, as it reached the order address on 2026-11-03. Subject "Order
// Notification". One text/html part, UTF-8, quoted-printable; no text part.
// The order address is a Google group, which rewrites From to "'Ben & Jerry's'
// via Admin" <the group's address>; Olo's own address, orders@olo.com, is in
// X-Original-Sender (X-Original-From and Reply-To carry it too). The body is
// four tables of <tr><td>label</td><td>value</td></tr> rows, under an <h3> that
// says "Order Transmitted Notification":
//   * Location, Order ID, Date Due ("Tuesday, 11/3/2026"), Handoff Mode
//     ("CounterPickup"), Time Due ("5:53 PM", New York), Order is PAID;
//   * Customer Name, Customer Email, Customer Contact Number;
//   * the items: each top-level item is a row whose first cell spans two
//     columns and reads "N x <name>", followed by one row per modifier
//     ("Choose up to 2 Flavors:" | "2 x Milk & Cookies" | its price, if any);
//   * Subtotal, Estimated Tax, Total, Paid by ("Paid Via Uber Eats",
//     "Paid by DoorDash").
//
// WHICH ORDERS ARE POSTED: CUSTOM CAKES ONLY. The owner's ruling, 2026-11-03:
// "custom cakes are the only ones that need to be made and tracked. named
// cakes get refilled from stock and don't need notifications". A custom cake
// is a top-level item whose name starts with the word "Custom" and ends in the
// word "Cake" (a trailing "(...)" allowed): on the store's Olo menu
// (order.benjerry.com/menu/upenn, read 2026-11-03) that is "Custom Order
// Cake" alone, and a custom cake item added later ("Custom Heart Cake") still
// counts. Every other cake on that menu is a named cake and is skipped: the
// four "Ready-Made Ice Cream Cakes (15 minutes)", such as "Small Half Baked
// Ice Cream Cake- Celebration Cake (Ready-Made)", and the fourteen named
// "Order Ahead Ice Cream Cakes (48 Hours)", "Celebration Cake" to "Cow-Spot
// Cake", seasonal ones included. A named cake is any other top-level item
// whose name ends in "Cake", so its skip says so ("named cake, refilled from
// stock"). "Custom Milkshake (20oz)" and the custom sundaes do not end in
// "Cake", so they are not custom cakes. The rule reads top-level item names
// only, so a cake flavour or topping inside a shake or a pint ("Cake
// Batter", "Birthday Cake") never makes an order a cake order. The channel is
// not a rule: the item name decides, whoever the order came through.
//
// A parse never guesses. Not from Olo, or an Olo order with no custom cake on
// it: "not_custom_cake", with the Olo order id when there is one, so the run
// can log why it skipped it. Anything from Olo it cannot read as a new order
// (another heading, no order id, no items): "unrecognised", which the run
// counts and a dry run lists by sender and subject.

import { nyInstant } from "../cashCount/plan";
import { headerOf } from "./mail";

/** Olo's sending address, as X-Original-Sender gives it through the group. */
const OLO_SENDER = "orders@olo.com";
/** The <h3> of a new order's email. */
const NEW_ORDER_HEADING = "Order Transmitted Notification";
/** The subject Olo gives every order email; the mailbox search asks for it. */
const ORDER_SUBJECT = "Order Notification";

/** One custom cake order, as the post shows it. */
export type CakeOrder = {
  /** The order's own id in the email: the same order emailed twice is posted once. */
  key: string;
  customer: string;
  /** The pickup time as an instant (ISO), when the email gives one. */
  pickupAt: string | null;
  /** The pickup time as the email writes it. */
  pickupText: string;
  /** One line per custom cake item: size, flavour, options, the message on it. */
  cake: string[];
};

export type ParsedEmail =
  | { kind: "cake_order"; order: CakeOrder }
  /** `order` is the Olo order id when the email is an Olo order. */
  | { kind: "not_custom_cake"; why: string; order?: string }
  | { kind: "unrecognised"; why: string };

/** Turn one raw RFC 5322 email into a custom cake order, or say why it is not one. */
export type ParseEmail = (raw: string) => ParsedEmail;

/** One top-level item and its modifiers, as the email lists them. */
export type OloItem = { quantity: number; name: string; modifiers: { label: string; value: string }[] };

/** Everything an Olo order email says that the job uses. */
export type OloOrder = {
  orderId: string;
  /** "Tuesday, 11/3/2026 5:53 PM", as the email writes it. */
  dueText: string;
  /** The same, as an instant (ISO), or null when it cannot be read. */
  dueAt: string | null;
  /** "CounterPickup" and the like. */
  handoffMode: string;
  customer: string;
  /** "Paid Via Uber Eats", "Paid by DoorDash". */
  paidBy: string;
  items: OloItem[];
};

export type OloRead = { kind: "order"; order: OloOrder } | { kind: "not_olo" } | { kind: "unrecognised"; why: string };

/** A trailing word "Cake", a "(Ready-Made)" or other bracket allowed after it. */
const ENDS_IN_CAKE = /\bcake(\s*\([^)]*\))?\s*$/i;

/** Is this top-level item a custom cake, the only kind posted? See WHICH ORDERS ARE POSTED above. */
export function isCustomCakeItem(name: string): boolean {
  return /^custom\b/i.test(name.trim()) && ENDS_IN_CAKE.test(name.trim());
}

/** Is this top-level item a named cake, refilled from stock and never posted? See WHICH ORDERS ARE POSTED above. */
export function isNamedCakeItem(name: string): boolean {
  return ENDS_IN_CAKE.test(name.trim()) && !isCustomCakeItem(name);
}

/** Read an Olo order email. Not from Olo: "not_olo". From Olo but not a readable new order: "unrecognised". */
export function readOloOrder(raw: string): OloRead {
  if (senderOf(raw) !== OLO_SENDER) return { kind: "not_olo" };
  const html = htmlOf(raw);
  if (html === null) return { kind: "unrecognised", why: "an Olo email with no readable HTML part" };
  const heading = text(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(html)?.[1] ?? "");
  if (heading !== NEW_ORDER_HEADING) return { kind: "unrecognised", why: `an Olo email that is not a new order (${heading || "no heading"})` };

  const fields = new Map<string, string>();
  const items: OloItem[] = [];
  let totals = false;
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b([^>]*?)\s*\/>|<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map((c) => ({
      spans: /\bcolspan\s*=\s*"?2/i.test(c[2] ?? ""),
      text: text(c[3] ?? ""),
    }));
    if (!cells.length) continue;
    const item = cells[0].spans ? /^(\d+)\s*x\s+(.+)$/.exec(cells[0].text) : null;
    if (item && !totals) {
      items.push({ quantity: Number(item[1]), name: item[2], modifiers: [] });
      continue;
    }
    const label = cells[0].text.replace(/:$/, "").trim();
    const value = cells[1]?.text ?? "";
    if (label === "Subtotal") totals = true;
    if (items.length && !totals) items[items.length - 1].modifiers.push({ label, value });
    else if (!fields.has(label)) fields.set(label, value);
  }

  const orderId = fields.get("Order ID") ?? "";
  if (!/^\d+$/.test(orderId)) return { kind: "unrecognised", why: "an Olo order email with no order id" };
  if (!items.length) return { kind: "unrecognised", why: `Olo order ${orderId} lists no items` };
  const date = fields.get("Date Due") ?? "";
  const time = fields.get("Time Due") ?? "";
  return {
    kind: "order",
    order: {
      orderId,
      dueText: [date, time].filter(Boolean).join(" "),
      dueAt: nyDue(date, time),
      handoffMode: fields.get("Handoff Mode") ?? "",
      customer: fields.get("Customer Name") ?? "",
      paidBy: fields.get("Paid by") ?? "",
      items,
    },
  };
}

/** The job's parser: an Olo order with a custom cake on it is a cake order; everything else says why not. */
export const parseOloOrderEmail: ParseEmail = (raw) => {
  const read = readOloOrder(raw);
  if (read.kind === "not_olo") return { kind: "not_custom_cake", why: "not an Olo order email" };
  if (read.kind === "unrecognised") return read;
  const o = read.order;
  const cakes = o.items.filter((i) => isCustomCakeItem(i.name));
  if (!cakes.length) {
    const listed = (items: OloItem[]) => items.map((i) => `${i.quantity} x ${i.name}`).join(", ");
    const named = o.items.filter((i) => isNamedCakeItem(i.name));
    const why = named.length ? `named cake, refilled from stock: ${listed(named)}` : `no cake on it: ${listed(o.items)}`;
    return { kind: "not_custom_cake", order: o.orderId, why: `${why}${o.paidBy ? ` (${o.paidBy})` : ""}` };
  }
  return {
    kind: "cake_order",
    order: {
      key: o.orderId,
      customer: o.customer || "(no name on the order)",
      pickupAt: o.dueAt,
      pickupText: o.dueText || "(no pickup time on the order)",
      // The modifier values only: the labels are Olo's long questions ("Are There Any Food Allergies ...?").
      cake: cakes.map((i) => [`${i.quantity} x ${i.name}`, i.modifiers.map((m) => m.value).filter(Boolean).join("; ")].filter(Boolean).join(": ")),
    },
  };
};

/**
 * The Gmail search (IMAP X-GM-RAW) for order emails: Olo's order subject, to
 * the address Olo sends to, received in the last `days` days. The From is the
 * group's rewrite, so Gmail's from: cannot find Olo; the subject narrows the
 * search and the parser checks the sender. The address comes from the
 * environment (CAKE_ORDERS_ORDER_ADDRESS, set in the bj-box unit), not from
 * this public repo.
 */
export function orderMailQuery(orderAddress: string, days: number): string {
  return `to:${orderAddress} subject:"${ORDER_SUBJECT}" newer_than:${days}d`;
}

// ---- the raw email ---------------------------------------------------------------

/** Olo's address: X-Original-Sender through the group, else the From address. Lower case. */
function senderOf(raw: string): string {
  const original = headerOf(raw, "X-Original-Sender");
  const from = original || headerOf(raw, "From");
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/** The first text/html part, decoded, or null. Single-part and multipart both. */
function htmlOf(entity: string): string | null {
  const type = headerOf(entity, "Content-Type");
  const split = /\r?\n\r?\n/.exec(entity);
  const body = split ? entity.slice(split.index + split[0].length) : "";
  if (/^multipart\//i.test(type)) {
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (!boundary) return null;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const html = htmlOf(part.replace(/^\r?\n/, ""));
      if (html !== null) return html;
    }
    return null;
  }
  if (!/^text\/html\b/i.test(type)) return null;
  const encoding = headerOf(entity, "Content-Transfer-Encoding").toLowerCase();
  const bytes =
    encoding === "quoted-printable"
      ? Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1")
      : encoding === "base64"
        ? Buffer.from(body.replace(/\s+/g, ""), "base64")
        : Buffer.from(body, "latin1");
  const charset = (/charset="?([^";\s]+)/i.exec(type)?.[1] ?? "utf-8").toLowerCase();
  return bytes.toString(/^(iso-8859-1|latin1|windows-1252|us-ascii)$/.test(charset) ? "latin1" : "utf8");
}

/** A cell's text: tags dropped, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k] ?? "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** "Tuesday, 11/3/2026" and "5:53 PM", New York wall clock, as an instant (ISO); null when unreadable. */
function nyDue(date: string, time: string): string | null {
  const d = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(time.trim());
  if (!d || !t) return null;
  const [month, day, year] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const hour = (Number(t[1]) % 12) + (t[3].toUpperCase() === "P" ? 12 : 0);
  const minutes = hour * 60 + Number(t[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || minutes >= 24 * 60) return null;
  return new Date(nyInstant(`${year}-${month}-${day}`, minutes)).toISOString();
}
