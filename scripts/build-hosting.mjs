// Builds the upload for PHP shared hosting: hosting/ (folder) and uptime-pinger-hosting.zip.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'hosting');
const zip = join(root, 'uptime-pinger-hosting.zip');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === 0;
}

if (!run('npx', ['ng', 'build'])) process.exit(1);

// Empty the folder rather than deleting it: the local Docker container keeps it mounted.
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) rmSync(join(out, entry), { recursive: true, force: true });
cpSync(join(root, 'dist', 'uptime-pinger', 'browser'), out, { recursive: true });
cpSync(join(root, 'php'), out, { recursive: true });

rmSync(zip, { force: true });
// Windows 10+ and macOS ship bsdtar, which writes zip archives with -a. On Windows, name it explicitly so
// Git's GNU tar (which cannot write zips) does not win the PATH lookup.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const zipped = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', out, '.'], { stdio: 'pipe' }).status === 0 && existsSync(zip);

console.log(`\nUpload ready: ${out}`);
console.log(zipped ? `Zip: ${zip}` : 'Zip skipped (no bsdtar); upload the folder contents instead.');
