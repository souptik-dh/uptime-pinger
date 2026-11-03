// Runs the built upload locally the way shared hosting does: Apache + PHP, .htaccess, and cron.php every minute.
// Uses Docker because Windows Application Control blocks PHP's curl extension on this machine.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'uptime-pinger-local';
const port = process.env.PORT ?? '3000';
const image = process.env.PHP_IMAGE ?? 'php:8.3-apache';
const dataDir = join(root, '.local-data');

if (!existsSync(join(root, 'hosting', 'index.html'))) {
  console.error('hosting/ is missing. Run "npm run build" first.');
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });

spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
const boot = [
  'set -e',
  'a2enmod rewrite headers >/dev/null',
  'chmod 777 /data',
  // cPanel's cron job does this on the real host.
  "(while true; do runuser -u www-data -- env UPTIME_DATA_DIR=/data php /var/www/html/api/cron.php >> /proc/1/fd/1 2>&1; sleep 60; done) &",
  'exec apache2-foreground',
].join('\n');

const run = spawnSync(
  'docker',
  [
    'run', '-d', '--name', name, '-p', `${port}:80`,
    '-e', 'UPTIME_DATA_DIR=/data',
    '-v', `${join(root, 'hosting')}:/var/www/html`,
    // PHP edits in php/api apply without rebuilding.
    '-v', `${join(root, 'php', 'api')}:/var/www/html/api`,
    '-v', `${dataDir}:/data`,
    image, 'bash', '-c', boot,
  ],
  { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
);
if (run.status !== 0) {
  console.error('Could not start the container. Is Docker Desktop running?');
  process.exit(1);
}

console.log(`\nINFO running on http://localhost:${port}  (data in ${dataDir})`);
console.log(`INFO Ctrl+C stops following logs; "docker rm -f ${name}" stops the app.\n`);
spawn('docker', ['logs', '-f', name], { stdio: 'inherit' });
