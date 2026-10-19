// One save at a time per saved view (bj-finance #696).
//
// Every change on the Metrics board (a period, a stream, a week range, a move)
// sends the view's whole widget list. Sent side by side, two quick changes can
// land out of order and leave the older one saved: pick a start week then an
// end week, and the view keeps only the start. So a view's saves go one after
// another: while one is on its way, later changes wait, and changes that pile
// up while waiting go as a single save (the later field wins). The last choice
// is always the last thing saved.
//
// Pure: no React, no fetch. The board hands it the store call that sends.

export type Send<P, R> = (key: string, patch: P) => Promise<R>;

type Waiter<R> = { resolve: (r: R) => void; reject: (e: unknown) => void };
type Lane<P, R> = { busy: boolean; next: { patch: P; waiters: Waiter<R>[] } | null };

/**
 * A save function that sends one patch per key at a time, in the order asked,
 * folding patches that queue up behind a save into one (later fields over
 * earlier ones: what the PATCH bodies add up to). Each caller's promise
 * settles with the save that carried its patch.
 */
export function serialSaves<P extends object, R>(send: Send<P, R>): Send<P, R> {
  const lanes = new Map<string, Lane<P, R>>();

  function run(key: string, lane: Lane<P, R>) {
    const job = lane.next;
    if (!job) {
      lane.busy = false;
      lanes.delete(key);
      return;
    }
    lane.next = null;
    lane.busy = true;
    let sent: Promise<R>;
    try {
      sent = send(key, job.patch);
    } catch (e) {
      sent = Promise.reject(e);
    }
    sent.then(
      (r) => job.waiters.forEach((w) => w.resolve(r)),
      (e) => job.waiters.forEach((w) => w.reject(e)),
    ).finally(() => run(key, lane));
  }

  return (key, patch) =>
    new Promise<R>((resolve, reject) => {
      let lane = lanes.get(key);
      if (!lane) {
        lane = { busy: false, next: null };
        lanes.set(key, lane);
      }
      const waiter = { resolve, reject };
      lane.next = lane.next
        ? { patch: { ...lane.next.patch, ...patch }, waiters: [...lane.next.waiters, waiter] }
        : { patch, waiters: [waiter] };
      if (!lane.busy) run(key, lane);
    });
}
