<?php
// Shared code for the API (index.php) and the scheduler (cron.php). Targets PHP 7.4+ with pdo_sqlite and curl.
declare(strict_types=1);

const HISTORY_LIMIT = 100;
const INTERVALS = [1, 5, 6, 7, 10, 13, 14, 30, 60];
// Render free instances can take ~50s to cold start.
const PING_TIMEOUT_S = 60;
const SESSION_DAYS = 30;
// A site counts as due slightly early so a 10 min interval never drifts past Render's 15 min idle timer.
const SLACK_MS = 5000;
// How many sites one cron run pings in parallel.
const PING_BATCH = 20;

function data_dir(): string
{
    // Local runs point this elsewhere so test data never ends up in the upload.
    $dir = getenv('UPTIME_DATA_DIR') ?: __DIR__ . '/data';
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    return $dir;
}

/** Settings created on first run, so re-uploading a new build never overwrites them. */
function config(): array
{
    static $config = null;
    if ($config !== null) return $config;
    $file = data_dir() . '/config.json';
    if (is_file($file)) {
        $config = json_decode((string) file_get_contents($file), true) ?: [];
    }
    if (empty($config['cron_key'])) {
        $config = ['cron_key' => bin2hex(random_bytes(16))] + ($config ?: []);
        file_put_contents($file, json_encode($config, JSON_PRETTY_PRINT), LOCK_EX);
    }
    return $config;
}

/** set_time_limit is disabled on some free hosts; calling it there would be a fatal error. */
function extend_time_limit(int $seconds): void
{
    if (function_exists('set_time_limit')) set_time_limit($seconds);
}

function now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('sqlite:' . data_dir() . '/app.db', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 10,
    ]);
    $schema = [
        'PRAGMA foreign_keys = ON',
        'CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            pass_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS sites (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            interval_min INTEGER NOT NULL DEFAULT 10,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            last_ping_at INTEGER
        )',
        'CREATE TABLE IF NOT EXISTS pings (
            id INTEGER PRIMARY KEY,
            site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
            at INTEGER NOT NULL,
            ok INTEGER NOT NULL,
            status_code INTEGER,
            ms INTEGER NOT NULL,
            error TEXT
        )',
        'CREATE INDEX IF NOT EXISTS pings_site_at ON pings(site_id, at DESC)',
    ];
    foreach ($schema as $sql) $pdo->exec($sql);
    return $pdo;
}

function q(string $sql, array $params = []): PDOStatement
{
    $stmt = db()->prepare($sql);
    // Bind ints as ints: execute() sends everything as text, and SQLite sorts text above every number,
    // which breaks comparisons such as `last_ping_at + ... <= ?`.
    foreach (array_values($params) as $i => $value) {
        $type = is_int($value) ? PDO::PARAM_INT : ($value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $stmt->bindValue($i + 1, $value, $type);
    }
    $stmt->execute();
    return $stmt;
}

// ---------- pinging ----------

function due_sites(): array
{
    return q(
        'SELECT id, url FROM sites
         WHERE enabled = 1 AND (last_ping_at IS NULL OR last_ping_at + interval_min * 60000 - ? <= ?)',
        [SLACK_MS, now_ms()]
    )->fetchAll();
}

function record_ping(int $siteId, array $p): void
{
    q(
        'INSERT INTO pings (site_id, at, ok, status_code, ms, error) VALUES (?, ?, ?, ?, ?, ?)',
        [$siteId, $p['at'], $p['ok'] ? 1 : 0, $p['statusCode'], $p['ms'], $p['error']]
    );
    q('UPDATE sites SET last_ping_at = ? WHERE id = ?', [$p['at'], $siteId]);
    q(
        'DELETE FROM pings WHERE site_id = ? AND id NOT IN (
            SELECT id FROM pings WHERE site_id = ? ORDER BY at DESC LIMIT ' . HISTORY_LIMIT . '
        )',
        [$siteId, $siteId]
    );
}

/** $meta collects the Render routing header so a missing or suspended service is not reported as up. */
function ping_handle(string $url, ArrayObject $meta)
{
    $ch = curl_init($url);
    $opts = [
        CURLOPT_HTTPGET => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => PING_TIMEOUT_S,
        CURLOPT_TIMEOUT => PING_TIMEOUT_S,
        CURLOPT_USERAGENT => 'uptime-pinger/1.0 (+keep-warm)',
        CURLOPT_HTTPHEADER => ['Cache-Control: no-cache'],
        // The body is irrelevant; discard it as it streams in.
        CURLOPT_WRITEFUNCTION => function ($ch, string $chunk): int {
            return strlen($chunk);
        },
        CURLOPT_HEADERFUNCTION => function ($ch, string $line) use ($meta): int {
            if (stripos($line, 'x-render-routing:') === 0) $meta['routing'] = strtolower(trim(substr($line, 17)));
            return strlen($line);
        },
    ];
    // Windows PHP builds ship without a CA bundle; use the OS store when running locally.
    if (PHP_OS_FAMILY === 'Windows' && defined('CURLSSLOPT_NATIVE_CA')) {
        $opts[CURLOPT_SSL_OPTIONS] = CURLSSLOPT_NATIVE_CA;
    }
    curl_setopt_array($ch, $opts);
    return $ch;
}

