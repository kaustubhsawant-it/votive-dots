// Test fixture: a realistic main-window state (five sessions, twelve synthetic days of usage), used by Scripts/test-linux-main-ui.sh.
const root = process.argv[2], out = process.argv[3];  // writes out/state.json: a realistic state for the main window
const path = require('path');
const ms = require(path.join(__dirname, '..', 'linux', 'mainstate')), MI = require(path.join(__dirname, '..', 'linux', 'menuicons')), icon = require(path.join(__dirname, '..', 'linux', 'icon'));
const habits = require('./usage-habits'), pacing = require('./usage-pacing');
const now = Date.UTC(2026, 10, 11, 9, 0, 0);
// twelve synthetic days of usage: weekday evenings heavy, weekend light, weekly window resets every 7 days
const samples = []; let w = 0; const wr = Math.floor((now + 3 * 86400e3) / 1000);
for (let t = now - 12 * 86400e3; t <= now; t += 3600e3) {
  const d = new Date(t), h = d.getHours(), we = d.getDay() === 0 || d.getDay() === 6;
  const add = (we ? 0.15 : 0.1) + (h >= 18 && h <= 22 ? (we ? 0.7 : 2.0) : h >= 10 && h <= 12 ? 0.6 : 0);
  w = Math.min(95, w + add); samples.push({ t, w, wr });
}
const icons = {}; for (const s of Object.keys(icon.COLORS)) icons[s] = MI.stateIcon(s, { shapes: true, size: 40 }).toString('base64');
const S = (o) => Object.assign({ lastActivityAt: now - 30000, prompt: '', cwd: '/home/dev/' + o.name }, o);
const sessions = [
  S({ key: 'codex:s2', name: 'web', agentName: 'Codex', state: 'needsInput', label: 'needs you', prompt: 'which database should I use?' }),
  S({ key: 'claude-code:s1', name: 'api', agentName: 'Claude Code', state: 'working', label: 'working', prompt: 'fix the login bug' }),
  S({ key: 'cursor:s5', name: 'mobile', agentName: 'Cursor', state: 'working', label: 'working', prompt: 'add the profile screen' }),
  S({ key: 'gemini:s4', name: 'infra', agentName: 'Gemini CLI', state: 'stuck', label: 'stuck', prompt: 'migrate terraform and update every module that references the old backend' }),
  S({ key: 'claude-code:s3', name: 'docs', agentName: 'Claude Code', state: 'done', label: 'done', prompt: 'write the readme', lastActivityAt: now - 240000 })];
const analysis = habits.analyse(samples, { target: 80, now });
const st = ms.buildMainState({ now, sessions, icons, usage: { agents: [{ agentName: 'Claude Code', windows: [{ label: 'Session', usedPercentage: 43, resetsAtMs: now + 3 * 3600e3 }, { label: 'Weekly', usedPercentage: 92, resetsAtMs: now + 3 * 86400e3 }] }] },
  priority: { pins: { 'codex:s2': 1 }, folders: {}, onlyPriority: false }, analysis, pacing: pacing.format(pacing.advise(samples, { target: 80, conserve: 85 })), use: habits.hourlyUse(samples), samples,
  settings: { colorblindShapes: false, soundDone: 'Hero' }, keepAwake: true, heat: { hot: true, c: 97 }, summary: '1 needs you, 2 working, 1 stuck, 1 done', version: '1.8.2',
  agents: [{ id: 'claude-code', name: 'Claude Code', detected: true }, { id: 'codex', name: 'Codex', detected: true }, { id: 'cursor', name: 'Cursor', detected: true }, { id: 'gemini', name: 'Gemini CLI', detected: false }] });
require('fs').writeFileSync(out + '/state.json', JSON.stringify(Object.assign({ t: 'state' }, st)) + '\n');
console.log('insights:', st.insights.map((i) => i.id).join(','), '| forecast has:', st.forecast.has, '| daily nonzero:', st.habits.daily.filter((d) => d.points > 0).length);
