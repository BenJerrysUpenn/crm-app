# Withers Time: build and hosting guide

A start-to-finish guide for standing up the geolocation time clock + scheduling app on top of the **same** Supabase database the CRM already uses, served at `time.withers-ventures.com`. Written for someone doing this for the first time.

---

## The map (read this once, then forget it)

This is the same shape as the CRM. Three things live in three places and talk over the internet:

1. **Supabase** holds the data and runs the logins. It's the exact same project the CRM uses, already live. You're adding a few new tables to it and a handful of employee accounts.
2. **The app** is the time clock Claude wrote. It's a bundle of files sitting in a `time-app` folder inside your existing `crm-app` code. It needs somewhere to be served from. That somewhere is Vercel, as a **second project** separate from the CRM.
3. **The browser** (your phone, your staff's phones) loads the app from Vercel, then talks straight to Supabase.

No server to rent or babysit. One repo on GitHub, two Vercel projects pointing at two folders, two domains. The CRM at `crm.withers-ventures.com` is untouched. This new one lives at `time.withers-ventures.com`.

**The one rule that actually matters for safety:** this app uses one extra key the CRM didn't, the Supabase **service role key**. It's a master key that bypasses every security rule. It goes into Vercel as a plain (not `NEXT_PUBLIC_`) environment variable so it stays server-side only, and it must NEVER be hardcoded into the app or given a `NEXT_PUBLIC_` name, because anything `NEXT_PUBLIC_` is downloadable by anyone who visits the site. Keep that one line clean and you avoid the only mistake here that can actually hurt you.

---

## Part 1: Supabase prep

You'll do three things: run the database setup, make yourself a manager, and grab the keys.

### 1a. Run the schema (creates the tables and the locks)

The CRM already has Row Level Security turned on. This app adds its own tables (`profiles`, `locations`, `shifts`, `time_entries`, `notifications`, `availability`) and their own security policies in one script. Employees will only ever see their own data; managers see everything. That's all baked into the script.

1. Go to [supabase.com](https://supabase.com), open your project (the same one the CRM uses).
2. Left sidebar, click **SQL Editor**, then **New query**.
3. Open the file `time-app/supabase/migration.sql` from the code, copy the whole thing, paste it into the editor, and click **Run**.
4. It should say success. This creates every table, every security policy, a trigger that auto-creates a profile row whenever you add a new user, and it seeds one default store location you'll fix in Part 6.

You only run this once.

### 1b. Make yourself a manager

Everyone starts as an `employee`. You need to be a `manager` to see the schedule builder, team page, and everyone's timesheets.

1. Still in the SQL Editor, **New query**.
2. Paste this, swapping in your email, and **Run**:

```sql
update public.profiles set role = 'manager'
where id = (select id from auth.users where email = 'you@withers-ventures.com');
```

### 1c. Get the two public keys (same as the CRM)

The app needs the same two values the CRM uses.

1. Left sidebar, click **Settings** (gear icon), then **API Keys**.
2. Copy the **Publishable key** (starts `sb_publishable_`). Browser-safe; RLS is what makes it safe.
3. Click **Settings**, then **Data API**, and copy the **Project URL** (`https://....supabase.co`).

If you still have these from setting up the CRM, they're identical. You can reuse them.

### 1d. Get the service role key (new for this app)

This is the extra master key. It lets the missed-clock-in cron job read across all employees and look up email addresses.

1. Same **Settings → API Keys** screen.
2. Find the **service_role** key (under the secret/legacy keys section). Click to reveal, copy it.
3. Treat this like the master credential in `_secrets`. It goes into Vercel in Part 4 as a non-`NEXT_PUBLIC_` variable and nowhere else. Never paste it into code.

Keep all three values handy for Part 4.

---

## Part 2: The app already exists

Unlike the CRM, you don't need to prompt Claude from scratch. The app is already written and sitting in your code at `withers-crm/time-app/`. Skip straight to getting it on GitHub and Vercel.

If you ever want to change it, open a chat, point at the `time-app` folder, and describe the change.

---

## Part 3: GitHub (where the code lives)

The time app lives **inside the same repo as the CRM** (`crm-app`), in the `time-app` subfolder. So if the CRM is already on GitHub, the time app comes along with it the next time you push.

### If the CRM is already on GitHub (most likely)

1. Open **GitHub Desktop**. It will already show the `time-app` folder as a pile of new changes.
2. Type a short summary like `Add time clock app`, click **Commit to main**, then **Push origin**.
3. Done. The code is on GitHub. Don't worry that it's mixed in with the CRM; Vercel only looks at the folder you tell it to.

### If you used drag-and-drop before

Drag the `time-app` folder into the existing repo on github.com (the **Add file → Upload files** button). Skip the `node_modules` and `.next` folders if they appear; they're huge and rebuilt automatically.

---

## Part 4: Vercel (a second project)

The CRM is one Vercel project. The time app is a **separate Vercel project** that happens to read from the same repo but a different folder. This is the one step that's genuinely different from the CRM guide, and it's a single setting.

1. Go to [vercel.com](https://vercel.com), open your dashboard, click **Add New**, then **Project**.
2. Find the same `crm-app` repo you imported for the CRM and click **Import**. (Yes, the same repo. That's fine.)
3. **The important setting:** expand **Root Directory** and set it to `time-app`. This is what tells Vercel "build the folder, not the CRM." Get this right and everything else just works.
4. Vercel detects Next.js. Leave the build settings alone.
5. **Before you deploy**, expand **Environment Variables** and add these:

   | Name | Value | Notes |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | your Project URL | from Part 1c |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your publishable key | from Part 1c |
   | `SUPABASE_SERVICE_ROLE_KEY` | your service role key | from Part 1d. **No `NEXT_PUBLIC_` prefix.** |
   | `CRON_SECRET` | any random string you make up | e.g. mash the keyboard. Protects the cron job. |

   The email and SMS variables (`RESEND_API_KEY`, `TWILIO_*`) are optional. Leave them out for now; notifications still show up in the app's bell. You add those later in Part 7.

6. Click **Deploy**. Wait a minute or two. Vercel gives you a temporary address like `withers-time.vercel.app`. Open it on your phone, log in with your account, and you should land on the clock-in screen.

From now on, every push to GitHub redeploys **both** projects automatically. You never restart anything.

---

## Part 5: DNS (point the subdomain)

You own `withers-ventures.com`, so `time.` is yours for free. The CRM proved the pattern; this is the same move with a different word.

### 5a. Tell Vercel about the subdomain

1. In Vercel, open the **time** project, click **Settings**, then **Domains**.
2. Type `time.withers-ventures.com` and click **Add**.
3. Vercel shows a **CNAME** record: a **Name** (`time`) and a **Value** (something like `cname.vercel-dns.com`). Copy the Value exactly. Leave the tab open.

### 5b. Add the record where your DNS lives

1. Log in to wherever you manage `withers-ventures.com` DNS (Squarespace, same place you added the `crm` record).
2. **Add record:**
   - **Type:** CNAME
   - **Host / Name:** `time`
   - **Data / Value:** the Vercel value you copied
3. Save. **Don't touch any MX or TXT records** — those run your email.

### 5c. Verify

Back in Vercel's Domains tab it checks for the record. A few minutes, occasionally a few hours. Once it's valid, Vercel issues HTTPS automatically and `https://time.withers-ventures.com` loads the app. The CRM and your main site keep working untouched.

HTTPS matters here more than it did for the CRM: phone GPS only works over HTTPS, so once the domain is live, clock-in works from any phone.

---

## Part 6: First-run setup inside the app

A few things you do once, from the app itself, as a manager.

### 6a. Add your employees

1. In Supabase, **Authentication → Users → Add user → Create new user**. Enter their email and a password, tick **Auto Confirm User**.
2. That's it in Supabase. A profile row is created automatically.
3. In the app, open the **Team** page. Each person appears. Set their **name**, **phone** (needed for text alerts), **role** (leave as employee unless they're a manager), and **pay rate** (used for timesheet pay totals). Changes save as you type.

### 6b. Set the store geofence

This is what makes clock-in location-aware. Easiest way:

1. Stand inside the store, on your phone.
2. Open the app, **Team** page, scroll to **Locations**.
3. Tap **Use my location** on the store row. It captures your exact coordinates.
4. Set the **radius** in meters. 150 is a sensible default (about a block); tighten it to 75 if you want them physically at the shop, loosen it if GPS is flaky indoors.

From then on, the app refuses any clock-in further than that radius from the store, and records the measured distance on every punch so you can spot-check it in Timesheets.

---

## Part 7: Turn on text and email alerts (optional, do it later)

The app always shows notifications in the in-app bell (the little bell in the top bar). Text and email are extra channels that stay off until you add keys. Nothing breaks without them.

### Text messages (Twilio)

1. Make a [twilio.com](https://twilio.com) account, buy a phone number (a few dollars a month).
2. From the Twilio console copy your **Account SID**, **Auth Token**, and the **phone number** you bought.
3. In the Vercel **time** project, **Settings → Environment Variables**, add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. Redeploy (Vercel → Deployments → Redeploy, or just push any change).
4. Make sure each employee's phone number is filled in on the Team page.

### Email (Resend)

1. Make a [resend.com](https://resend.com) account, verify your domain (or use their test sender to start).
2. Copy the **API key**.
3. In Vercel add `RESEND_API_KEY` and optionally `NOTIFICATIONS_FROM_EMAIL` (e.g. `Withers Time <time@withers-ventures.com>`). Redeploy.

Email also needs the service role key (Part 1d) to be set, because that's how the app looks up each person's email address.

---

## Part 8: The missed-clock-in checker (one note about your Vercel plan)

The app checks every few minutes for anyone who was scheduled but hasn't clocked in, and alerts them and you. How that runs depends on your Vercel plan:

- **Vercel Pro:** it already works. The `vercel.json` file in the app schedules the check every 5 minutes automatically. Nothing to do.
- **Vercel Hobby (free):** the free plan only allows the check to run **once a day**, which isn't useful for shift alerts. Two options: upgrade the time project to Pro, **or** use a free outside scheduler. Make a free account at [cron-job.org](https://cron-job.org), and have it call this URL every 5 minutes:

  `https://time.withers-ventures.com/api/cron/missed-clockins?secret=YOUR_CRON_SECRET`

  (swap in the `CRON_SECRET` you set in Part 4). That does the same job without Pro.

Not sure which plan you're on? Vercel → your account → **Settings → Billing** shows it. If you never paid Vercel anything, you're on Hobby.

---

## Order of operations, quickest path

1. Supabase: run `migration.sql`, make yourself a manager, grab URL + publishable key + service role key. (Part 1)
2. Push the `time-app` folder to GitHub (it rides along in the existing repo). (Part 3)
3. New Vercel project off the same repo, **Root Directory = `time-app`**, add the env vars, deploy, test on the `.vercel.app` address. (Part 4)
4. Add the `time` subdomain in Vercel and your DNS. (Part 5)
5. In the app: add employees, set their details, set the store geofence. (Part 6)
6. Later, when you want them: text/email keys (Part 7) and confirm the missed-clock-in checker matches your plan (Part 8).

Roughly free at your scale, plus a few dollars a month if you add Twilio texts.

---

## A note for later

The geofence stops the common case (clocking in from home). It can't stop someone who deliberately fakes GPS at the phone's operating-system level, which is a much higher bar and rare for hourly staff. If you ever want tighter proof, the next step up is requiring a photo at clock-in or a manager-present code. Not needed for v1. Ask Claude when you get there.
