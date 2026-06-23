# Set up the missed-clock-in checker on this Mac

Hand this whole file to **Claude Code** in the Terminal on Alex's Mac and let it do the work. The goal: run the time-clock app's "missed clock-in" check every 5 minutes from this Mac, so we don't have to pay for Vercel Pro's cron feature.

---

## For Claude Code: what to build

Set up a recurring background job on this macOS machine that calls a single web URL every 5 minutes. Use a **launchd LaunchAgent** (the proper macOS way), not a crontab, because launchd survives reboots and re-runs a missed job when the Mac wakes from sleep.

### The job

Every 5 minutes, make an HTTPS GET request to:

```
https://time.withers-ventures.com/api/cron/missed-clockins?secret=PASTE_CRON_SECRET_HERE
```

That endpoint looks for anyone who was scheduled but hasn't clocked in, and sends them and the managers an alert. It's safe to call any time; when nothing is due it does nothing. A successful call returns JSON like `{"checked":N,"flagged":[...]}`.

### Requirements

1. **Ask Alex for the secret first.** Replace `PASTE_CRON_SECRET_HERE` with the real value. This is the `CRON_SECRET` that's set in the time app's Vercel project (Settings → Environment Variables). If Alex doesn't have it, he can copy it from there. Do **not** commit the real secret into any git repo or shared file; keep it only inside the LaunchAgent on this machine.
2. **Schedule:** every 5 minutes (`StartInterval` of 300 seconds).
3. **Logging:** write each run's timestamp and the HTTP response to a log file (e.g. `~/Library/Logs/bj-clockin-cron.log`), and cap it so it can't grow forever (rotate or trim when it gets large).
4. **Resilience:** use `curl` with a timeout (say 30s) and `--fail` so errors are visible in the log. The job should not crash the agent if the network is down; just log and move on.
5. **Survive reboot/sleep:** the LaunchAgent must be loaded so it auto-starts on login and resumes after sleep.
6. **No Homebrew dependency** if avoidable — `curl` ships with macOS. Keep it to a small shell script plus a `.plist`.

### Suggested shape (Claude, adapt as needed)

- A script at `~/bin/bj-clockin-cron.sh` that curls the URL and appends the result to the log.
- A LaunchAgent plist at `~/Library/LaunchAgents/com.withers.clockin-cron.plist` with `StartInterval` = 300, `RunAtLoad` = true, `StandardOutPath` / `StandardErrorPath` pointed at the log.
- Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.withers.clockin-cron.plist` (or `launchctl load` on older macOS).
- Keep the secret out of the script if cleaner — e.g. read it from a file with `600` permissions like `~/.config/bj-clockin/secret` — but a single hardcoded plist on this personal machine is acceptable since it never leaves the Mac.

### Verify before you finish

1. Run the script once by hand and show Alex the log line and the JSON response (a `200` with `{"checked":...}` means it works; a `401` means the secret is wrong).
2. Confirm the LaunchAgent is loaded: `launchctl list | grep clockin`.
3. Tell Alex two things in plain language:
   - This only runs while the Mac is **powered on and logged in**. If the laptop is closed/asleep all evening, checks pause until it wakes. For a machine that's usually on during shop hours this is fine; if shifts run late and the Mac is off, mention that as a limitation.
   - To stop or remove it later, `launchctl bootout gui/$(id -u)/com.withers.clockin-cron` and delete the two files.

---

## Background (so Claude has context)

- The app is "Withers Time," a geolocation time clock + scheduling tool at `time.withers-ventures.com`, hosted on Vercel (Hobby plan).
- Vercel Hobby only allows cron once per day, which is useless for shift alerts, hence running it from this Mac instead.
- The endpoint is already built and deployed; nothing in the app needs changing. This task is purely setting up the local scheduler.
- A grace period is built into the endpoint (it waits ~10 minutes after a shift start before flagging someone), so calling every 5 minutes is the right cadence.
