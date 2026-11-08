// Referral Credits in the deal drawer (bj-finance #901, map #899).
//
// Words (Catering-Manager GLOSSARY.md): an Advocate is a person who sends us
// customers; a Referral Credit is a fixed dollar amount off an Advocate's own
// event, earned when a new customer they referred pays a deposit while an
// Offer runs.
//
// THE RULES ARE NOT HERE. They are SQL functions in Catering-Manager
// migrations/029_referral_credit.sql, called through PostgREST as the
// signed-in manager (RLS: managers only), so the drawer, the catering sweep
// and the SQL editor apply one set of rules:
//
//   referral_credit_check(deal)     would this deal earn a credit, and why not
//   referral_claim_add(...)         an Advocate's listing, or the customer
//                                   naming an Advocate; tags the Advocate
//   referral_claim_link(claim, deal) a pending listing is this customer
//   referral_credit_apply(credit, deal, actor) / referral_credit_unapply
//
// A deal turning paid earns its credit through the trigger on deals, so the
// card's deposit pill and the drawer's Payment status earn it with no call
// from here. Everything is stored in the database; nothing in the browser.
//
// This file holds the pure half (what the panel says and offers, tested in
// tests/referralCredit.test.ts) and thin wrappers over those calls.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isTerminal } from "@/lib/stages";
import type { Deal } from "@/lib/types";

export const REFERRAL_CREDIT_LINE = "Referral Credit";

/** referral_credit_check's verdicts. */
export type Verdict =
  | "earned_already"
  | "no_advocate"
  | "self_referral"
  | "no_email"
  | "not_paid"
  | "late"
  | "returning"
  | "listed_after_enquiry"
  | "earns";

export type Check = {
  verdict: Verdict;
  advocate_id: number | null;
  amount: number;
  expires_on: string;
  deposit_paid_at: string | null;
};

export type Advocate = { id: number; name: string; email: string };

export type Claim = {
  id: number;
  advocate_id: number;
  referred_name: string;
  referred_email: string | null;
  named_by: "advocate" | "customer";
  claimed_at: string;
  deal_id: number | null;
  advocates: { name: string; email: string } | null;
};

export type Credit = {
  id: number;
  advocate_id: number;
  earned_from_deal_id: number;
  amount: number;
  expires_on: string;
  status: "open" | "used" | "expired";
  used_on_deal_id: number | null;
};

export type Balance = {
  advocate_id: number;
  name: string;
  email: string;
  open_count: number;
  open_amount: number;
  used_amount: number;
  expired_amount: number;
  pending_count: number;
};

export type PanelData = {
  check: Check;
  /** Claims on this deal (the Advocate it is credited to is one of them). */
  claims: Claim[];
  /** Pending listings that may be this customer, for a person to confirm. */
  suggestions: Claim[];
  /** This deal's contact as an Advocate, or null if they have referred no one. */
  advocate: Balance | null;
  credits: Credit[];
  /** Pending listings this Advocate made. */
  listed: Claim[];
};

export type PanelLoad =
  | { state: "ready"; data: PanelData }
  | { state: "not_set_up" }
  | { state: "error"; message: string };

type PgError = { code?: string; message: string } | null;

/** The tables or functions of migration 029 are missing. */
export function isNotSetUp(error: PgError): boolean {
  if (!error) return false;
  // 42P01 undefined table, 42883 undefined function (Postgres);
  // PGRST202 function and PGRST205 table not in PostgREST's schema cache.
  return ["42P01", "42883", "PGRST202", "PGRST205"].includes(error.code ?? "");
}

export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

export function money(n: number): string {
  return `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;
}

/** "Dec 31, 2027" from "2027-12-31". */
export function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

/** What the check means, in plain words for whoever is quoting. */
export function verdictText(check: Check, advocateName: string | null): string {
  const who = advocateName ?? "the Advocate";
  const amount = money(check.amount);
  switch (check.verdict) {
    case "earned_already":
      return `${who} earned a ${amount} Referral Credit for this booking.`;
    case "earns":
      return `${who} has a ${amount} Referral Credit for this booking that is not recorded yet.`;
    case "not_paid":
      return `${who} earns a ${amount} Referral Credit once this deposit is paid, by Dec 31, 2026.`;
    case "late":
      return `No Referral Credit: the deposit was paid after Dec 31, 2026.`;
    case "returning":
      return `No Referral Credit: this customer had booked or asked about an event with us before.`;
    case "listed_after_enquiry":
      return `No Referral Credit yet: ${who} listed this customer after they had already contacted us. If the customer names ${who}, record that below.`;
    case "self_referral":
      return `No Referral Credit: an Advocate cannot refer their own event.`;
    case "no_email":
      return `No Referral Credit yet: add the customer's email so we can check they are new.`;
    case "no_advocate":
      return "No Advocate on this deal.";
  }
}

