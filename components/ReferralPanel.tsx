"use client";

// Referrals section of the deal drawer (bj-finance #901). Who referred this
// customer, and this customer's own Referral Credits if they are an Advocate.
// Every rule and every write is in the database (lib/referralCredit.ts says
// which function does what); this component only shows and asks.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Deal } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { easternTodayYmd } from "@/lib/dateFormat";
import {
  APPLY_NOTE,
  applyCredit,
  balanceText,
  confirmCredit,
  creditRows,
  customerName,
  fmtDay,
  isEmail,
  linkListing,
  loadPanel,
  recordCustomerNamed,
  recordListing,
  unapplyCredit,
  verdictText,
  type PanelData,
  type PanelLoad,
} from "@/lib/referralCredit";

const INPUT =
  "w-full text-sm bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1.5 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-500";
const BUTTON =
  "text-xs bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 rounded px-3 py-1.5 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
const LINK_BUTTON =
  "text-[11px] text-sky-300 underline underline-offset-2 hover:text-sky-200 disabled:opacity-40";

export default function ReferralPanel({
  deal,
  onNamedDiscountsChanged,
}: {
  deal: Deal;
  // Called after "Use on this event" or "Undo" succeeds: both rewrite
  // deals.named_discounts in the database, so the drawer reloads it.
  onNamedDiscountsChanged?: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [load, setLoad] = useState<PanelLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad(await loadPanel(supabase, deal));
  }, [supabase, deal]);

  // Reload when the deal's payment or contact changes: a deposit marked paid
  // earns the credit in the database, and the panel should show it.
  useEffect(() => {
    void refresh();
  }, [refresh, deal.payment_status, deal.contact_email]);

  async function run(
    action: () => Promise<{ error: string | null }>,
    done?: string,
    afterSuccess?: () => void,
  ) {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error: err } = await action();
    if (err) setError(err);
    else {
      if (done) setNote(done);
      afterSuccess?.();
    }
    await refresh();
    setBusy(false);
  }

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
        Referrals
      </h3>
      <ReferralBody
        deal={deal}
        load={load}
        busy={busy}
        error={error}
        note={note}
        onCustomerNamed={(name, email) =>
          run(() => recordCustomerNamed(supabase, deal, name, email))
        }
        onLink={(claimId) => run(() => linkListing(supabase, claimId, deal.id))}
        onConfirm={() => run(() => confirmCredit(supabase, deal.id))}
        onListing={(adv, referred, day) => run(() => recordListing(supabase, adv, referred, day))}
        onApply={(creditId) =>
          run(() => applyCredit(supabase, creditId, deal.id), APPLY_NOTE, onNamedDiscountsChanged)
        }
        onUndo={(creditId) =>
          run(() => unapplyCredit(supabase, creditId), undefined, onNamedDiscountsChanged)
        }
      />
    </section>
  );
}

type BodyProps = {
  deal: Deal;
  load: PanelLoad | null;
  busy: boolean;
  error: string | null;
  note: string | null;
  onCustomerNamed: (name: string, email: string) => void;
  onLink: (claimId: number) => void;
  onConfirm: () => void;
  onListing: (
    advocate: { name: string; email: string },
    referred: { name: string; email: string },
    replyDay: string,
  ) => void;
  onApply: (creditId: number) => void;
  onUndo: (creditId: number) => void;
};

/** Everything the panel draws, from what was loaded. Exported for tests. */
export function ReferralBody(props: BodyProps) {
  const { load, error, note } = props;
  if (!load) return <div className="text-[11px] text-slate-500">Loading…</div>;
  if (load.state === "not_set_up")
    return (
      <div className="text-[11px] text-slate-500">
        Referral Credits are not set up in the database yet.
      </div>
    );
  if (load.state === "error")
    return <div className="text-xs text-rose-300">Could not load referrals: {load.message}</div>;
  return (
    <div className="space-y-3">
      <ReferredBy {...props} data={load.data} />
      <AsAdvocate {...props} data={load.data} />
      {error && <div className="text-xs text-rose-300">{error}</div>}
      {note && <div className="text-xs text-amber-300">{note}</div>}
    </div>
  );
}

