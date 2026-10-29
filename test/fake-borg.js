#!/usr/bin/env node
const fs = require ('node:fs');
const path = require ('node:path');
const assert = require ('node:assert/strict');
const dir = process.env.FAKE_BORG_DIR;
const major = Number (process.env.FAKE_BORG_MAJOR);
let args = process.argv.slice (2);
fs.appendFileSync (path.join (dir, 'calls.jsonl'), JSON.stringify ({ args, cwd: process.cwd () }) + '\n');
if (args[0] === '--version') {
    console.log (process.env.FAKE_BORG_VERSION ?? ('borg ' + (major === 1 ? '1.4.5' : '2.0.0b25')));
    process.exit (0);
}
if (major === 2) {
    assert.equal (args[0], '--repo');
    assert.equal (args[1], path.join (dir, 'repo'));
    args = args.slice (2);
} else {
    assert.ok (args.at (-1).startsWith (path.join (dir, 'repo')));
}
const command = args[0];
const data = JSON.parse (fs.readFileSync (path.join (dir, 'repository.json'), 'utf8'));
if (command === 'repo-list' || (command === 'list' && args.includes ('--json'))) {
    assert.equal (command, major === 1 ? 'list' : 'repo-list');
    console.log (JSON.stringify ({ archives: data.archives }));
    if (data.repoSignal) process.kill (process.pid, 'SIGTERM');
    process.exit (data.repoExit ?? 0);
}
if (command === 'list') {
    assert.ok (args.includes ('--json-lines'));
    assert.equal (args[args.indexOf ('--format') + 1], '{type} {path} {size} {isomtime}');
    const target = major === 2 ? args.at (-1) : args.at (-1).split ('::')[1];
    assert.ok (data.archives.some (e => target === e.name || (major === 2 && target === 'aid:' + e.id)), 'Unknown archive ' + target);
    for (const item of data.items) console.log (JSON.stringify (item));
    if (data.listSignal) process.kill (process.pid, 'SIGTERM');
    process.exit (data.listExit ?? 0);
}
assert.equal (command, 'extract');
const target = major === 2 ? args.at (-1) : args.at (-1).split ('::')[1];
assert.ok (data.archives.some (e => target === e.name || (major === 2 && target === 'aid:' + e.id)), 'Unknown archive ' + target);
assert.ok (args.includes ('--sparse'));
const patterns = fs.readFileSync (args[args.indexOf ('--patterns-from') + 1], 'utf8');
assert.ok (patterns.includes ('+pf:file\n'));
assert.ok (patterns.endsWith ('!*\n'));
if (major === 2) assert.equal (fs.readdirSync ('.').length, 0);
if (!data.extractExit) fs.writeFileSync ('file', args.at (-1));
console.error ('Restored file');
process.exit (data.extractExit ?? 0);
