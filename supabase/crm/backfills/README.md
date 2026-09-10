# One-off data backfills (CRM side)

Scripts here are run by a human against the Supabase project with the postgres
`DATABASE_URL` from the drive's `_secrets/supabase.env`. Each is idempotent
(writes only where the target is empty), dry-run by default, and documents
its source data. Source files with PII (Salesforce exports) stay on the drive,
never in this repo.

| # | Script | Source | Ticket |
|---|--------|--------|--------|
| 003 | `003_party_type_from_sf_leads.py` | `Drive/Salesforce/Leads report 2026-08-25 (report1787707750166).csv` | bj-finance #414 |
