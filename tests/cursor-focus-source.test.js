'use strict';
//
// Clicking a Cursor session raises the Cursor window that has the session's folder open. The rule is
// narrow on purpose: only agent "cursor" in the Cursor app, only an absolute directory. Another agent's
// cwd may be a sub-folder, and handing that to an editor opens a new window. Swift has no unit test target
// here, so this guards the source (same idea as tests/windows-source.test.js).
//
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'Votive', f), 'utf8');
const focus = read('Services/TerminalFocus.swift');

test('the workspace is handed over for Cursor sessions only', () => {
  assert.match(focus, /agent == "cursor" && bundle == cursorBundleID && cwd\.hasPrefix\("\/"\)/);
  assert.match(focus, /cursorBundleID = "com\.todesktop\.230313mzl4w4u92"/);
});

test('the folder goes through Reveal (plain folders only), not straight to NSWorkspace', () => {
  assert.match(focus, /Reveal\.folder\(cwd, inEditorAt: url\)/);
  assert.doesNotMatch(focus.replace(/\/\/.*$/gm, ''), /NSWorkspace\.shared\.open\(\[/);
  assert.match(read('Services/Reveal.swift'), /guard case \.openFolderWindow\(let url\) = plan\(forFolder: raw\) else \{ return false \}/);
});

test('every row, banner and dialog click passes the agent and folder', () => {
  const rows = read('UI/AgentRowView.swift');
  const menu = read('UI/StatusItemController.swift');
  assert.match(rows, /TerminalFocus\.focus\(sessionPID: session\.pid, agent: session\.agent, cwd: session\.cwd\)/);
  assert.match(menu, /TerminalFocus\.focus\(sessionPID: pid, agent: s\.agent, cwd: s\.cwd\)/);
  assert.match(menu, /TerminalFocus\.focus\(sessionPID: ref\.pid, agent: ref\.agent, cwd: ref\.cwd\)/);
});
