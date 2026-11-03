# Uptime Pinger

Keeps Render free instances warm. Sign up, add your Render URLs, close the tab: the server pings each site on its
own schedule (1, 5, 6, 7, 10, 13, 14, 30 or 60 minutes) and keeps the last 100 results per site.

Built for plain PHP shared hosting: an Angular frontend plus a small PHP API with SQLite, and a cron job as the
scheduler. No Node, database server or SSH needed on the host.

```
php/api/        PHP source (copied into the build)
  index.php     JSON API: auth, sites, ping now
  cron.php      scheduler: pings every site that is due
  lib.php       shared code: database, pinging
  data/         SQLite database + generated config (blocked from the web)
src/            Angular dashboard
scripts/        build + local run
```

## Build the upload

```bash
npm install
npm run build      # -> hosting/ and uptime-pinger-hosting.zip
```

## Deploy to cPanel shared hosting

1. **Check PHP.** In cPanel > *Select PHP Version*, pick PHP 7.4 or newer and make sure the `pdo_sqlite` and `curl`
   extensions are ticked (they are on by default almost everywhere).
2. **Upload.** In *File Manager*, open `public_html` (or a subfolder such as `public_html/pinger`; the app works from
   any folder), upload `uptime-pinger-hosting.zip` and choose *Extract*. Turn on *Show Hidden Files* and check that
   `.htaccess`, `api/.htaccess` and `api/data/.htaccess` are there.
3. **Add the cron job.** In cPanel > *Cron Jobs*, choose *Once Per Minute* (`* * * * *`) and use:

   ```
   php -q /home/YOUR_CPANEL_USER/public_html/api/cron.php >/dev/null 2>&1
   ```

   Adjust the path if you used a subfolder. If `php` is not found, try `/usr/local/bin/php`.
4. **Open the site and create your account.**

**If your host does not allow cron every minute** (some limit it to every 5 or 15 minutes), anything slower than
10 minutes lets Render fall asleep. Use a free external cron service such as cron-job.org to call this every minute
instead:

```
https://your-domain/api/cron.php?key=CRON_KEY
```

`CRON_KEY` is in `api/data/config.json`, which is created the first time the site is opened (open it in File
Manager; on InfinityFree it is under `htdocs/api/data/`). If it is missing, open `https://your-domain/api/cron.php`
in a browser once: it shows "Forbidden" but creates the file.

## Run 24/7 on InfinityFree (GitHub Actions)

InfinityFree has no cron jobs, and it answers outside callers (cron-job.org included) with a JavaScript bot check,
so `cron.php` never runs and pinging stops as soon as the dashboard tab is closed. `.github/workflows/keep-warm.yml`
fixes that. Every 5 minutes it pings the Render URLs directly, then calls `cron.php`, getting past the bot check
the way a browser does, so the dashboard keeps its history.

1. Push this project to a **public** GitHub repo (Actions minutes are unlimited there; a private repo runs out
   of its 2,000 free minutes in about a week at this rate). Secrets stay private either way.
2. In the repo, open *Settings > Secrets and variables > Actions*:
   - Secret `CRON_URL` = `https://your-domain/api/cron.php?key=CRON_KEY`
   - Variable `PING_URLS` = your Render URLs, space separated (optional; it defaults to the two current sites)
3. Open *Actions > Keep warm > Run workflow* once to check that it works. A run turns red when a Render site is
   down, and GitHub emails you.

**Updating:** build again and extract the new zip over the old files. Your database and config in `api/data/` are
not in the zip, so they stay as they are.

## Run locally

Needs Docker Desktop (PHP's curl extension is blocked by Windows Application Control on this machine, so the app
runs in the same Apache + PHP setup a host uses):

```bash
npm start          # build, then serve on http://localhost:3000 with cron every minute
npm run serve      # serve the last build without rebuilding
docker rm -f uptime-pinger-local   # stop
```

Local data lives in `.local-data/`. PHP changes in `php/api/` apply immediately. For frontend work, run
`npm run serve` and then `npm run dev` (Angular on :4200, proxying `api/` to :3000).

## Notes

- A response below 500 counts as up. 5xx, network errors, no reply within 60s, and Render's "no service at this URL"
  page count as down.
- Anyone who can open the site can create an account. If it is only for you, sign up and then remove the signup
  route in `php/api/index.php`, or protect the folder with cPanel > *Directory Privacy*.
- Render's free plan gives 750 instance hours a month per workspace, and one site kept awake 24/7 uses about 744.
