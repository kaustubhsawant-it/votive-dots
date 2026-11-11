'use strict';
//
// The Linux download (Scripts/make-linux-release.sh): a tarball with the tray, the shared scripts and an installer, no Mac pieces, no tests, a checksum that matches,
// and files that run. Built into a scratch folder.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const version = /MARKETING_VERSION: "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'project.yml'), 'utf8'))[1];
const NAME = 'Votive-Dots-' + version + '-linux';
const haveTar = (() => { try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const skip = !haveTar && 'needs tar';

test('linux release: the tarball holds the tray, the scripts and an installer, and nothing from the Mac build', { skip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-linux-rel-'));
  execFileSync('bash', [path.join(ROOT, 'Scripts', 'make-linux-release.sh')], { env: Object.assign({}, process.env, { VOTIVE_RELEASE_OUT: out }), stdio: 'pipe', cwd: ROOT });
  const tarball = path.join(out, NAME + '.tar.gz');
  assert.ok(fs.existsSync(tarball), 'named after the version in project.yml');
  const list = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const has = (p) => list.includes(NAME + '/' + p);
  for (const f of ['linux/votive-tray.js', 'linux/install.sh', 'linux/README.md', 'linux/dbus/bus.js', 'Scripts/install-linux.js', 'Scripts/votive-event.js', 'Scripts/doctor.js', 'Scripts/usage-habits.js',
    'mcp-server/index.js', 'mcp-server/package.json', 'LICENSE', 'INSTALL.txt', 'PRIVACY.md', 'SECURITY.md']) assert.ok(has(f), 'contains ' + f);
  assert.deepEqual(list.filter((p) => /\/tests\/|Votive\.app|\.xcodeproj|\.DS_Store|node_modules|Scripts\/(install|uninstall|make-release|build|test-linux)\.sh$|\/Votive\/|\.swift$/.test(p)), [], 'no Mac build, no tests, no node_modules');
  assert.ok(list.every((p) => p.startsWith(NAME + '/')), 'one top folder');
  // the checksum file matches the tarball
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS-linux.txt'), 'utf8').trim();
  assert.equal(sums, crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex') + '  ' + NAME + '.tar.gz');
  // what is inside runs: extract it and syntax-check every script, and the installer script is executable
  const ex = fs.mkdtempSync(path.join(os.tmpdir(), 'votive-linux-ex-'));
  execFileSync('tar', ['-xzf', tarball, '-C', ex]);
  const top = path.join(ex, NAME);
  assert.ok((fs.statSync(path.join(top, 'linux', 'install.sh')).mode & 0o111) !== 0, 'install.sh is executable');
  const js = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) js.push(p); } };
  walk(path.join(top, 'linux')); walk(path.join(top, 'Scripts'));
  assert.ok(js.length > 30);
  for (const f of js) execFileSync(process.execPath, ['--check', f]);
  const txt = fs.readFileSync(path.join(top, 'INSTALL.txt'), 'utf8');
  assert.match(txt, new RegExp('Votive Dots ' + version.replace(/\./g, '\\.') + ' for Linux'));
  assert.match(txt, /\.\/linux\/install\.sh/);
  assert.match(txt, /Node\.js 18/);
  assert.doesNotMatch(txt, /Votive\.app|macOS|brew /);
});

test('linux release: the script refuses to run without a linux folder or a version, and never writes outside its output folder', { skip }, () => {
  const src = fs.readFileSync(path.join(ROOT, 'Scripts', 'make-linux-release.sh'), 'utf8');
  assert.match(src, /set -euo pipefail/);
  assert.match(src, /\[ -d linux \]/);
  assert.match(src, /Could not read the version/);
  assert.match(src, /mv -f "\$WORK\/\$NAME\.tar\.gz" "\$TARBALL"/, 'written aside and moved into place');
});
