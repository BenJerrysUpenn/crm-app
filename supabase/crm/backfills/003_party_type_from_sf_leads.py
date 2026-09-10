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

# SF picklist API names -> the names deals.package_name may hold. The column
# has a CHECK constraint (Catering-Manager's) allowing only the current
# packages, so discontinued offerings (Deluxe Cup Party, Hot Chocolate Party,
# Cow Mobile, …) cannot be stored there: for those the original Salesforce
# value goes into the deal's notes as a dated line instead, and event_type
# still fills. "AskanExpert" is not a party type and is dropped entirely.
PARTY_TYPE_MAP = {
    "CuporConeParty": "Cup or Cone Party",
    "Cup and Cone": "Cup or Cone Party",
    "SundaeParty": "Sundae Party",
    "SundaePartyDeluxe": "Deluxe Sundae Party",
    "SundaeParty(Deluxe)": "Deluxe Sundae Party",
    "SuperDeluxeSundaeParty": "Super Deluxe Sundae Party",
    "WaffleConeParty": "Waffle Cone Party",
}
ALLOWED_PACKAGES = {"Cup or Cone Party", "Waffle Cone Party", "Sundae Party", "Super Sundae Party",
                    "Deluxe Sundae Party", "Super Deluxe Sundae Party", "DIY Ice Cream Social", "DIY Sundae Upgrade"}
NOT_A_PARTY_TYPE = {"AskanExpert"}
NOTE_PREFIX = "Salesforce Party Type: "

def norm_date(d):
    m = re.match(r"(\d+)/(\d+)/(\d+)", d or "")
    return f"{int(m.group(3)):04d}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else ""

def party_type(raw):
    """-> (package_name or None, legacy label or None)."""
    raw = (raw or "").strip()
    if not raw or raw in NOT_A_PARTY_TYPE:
        return None, None
    mapped = PARTY_TYPE_MAP.get(raw)
    if mapped in ALLOWED_PACKAGES:
        return mapped, None
    return None, re.sub(r"(?<=[a-z])(?=[A-Z])", " ", raw)

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
        parsed = [party_type(r["Party Type"]) for r in cands]
        pts = {p for p, _ in parsed} - {None}
        legacy = {l for _, l in parsed} - {None}
        evts = {r["Event Type"].strip() for r in cands} - {""}
        new_pkg = pts.pop() if len(pts) == 1 and not pkg else None
        new_evt = evts.pop() if len(evts) == 1 and not evt else None
        note = (NOTE_PREFIX + legacy.pop()) if (len(legacy) == 1 and not pts and not pkg) else ""
        if len(pts) > 1 or len(legacy) > 1: stats["conflict_party_type"] += 1
        for _, l in parsed:
            if l: unknown[l] += 1
        if new_pkg or new_evt or note:
            out.append((deal_id, new_pkg or "", new_evt or "", note, how))
            stats[f"fill:{how}"] += 1
            if new_pkg: stats["fills_package_name"] += 1
            if new_evt: stats["fills_event_type"] += 1
            if note: stats["fills_legacy_note"] += 1
        else:
            stats["matched_nothing_to_fill"] += 1

    print(f"legacy deals: {len(deals)} | report rows: {len(rows)}")
    for k, v in sorted(stats.items()): print(f"  {k}: {v}")
    if unknown: print("  discontinued Party Types (to notes, not package_name):", dict(unknown))
    print("  sample:", out[:5])
    if not a.live:
        print("DRY RUN — nothing written. Re-run with --live to apply."); return

    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="") as f:
        csv.writer(f).writerows(out); staged = f.name
    sql = f"""
begin;
create temp table sf_backfill (deal_id bigint, package_name text, event_type text, note text, how text);
\\copy sf_backfill from '{staged}' with csv
select 'before: pkg_filled=' || count(*) filter (where package_name<>'') || ' evt_filled=' || count(*) filter (where event_type<>'') from deals where legacy_sf_id is not null;
update deals d set package_name = b.package_name, updated_at = now()
  from sf_backfill b where d.id = b.deal_id and b.package_name <> '' and coalesce(d.package_name,'') = '';
update deals d set event_type = b.event_type, updated_at = now()
  from sf_backfill b where d.id = b.deal_id and b.event_type <> '' and coalesce(d.event_type,'') = '';
update deals d set notes = case when coalesce(d.notes,'') = '' then '[' || to_char(now(),'YYYY-MM-DD') || '] ' || b.note
                                else d.notes || E'\n[' || to_char(now(),'YYYY-MM-DD') || '] ' || b.note end,
                   updated_at = now()
  from sf_backfill b where d.id = b.deal_id and b.note <> '' and coalesce(d.notes,'') not like '%' || b.note || '%';
select 'legacy notes written=' || count(*) from deals where legacy_sf_id is not null and notes like '%{NOTE_PREFIX}%';
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
