// Reading Olo's per-order email (lib/cakeOrders/oloEmail.ts), on the raw
// bytes of the first real ones (fixtures/, received 2026-11-03, redacted) and
// one derived cake order (fixtures/olo-order-cake-DERIVED.eml: built from a
// real email with a real Olo menu cake swapped in, because no cake order had
// arrived yet; its X-Fixture header says so). The stories:
//   * a real Olo order email is read whole: order id, due time as an instant,
//     handoff mode, customer, the items with their modifiers, and Paid by;
//   * only a cake order is a cake order; the milkshake and the pints that
//     arrived first are skipped, with the order id and why;
//   * a cake flavour or topping inside a shake is not a cake;
//   * only Olo's email counts, matched on X-Original-Sender because the group
//     rewrites From; another Olo email, or one it cannot read, is
//     "unrecognised", never a guess.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Olo from "./oloEmail.ts";

const olo = await loadAppModule<typeof Olo>("lib/cakeOrders/oloEmail.ts");
const { isCakeItem, orderMailQuery, parseOloOrderEmail, readOloOrder } = olo;

/** A fixture as the mailbox reader hands it over: latin1, so every byte survives. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString("latin1");
const MILKSHAKE = fixture("olo-order-uber-milkshake.eml");
const TWO_PINTS = fixture("olo-order-doordash-two-pints.eml");
const PINT = fixture("olo-order-doordash-pint.eml");
const CAKE = fixture("olo-order-cake-DERIVED.eml");

/** Replace text that must be in the raw email exactly once. */
function swap(raw: string, from: string, to: string): string {
  assert.equal(raw.split(from).length, 2, `exactly one ${JSON.stringify(from)} in the email`);
  return raw.replace(from, to);
}

