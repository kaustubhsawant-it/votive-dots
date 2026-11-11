'use strict';
//
// Small actions of the menu that need a program of the desktop: putting text on the clipboard. Same stance as focus.js: only a fixed set of tools,
// found in the usual places, started with an argument list (never a shell), the text given on standard input (never as an argument).
//   Wayland: wl-copy (package wl-clipboard).  X11: xclip, or xsel.
//
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const find = (name, ex = exists) => { for (const d of BIN_DIRS) if (ex(path.join(d, name))) return path.join(d, name); return null; };
const MAX_TEXT = 4096;
const TIMEOUT_MS = 3000;

/** The tool to use for this desktop session: { bin, args } or null. Wayland first when the session has it, else X11. */
function clipboardTool(env = process.env, ex = exists) {
  if (env.WAYLAND_DISPLAY) { const b = find('wl-copy', ex); if (b) return { bin: b, args: [] }; }
  if (env.DISPLAY) {
    const x = find('xclip', ex);
    if (x) return { bin: x, args: ['-selection', 'clipboard'] };
    const s = find('xsel', ex);
    if (s) return { bin: s, args: ['--clipboard', '--input'] };
  }
  return null;
}

/** Why nothing can be copied here, in words for the person. */
function whyNoClipboard(env = process.env, ex = exists) {
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) return 'no display';
  return env.WAYLAND_DISPLAY && !env.DISPLAY ? 'install wl-clipboard (sudo apt install wl-clipboard)' : 'install xclip (sudo apt install xclip)';
}

/** Puts `text` on the clipboard. Resolves { ok, why }. */
function copyText(text, { env = process.env, ex = exists, spawnFn = spawn } = {}) {
  const tool = clipboardTool(env, ex);
  if (!tool) return Promise.resolve({ ok: false, why: whyNoClipboard(env, ex) });
  const clean = String(text).slice(0, MAX_TEXT);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const childEnv = {};
    for (const k of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (env[k]) childEnv[k] = env[k];
    let child;
    try { child = spawnFn(tool.bin, tool.args, { env: childEnv, stdio: ['pipe', 'ignore', 'ignore'] }); } catch (e) { return resolve({ ok: false, why: 'could not start ' + path.basename(tool.bin) }); }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish({ ok: false, why: path.basename(tool.bin) + ' did not answer' }); }, TIMEOUT_MS);
    timer.unref();
    child.on('error', () => finish({ ok: false, why: 'could not start ' + path.basename(tool.bin) }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, why: '' } : { ok: false, why: path.basename(tool.bin) + ' failed' }));
    child.stdin.on('error', () => { /* it exited early: close reports it */ });
    child.stdin.end(clean);
  });
}

/** The tool that reads the clipboard: { bin, args } or null. Same order as clipboardTool. */
function pasteTool(env = process.env, ex = exists) {
  if (env.WAYLAND_DISPLAY) { const b = find('wl-paste', ex); if (b) return { bin: b, args: ['--no-newline'] }; }
  if (env.DISPLAY) {
    const x = find('xclip', ex);
    if (x) return { bin: x, args: ['-selection', 'clipboard', '-out'] };
    const s = find('xsel', ex);
    if (s) return { bin: s, args: ['--clipboard', '--output'] };
  }
  return null;
}

const childEnvOf = (env) => { const e = {}; for (const k of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (env[k]) e[k] = env[k]; return e; };

/** Reads the text on the clipboard (at most MAX_TEXT characters). Resolves { ok, text, why }. Only called when the person clicks "Add from clipboard". */
function readText({ env = process.env, ex = exists, spawnFn = spawn } = {}) {
  const tool = pasteTool(env, ex);
  if (!tool) return Promise.resolve({ ok: false, text: '', why: whyNoClipboard(env, ex) });
  return new Promise((resolve) => {
    let done = false, out = '';
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try { child = spawnFn(tool.bin, tool.args, { env: childEnvOf(env), stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return resolve({ ok: false, text: '', why: 'could not start ' + path.basename(tool.bin) }); }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish({ ok: false, text: '', why: path.basename(tool.bin) + ' did not answer' }); }, TIMEOUT_MS);
    timer.unref();
    child.on('error', () => finish({ ok: false, text: '', why: 'could not start ' + path.basename(tool.bin) }));
    child.stdout.on('data', (d) => { if (out.length < MAX_TEXT) out += d.toString('utf8'); });
    child.on('close', (code) => finish(code === 0 ? { ok: true, text: out.slice(0, MAX_TEXT), why: '' } : { ok: false, text: '', why: 'the clipboard has no text' }));
  });
}

/**
 * How to start a program for the person: through the user's systemd manager (`systemd-run --user`) when there is one, else directly. The tray runs with NoNewPrivileges, and a
 * process that inherits it cannot start a snap application (Ubuntu's Firefox: "snap-confine ... cannot continue", seen in the VM); a program started by the manager is not
 * bound by it. Returns { bin, args } for spawn. The desktop variables are passed on explicitly.
 */
function launcher(bin, args, { env = process.env, ex = exists } = {}) {
  const sr = find('systemd-run', ex);
  if (!sr) return { bin, args };
  const pass = [];
  for (const k of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE']) if (env[k]) pass.push('-E', k + '=' + env[k]);
  return { bin: sr, args: ['--user', '--quiet', '--collect', '--no-block'].concat(pass, ['--', bin], args) };
}

/** Opens a file with the desktop's default program (xdg-open, started with an argument list, never a shell). Resolves { ok, why }. */
function openFile(file, { env = process.env, ex = exists, spawnFn = spawn } = {}) {
  const bin = find('xdg-open', ex);
  if (!bin) return Promise.resolve({ ok: false, why: 'install xdg-utils (sudo apt install xdg-utils)' });
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.resolve({ ok: false, why: 'no display' });
  return new Promise((resolve) => {
    let child;
    const l = launcher(bin, [String(file)], { env, ex });
    try { child = spawnFn(l.bin, l.args, { env: Object.assign(childEnvOf(env), { PATH: '/usr/bin:/bin' }), stdio: 'ignore', detached: true }); } catch (e) { return resolve({ ok: false, why: 'could not start xdg-open' }); }
    child.on('error', () => resolve({ ok: false, why: 'could not start xdg-open' }));
    if (child.unref) child.unref();
    setImmediate(() => resolve({ ok: true, why: '' }));   // xdg-open can stay up as long as the program it started; the start is what we can know
  });
}

/**
 * Shows a folder in the file manager. The path may come from an event file an agent wrote, so it is untrusted: it must be absolute and, after
 * resolving links, an existing directory. Only directories are ever passed to xdg-open (a file could be run by whatever handles its type).
 */
function openFolder(dir, opts = {}) {
  const real = opts.realpath || fs.realpathSync;
  const stat = opts.stat || fs.statSync;
  let target;
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) return Promise.resolve({ ok: false, why: 'not an absolute path' });
    target = real(dir);
    if (!stat(target).isDirectory()) return Promise.resolve({ ok: false, why: 'not a folder' });
  } catch (e) { return Promise.resolve({ ok: false, why: 'that folder is gone' }); }
  return openFile(target, opts);
}

