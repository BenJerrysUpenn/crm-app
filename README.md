# Withers Ventures CRM

Login-protected Kanban board for the catering pipeline. Reads and writes the
`deals` table in the existing Supabase project.

## Stack
- Next.js 14 (App Router) + TypeScript
- Supabase Auth (email + password)
- @dnd-kit for drag-and-drop
- Tailwind CSS

## Environment variables
Set both in Vercel (Project Settings, Environment Variables). Do not commit them.

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | The Supabase Project URL, e.g. `https://abcd.supabase.co` (no trailing path) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The Supabase publishable key (starts `sb_publishable_`) or legacy anon key |

A `.env.example` is included as a reference. For local dev, copy it to `.env.local`.

## Supabase setup required
The web app assumes the following are already done in Supabase:

1. Row Level Security enabled on every table in the `public` schema.
2. A policy on `public.deals` granting full access to the `authenticated` role:
   ```sql
   create policy "authenticated full access to deals"
   on public.deals for all
   to authenticated
   using (true) with check (true);
   ```
3. User accounts created by hand under Authentication, Users, with **Auto Confirm User** ticked. No public sign-up page exists.

If the board later needs to read/write other tables (e.g. `quote_versions`,
`invoices`), add the same policy for each.

## Stage write rules
When a card is dragged to a new column, the app writes four fields in a single
update:

1. `stage` = new stage
2. `boomerang_reason` = `null` (always, to satisfy the database CHECK constraint)
3. `is_active` = `0` for terminal stages (Event Complete, Closed Lost, Closed
   Below Min, Closed Marketing Event), else `1`
4. `updated_at` = current ISO timestamp

Updates are optimistic: the card moves immediately, and rolls back with a toast
if the write fails.

## Filtering
The board loads `archived = 0` rows only. Archived deals (9.5k+ historical rows)
stay hidden. Within each column, cards sort by `event_date` ascending.

## Local dev (optional)
```
npm install
cp .env.example .env.local   # fill in real values
npm run dev
```
Open http://localhost:3000.

## Deploy
Push to GitHub, import the repo into Vercel, set the two env vars, deploy.
Custom domain via Vercel, Project Settings, Domains.