/** Pending listings that may be this deal's customer: the same email, or a
 *  listed name holding the contact's last name (and first name, if any). */
export function likelyMatches(pending: Claim[], deal: Deal): Claim[] {
  const email = normalizeEmail(deal.contact_email);
  const first = (deal.contact_first_name ?? "").trim().toLowerCase();
  const last = (deal.contact_last_name ?? "").trim().toLowerCase();
  return pending.filter((c) => {
    if (c.deal_id !== null) return false;
    if (email && c.referred_email === email) return true;
    const name = c.referred_name.toLowerCase();
    return last !== "" && name.includes(last) && (first === "" || name.includes(first));
  });
}

/** The deal's customer as a referral names them: the contact's name, else
 *  the company, else "" when the deal has neither. */
export function customerName(deal: Deal): string {
  return (
    [deal.contact_first_name, deal.contact_last_name].filter(Boolean).join(" ") ||
    deal.company ||
    ""
  );
}

/** A credit can go on this deal: not at a terminal stage, not paid in
 *  full. The database refuses the rest (referral_credit_apply). */
export function canTakeCredit(deal: Deal): boolean {
  return !isTerminal(deal.stage) && deal.payment_status !== "Paid in Full";
}

export type CreditRow = {
  credit: Credit;
  /** What the row says about the credit. */
  label: string;
  canApply: boolean;
  canUndo: boolean;
};

/** One row per credit, as the panel lists them for `deal`, the Advocate's own. */
export function creditRows(credits: Credit[], deal: Deal, todayYmd: string): CreditRow[] {
  const takes = canTakeCredit(deal);
  return credits.map((credit) => {
    const pastDate = credit.expires_on.slice(0, 10) < todayYmd;
    const from = `from deal #${credit.earned_from_deal_id}`;
    if (credit.status === "used") {
      const here = credit.used_on_deal_id === deal.id;
      return {
        credit,
        label: here
          ? `${money(credit.amount)} ${from}, used on this event`
          : `${money(credit.amount)} ${from}, used on deal #${credit.used_on_deal_id}`,
        canApply: false,
        canUndo: here,
      };
    }
    if (credit.status === "expired" || pastDate) {
      return {
        credit,
        label: `${money(credit.amount)} ${from}, expired ${fmtDay(credit.expires_on)}`,
        canApply: false,
        canUndo: false,
      };
    }
    return {
      credit,
      label: `${money(credit.amount)} ${from}, good through ${fmtDay(credit.expires_on)}`,
      canApply: takes,
      canUndo: false,
    };
  });
}

/** The panel's headline for an Advocate. */
export function balanceText(b: Balance): string {
  const parts = [
    `${money(b.open_amount)} open (${b.open_count} ${b.open_count === 1 ? "credit" : "credits"})`,
  ];
  if (Number(b.used_amount) > 0) parts.push(`${money(b.used_amount)} used`);
  if (Number(b.expired_amount) > 0) parts.push(`${money(b.expired_amount)} expired`);
  return parts.join(" · ");
}

/** "2026-11-17" (a date picked in the drawer) as noon Eastern, which
 *  Postgres reads with the zone name. Listings are ordered by this time. */
export function claimedAtFromDay(ymd: string): string {
  return `${ymd} 12:00 America/New_York`;
}

// ---------------------------------------------------------------------------
// Reads and writes. Each runs as the signed-in manager.
// ---------------------------------------------------------------------------

const CLAIM_COLUMNS =
  "id, advocate_id, referred_name, referred_email, named_by, claimed_at, deal_id, advocates(name, email)";