const BROWSERS = ['x-www-browser', 'sensible-browser', 'firefox', 'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'brave-browser', 'microsoft-edge', 'epiphany'];

/**
 * Shows one of our own .html files in a web browser. `xdg-open` would hand it to whatever handles HTML, which can be a text editor (it was, in a clean Ubuntu VM),
 * so a browser is started directly: the system's choice (`x-www-browser`) first, then the usual ones, with the file as a file:// address in an argument list.
 * Falls back to xdg-open when no browser is found.
 */
function openInBrowser(file, opts = {}) {
  const ex = opts.ex || exists;
  const env = opts.env || process.env;
  const spawnFn = opts.spawnFn || spawn;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.resolve({ ok: false, why: 'no display' });
  const dirs = BIN_DIRS.concat(['/snap/bin']);
  let bin = null;
  for (const name of BROWSERS) { bin = dirs.map((d) => path.join(d, name)).find(ex); if (bin) break; }
  if (!bin) return openFile(file, opts);
  const url = 'file://' + String(file).split('/').map(encodeURIComponent).join('/');
  return new Promise((resolve) => {
    let child;
    const l = launcher(bin, [url], { env, ex });
    try { child = spawnFn(l.bin, l.args, { env: Object.assign(childEnvOf(env), { PATH: '/usr/bin:/bin:/snap/bin', HOME: env.HOME || '' }), stdio: 'ignore', detached: true }); } catch (e) { return resolve({ ok: false, why: 'could not start ' + path.basename(bin) }); }
    child.on('error', () => resolve({ ok: false, why: 'could not start ' + path.basename(bin) }));
    if (child.unref) child.unref();
    setImmediate(() => resolve({ ok: true, why: '' }));
  });
}

const TRANSCRIPT_EXTENSIONS = new Set(['.jsonl', '.json', '.log', '.txt', '.md']);
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

/**
 * Opens a session's transcript with the desktop's default viewer. The path comes from an event file an agent wrote, so it is untrusted: it must be absolute and,
 * after resolving links, a regular file with a text-like extension, no bigger than 50 MB and not executable. Anything else is refused and never reaches xdg-open
 * (a file of another kind could be run by whatever handles its type).
 */
function openTranscript(file, opts = {}) {
  const real = opts.realpath || fs.realpathSync;
  const stat = opts.stat || fs.statSync;
  let target;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return Promise.resolve({ ok: false, why: 'not an absolute path' });
    target = real(file);
    const st = stat(target);
    if (!st.isFile()) return Promise.resolve({ ok: false, why: 'not a file' });
    if (!TRANSCRIPT_EXTENSIONS.has(path.extname(target).toLowerCase())) return Promise.resolve({ ok: false, why: 'not a text transcript (it is not opened, so nothing can run)' });
    if ((st.mode & 0o111) !== 0) return Promise.resolve({ ok: false, why: 'that file is executable, so it is not opened' });
    if (st.size > MAX_TRANSCRIPT_BYTES) return Promise.resolve({ ok: false, why: 'that transcript is bigger than 50 MB' });
  } catch (e) { return Promise.resolve({ ok: false, why: 'that file is gone' }); }
  return openFile(target, opts);
}

module.exports = { clipboardTool, whyNoClipboard, copyText, pasteTool, readText, openFile, openFolder, openTranscript, openInBrowser, launcher };