/** curl_errno() is always 0 for handles run through curl_multi; their result comes from curl_multi_info_read(). */
function ping_result($ch, ArrayObject $meta, int $at, ?int $errno = null): array
{
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $ms = (int) round(curl_getinfo($ch, CURLINFO_TOTAL_TIME) * 1000);
    $errno = $errno ?? curl_errno($ch);
    if ($errno === 0 && $code > 0) {
        $routing = $meta['routing'] ?? '';
        if (strpos($routing, 'no-server') !== false) {
            return ['at' => $at, 'ok' => false, 'statusCode' => $code, 'ms' => $ms, 'error' => 'no Render service at this URL'];
        }
        if (strpos($routing, 'suspend') !== false) {
            return ['at' => $at, 'ok' => false, 'statusCode' => $code, 'ms' => $ms, 'error' => 'Render service suspended'];
        }
        return ['at' => $at, 'ok' => $code < 500, 'statusCode' => $code, 'ms' => $ms, 'error' => null];
    }
    // 28 = CURLE_OPERATION_TIMEDOUT
    $error = $errno === 28 ? 'timeout ' . PING_TIMEOUT_S . 's' : (curl_error($ch) ?: ($errno ? curl_strerror($errno) : 'network error'));
    return ['at' => $at, 'ok' => false, 'statusCode' => null, 'ms' => $ms, 'error' => $error];
}

/**
 * Pings the given sites in parallel batches and stores each result.
 * Each site needs `id` and `url`. Returns results keyed by site id.
 */
function ping_sites(array $sites, bool $log = false): array
{
    $results = [];
    $store = function (array $site, $ch, ArrayObject $meta, int $at, ?int $errno) use (&$results, $log): void {
        $result = ping_result($ch, $meta, $at, $errno);
        record_ping((int) $site['id'], $result);
        $results[(int) $site['id']] = $result;
        if ($log) {
            $host = parse_url($site['url'], PHP_URL_HOST);
            $detail = trim(($result['statusCode'] ? "{$result['statusCode']} {$result['ms']}ms " : '') . ($result['error'] ?? ''));
            echo date('H:i:s', intdiv($at, 1000)) . ($result['ok'] ? ' OK   ' : ' FAIL ') . "$host → $detail\n";
            flush();
        }
    };

    if (!function_exists('curl_multi_exec')) {
        // Some free hosts (InfinityFree) disable curl_multi_exec; ping one at a time and save each result right away,
        // so a run cut short by the host's time limit still keeps what it finished.
        foreach ($sites as $site) {
            $at = now_ms();
            $meta = new ArrayObject();
            $ch = ping_handle($site['url'], $meta);
            curl_exec($ch);
            $store($site, $ch, $meta, $at, null);
            curl_close($ch);
        }
        return $results;
    }

    foreach (array_chunk($sites, PING_BATCH) as $batch) {
        $multi = curl_multi_init();
        $handles = [];
        $errnos = [];
        $at = now_ms();
        foreach ($batch as $site) {
            $meta = new ArrayObject();
            $ch = ping_handle($site['url'], $meta);
            curl_multi_add_handle($multi, $ch);
            $handles[] = [$site, $ch, $meta];
        }
        do {
            $status = curl_multi_exec($multi, $running);
            while ($info = curl_multi_info_read($multi)) $errnos[handle_key($info['handle'])] = (int) $info['result'];
            if ($running) curl_multi_select($multi, 1.0);
        } while ($running && $status === CURLM_OK);

        foreach ($handles as [$site, $ch, $meta]) {
            $store($site, $ch, $meta, $at, $errnos[handle_key($ch)] ?? null);
            curl_multi_remove_handle($multi, $ch);
            curl_close($ch);
        }
        curl_multi_close($multi);
    }
    return $results;
}

/** Curl handles are resources on PHP 7 and objects on PHP 8. */
function handle_key($ch): int
{
    return is_object($ch) ? spl_object_id($ch) : (int) $ch;
}

// ---------- views ----------

function site_view(array $row): array
{
    $history = array_map(function (array $h): array {
        $p = ['at' => (int) $h['at'], 'ok' => (bool) $h['ok'], 'statusCode' => $h['status_code'] === null ? null : (int) $h['status_code'], 'ms' => (int) $h['ms']];
        if ($h['error'] !== null) $p['error'] = $h['error'];
        return $p;
    }, q('SELECT at, ok, status_code, ms, error FROM pings WHERE site_id = ? ORDER BY at ASC', [$row['id']])->fetchAll());

    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'url' => $row['url'],
        'intervalMin' => (int) $row['interval_min'],
        'enabled' => (bool) $row['enabled'],
        'createdAt' => (int) $row['created_at'],
        'lastPingAt' => $row['last_ping_at'] === null ? null : (int) $row['last_ping_at'],
        'history' => $history,
    ];
}