/** A fixture's head and its HTML, quoted-printable decoded: test setup, so a swap need not mind soft line breaks. */
function decoded(raw: string): { head: string; html: Buffer } {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split).replace(/^Content-(Type|Transfer-Encoding):.*\r\n/gim, "");
  const qp = raw.slice(split + 4);
  return { head, html: Buffer.from(qp.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1") };
}

/** The post for the derived cake order (fixtures/olo-order-cake-DERIVED.eml), read off the email by hand. */
const CAKE_POST = {
  kind: "cake_order",
  order: {
    key: "47729604891100001",
    customer: "Pat P. 0000C",
    pickupAt: "2026-11-05T20:00:00.000Z",
    pickupText: "Thursday, 11/5/2026 3:00 PM",
    cake: ['1 x Celebration Cake: No Allergy Concerns; Medium Round 8" (Serves 8-10); Cake Batter; Standard Frosting; Happy Birthday!'],
  },
};

test("the real Uber Eats milkshake order is read whole, and skipped as no cake", () => {
  assert.deepEqual(readOloOrder(MILKSHAKE), {
    kind: "order",
    order: {
      orderId: "47729604891115532",
      dueText: "Tuesday, 11/3/2026 5:53 PM",
      dueAt: "2026-11-03T22:53:00.000Z",
      handoffMode: "CounterPickup",
      customer: "Pat P. 0000C",
      paidBy: "Paid Via Uber Eats",
      items: [
        {
          quantity: 1,
          name: "Custom Milkshake (20oz)",
          modifiers: [
            { label: "Choose up to 2 Flavors", value: "2 x Milk & Cookies" },
            { label: "Do you want Whipped Cream?", value: "No, I do not want Whipped Cream." },
            { label: "Do you want a Straw?", value: "Yes, I would like a Straw." },
            { label: "Add-Ons", value: "Freshly Baked Brownie" },
          ],
        },
      ],
    },
  });
  assert.deepEqual(parseOloOrderEmail(MILKSHAKE), {
    kind: "not_cake",
    order: "47729604891115532",
    why: "no cake on it: 1 x Custom Milkshake (20oz) (Paid Via Uber Eats)",
  });
});

test("the real DoorDash pint orders are read, each item with its own flavours, and skipped as no cake", () => {
  const two = readOloOrder(TWO_PINTS);
  assert.equal(two.kind, "order");
  if (two.kind !== "order") return;
  assert.equal(two.order.dueAt, "2026-11-03T23:53:00.000Z");
  assert.equal(two.order.paidBy, "Paid by DoorDash");
  assert.deepEqual(
    two.order.items.map((i) => [i.quantity, i.name, i.modifiers.map((m) => m.value)]),
    [
      [1, "Fresh Packed Pint (16oz)", ["2 x Marshmallow Sky"]],
      [1, "Fresh Packed Pint (16oz)", ["2 x Chocolate PB Chunk"]],
    ],
  );
  assert.deepEqual(parseOloOrderEmail(TWO_PINTS), {
    kind: "not_cake",
    order: "47730533409587210",
    why: "no cake on it: 1 x Fresh Packed Pint (16oz), 1 x Fresh Packed Pint (16oz) (Paid by DoorDash)",
  });
  assert.deepEqual(parseOloOrderEmail(PINT), {
    kind: "not_cake",
    order: "47730730709549057",
    why: "no cake on it: 1 x Fresh Packed Pint (16oz) (Paid by DoorDash)",
  });
});

test("a cake order (derived from a real email, see its X-Fixture header) is a cake order with its options", () => {
  assert.match(CAKE, /^X-Fixture: DERIVED, NOT RECEIVED\./);
  assert.deepEqual(parseOloOrderEmail(CAKE), CAKE_POST);
});

test("a cake flavour or a cake add-on inside a milkshake does not make it a cake order", () => {
  const shake = swap(swap(MILKSHAKE, "Milk &amp; Cookies", "Birthday Cake"), "Freshly Baked Brownie", "Cake Batter");
  const read = readOloOrder(shake);
  assert.equal(read.kind, "order");
  if (read.kind === "order") assert.deepEqual(read.order.items[0].modifiers.map((m) => m.value).slice(0, 1), ["2 x Birthday Cake"]);
  assert.equal(parseOloOrderEmail(shake).kind, "not_cake");
});

test("a cake beside other items: only the cake is on the post", () => {
  // The derived cake's item row, copied in after the milkshake's last modifier row.
  const order = swap(MILKSHAKE, "<td>Freshly Baked Brownie</td>", "<td>Freshly Baked Brownie</td></tr><tr><td colspan=3D\"2\"><font>1 x Oh Bats! Cake</font></td><td>$0.00</td>");
  const parsed = parseOloOrderEmail(order);
  assert.equal(parsed.kind, "cake_order");
  if (parsed.kind === "cake_order") assert.deepEqual(parsed.order.cake, ["1 x Oh Bats! Cake"]);
});

test("every cake on the store's Olo menu is a cake, and nothing else on it is", () => {
  // order.benjerry.com/menu/upenn, every product, read 2026-11-03.
  const cakes = [
    "Small Half Baked Ice Cream Cake- Celebration Cake (Ready-Made)",
    "Medium Half Baked Ice Cream Cake- Celebration Cake (Ready-Made)",
    "Small Vanilla and Chocolate Ice Cream Cake- Celebration Cake (Ready-Made)",
    "Medium Vanilla and Chocolate Ice Cream Cake- Celebration Cake (Ready-Made)",
    "Celebration Cake",
    "Fudge Caramel Drizzle Cake",
    "Sprinkle Explosion Cake",
    "Groovy Tie-Dye Cake",
    "Sweet Cream & Cookies Cake",
    "Sprinkles Make My Day Cake",
    "Jack O’Lantern Cake",
    "Oh Bats! Cake",
    "Scary and Sweet Cake",
    "Tie Dye Cake",
    "The One With Confetti Cake",
    "Lucky Stars Cake",
    "Polka Dot Cake",
    "Cow-Spot Cake",
    "Custom Order Cake",
  ];
  const others = [
    "Small (2 scoops)",
    "Large (3 scoops)",
    "Custom Milkshake (20oz)",
    "Custom Ice Cream Sundae (2 scoops)",
    "Custom Cookie Sundae (2 scoops)",
    "Fresh Packed Pint (16oz)",
    "Fresh Packed Quart (32oz)",
    "Non-Dairy Small (2 scoops)",
    "Non-Dairy Large (3 scoops)",
    "Non-Dairy Fresh Packed Pint (16oz)",
    "Non-Dairy Fresh Packed Quart (32oz)",
    "Custom Non-Dairy Shake (20oz)",
    "Custom Non-Dairy Sundae (2 scoops)",
    "Sundae Party",
    "Yes, Please Add Complimentary Spoons and Napkins",
    "No Spoons or Napkins Needed",
  ];
  assert.deepEqual(cakes.filter((n) => !isCakeItem(n)), []);
  assert.deepEqual(others.filter((n) => isCakeItem(n)), []);
  // Cake words that are not a cake item.
  assert.deepEqual(["Cake Batter", "Birthday Cake Shake", "Cupcake", "Cake Batter Pint (16oz)"].filter((n) => isCakeItem(n)), []);
});

test("only Olo's email counts: matched on X-Original-Sender through the group, or From when sent direct", () => {
  const notOlo = swap(CAKE, "X-Original-Sender: orders@olo.com", "X-Original-Sender: someone@example.test");
  assert.deepEqual(parseOloOrderEmail(notOlo), { kind: "not_cake", why: "not an Olo order email" });
  const unrelated = "From: \"'Someone' via Admin\" <admin@example.test>\r\nX-Original-Sender: someone@example.test\r\nSubject: Order Notification\r\n\r\nA cake, I promise.\r\n";
  assert.deepEqual(parseOloOrderEmail(unrelated), { kind: "not_cake", why: "not an Olo order email" });

  // Sent straight to a mailbox, not through the group: no X-Original-Sender, Olo in From.
  const direct = swap(swap(CAKE, "X-Original-Sender: orders@olo.com\r\n", ""), `From: "'Ben & Jerry's' via Admin" <admin@example.test>`, "From: Ben & Jerry's <orders@olo.com>");
  assert.equal(parseOloOrderEmail(direct).kind, "cake_order");
});

test("an Olo email that is not a new order, or has no order id or no items, is unrecognised", () => {
  assert.deepEqual(parseOloOrderEmail(swap(CAKE, "Order Transmitted Notification", "Order Cancelled Notification")), {
    kind: "unrecognised",
    why: "an Olo email that is not a new order (Order Cancelled Notification)",
  });
  assert.deepEqual(parseOloOrderEmail(swap(MILKSHAKE, "<td>Order ID:</td>", "<td>Order:</td>")), {
    kind: "unrecognised",
    why: "an Olo order email with no order id",
  });
  assert.deepEqual(parseOloOrderEmail(swap(MILKSHAKE, "<br />1 x Custom Milkshake (20oz)", "<br />Custom Milkshake (20oz)")), {
    kind: "unrecognised",
    why: "Olo order 47729604891115532 lists no items",
  });
  assert.deepEqual(parseOloOrderEmail(swap(MILKSHAKE, "Content-Type: text/html", "Content-Type: text/plain")), {
    kind: "unrecognised",
    why: "an Olo email with no readable HTML part",
  });
});

test("the HTML is found inside a multipart email and in base64 too", () => {
  const { head, html } = decoded(CAKE);
  const multipart =
    `${head}\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n` +
    `--b1\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nOrder 1\r\n` +
    `--b1\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${html.toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n` +
    `--b1--\r\n`;
  assert.deepEqual(parseOloOrderEmail(multipart), CAKE_POST);
});

test("the due time is New York wall clock, either side of a daylight saving change", () => {
  const TIME_DUE = "<td>=\r\n3:00 PM</td>";
  const due = (date: string, time: string) => {
    // The time is split across a quoted-printable soft line break in the derived fixture's body.
    const read = readOloOrder(swap(swap(CAKE, "Thursday, 11/5/2026", date), TIME_DUE, `<td>${time}</td>`));
    return read.kind === "order" ? read.order.dueAt : read.kind;
  };
  assert.equal(due("Saturday, 3/7/2026", "3:00 PM"), "2026-03-07T20:00:00.000Z");
  assert.equal(due("Sunday, 3/8/2026", "3:00 PM"), "2026-03-08T19:00:00.000Z");
  assert.equal(due("Monday, 11/2/2026", "12:15 AM"), "2026-11-02T05:15:00.000Z");
  assert.equal(due("Monday, 11/2/2026", "12:15 PM"), "2026-11-02T17:15:00.000Z");
  assert.equal(due("Monday, 11/2/2026", "ASAP"), null);
});

test("the mailbox search is Olo's order subject, to the order address, in the last days", () => {
  assert.equal(orderMailQuery("orders@example.test", 2), 'to:orders@example.test subject:"Order Notification" newer_than:2d');
});
