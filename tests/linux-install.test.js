'use strict';
//
// The Linux installer (Scripts/install-linux.js) and the doctor's Linux checks. The installer runs in a throwaway HOME, in a child process,
// so the real home folder is never touched; --no-systemctl keeps it from talking to a service manager.
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { unitText } = require('../Scripts/install-linux');

const ROOT = path.join(__dirname, '..');
const installer = path.join(ROOT, 'Scripts', 'install-linux.js');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'votive-inst-'));
const env = (h, extra) => Object.assign({ PATH: process.env.PATH, HOME: h, VOTIVE_INSTALL_ANYWHERE: '1' }, extra);
const run = (h, args, extra) => spawnSync(process.execPath, [installer, ...args], { env: env(h, extra), encoding: 'utf8', timeout: 60000 });

test('the unit file: quoted command, only unix sockets, no new privileges, starts at login', () => {
  const u = unitText('/usr/bin/node', '/home/a/.local/share/votive/linux/votive-tray.js');
  assert.match(u, /^ExecStart="\/usr\/bin\/node" "\/home\/a\/\.local\/share\/votive\/linux\/votive-tray\.js"$/m);
  assert.match(u, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.doesNotMatch(u, /IPAddressDeny/);                                    // not honoured in a user unit: it only makes systemd warn
  assert.match(u, /^NoNewPrivileges=yes$/m);
  assert.match(u, /^Restart=on-failure$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
  assert.deepEqual(u.split('\n').filter((l) => /^\[/.test(l)), ['[Unit]', '[Service]', '[Install]']);
  // a path with a space, a quote, a dollar sign and a percent sign survives systemd's rules
  const odd = unitText('/opt/my node/bin/node', '/home/a"b/$x%y/votive-tray.js');
  assert.match(odd, /^ExecStart="\/opt\/my node\/bin\/node" "\/home\/a\\"b\/\$\$x%%y\/votive-tray\.js"$/m);
});

test('install: copies the tray program and the scripts, writes the service file, and the installed copy runs on its own', () => {
  const h = home();
  try {
    const r = run(h, ['--no-systemctl', '--no-mcp']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const data = path.join(h, '.local', 'share', 'votive');
    for (const f of ['linux/votive-tray.js', 'linux/sessions.js', 'linux/icon.js', 'linux/tray.js', 'linux/dbus/bus.js', 'linux/dbus/wire.js', 'linux/dbus/dbusmenu.js', 'Scripts/overlay-settings.js', 'Scripts/overlay-paths.js']) {
      assert.ok(fs.existsSync(path.join(data, f)), f);
    }
    const unit = fs.readFileSync(path.join(h, '.config', 'systemd', 'user', 'votive.service'), 'utf8');
    assert.ok(unit.includes('"' + process.execPath + '" "' + path.join(data, 'linux', 'votive-tray.js') + '"'));
    assert.ok(fs.existsSync(path.join(h, '.votive', 'bin', 'votive-event.js')), 'the hook scripts are in place');
    // run again: safe
    assert.equal(run(h, ['--no-systemctl', '--no-mcp']).status, 0);
    // the installed copy is self-contained: it needs nothing from the folder it was installed from
    const events = path.join(h, '.votive', 'events');
    fs.mkdirSync(events, { recursive: true });
    fs.writeFileSync(path.join(events, 'codex--z.json'), JSON.stringify({ agent: 'codex', sessionId: 'z', lastEvent: 'done', lastEventAt: Date.now(), cwd: '/a/proj' }));
    const p = spawnSync(process.execPath, [path.join(data, 'linux', 'votive-tray.js'), '--print'], { env: { PATH: process.env.PATH, HOME: h }, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout).sessions[0].name, 'proj');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('install on a machine without Claude Code does not create ~/.claude', () => {
  const h = home();
  try {
    const r = spawnSync(process.execPath, [installer, '--no-systemctl', '--no-mcp'], { env: { PATH: '/usr/bin:/bin', HOME: h, VOTIVE_INSTALL_ANYWHERE: '1' }, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(path.join(h, '.claude')), 'no Claude Code, so no ~/.claude');
    assert.ok(fs.existsSync(path.join(h, '.votive', 'bin', 'votive-event.js')));
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('remove: deletes the service and the tray files, keeps the session state', () => {
  const h = home();
  try {
    assert.equal(run(h, ['--no-systemctl', '--no-mcp']).status, 0);
    fs.mkdirSync(path.join(h, '.votive', 'events'), { recursive: true });
    fs.writeFileSync(path.join(h, '.votive', 'events', 'keep.json'), '{}');
    const r = run(h, ['--remove', '--no-systemctl']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(path.join(h, '.local', 'share', 'votive')));
    assert.ok(!fs.existsSync(path.join(h, '.config', 'systemd', 'user', 'votive.service')));
    assert.ok(!fs.existsSync(path.join(h, '.votive', 'bin')));
    assert.ok(fs.existsSync(path.join(h, '.votive', 'events', 'keep.json')), 'session state is never deleted');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('on a Mac or Windows the Linux installer refuses without touching anything', { skip: process.platform === 'linux' && 'this is Linux' }, () => {
  const h = home();
  try {
    const r = spawnSync(process.execPath, [installer, '--no-systemctl'], { env: { PATH: process.env.PATH, HOME: h }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /for Linux/);
    assert.deepEqual(fs.readdirSync(h), []);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('doctor on Linux: tray installed, service not running (no systemd here), and the report names the tray host', { skip: process.platform !== 'linux' && 'the Linux checks run on Linux' }, () => {
  const h = home();
  try {
    assert.equal(run(h, ['--no-systemctl', '--no-mcp']).status, 0);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'Scripts', 'doctor.js')], { env: { PATH: process.env.PATH, HOME: h }, encoding: 'utf8' });
    assert.match(r.stdout, /ok\s+app-installed\s+.*votive-tray\.js/);
    assert.match(r.stdout, /FAIL\s+app-running/);
    assert.match(r.stdout, /(warn|ok)\s+tray-host/);
    assert.match(r.stdout, /ok\s+scripts\s+Up to date/);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
