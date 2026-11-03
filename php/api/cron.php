<?php
// Scheduler. Run every minute from a cPanel cron job:
//   php /home/USER/public_html/api/cron.php
// or, if the host only allows URL cron jobs:
//   https://your-domain/api/cron.php?key=CRON_KEY   (key is in api/data/config.json)
declare(strict_types=1);
require __DIR__ . '/lib.php';

if (PHP_SAPI !== 'cli') {
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    if (!hash_equals(config()['cron_key'], (string) ($_GET['key'] ?? ''))) {
        http_response_code(403);
        exit("Forbidden\n");
    }
}
extend_time_limit(PING_TIMEOUT_S * 3);
ignore_user_abort(true);

// Skip this run if the previous one is still waiting on slow cold starts.
$lock = fopen(data_dir() . '/cron.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
    exit("INFO previous run still busy, skipping\n");
}

q('DELETE FROM sessions WHERE expires_at < ?', [now_ms()]);
$due = due_sites();
echo 'INFO ' . date('H:i:s') . ' scheduler run, ' . count($due) . " sites due\n";
ping_sites($due, true);

flock($lock, LOCK_UN);
