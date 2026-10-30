const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs/promises');
const os = require ('node:os');
const path = require ('node:path');
const { randomUUID } = require ('node:crypto');
const { backupSchema } = require ('../dist/management-schema');
const { createBackupExecutor, createArguments, pruneArguments, pullInvocation } = require ('../dist/backup-engine');
const { RedactingStream } = require ('../dist/backup-process');
const DBuffer = require ('../dbuffer');
const { browseArchive } = require ('../dist/archive-browse');

async function sandbox (t) {
    const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-engine-'));
    const cwd = process.cwd (), previous = { ...process.env };
    process.chdir (dir);
    t.after (async () => { process.chdir (cwd); process.env = previous; await fs.rm (dir, { recursive: true, force: true }); });
    await fs.mkdir ('bin'); await fs.mkdir ('etc');
    await fs.writeFile ('etc/server.json', JSON.stringify ({ data: [] }));
    process.env.PATH = path.join (dir, 'bin') + path.delimiter + process.env.PATH;
    process.env.TEST_ENGINE_ROOT = dir;
    await fs.writeFile ('bin/borg', `#!/usr/bin/env node
const fs = require('node:fs');
const root = process.env.TEST_ENGINE_ROOT;
const args = process.argv.slice(2), op = args[0];
fs.appendFileSync(root + '/commands.jsonl', JSON.stringify({args}) + '\\n');
if (op === 'serve') { process.stdin.pipe(process.stdout); }
else if (op === 'list' && args.includes('--json-lines')) console.log(JSON.stringify({type:'-',path:process.env.TEST_LIST_PATH || 'dir/file',size:7,isomtime:'2026-10-30T00:00:00'}));
else if (op === 'list') console.log(JSON.stringify({archives:[{name:'source-2026-10-30-030000'}]}));
else {
  console.log('Borg ' + op + ' ' + (process.env.BORG_PASSPHRASE || ''));
  process.exitCode = Number(process.env['TEST_' + op.toUpperCase() + '_EXIT'] || 0);
}
`, { mode: 0o755 });
    await fs.writeFile ('bin/ssh', `#!/usr/bin/env node
const fs = require('node:fs'), net = require('node:net');
const args = process.argv.slice(2); let input = '';
process.stdin.on('data',chunk => { input += chunk; });
process.stdin.on('end',() => {
  fs.writeFileSync(process.env.TEST_ENGINE_ROOT + '/ssh.json',JSON.stringify({args,input}));
  const forward = args[args.indexOf('-R') + 1];
  const socket = net.connect(forward.slice(forward.indexOf(':') + 1));
  socket.on('connect',() => socket.write('protocol-test'));
  socket.on('data',chunk => { if(chunk.toString() !== 'protocol-test') process.exitCode=2; socket.end(); });
  socket.on('error',error => { console.error(error.message); process.exitCode=2; });
});
`, { mode: 0o755 });
    return dir;
}
const backup = extra => backupSchema.parse ({ id: 'source', name: 'Source', mode: 'local', repository: '/backup/repo', sources: ['/source path'], index: false, ...extra });
const run = (action = 'backup') => ({ id: randomUUID (), backupId: 'source', archive: 'source-2026-10-30-030000', action, origin: 'manual', state: 'running', queuedAt: '2026-10-30T03:00:00Z', message: 'Running' });
const commands = async () => (await fs.readFile ('commands.jsonl', 'utf8')).trim ().split ('\n').map (line => JSON.parse (line).args);

test ('command plans quote shell input and scope pruning without shell execution locally', () => {
    const value = backup ({ exclusions: ["*/it's cache"] });
    const args = createArguments (value, 'source-2026-10-30-030000');
    assert.ok (args.includes ("*/it's cache")); assert.equal (args.at (-1), '/source path');
    const prune = pruneArguments (value); assert.equal (prune[prune.indexOf ('--glob-archives') + 1], 'source-*');
    const remote = backup ({ mode: 'pull', remote: { host: 'client', user: 'root' }, sources: ["/path with 'quotes' $(touch /bad)"] });
    const invocation = pullInvocation (remote, { id: 'key', name: 'Key', passphrase: "safe 'secret'" }, run (), '/tmp/socket');
    assert.ok (invocation.input.includes ("'\\''"));
    assert.equal (invocation.args.some (arg => arg.includes ('secret')), false);
    assert.ok (invocation.args.includes ('ExitOnForwardFailure=yes'));
});

test ('streaming log redaction covers secrets split across chunks and UTF-8', async () => {
    const stream = new RedactingStream ('秘密-password'); let text = '';
    stream.on ('data', chunk => { text += chunk.toString (); });
    const bytes = Buffer.from ('before 秘密-password after 秘密-password');
    for (const byte of bytes) stream.write (Buffer.from ([byte]));
    stream.end (); await new Promise (resolve => { stream.on ('end', resolve); });
    assert.equal (text, 'before [redacted] after [redacted]');
});

