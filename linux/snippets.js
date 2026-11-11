'use strict';
//
// Prompt snippets: reusable prompts in ~/.votive/snippets.json (a plain array of strings), the same file and the same rules as the Mac's SnippetStore.
// Clicking one in the menu puts it on the clipboard so it can be pasted into any agent's terminal.
//
const fs = require('fs');
const path = require('path');

const LIMIT = 1024 * 1024;   // a bigger file is not a list of prompts
const EXAMPLES = ['Review the changes on this branch and list any bugs.', 'Run the tests and fix anything that fails.', 'Explain what this file does, briefly.'];

const fileOf = (root) => path.join(root, 'snippets.json');

/** The snippets, or null when the file exists but is not a JSON array of strings (a hand edit left a trailing comma). A missing file is an empty list. */
function loadStrict(root) {
  const file = fileOf(root);
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > LIMIT) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (e) { return e.code === 'ENOENT' ? [] : null; }
  let arr;
  try { arr = JSON.parse(text); } catch (e) { return null; }
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) return null;
  return arr.filter((x) => x.trim() !== '');
}

const load = (root) => loadStrict(root) || [];

function save(root, snippets) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = fileOf(root);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snippets, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Adds one snippet: 'added', 'duplicate', 'empty' or 'unreadable'. It never replaces a file it could not read, so a broken hand edit is reported and left alone. */
function add(root, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return 'empty';
  const arr = loadStrict(root);
  if (arr === null) return 'unreadable';
  if (arr.includes(t)) return 'duplicate';
  arr.push(t);
  save(root, arr);
  return 'added';
}

/** Creates the file with a few examples when there is none, so "Edit snippets" always opens something. */
function ensureFile(root) {
  if (fs.existsSync(fileOf(root))) return;
  save(root, EXAMPLES);
}

/** One line of the menu for a snippet: line breaks become spaces, 48 characters at most (as on the Mac). */
function shown(text) {
  const one = text.replace(/\s*\n\s*/g, ' ');
  return one.length > 48 ? one.slice(0, 48).trimEnd() + '…' : one;
}

module.exports = { loadStrict, load, add, save, ensureFile, shown, fileOf, EXAMPLES };
