// Named discount lines on a quote: Holiday Gift and Referral Credit
// (bj-finance #900, rulings in #899, 2026-11-07).
//
// An Offer's discount carries its name on the quote so redemptions can be
// counted from quotes. The deal stores the lines in deals.named_discounts
// (Catering-Manager migration 028), a JSON array, one object per line:
//
//   [{"name": "Holiday Gift", "amount": 100},
//    {"name": "Referral Credit", "amount": 100}]
//
// A Referral Credit is one object per credit. The quote job
// (Catering-Manager modules/quote.py named_discount_lines) takes them off the
// ice cream, so the taxable subtotal and the tax fall, and prints the names
// as the discount line's label; discountLineLabel below mirrors its label so
// the drawer shows what the quote will say. Both are $100 by the ruling.

export const NAMED_DISCOUNTS = ["Holiday Gift", "Referral Credit"] as const;
export type NamedDiscountName = (typeof NAMED_DISCOUNTS)[number];
export type NamedDiscount = { name: NamedDiscountName; amount: number };

// Each Holiday Gift and each Referral Credit is $100 off (#899).
export const NAMED_DISCOUNT_AMOUNT = 100;

// The quote's discount line label when no named line is on it.
const DISCOUNT_LINE_LABEL = "Discounts or Additional Fees";

function isName(value: unknown): value is NamedDiscountName {
  return (NAMED_DISCOUNTS as readonly unknown[]).includes(value);
}

/** The deal's stored lines. A string is parsed; anything that is not a line
 * with one of the two names and a positive amount is left out, as the quote
 * job would refuse it. */
export function namedDiscountLines(value: unknown): NamedDiscount[] {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const name = item?.name;
    const amount = Number(item?.amount);
    return isName(name) && amount > 0 ? [{ name, amount }] : [];
  });
}

/** The quote's discount line label: the names in the order added, a repeat
 * counted ("Holiday Gift + Referral Credit x2"), and DISCOUNT_LINE_LABEL after
 * them when the line also nets the short-notice surcharge field. */
export function discountLineLabel(lines: NamedDiscount[], otherAdjustment: boolean): string {
  if (lines.length === 0) return DISCOUNT_LINE_LABEL;
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.name, (counts.get(line.name) ?? 0) + 1);
  const parts = [...counts].map(([name, n]) => (n === 1 ? name : `${name} x${n}`));
  if (otherAdjustment) parts.push(DISCOUNT_LINE_LABEL);
  return parts.join(" + ");
}

/** The lines with one more $100 line of `name` at the end. */
export function addNamedDiscount(lines: NamedDiscount[], name: NamedDiscountName): NamedDiscount[] {
  return [...lines, { name, amount: NAMED_DISCOUNT_AMOUNT }];
}

/** The lines without the one at `index`; null when none are left, which is
 * how the column says "no named line". */
export function removeNamedDiscount(lines: NamedDiscount[], index: number): NamedDiscount[] | null {
  const kept = lines.filter((_, i) => i !== index);
  return kept.length ? kept : null;
}