test ('local create/prune, warning/error exits, encryption initialization and log redaction', async t => {
    await sandbox (t);
    const execute = createBackupExecutor ();
    const secret = { id: 'key', name: 'Key', passphrase: 'super-secret' };
    const first = run ();
    assert.equal (await execute (backup ({}), secret, first, new AbortController ().signal), 0);
    assert.deepEqual ((await commands ()).map (args => args[0]), ['create', 'prune']);
    const log = await fs.readFile ('log/backups/' + first.id + '.log', 'utf8');
    assert.equal (log.includes (secret.passphrase), false); assert.ok (log.includes ('[redacted]'));
    process.env.TEST_CREATE_EXIT = '1'; assert.equal (await execute (backup ({}), secret, run (), new AbortController ().signal), 1);
    const count = (await commands ()).length;
    process.env.TEST_CREATE_EXIT = '2'; assert.equal (await execute (backup ({}), secret, run (), new AbortController ().signal), 2);
    assert.equal ((await commands ()).length, count + 1);
    delete process.env.TEST_CREATE_EXIT;
    const initialization = run ('initialize');
    assert.equal (await execute (backup ({ repository: path.resolve ('repositories/new') }), secret, initialization, new AbortController ().signal), 0);
    assert.ok ((await commands ()).at (-1).includes ('repokey-blake2'));
    await assert.rejects (execute (backup ({}), undefined, run ('initialize'), new AbortController ().signal), /passphrase/);
});

test ('pull starts restricted local Borg serve, passes secrets on SSH stdin, prunes locally and cleans sockets', async t => {
    await sandbox (t);
    const current = run ();
    const value = backup ({ mode: 'pull', remote: { host: 'client', user: 'root' } });
    assert.equal (await createBackupExecutor () (value, { id: 'key', name: 'Key', passphrase: 'pull-secret' }, current, new AbortController ().signal), 0);
    const ssh = JSON.parse (await fs.readFile ('ssh.json', 'utf8'));
    assert.ok (ssh.input.includes ('pull-secret'));
    assert.equal (ssh.args.join (' ').includes ('pull-secret'), false);
    const serve = (await commands ()).find (args => args[0] === 'serve');
    assert.ok (serve.includes ('--append-only'));
    assert.equal (serve[serve.indexOf ('--restrict-to-repository') + 1], '/backup/repo');
    assert.equal ((await commands ()).at (-1)[0], 'prune');
    const localSocket = ssh.args[ssh.args.indexOf ('-R') + 1].split (':').at (-1);
    await assert.rejects (fs.access (localSocket));
    await assert.rejects (fs.access (path.dirname (localSocket)));
});

test ('successful backups refresh the binary restore index through the real CLI', async t => {
    await sandbox (t); let indexed = false;
    const value = backup ({ index: true });
    assert.equal (await createBackupExecutor (async () => { indexed = true; }) (value, undefined, run (), new AbortController ().signal), 0);
    assert.equal (indexed, true);
    const db = new DBuffer (await fs.open ('data/managed/source-data-tree.bin', 'r'));
    try {
        const offset = await db.read_header ();
        const listing = await browseArchive ({ db, offset }, 'dir', 1);
        assert.equal (listing.c.file.s, 7);
    } finally { await db.close (); }
    const { indexMatchesRepository } = require ('../dist/backup-index');
    const changed = backup ({ index: true, repository: './different-repo' });
    assert.equal (changed.repository, path.resolve ('different-repo'));
    assert.equal (await indexMatchesRepository (changed), false);
    process.env.TEST_LIST_PATH = 'newdir/newfile';
    assert.equal (await createBackupExecutor () (changed, undefined, run (), new AbortController ().signal), 0);
    assert.equal (await indexMatchesRepository (changed), true);
    const rebuilt = new DBuffer (await fs.open ('data/managed/source-data-tree.bin', 'r'));
    try {
        const offset = await rebuilt.read_header ();
        assert.equal (await browseArchive ({ db: rebuilt, offset }, 'dir', 1), null);
        assert.equal ((await browseArchive ({ db: rebuilt, offset }, 'newdir', 1)).c.newfile.s, 7);
    } finally { await rebuilt.close (); }
});

test ('log sink errors terminate a live command and Unicode outside secrets stays intact', { timeout: 10000 }, async () => {
    const { Writable } = require ('node:stream');
    const { command } = require ('../dist/backup-process');
    const output = new Writable ({ write (_chunk, _encoding, callback) { callback (Error ('disk full')); } });
    await assert.rejects (command (process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>process.stdout.write("more"),100);'], output, { signal: new AbortController ().signal }), /disk full/);
    const redacted = new RedactingStream ('abc'); let text = '';
    redacted.on ('data', chunk => { text += chunk.toString (); });
    redacted.write ('😀'); redacted.write ('x'); redacted.end ();
    await new Promise (resolve => { redacted.once ('end', resolve); });
    assert.equal (text, '😀x');
});
