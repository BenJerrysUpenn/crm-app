// PROTOTYPE (bj-finance #811), throwaway. A SYNTHETIC fixture in the same
// shapes the loaders return, for local dev and screenshots only (the page
// uses it when NODE_ENV is development and CONSOLE_PROTO_SYNTHETIC=1). Every
// person is invented ("Example 001", p001@example.com). The mailbox roster is
// the business's own seven sending mailboxes, as in outreach_mailboxes.

import type { DealRow, ProspectRow, RawData, SentRow } from "../model";
import type { ConsoleExtras, MailboxFull, OutcomeEvent, SendEvent } from "./load";
import { WARM_TEMPLATE_KEY, WARM_COORDINATOR_TEMPLATE_KEY } from "../sequences";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DAY = 86_400_000;

export function syntheticData(now: Date): { raw: RawData; extras: ConsoleExtras } {
  const r = rng(811);
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const naive = (msAgo: number) => iso(msAgo).slice(0, 19);

  const mailboxes: MailboxFull[] = [
    { address: "catering@benjerryphilly.com", daily_allowance: 3, frozen: false, frozen_reason: null, frozen_at: null, unverified_ration: 1, unverified_ration_at: iso(9 * DAY), allowance_ceiling: 3, wedding_daily_allowance: null },
    ...["jacob", "jake", "jakob"].map((n) => ({
      address: `${n}@news.benjerryphilly.com`, daily_allowance: 7, frozen: false, frozen_reason: null, frozen_at: null,
      unverified_ration: 0, unverified_ration_at: null, allowance_ceiling: 33, wedding_daily_allowance: 40,
    })),
    ...["alana", "alina", "anastasia"].map((n, i) => ({
      address: `${n}@phillyicecreamcatering.com`, daily_allowance: i === 1 ? 30 : 15, frozen: true,
      frozen_reason: `governor: hard bounces ${2 + i} of ${40 + 20 * i} over 2.0% over 14d (synthetic)`,
      frozen_at: iso((6 + (i % 2)) * DAY), unverified_ration: null, unverified_ration_at: null, allowance_ceiling: null, wedding_daily_allowance: null,
    })),
  ];

  const prospects: ProspectRow[] = [];
  const add = (engine: string, extra: Partial<ProspectRow>) => {
    const id = prospects.length + 1;
    const tag = String(id).padStart(3, "0");
    prospects.push({
      id, name: `Example ${tag}`, company: null, email: `p${tag}@example.com`, status: "queued", engine,
      category: null, ever_booked: false, last_event_date: null, marketing_opt_in: false, opt_in_source: null,
      last_outreach_at: null, verify_status: "valid", event_date: null, archived_at: null, ...extra,
    });
    return prospects[prospects.length - 1];
  };
  for (let i = 0; i < 320; i++) add("warm", {});
  for (let i = 0; i < 30; i++) add("warm", { ever_booked: true, last_event_date: "2024-06-01" });
  for (let i = 0; i < 40; i++) add("warm", { marketing_opt_in: true, opt_in_source: "signup_form" });
  for (let i = 0; i < 62; i++) add("warm", { category: "wedding", event_date: "2027-06-12" });
  for (let i = 0; i < 220; i++) add("cold", { category: ["office_manager", "hr_people_ops", "law_admin"][i % 3] });

  const sent: SentRow[] = [];
  const sends: SendEvent[] = [];
  let eid = 1;
  const news = mailboxes.slice(1, 4).map((m) => m.address);
  const send = (p: ProspectRow, template: string, msAgo: number, mailbox: string) => {
    const at = iso(msAgo);
    sent.push({ prospect_id: p.id, template, sent_at: at, tracking_id: null });
    sends.push({ id: eid++, prospect_id: p.id, at, mailbox, template, apollo: false });
    p.last_outreach_at = at;
  };
  // Warm: 110 had the warm email over the last 3 weeks (coordinator copy from news.*).
  prospects.filter((p) => p.engine === "warm" && !p.category).slice(0, 110).forEach((p, i) => {
    const daysAgo = i % 21;
    const mb = i % 5 === 0 ? "catering@benjerryphilly.com" : news[i % 3];
    send(p, mb.startsWith("catering@") ? WARM_TEMPLATE_KEY : WARM_COORDINATOR_TEMPLATE_KEY, daysAgo * DAY + 3_600_000 * (1 + r() * 5), mb);
  });
  // Wedding: 57 had touch 1 between 2 and 12 days ago, plus today's batch.
  prospects.filter((p) => p.category === "wedding").slice(0, 57).forEach((p, i) => {
    const daysAgo = i < 9 ? 0 : 2 + (i % 11);
    send(p, "wedding_expo_v2", daysAgo * DAY + (i < 9 ? 600_000 * (i + 1) : 3_600_000 * 2), news[i % 3]);
  });
  // Cold: Apollo enrolments only (no sends stored).
  prospects.filter((p) => p.engine === "cold").slice(0, 120).forEach((p, i) => {
    const mb = mailboxes[4 + (i % 3)].address;
    sends.push({ id: eid++, prospect_id: p.id, at: iso((8 + (i % 5)) * DAY), mailbox: mb, template: null, apollo: true });
    p.last_outreach_at = iso((8 + (i % 5)) * DAY);
  });

  const outcomes: OutcomeEvent[] = [];
  const warmSent = prospects.filter((p) => p.engine === "warm" && !p.category && p.last_outreach_at);
  [3, 17, 40].forEach((k, i) => {
    const p = warmSent[k];
    const at = iso((2 + i * 5) * DAY);
    outcomes.push({ id: eid++, prospect_id: p.id, event: "replied", at, mailbox: null });
    outcomes.push({ id: eid++, prospect_id: p.id, event: "handed_off", at: iso((2 + i * 5) * DAY - 3_600_000), mailbox: null });
  });
  const wedSent = prospects.filter((p) => p.category === "wedding" && p.last_outreach_at);
  outcomes.push({ id: eid++, prospect_id: wedSent[20].id, event: "replied", at: iso(4 * DAY), mailbox: null });
  outcomes.push({ id: eid++, prospect_id: wedSent[20].id, event: "handed_off", at: iso(4 * DAY - 7_200_000), mailbox: null });
  outcomes.push({ id: eid++, prospect_id: wedSent[30].id, event: "bounced", at: iso(3_600_000), mailbox: news[1] });

  const deals: DealRow[] = [
    { contact_email: wedSent[20].email, event_type: "Wedding", stage: "Sent Quote", event_date: "2027-06-12", created_at: naive(3 * DAY), last_outbound_at: null, source: "email" },
    { contact_email: warmSent[3].email, event_type: "Employee appreciation", stage: "Booked Paid", event_date: "2026-12-10", created_at: naive(1 * DAY), last_outbound_at: null, source: "email" },
    { contact_email: warmSent[17].email, event_type: "Holiday party", stage: "Sent Quote", event_date: "2026-12-12", created_at: naive(12 * DAY), last_outbound_at: null, source: "email" },
    { contact_email: "walkin@example.com", event_type: "Birthday", stage: "Booked Unpaid", event_date: "2026-11-20", created_at: naive(2 * DAY), last_outbound_at: null, source: "web" },
  ];

  return {
    raw: {
      prospects,
      deals,
      sent,
      hits: [],
      suppressedEmails: [],
      blockedDomains: ["yahoo.com", "outlook.com"],
      mailboxes: mailboxes.map(({ address, daily_allowance, frozen }) => ({ address, daily_allowance, frozen })),
    },
    extras: { mailboxes, sends, outcomes },
  };
}
