#!/usr/bin/env python3
"""Backfill deals.package_name (Party Type) and empty deals.event_type for the
Salesforce-migrated deals, from the Salesforce Leads report (bj-finance #414).

Why: the 2026-05-16 migration wrote 9,450 SF deals with package_name empty on
all but 3 rows, although Party Type is a real SF field. The Leads report
exported 2026-08-25 carries Party Type, Event Type and Lead ID for 13,925
leads, so the value can be recovered without touching Salesforce.

Matching (never guesses across different values):
  * deals.legacy_sf_id = 'LEAD-<Lead ID>'  -> exact Lead ID match.
  * deals.legacy_sf_id = '006…' (Opportunity) -> the report has no Opportunity
    Id, so match on (email, event date); if that fails, (email, Converted=1).
    Several candidate rows are accepted only when they agree on Party Type.
Writes only where the target column is empty. Dry run by default.

Usage:
  python3 003_party_type_from_sf_leads.py --csv "<Leads report>.csv"          # dry run
  python3 003_party_type_from_sf_leads.py --csv "<Leads report>.csv" --live   # writes
Needs DATABASE_URL (postgres role) in the environment and psql on PATH.
"""
import argparse, collections, csv, os, re, subprocess, sys, tempfile

# SF picklist API names -> the names the Price Book / deals use. Legacy
# offerings that no longer exist keep a readable legacy name so history reads.
PARTY_TYPE_MAP = {
    "CuporConeParty": "Cup or Cone Party",
    "SundaeParty": "Sundae Party",
    "SundaePartyDeluxe": "Deluxe Sundae Party",
    "SundaeParty(Deluxe)": "Deluxe Sundae Party",
    "SuperDeluxeSundaeParty": "Super Deluxe Sundae Party",
    "WaffleConeParty": "Waffle Cone Party",
    "DeluxeCupParty": "Deluxe Cup Party (legacy)",
    "HotChocolateParty": "Hot Chocolate Party (legacy)",
    "CowMobileFullMenu": "Cow Mobile Full Menu (legacy)",
    "IceCreamCookieSandwich": "Ice Cream Cookie Sandwich (legacy)",
    "AskanExpert": None,  # not a party type
}

def norm_date(d):
    m = re.match(r"(\d+)/(\d+)/(\d+)", d or "")
    return f"{int(m.group(3)):04d}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else ""

def party_type(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    if raw in PARTY_TYPE_MAP:
        return PARTY_TYPE_MAP[raw]
    # Unknown picklist value: split CamelCase into words and mark legacy.
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", raw) + " (legacy)"

def psql(sql, dsn):
    r = subprocess.run(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql], capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr)
    return r.stdout.strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--live", action="store_true")
    a = ap.parse_args()
    dsn = os.environ.get("DATABASE_URL") or sys.exit("DATABASE_URL not set")

    rows = list(csv.DictReader(open(a.csv, encoding="cp1252", errors="replace")))
    by_lead = {r["Lead ID"]: r for r in rows}
    by_email_date, by_email = collections.defaultdict(list), collections.defaultdict(list)
    for r in rows:
        e = r["Email"].strip().lower()
        by_email_date[(e, norm_date(r["Event Date"]))].append(r)
        by_email[e].append(r)

    deals_csv = psql(
        "copy (select id, legacy_sf_id, lower(btrim(coalesce(contact_email,''))), "
        "coalesce(event_date::text,''), coalesce(package_name,''), coalesce(event_type,'') "
        "from deals where legacy_sf_id is not null order by id) to stdout with csv", dsn)
    deals = list(csv.reader(deals_csv.splitlines()))

    out, stats, unknown = [], collections.Counter(), collections.Counter()
    for deal_id, key, email, edate, pkg, evt in deals:
        if key.startswith("LEAD-"):
            r = by_lead.get(key[5:]); cands = [r] if r else []; how = "lead_id"
        else:
            cands, how = by_email_date.get((email, edate), []), "email+date"
            if not cands and email:
                cands, how = [r for r in by_email[email] if r["Converted"] == "1"], "email+converted"
        if not cands:
            stats["unmatched"] += 1; continue
        pts = {party_type(r["Party Type"]) for r in cands} - {None}
        evts = {r["Event Type"].strip() for r in cands} - {""}
        new_pkg = pts.pop() if len(pts) == 1 and not pkg else None
        new_evt = evts.pop() if len(evts) == 1 and not evt else None
        if len(pts) > 1: stats["conflict_party_type"] += 1
        for r in cands:
            raw = r["Party Type"].strip()
            if raw and raw not in PARTY_TYPE_MAP: unknown[raw] += 1
        if new_pkg or new_evt:
            out.append((deal_id, new_pkg or "", new_evt or "", how))
            stats[f"fill:{how}"] += 1
            if new_pkg: stats["fills_package_name"] += 1
            if new_evt: stats["fills_event_type"] += 1
        else:
            stats["matched_nothing_to_fill"] += 1

    print(f"legacy deals: {len(deals)} | report rows: {len(rows)}")
    for k, v in sorted(stats.items()): print(f"  {k}: {v}")
    if unknown: print("  unknown Party Type values (mapped generically):", dict(unknown))
    print("  sample:", out[:5])
    if not a.live:
        print("DRY RUN — nothing written. Re-run with --live to apply."); return

    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="") as f:
        csv.writer(f).writerows(out); staged = f.name
    sql = f"""
begin;
create temp table sf_backfill (deal_id bigint, package_name text, event_type text, how text);
\\copy sf_backfill from '{staged}' with csv
select 'before: pkg_filled=' || count(*) filter (where package_name<>'') || ' evt_filled=' || count(*) filter (where event_type<>'') from deals where legacy_sf_id is not null;
update deals d set package_name = b.package_name, updated_at = now()
  from sf_backfill b where d.id = b.deal_id and b.package_name <> '' and coalesce(d.package_name,'') = '';
update deals d set event_type = b.event_type, updated_at = now()
  from sf_backfill b where d.id = b.deal_id and b.event_type <> '' and coalesce(d.event_type,'') = '';
select 'after:  pkg_filled=' || count(*) filter (where package_name<>'') || ' evt_filled=' || count(*) filter (where event_type<>'') from deals where legacy_sf_id is not null;
commit;
"""
    r = subprocess.run(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-Atq"], input=sql, capture_output=True, text=True)
    os.unlink(staged)
    print(r.stdout); 
    if r.returncode: sys.exit(r.stderr)
    print("LIVE run committed.")

if __name__ == "__main__":
    main()
