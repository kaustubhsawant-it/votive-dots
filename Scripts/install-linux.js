#!/usr/bin/env node
'use strict';
//
// Linux installer, per user, no root. What ./Scripts/install.sh does on a Mac, for the tray program:
//   1. copies the hook scripts to ~/.votive/bin, wires the hooks of every detected agent, wraps the Claude Code status line
//      (the doctor's repairs, so install and repair cannot drift)
//   2. copies the tray program (linux/ and Scripts/) to ~/.local/share/votive
//   3. writes a systemd user service, ~/.config/systemd/user/votive.service, enables it and starts it
//   4. Claude Code only: the notify MCP server and the /notify command, like install.sh
//
//   node Scripts/install-linux.js                 install (safe to run again)
//   node Scripts/install-linux.js --remove        stop and remove the service and the tray files, unwire hooks, restore the status line
//   --no-systemctl   write files only          --no-mcp   skip the MCP server (it runs npm install)
//
// Your agents' config files are backed up before they are changed. ~/.votive (your session state) is never deleted.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { repair, linuxPaths, UNIT } = require('./doctor');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const HOME = os.homedir();

/** The text of the systemd user unit. Quoted paths, so a space in a folder name is safe. */
function unitText(nodePath, trayPath) {
  // systemd: a backslash escapes " and \, a literal % is %% and a literal $ is $$
  const q = (s) => '"' + String(s).replace(/[\\"$%]/g, (c) => (c === '%' ? '%%' : c === '$' ? '$$' : '\\' + c)) + '"';
  return [
    '[Unit]',
    'Description=Votive Dots: one dot per AI coding agent session in the system tray',
    'After=graphical-session.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=' + q(nodePath) + ' ' + q(trayPath),
    'Restart=on-failure',
    'RestartSec=3',
    // The tray only reads ~/.votive and talks to the user\'s own D-Bus session over a unix socket. systemd enforces it (AF_UNIX alone rules out IP sockets; IPAddressDeny is not honoured in a user unit and only logs a warning).
    'RestrictAddressFamilies=AF_UNIX',
    'NoNewPrivileges=yes',
    // No PrivateTmp: in a user service it puts the process in a private user namespace, and then Linux refuses it the descriptor links of the user's own programs,
    // which the Ports list reads to name who owns a port (seen on Ubuntu 24.04). The tray writes nothing to /tmp.
    'MemoryMax=300M',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const say = (ok, what, output) => console.log((ok ? '  done  ' : '  FAIL  ') + what + (output ? ': ' + output.split('\n').join('\n        ') : ''));
const run = (cmd, a, opts = {}) => { const r = spawnSync(cmd, a, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts)); return { ok: r.status === 0, output: ((r.stdout || '') + (r.stderr || '')).trim(), missing: !!r.error }; };
const node = (script, extra) => run(process.execPath, [path.join(__dirname, script), ...extra]);

function copyApp(lp) {
  fs.mkdirSync(lp.appDir, { recursive: true });
  for (const sub of ['linux', 'Scripts']) {
    fs.rmSync(path.join(lp.appDir, sub), { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, sub), path.join(lp.appDir, sub), { recursive: true, filter: (src) => !/[\\/](node_modules|\.DS_Store)$/.test(src) });
  }
}

function installMcp() {
  const keep = path.join(HOME, '.votive', 'release');
  fs.mkdirSync(path.join(keep, 'mcp-server'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'Scripts'), path.join(keep, 'Scripts'), { recursive: true });
  for (const f of ['index.js', 'package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, 'mcp-server', f), path.join(keep, 'mcp-server', f));
  const mcp = path.join(keep, 'mcp-server');
  if (!fs.existsSync(path.join(mcp, 'node_modules'))) {
    const n = run('npm', ['install', '--omit=dev'], { cwd: mcp });
    if (!n.ok) return say(false, 'MCP server (npm install)', n.missing ? 'npm not found' : n.output.slice(-300));
  }
  if (run('claude', ['--version']).ok) {
    run('claude', ['mcp', 'remove', 'votive', '--scope', 'user']);
    const a = run('claude', ['mcp', 'add', '--scope', 'user', 'votive', '--', process.execPath, path.join(mcp, 'index.js')]);
    say(a.ok, 'Claude Code MCP server', a.ok ? '' : a.output);
  }
  fs.mkdirSync(path.join(HOME, '.claude', 'commands'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'Scripts', 'commands', 'notify.md'), path.join(HOME, '.claude', 'commands', 'notify.md'));
}

function main() {
  const lp = linuxPaths();
  const useSystemctl = !has('--no-systemctl');
  if (has('--remove')) {
    let ok = true;
    if (useSystemctl) run('systemctl', ['--user', 'disable', '--now', UNIT]);
    fs.rmSync(lp.unit, { force: true });
    fs.rmSync(lp.appDir, { recursive: true, force: true });
    if (useSystemctl) run('systemctl', ['--user', 'daemon-reload']);
    say(true, 'service and tray files removed');
    const a = node('install-agents.js', ['--remove']); say(a.ok, 'hooks', a.output); ok = ok && a.ok;
    const s = node('install-statusline.js', ['--remove']); say(s.ok, 'status line', s.output); ok = ok && s.ok;
    fs.rmSync(path.join(HOME, '.votive', 'bin'), { recursive: true, force: true });
    fs.rmSync(path.join(HOME, '.claude', 'commands', 'notify.md'), { force: true });
    if (run('claude', ['--version']).ok) run('claude', ['mcp', 'remove', 'votive', '--scope', 'user']);
    console.log('\n' + (ok ? 'Removed. ' : 'Removed, with problems (see above). ') + 'Your session state in ~/.votive was left in place.');
    return ok ? 0 : 1;
  }

  if (process.platform !== 'linux' && !process.env.VOTIVE_INSTALL_ANYWHERE) { console.error('This installer is for Linux. On a Mac run ./Scripts/install.sh; on Windows run node Scripts/install-windows.js.'); return 1; }
  if (parseInt(process.versions.node, 10) < 18) { console.error('Node 18 or later is needed (this is ' + process.versions.node + ').'); return 1; }
  let ok = true;
  // The status line wrapper is only for Claude Code: on a machine without it, do not create ~/.claude
  const hasClaude = fs.existsSync(path.join(HOME, '.claude')) || run('claude', ['--version']).ok;
  for (const r of repair(hasClaude ? ['scripts', 'hooks', 'statusline'] : ['scripts', 'hooks'])) { say(r.ok, r.repair, r.output); ok = ok && r.ok; }
  try { copyApp(lp); say(true, 'tray program', lp.appDir); } catch (e) { say(false, 'tray program', e.message); return 1; }
  try {
    fs.mkdirSync(lp.unitDir, { recursive: true });
    fs.writeFileSync(lp.unit, unitText(process.execPath, lp.tray));
    say(true, 'service file', lp.unit);
  } catch (e) { say(false, 'service file', e.message); return 1; }
  if (!has('--no-mcp') && (fs.existsSync(path.join(HOME, '.claude')) || run('claude', ['--version']).ok)) {
    try { installMcp(); } catch (e) { say(false, 'MCP server', e.message); ok = false; }
  }
  if (useSystemctl) {
    const steps = [['daemon-reload'], ['enable', UNIT], ['restart', UNIT]];
    for (const st of steps) {
      const r = run('systemctl', ['--user', ...st]);
      say(r.ok, 'systemctl --user ' + st.join(' '), r.ok ? '' : (r.missing ? 'systemctl not found: start the tray yourself with: node ' + lp.tray : r.output));
      if (!r.ok) { ok = false; break; }
    }
  }
  console.log(ok ? '\nInstalled. The dots appear in your tray; check with: node Scripts/doctor.js' : '\nSome steps failed (see above).');
  console.log('GNOME needs the AppIndicator extension to show a tray icon (Ubuntu has it on). Without a tray host nothing is drawn.');
  return ok ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { unitText };
