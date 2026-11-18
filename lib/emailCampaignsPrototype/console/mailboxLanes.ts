// Which lane a mailbox belongs to: the one place the console decides it.
//
// Two different questions, so two functions:
//   handLane:  which lane a sending domain serves on the mailbox panels. Every
//              benjerryphilly domain is warm (the news mailboxes and the
//              hand-run benjerryphilly.com one); any other domain is cold.
//   loopLane:  which mailboxes the weekly loop's sender sends from, mirrored
//              from Catering-Manager sales/loop/sender.py (WARM_DOMAIN) and
//              apollo_send.py (COLD_DOMAIN, OWNER): warm is news.benjerryphilly.com
//              only; cold is phillyicecreamcatering.com without the owner's
//              mailbox, which the loop never sends from. Anything else is not
//              loop room.

export const LOOP_WARM_DOMAIN = "news.benjerryphilly.com";
export const LOOP_COLD_DOMAIN = "phillyicecreamcatering.com";
export const LOOP_COLD_OWNER = `alina@${LOOP_COLD_DOMAIN}`;

export function handLane(domain: string): "warm" | "cold" {
  return domain.toLowerCase().includes("benjerryphilly") ? "warm" : "cold";
}

export function loopLane(address: string): "warm" | "cold" | null {
  const a = address.trim().toLowerCase();
  if (a.endsWith(`@${LOOP_WARM_DOMAIN}`)) return "warm";
  if (a.endsWith(`@${LOOP_COLD_DOMAIN}`) && a !== LOOP_COLD_OWNER) return "cold";
  return null;
}
