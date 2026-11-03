// 24/7 scheduler, run by .github/workflows/keep-warm.yml every 5 minutes.
// 1. Pings each Render URL directly, so the sites stay warm even if the PHP host is down or slow.
// 2. Calls cron.php on the host so the dashboard records history. InfinityFree answers outside callers with a
//    JavaScript bot check (slowAES) instead of running the script; this solves it the way a browser would.
//
// Env: PING_URLS  Render URLs, separated by spaces, commas or newlines
//      CRON_URL   https://your-domain/api/cron.php?key=CRON_KEY (optional)
import { createDecipheriv } from 'node:crypto';

const PING_TIMEOUT_MS = 90_000;
const USER_AGENT = 'Mozilla/5.0 (uptime-pinger keep-warm; +github-actions)';

const urls = (process.env.PING_URLS ?? '').split(/[\s,]+/).filter(Boolean);
const cronUrl = (process.env.CRON_URL ?? '').trim();

async function ping(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    const routing = res.headers.get('x-render-routing') ?? '';
    const error = routing.includes('no-server')
      ? 'no Render service at this URL'
      : routing.includes('suspend')
        ? 'Render service suspended'
        : res.status >= 500
          ? `HTTP ${res.status}`
          : null;
    return { ok: !error, status: res.status, ms: Date.now() - started, error };
  } catch (e) {
    const error = e.name === 'TimeoutError' ? `timeout ${PING_TIMEOUT_MS / 1000}s` : (e.cause?.code ?? e.message);
    return { ok: false, status: null, ms: Date.now() - started, error };
  }
}

/** A cold start can fail the first request; try once more before calling the site down. */
async function pingWithRetry(url) {
  const first = await ping(url);
  if (first.ok) return first;
  console.log(`RETRY ${url} (${first.error})`);
  return ping(url);
}

/** InfinityFree's check sets __test = AES-128-CBC-decrypt(c, key a, iv b), then reloads with ?i=1. */
function solveChallenge(html, url) {
  const hex = [...html.matchAll(/toNumbers\("([0-9a-f]+)"\)/g)].map(m => Buffer.from(m[1], 'hex'));
  if (hex.length < 3) return null;
  const [key, iv, data] = hex;
  const decipher = createDecipheriv('aes-128-cbc', key, iv).setAutoPadding(false);
  const cookie = Buffer.concat([decipher.update(data), decipher.final()]).toString('hex');
  const next = html.match(/location\.href\s*=\s*"([^"]+)"/)?.[1] ?? `${url}${url.includes('?') ? '&' : '?'}i=1`;
  return { cookie: `__test=${cookie}`, next };
}

async function runCron(url) {
  const get = (u, cookie) =>
    fetch(u, {
      headers: { 'User-Agent': USER_AGENT, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(170_000),
    });
  let res = await get(url);
  let body = await res.text();
  if (body.includes('slowAES')) {
    const solved = solveChallenge(body, url);
    if (!solved) throw new Error('host bot check changed; could not solve it');
    res = await get(solved.next, solved.cookie);
    body = await res.text();
    if (body.includes('slowAES')) throw new Error('host still answers with its bot check');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  return body.trim();
}

let failed = false;

if (!urls.length) console.log('WARN PING_URLS is empty, no Render sites to ping');
const results = await Promise.all(urls.map(async url => [url, await pingWithRetry(url)]));
for (const [url, r] of results) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${url} -> ${r.status ?? '-'} ${r.ms}ms${r.error ? ' ' + r.error : ''}`);
  if (!r.ok) failed = true;
}

if (cronUrl) {
  try {
    console.log(`\nCRON ${new URL(cronUrl).host}\n${await runCron(cronUrl)}`);
  } catch (e) {
    // The sites were already pinged above, so a host hiccup only costs dashboard history.
    console.log(`::warning::cron.php call failed: ${e.message}`);
  }
} else {
  console.log('INFO CRON_URL not set, skipping the dashboard scheduler');
}

process.exit(failed ? 1 : 0);
