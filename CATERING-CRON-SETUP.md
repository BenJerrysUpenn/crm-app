# Set up the catering-shift reconciler on this Mac

Hand this whole file to **Claude Code** in the Terminal on the Mac that already runs the missed-clock-in checker, and let it do the work. Goal: every 15 minutes, ping one web URL so that any booked catering deal whose picklist has been generated gets its crew draft-shifts created in the schedule app.

This is the twin of the existing `com.withers.clockin-cron` job. Same machine, same launchd + secret-file pattern, different URL and interval.

---

## Two values to supply

1. **CRM domain** — the production URL of the CRM (the Kanban/pipeline app), NOT the time app. Find it in the CRM's Vercel project → Settings → Domains. Used as `CRM_DOMAIN` below (e.g. `crm.withers-ventures.com`).
2. **The secret** — reuse the same value that's already in `~/.config/bj-clockin/secret`, OR skip the secret entirely (see note). If reused, it must ALSO be set as `CRON_SECRET` on the **CRM** Vercel project, otherwise the CRM endpoint ignores it.

> Note: the CRM endpoint is only gated if a `CRON_SECRET` env var is set on the CRM Vercel project. If you don't set one there, the endpoint is open and you can drop the `?secret=...` part of the URL entirely — simplest option.

---

## For Claude Code: what to build

A launchd LaunchAgent (survives reboot/sleep, re-runs missed jobs on wake), mirroring the clock-in job, with the secret read from a `600`-permission file (never hardcoded, never in the plist).

### The secret file — `~/.config/bj-catering/secret`

```bash
mkdir -p ~/.config/bj-catering
# paste the secret value into this file (no trailing newline is fine):
#   printf '%s' 'THE_SECRET' > ~/.config/bj-catering/secret
chmod 600 ~/.config/bj-catering/secret
```

If you're NOT gating the endpoint, skip this file and use the no-secret script variant below.

### The script — `~/bin/bj-catering-cron.sh`

```bash
#!/bin/bash
# bj-catering-cron.sh — pings the CRM catering-shift reconciler. Logs, never crashes.
SECRET_FILE="$HOME/.config/bj-catering/secret"
LOG="$HOME/Library/Logs/bj-catering-cron.log"
URL_BASE="https://CRM_DOMAIN/api/cron/catering-shifts"

# Trim the log if it passes ~1 MB so it can't grow forever.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

TS="$(date '+%Y-%m-%d %H:%M:%S')"

# Build the URL with the secret if present, without it otherwise.
if [ -r "$SECRET_FILE" ] && [ -s "$SECRET_FILE" ]; then
  URL="${URL_BASE}?secret=$(cat "$SECRET_FILE")"
else
  URL="${URL_BASE}"
fi

RESP="$(curl --fail --silent --show-error --max-time 30 "$URL" 2>&1)"
CODE=$?

if [ $CODE -eq 0 ]; then
  echo "$TS OK ${RESP}" >> "$LOG"
else
  echo "$TS ERR(curl=$CODE) ${RESP}" >> "$LOG"
fi
exit 0
```

Make it executable: `chmod +x ~/bin/bj-catering-cron.sh`
Replace `CRM_DOMAIN` with the real domain.

### The LaunchAgent — `~/Library/LaunchAgents/com.withers.catering-cron.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.withers.catering-cron</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>$HOME/bin/bj-catering-cron.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/bj-catering-cron.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/bj-catering-cron.err</string>
</dict>
</plist>
```

`StartInterval` 900 = every 15 minutes. Picklists aren't minute-sensitive (events are days out), so 15 min is plenty; 1800 (30 min) is also fine.

### Load it

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.withers.catering-cron.plist
```

(On older macOS: `launchctl load ~/Library/LaunchAgents/com.withers.catering-cron.plist`.)

### Verify

```bash
~/bin/bj-catering-cron.sh && tail -1 ~/Library/Logs/bj-catering-cron.log
launchctl list | grep catering
```

A log line ending in `OK {"ok":true,...}` means it works. `401` means the secret is wrong (or set on Vercel but missing/mismatched in the file); a curl error means the URL/domain is off.

### To remove later

```bash
launchctl bootout gui/$(id -u)/com.withers.catering-cron
rm ~/Library/LaunchAgents/com.withers.catering-cron.plist ~/bin/bj-catering-cron.sh
```

---

## Context

- Endpoint: `GET /api/cron/catering-shifts` on the CRM app. Already built and deployed once the code is pushed. It scans booked deals (Booked Unpaid or Booked Paid) whose picklist has set a `departure_time`, and creates one open draft shift per crew member, starting an hour before departure. Idempotent — never double-creates.
- Prereq on the CRM Vercel project: `SUPABASE_SERVICE_ROLE_KEY` must be set (the reconciler writes shifts with it). Optional: `CRON_SECRET` to gate the endpoint.
- Only runs while this Mac is powered on and logged in.
