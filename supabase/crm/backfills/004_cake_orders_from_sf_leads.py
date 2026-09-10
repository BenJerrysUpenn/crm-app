#!/usr/bin/env python3
"""Mark the Salesforce-migrated deals that were really CAKE ORDERS (bj-finance #414).

Why: the 2026-05-16 migration turned 2,067 Salesforce leads of record type
"Cake Order" into deals at stage Closed Lost with no package and no event
type. On the call desk they look like lost catering enquiries. The reason
those people contacted us was a cake, which is exactly what the desk should
say. deals.package_name is constrained to the eight catering packages, so the
fact goes into event_type ('Cake Order') and a dated notes line with the cake
type, occasion and pickup date from the Leads report.

Writes only where event_type is empty, and only one notes line per deal.
Dry run by default; --live to apply. Needs DATABASE_URL and psql.
"""
import argparse, collections, csv, os, re, subprocess, sys, tempfile

NOTE_PREFIX = "Salesforce record type: Cake Order"

def norm_date(d):
    m = re.match(r"(\d+)/(\d+)/(\d+)", d or "")
    return f"{int(m.group(3)):04d}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else ""

def psql(sql, dsn):
    r = subprocess.run(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql], capture_output=True, text=True)
    if r.returncode: sys.exit(r.stderr)
    return r.stdout.strip()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--csv", required=True); ap.add_argument("--live", action="store_true")
    a = ap.parse_args()
    dsn = os.environ.get("DATABASE_URL") or sys.exit("DATABASE_URL not set")
    rows = list(csv.DictReader(open(a.csv, encoding="cp1252", errors="replace")))
    cakes = {r["Lead ID"]: r for r in rows if r["Lead Record Type"] == "Cake Order"}
    by_email_date = collections.defaultdict(list)
    for r in cakes.values():
        by_email_date[(r["Email"].strip().lower(), norm_date(r["Event Date"]) or norm_date(r["Pickup Date"]))].append(r)

    deals = list(csv.reader(psql(
        "copy (select id, legacy_sf_id, lower(btrim(coalesce(contact_email,''))), coalesce(event_date::text,''), "
        "coalesce(event_type,''), coalesce(notes,''), stage from deals where legacy_sf_id is not null "
        "and coalesce(package_name,'')='' order by id) to stdout with csv", dsn).splitlines()))

    out, stats = [], collections.Counter()
    for deal_id, key, email, edate, evt, notes, stage in deals:
        if key.startswith("LEAD-"):
            r = cakes.get(key[5:])
        else:
            c = by_email_date.get((email, edate), []); r = c[0] if len(c) == 1 else None
        if not r: continue
        stats["cake_order_deals"] += 1; stats[f"stage:{stage}"] += 1
        bits = [f"{r['Cake Type'].strip() or 'unspecified'} cake"]
        if r["Occasion"].strip(): bits.append(f"occasion {r['Occasion'].strip()}")
        if r["Pickup Date"].strip(): bits.append(f"pickup {norm_date(r['Pickup Date'])}")
        note = "" if NOTE_PREFIX in notes else f"{NOTE_PREFIX} ({', '.join(bits)})"
        new_evt = "Cake Order" if not evt else ""
        if new_evt: stats["fills_event_type"] += 1
        if note: stats["fills_note"] += 1
        if new_evt or note: out.append((deal_id, new_evt, note))
    print(f"legacy deals without package: {len(deals)} | cake-order leads in report: {len(cakes)}")
    for k, v in sorted(stats.items()): print(f"  {k}: {v}")
    print("  sample:", out[:3])
    if not a.live: print("DRY RUN — nothing written. Re-run with --live to apply."); return

    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="") as f:
        csv.writer(f).writerows(out); staged = f.name
    sql = f"""
begin;
create temp table sf_cakes (deal_id bigint, event_type text, note text);
\\copy sf_cakes from '{staged}' with csv
select 'before: cake event_type=' || count(*) from deals where event_type = 'Cake Order';
update deals d set event_type = b.event_type, updated_at = now() from sf_cakes b
  where d.id = b.deal_id and b.event_type <> '' and coalesce(d.event_type,'') = '';
update deals d set notes = case when coalesce(d.notes,'') = '' then '[' || to_char(now(),'YYYY-MM-DD') || '] ' || b.note
                                else d.notes || E'\\n[' || to_char(now(),'YYYY-MM-DD') || '] ' || b.note end, updated_at = now()
  from sf_cakes b where d.id = b.deal_id and b.note <> '' and coalesce(d.notes,'') not like '%{NOTE_PREFIX}%';
select 'after:  cake event_type=' || count(*) from deals where event_type = 'Cake Order';
commit;
"""
    r = subprocess.run(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-Atq"], input=sql, capture_output=True, text=True)
    os.unlink(staged); print(r.stdout)
    if r.returncode: sys.exit(r.stderr)
    print("LIVE run committed.")

if __name__ == "__main__":
    main()