function ReferredBy({
  deal,
  data,
  busy,
  onCustomerNamed,
  onLink,
  onConfirm,
}: BodyProps & { data: PanelData }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const winner = data.claims.find((c) => c.advocate_id === data.check.advocate_id);
  const advocateName = winner?.advocates?.name ?? null;
  const ok = name.trim() !== "" && isEmail(email);

  return (
    <div className="bg-slate-800/40 rounded p-3 border border-slate-800 space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">Referred by</div>
      <div className="text-sm text-slate-200">
        {advocateName ? (
          <span>
            {advocateName}{" "}
            <span className="text-slate-500">
              ({winner?.named_by === "customer" ? "the customer named them" : "they listed this customer"})
            </span>
          </span>
        ) : (
          <span className="text-slate-500">No Advocate yet.</span>
        )}
      </div>
      {data.check.advocate_id !== null && (
        <div className="text-xs text-slate-300">{verdictText(data.check, advocateName)}</div>
      )}
      {data.check.verdict === "earns" && (
        <button type="button" className={BUTTON} disabled={busy} onClick={onConfirm}>
          Record the Referral Credit
        </button>
      )}
      {data.claims.length > 1 && (
        <ul className="text-[11px] text-slate-500 space-y-0.5">
          {data.claims.map((c) => (
            <li key={c.id}>
              {c.advocates?.name} {c.named_by === "customer" ? "named by the customer" : "listed them"}{" "}
              on {fmtDay(c.claimed_at)}
            </li>
          ))}
        </ul>
      )}
      {data.suggestions.map((c) => (
        <div key={c.id} className="flex items-center justify-between gap-2 text-xs text-slate-300">
          <span>
            {c.advocates?.name} listed “{c.referred_name}”
            {c.referred_email ? ` (${c.referred_email})` : ""} on {fmtDay(c.claimed_at)}.
          </span>
          <button type="button" className={LINK_BUTTON} disabled={busy} onClick={() => onLink(c.id)}>
            This is them
          </button>
        </div>
      ))}
      <div className="pt-1 space-y-1.5">
        <div className="text-[11px] text-slate-500">
          The customer says someone sent them? Enter that person:
        </div>
        <input className={INPUT} placeholder="Their name" value={name}
               onChange={(e) => setName(e.target.value)} />
        <input className={INPUT} type="email" placeholder="Their email" value={email}
               onChange={(e) => setEmail(e.target.value)} />
        <div className="flex justify-end">
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !ok}
            onClick={() => {
              onCustomerNamed(name, email);
              setName("");
              setEmail("");
            }}
          >
            Save who referred them
          </button>
        </div>
      </div>
      {!deal.contact_email && (
        <div className="text-[11px] text-amber-300">
          Add the customer&apos;s email: a Referral Credit needs it to check they are new.
        </div>
      )}
    </div>
  );
}

function AsAdvocate({
  deal,
  data,
  busy,
  onListing,
  onApply,
  onUndo,
}: BodyProps & { data: PanelData }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [day, setDay] = useState(easternTodayYmd());
  const rows = creditRows(data.credits, deal, easternTodayYmd());
  const self = { name: customerName(deal), email: deal.contact_email ?? "" };
  const canList = self.name !== "" && isEmail(self.email);
  const ok = canList && name.trim() !== "" && (email.trim() === "" || isEmail(email)) && day !== "";

  return (
    <div className="bg-slate-800/40 rounded p-3 border border-slate-800 space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">
        This customer&apos;s Referral Credits
      </div>
      {data.advocate ? (
        <div className="text-sm text-slate-200">{balanceText(data.advocate)}</div>
      ) : (
        <div className="text-xs text-slate-500">None. They have not referred anyone yet.</div>
      )}
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.credit.id} className="flex items-center justify-between gap-2 text-xs text-slate-300">
              <span>{r.label}</span>
              {r.canApply && (
                <button type="button" className={BUTTON} disabled={busy}
                        onClick={() => onApply(r.credit.id)}>
                  Use on this event
                </button>
              )}
              {r.canUndo && (
                <button type="button" className={LINK_BUTTON} disabled={busy}
                        onClick={() => onUndo(r.credit.id)}>
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.listed.length > 0 && (
        <div>
          <div className="text-[11px] text-slate-500">Listed, not booked yet:</div>
          <ul className="text-xs text-slate-300 space-y-0.5">
            {data.listed.map((c) => (
              <li key={c.id}>
                {c.referred_name}
                {c.referred_email ? ` (${c.referred_email})` : ""}, listed {fmtDay(c.claimed_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="pt-1 space-y-1.5">
        <div className="text-[11px] text-slate-500">
          They replied with someone they are sending us? Add each person:
        </div>
        <input className={INPUT} placeholder="Name" value={name}
               onChange={(e) => setName(e.target.value)} disabled={!canList} />
        <input className={INPUT} type="email" placeholder="Email, if they gave one" value={email}
               onChange={(e) => setEmail(e.target.value)} disabled={!canList} />
        <label className="flex items-center gap-2 text-[11px] text-slate-500">
          Date of their reply
          <input className={INPUT} type="date" value={day}
                 onChange={(e) => setDay(e.target.value)} disabled={!canList} />
        </label>
        <div className="flex justify-end">
          <button
            type="button"
            className={BUTTON}
            disabled={busy || !ok}
            onClick={() => {
              onListing(self, { name, email }, day);
              setName("");
              setEmail("");
            }}
          >
            Add to their referrals
          </button>
        </div>
        {!canList && (
          <div className="text-[11px] text-amber-300">
            This deal needs the customer&apos;s name and email before they can refer anyone.
          </div>
        )}
      </div>
    </div>
  );
}
