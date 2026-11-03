<?php
// JSON API. Every request under api/ is rewritten here by api/.htaccess.
declare(strict_types=1);
require __DIR__ . '/lib.php';

class HttpError extends Exception
{
    public $status;

    public function __construct(int $status, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function send(int $status, $body = null): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    if ($body !== null) echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function body(): array
{
    $raw = (string) file_get_contents('php://input', false, null, 0, 64 * 1024);
    if ($raw === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) throw new HttpError(400, 'Invalid JSON');
    return $data;
}

// ---------- auth ----------

function set_session_cookie(string $token, int $maxAge): void
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    setcookie('sid', $token, [
        'expires' => $maxAge > 0 ? time() + $maxAge : time() - 3600,
        'path' => '/',
        'secure' => $https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function start_session(int $userId): void
{
    $token = bin2hex(random_bytes(32));
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [$token, $userId, now_ms() + SESSION_DAYS * 86400000]);
    set_session_cookie($token, SESSION_DAYS * 86400);
}

function current_user(): ?array
{
    $token = $_COOKIE['sid'] ?? '';
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) return null;
    $user = q(
        'SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token = ? AND sessions.expires_at > ?',
        [$token, now_ms()]
    )->fetch();
    return $user ? $user + ['token' => $token] : null;
}

function credentials(array $body): array
{
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');
    if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $email)) throw new HttpError(400, 'Enter a valid email');
    if (strlen($password) < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    return [$email, $password];
}

// ---------- validation ----------

function valid_url($raw): string
{
    $url = trim((string) $raw);
    $scheme = strtolower((string) parse_url($url, PHP_URL_SCHEME));
    if (filter_var($url, FILTER_VALIDATE_URL) && ($scheme === 'http' || $scheme === 'https')) return $url;
    throw new HttpError(400, 'Enter a full http(s) URL');
}

function valid_interval($raw): int
{
    $n = is_numeric($raw) && (float) $raw == (int) $raw ? (int) $raw : 0;
    if (!in_array($n, INTERVALS, true))throw new HttpError(400, 'Interval must be one of ' . implode(', ', INTERVALS));
    return $n;
}

function owned_site(int $userId, int $id): array
{
    $site = q('SELECT * FROM sites WHERE id = ? AND user_id = ?', [$id, $userId])->fetch();
    if (!$site) throw new HttpError(404, 'Site not found');
    return $site;
}

function clean_name($raw): string
{
    return function_exists('mb_substr') ? mb_substr(trim((string) $raw), 0, 80) : substr(trim((string) $raw), 0, 80);
}

// ---------- routes ----------

function route(string $method, string $path): void
{
    if ($method === 'POST' && $path === '/signup') {
        [$email, $password] = credentials(body());
        if (q('SELECT 1 FROM users WHERE email = ?', [$email])->fetch()) {
            throw new HttpError(409, 'An account with that email already exists');
        }
        q('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)', [$email, password_hash($password, PASSWORD_DEFAULT), now_ms()]);
        start_session((int) db()->lastInsertId());
        send(201, ['email' => $email]);
    }

    if ($method === 'POST' && $path === '/login') {
        $body = body();
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $user = q('SELECT id, email, pass_hash FROM users WHERE email = ?', [$email])->fetch();
        if (!$user || !password_verify((string) ($body['password'] ?? ''), $user['pass_hash'])) {
            throw new HttpError(401, 'Wrong email or password');
        }
        start_session((int) $user['id']);
        send(200, ['email' => $user['email']]);
    }

    $user = current_user();

    if ($method === 'POST' && $path === '/logout') {
        if ($user) q('DELETE FROM sessions WHERE token = ?', [$user['token']]);
        set_session_cookie('', 0);
        send(204);
    }

    if ($method === 'GET' && $path === '/me') {
        $user ? send(200, ['email' => $user['email']]) : send(401, ['error' => 'Not signed in']);
    }

    if (!$user) throw new HttpError(401, 'Not signed in');
    $uid = (int) $user['id'];

    if ($method === 'GET' && $path === '/sites') {
        $rows = q('SELECT * FROM sites WHERE user_id = ? ORDER BY created_at', [$uid])->fetchAll();
        send(200, ['intervals' => INTERVALS, 'sites' => array_map('site_view', $rows)]);
    }

    if ($method === 'POST' && $path === '/sites') {
        $body = body();
        $url = valid_url($body['url'] ?? '');
        $interval = valid_interval($body['intervalMin'] ?? 10);
        $name = clean_name($body['name'] ?? '') ?: (string) parse_url($url, PHP_URL_HOST);
        q('INSERT INTO sites (user_id, name, url, interval_min, created_at) VALUES (?, ?, ?, ?, ?)', [$uid, $name, $url, $interval, now_ms()]);
        $site = owned_site($uid, (int) db()->lastInsertId());
        // First ping right away so the new card shows a real result.
        ping_sites([$site]);
        send(201, site_view(owned_site($uid, (int) $site['id'])));
    }

    if (preg_match('#^/sites/(\d+)(?:/(ping|delete))?$#', $path, $m)) {
        $site = owned_site($uid, (int) $m[1]);
        $action = $m[2] ?? '';

        if ($method === 'POST' && $action === 'ping') {
            ping_sites([$site]);
            send(200, site_view(owned_site($uid, (int) $site['id'])));
        }

        // POST aliases exist because some shared hosts block PATCH and DELETE.
        if (($method === 'PATCH' || $method === 'POST') && $action === '') {
            $body = body();
            $name = array_key_exists('name', $body) ? (clean_name($body['name']) ?: $site['name']) : $site['name'];
            $interval = array_key_exists('intervalMin', $body) ? valid_interval($body['intervalMin']) : (int) $site['interval_min'];
            $enabled = array_key_exists('enabled', $body) ? ($body['enabled'] ? 1 : 0) : (int) $site['enabled'];
            q('UPDATE sites SET name = ?, interval_min = ?, enabled = ? WHERE id = ?', [$name, $interval, $enabled, $site['id']]);
            send(200, site_view(owned_site($uid, (int) $site['id'])));
        }

        if (($method === 'DELETE' && $action === '') || ($method === 'POST' && $action === 'delete')) {
            q('DELETE FROM sites WHERE id = ?', [$site['id']]);
            send(204);
        }
    }

    throw new HttpError(404, 'Not found');
}

// ---------- dispatch ----------

// The app may live in a subfolder, so take whatever follows the last "/api" in the path.
$uri = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$pos = strrpos($uri, '/api/');
$path = $pos === false ? '/' : substr($uri, $pos + 4);
$path = '/' . trim((string) preg_replace('#^/index\.php#', '', $path), '/');

// A ping can take up to 60s on a cold start.
extend_time_limit(PING_TIMEOUT_S + 30);
// Creates data/config.json (with the cron key) on the first visit, not only on the first cron run.
config();

try {
    route($_SERVER['REQUEST_METHOD'] ?? 'GET', $path);
} catch (HttpError $e) {
    send($e->status, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('uptime-pinger: ' . $e);
    send(500, ['error' => 'Server error']);
}
