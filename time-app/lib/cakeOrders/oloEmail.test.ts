// Reading Olo's per-order email (lib/cakeOrders/oloEmail.ts). No real Olo
// order email had arrived when this was written (crm-app #142), so the parser
// is not built: these tests pin that it recognises nothing yet, so the job
// cannot post an order it guessed at, and hold the place of the real test.
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Olo from "./oloEmail.ts";

const olo = await loadAppModule<typeof Olo>("lib/cakeOrders/oloEmail.ts");

test("until it is built from a real email, the parser recognises nothing and says why", () => {
  assert.equal(olo.PARSER_READY, false);
  const raw = "From: someone@example.test\r\nSubject: Order 1234\r\n\r\nA cake, I promise.\r\n";
  assert.deepEqual(olo.parseOloOrderEmail(raw), { kind: "unrecognised", why: olo.WAITING_NOTE });
});

test("the mailbox search is mail to the order address in the last days", () => {
  assert.equal(olo.orderMailQuery("orders@example.test", 2), "to:orders@example.test newer_than:2d");
});

test(
  "parses the first real Olo cake order email (raw-bytes fixture in fixtures/)",
  { todo: "waiting on the first real Olo order email to the order address (crm-app #142); see TO BUILD IT in oloEmail.ts" },
  () => {},
);

test(
  "a marketplace order (DoorDash and the others Olo routes) and a non-cake Olo order are not cake orders",
  { todo: "waiting on real Olo order emails of those kinds (crm-app #142)" },
  () => {},
);