export async function loadPanel(supabase: SupabaseClient, deal: Deal): Promise<PanelLoad> {
  const check = await supabase.rpc("referral_credit_check", { p_deal_id: deal.id });
  if (check.error) return failed(check.error);

  const claims = await supabase
    .from("referral_claims")
    .select(CLAIM_COLUMNS)
    .or(`deal_id.eq.${deal.id},deal_id.is.null`)
    .order("claimed_at");
  if (claims.error) return failed(claims.error);
  const all = (claims.data ?? []) as unknown as Claim[];
  const onDeal = all.filter((c) => c.deal_id === deal.id);
  const pending = all.filter((c) => c.deal_id === null);

  let advocate: Balance | null = null;
  let credits: Credit[] = [];
  const email = normalizeEmail(deal.contact_email);
  if (email) {
    const bal = await supabase
      .from("referral_credit_balances")
      .select("*")
      .eq("email", email)
      .maybeSingle();
    if (bal.error) return failed(bal.error);
    advocate = (bal.data as Balance | null) ?? null;
    if (advocate) {
      const cr = await supabase
        .from("referral_credits")
        .select("id, advocate_id, earned_from_deal_id, amount, expires_on, status, used_on_deal_id")
        .eq("advocate_id", advocate.advocate_id)
        .order("id");
      if (cr.error) return failed(cr.error);
      credits = (cr.data ?? []) as Credit[];
    }
  }

  return {
    state: "ready",
    data: {
      check: check.data as Check,
      claims: onDeal,
      suggestions: onDeal.length ? [] : likelyMatches(pending, deal),
      advocate,
      credits,
      listed: advocate ? pending.filter((c) => c.advocate_id === advocate!.advocate_id) : [],
    },
  };
}

function failed(error: { code?: string; message: string }): PanelLoad {
  return isNotSetUp(error) ? { state: "not_set_up" } : { state: "error", message: error.message };
}

async function actor(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return `crm:${user?.email ?? "unknown"}`;
}

type Result = { error: string | null };

function result(error: PgError): Result {
  return { error: error ? error.message : null };
}

/** The customer named an Advocate while being quoted. */
export async function recordCustomerNamed(
  supabase: SupabaseClient,
  deal: Deal,
  advocateName: string,
  advocateEmail: string,
): Promise<Result> {
  const customer = customerName(deal) || `deal #${deal.id}`;
  const { error } = await supabase.rpc("referral_claim_add", {
    p_advocate_name: advocateName.trim(),
    p_advocate_email: normalizeEmail(advocateEmail),
    p_referred_name: customer,
    p_referred_email: normalizeEmail(deal.contact_email) || null,
    p_named_by: "customer",
    p_deal_id: deal.id,
    p_actor: await actor(supabase),
  });
  return result(error);
}

/** An Advocate listed someone by reply, before that person booked. */
export async function recordListing(
  supabase: SupabaseClient,
  advocate: { name: string; email: string },
  referred: { name: string; email: string },
  replyDay: string,
): Promise<Result> {
  const { error } = await supabase.rpc("referral_claim_add", {
    p_advocate_name: advocate.name.trim(),
    p_advocate_email: normalizeEmail(advocate.email),
    p_referred_name: referred.name.trim(),
    p_referred_email: normalizeEmail(referred.email) || null,
    p_named_by: "advocate",
    p_deal_id: null,
    p_actor: await actor(supabase),
    p_claimed_at: claimedAtFromDay(replyDay),
  });
  return result(error);
}

export async function linkListing(
  supabase: SupabaseClient,
  claimId: number,
  dealId: number,
): Promise<Result> {
  const { error } = await supabase.rpc("referral_claim_link", {
    p_claim_id: claimId,
    p_deal_id: dealId,
  });
  return result(error);
}

/** Mark an open credit used on this deal. The quote does not take it off by
 *  itself yet: see APPLY_NOTE. */
export async function applyCredit(
  supabase: SupabaseClient,
  creditId: number,
  dealId: number,
): Promise<Result> {
  const { error } = await supabase.rpc("referral_credit_apply", {
    p_credit_id: creditId,
    p_deal_id: dealId,
    p_actor: await actor(supabase),
  });
  return result(error);
}

/** Record a credit the check says is due (the trigger normally does this the
 *  moment the deposit is marked paid; the catering sweep is the backstop). */
export async function confirmCredit(supabase: SupabaseClient, dealId: number): Promise<Result> {
  const { error } = await supabase.rpc("referral_credit_confirm", { p_deal_id: dealId });
  return result(error);
}

export async function unapplyCredit(supabase: SupabaseClient, creditId: number): Promise<Result> {
  const { error } = await supabase.rpc("referral_credit_unapply", { p_credit_id: creditId });
  return result(error);
}

// TODO(bj-finance #900): once quotes print named discount lines, the quote
// worker takes each credit used on the deal as a "Referral Credit" line
// (Catering-Manager modules/referral_credit.quote_lines) and this note goes.
export const APPLY_NOTE =
  "Marked used on this event. The quote does not take it off by itself yet: take $100 off the quote by hand for each Referral Credit used.";
