const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs');
const path = require ('node:path');
const cp = require ('node:child_process');
const { fixture, success, startServer, restore, root, id, secondId } = require ('./helpers');

function repository (f, major, changes = {}) {
    const data = { archives: major === 1 ? [
        { name: 'backup-2026-10-29-123456', id, time: '2026-10-29T12:34:56' }
    ] : [
        { name: 'backup', id, time: '2026-10-29T12:34:56+00:00' },
        { name: 'backup', id: secondId, time: '2026-10-29T12:34:56+00:00' }
    ], items: [
        { type: '-', path: 'file', size: 5, isomtime: major === 1 ? '2026-10-29T12:34:56' : '2026-10-29T14:34:56+02:00' },
        { type: 'l', path: 'link', [major === 1 ? 'linktarget' : 'target']: 'file' }
    ], ...changes };
    fs.writeFileSync (path.join (f.dir, 'repository.json'), JSON.stringify (data));
    return data;
}

for (const major of [1, 2]) {
    for (const mode of ['-m', '-a', '-i']) {
        test (`Borg ${major}: ${mode} indexing, repeated sync, pruning and exact restore`, { timeout: 20000 }, async t => {
            const f = fixture (t, major);
            const data = repository (f, major);
            success (f.runTree ('-c', mode, 'backup-data-tree.bin', '/^backup'));
            const calls = fs.readFileSync (path.join (f.dir, 'calls.jsonl'), 'utf8').trim ().split ('\n').map (JSON.parse);
            assert.equal (calls.filter (e => e.args[0] === '--version').length, 1);
            const api = await startServer (t, f);
            const keys = await api ('/api/archives/backup');
            assert.equal (keys[0], null);
            assert.equal (keys.length, major === 2 && mode !== '-i' ? 3 : 2);
            const tree = await api ('/api/data/backup/');
            assert.equal (tree.c.file.s, 5);
            assert.equal (tree.c.file.t, Date.parse ('2026-10-29T12:34:56Z'));
            assert.equal (tree.c.link.l, 'file');
            for (const key of keys.slice (1)) {
                const job = await restore (api, key);
                assert.equal (job.state, 'done', job.info);
                const cwd = path.join (f.dir, 'restore', key, ...(major === 2 ? [job.handle] : []));
                assert.equal (fs.readFileSync (path.join (cwd, 'file'), 'utf8'), major === 2 ? 'aid:' + key.split ('@')[1] : path.join (f.dir, 'repo') + '::backup-' + key);
                assert.equal ((await restore (api, key)).state, 'done');
                assert.equal (fs.existsSync ('/tmp/borg-restore-' + job.handle + '.patterns'), false);
            }
            // Complete -i's second operation, then a no-op sync must preserve bytes.
            success (f.runTree (mode, 'backup-data-tree.bin', '/^backup'));
            const before = fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin'));
            success (f.runTree (mode, 'backup-data-tree.bin', '/^backup'));
            assert.deepEqual (fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin')), before);
            repository (f, major, { archives: data.archives.slice (1) });
            success (f.runTree (mode, 'backup-data-tree.bin', '/^backup'));
            const printed = success (f.runTree ('-p', 'backup-data-tree.bin'));
            assert.equal (printed.includes (major === 2 ? '@' + id : '2026-10-29-123456'), false);
        });
    }
}

test ('failed or signalled repository listings never replace an existing tree', t => {
    const f = fixture (t);
    repository (f, 2);
    success (f.runTree ('-c', '-m', 'backup-data-tree.bin', '/backup'));
    const before = fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin'));
    for (const changes of [{ repoExit: 73 }, { repoExit: 100 }, { repoSignal: true }]) {
        repository (f, 2, { archives: [], ...changes });
        const result = f.runTree ('-a', 'backup-data-tree.bin', '/backup');
        assert.equal (result.status, 1, result.stderr);
        assert.match (result.stderr, /Borg exited/);
        assert.deepEqual (fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin')), before);
    }
});

for (const mode of ['-m', '-a', '-i']) test (`${mode}: failed or signalled replacement listings preserve the original tree`, t => {
    const f = fixture (t);
    repository (f, 2);
    success (f.runTree ('-c', '-m', 'backup-data-tree.bin', '/backup'));
    const before = fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin'));
    for (const changes of [{ listExit: 2 }, { listExit: 105 }, { listSignal: true }]) {
        repository (f, 2, { archives: [{ name: 'backup', id: 'c'.repeat (64), time: '2026-10-30T00:00:00Z' }], ...changes });
        const result = f.runTree (mode, 'backup-data-tree.bin', '/backup');
        assert.equal (result.status, 1, result.stderr);
        assert.deepEqual (fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin')), before);
    }
});

test ('restore errors are visible and the queue continues', async t => {
    const f = fixture (t);
    repository (f, 2);
    success (f.runTree ('-c', '-m', 'backup-data-tree.bin', '/backup'));
    const api = await startServer (t, f);
    const key = (await api ('/api/archives/backup'))[1];
    repository (f, 2, { extractExit: 105 });
    assert.match ((await restore (api, key)).info, /code 105/);
    repository (f, 2);
    assert.equal ((await restore (api, key)).state, 'done');
});

test ('a missing Borg executable does not stall the queue or leave pattern files', async t => {
    const f = fixture (t);
    repository (f, 2);
    success (f.runTree ('-c', '-m', 'backup-data-tree.bin', '/backup'));
    const api = await startServer (t, f);
    const key = (await api ('/api/archives/backup'))[1];
    const bin = path.join (f.dir, 'bin', 'borg');
    fs.renameSync (bin, bin + '.saved');
    const job = await restore (api, key);
    assert.equal (job.state, 'err');
    assert.match (job.info, /ENOENT/);
    assert.equal (fs.existsSync ('/tmp/borg-restore-' + job.handle + '.patterns'), false);
    assert.match (fs.readFileSync (path.join (f.dir, 'log', job.handle + '.log'), 'utf8'), /ENOENT/);
    fs.renameSync (bin + '.saved', bin);
    assert.equal ((await restore (api, key)).state, 'done');
});

test ('offline JSON imports and printing work without Borg installed', t => {
    const f = fixture (t);
    fs.unlinkSync (path.join (f.dir, 'bin', 'borg'));
    fs.writeFileSync (path.join (f.dir, 'backup-2026-10-29-123456.json'), JSON.stringify ({ type: '-', path: 'file', size: 5, isomtime: '2026-10-29T12:34:56' }) + '\n');
    success (f.runTree ('-c', '-m', 'backup-data-tree.bin', '+backup-2026-10-29-123456.json'));
    assert.match (success (f.runTree ('-p', 'backup-data-tree.bin')), /2026-10-29-123456/);
    assert.equal (fs.existsSync (path.join (f.dir, 'calls.jsonl')), false);
});

test ('server refuses an unknown Borg version before startup', t => {
    const f = fixture (t);
    const result = cp.spawnSync (process.execPath, [path.join (root, 'server.js')], {
        cwd: f.dir, env: { ...f.env, FAKE_BORG_VERSION: 'borg 3.0.0' }, encoding: 'utf8', timeout: 5000
    });
    assert.equal (result.status, 1);
    assert.match (result.stderr, /Unsupported Borg version/);
    assert.doesNotMatch (result.stdout, /listening/);
});

for (const major of [1, 2]) test (`Borg ${major}: manual dated archive import and global repository fallback`, async t => {
    const f = fixture (t, major);
    const configFile = path.join (f.dir, 'config.js');
    fs.writeFileSync (configFile, fs.readFileSync (configFile, 'utf8')
        .replace (JSON.stringify (path.join (f.dir, 'wrong-repo')), JSON.stringify (path.join (f.dir, 'repo')))
        .replace (',"borg_repo":' + JSON.stringify (path.join (f.dir, 'repo')), ''));
    repository (f, major, { archives: [{ name: 'backup-2026-10-29-123456', id, time: '2026-10-29T12:34:56Z' }] });
    success (f.runTree ('-c', '-m', 'backup-data-tree.bin', '+backup-2026-10-29-123456'));
    const api = await startServer (t, f);
    const keys = await api ('/api/archives/backup');
    assert.equal (keys[1], '2026-10-29-123456');
    assert.equal ((await restore (api, keys[1])).state, 'done');
});

test ('a legacy tree synchronizes to Borg 2 IDs without losing snapshot selection', async t => {
    const f = fixture (t, 1);
    const data = repository (f, 1);
    success (f.runTree ('-c', '-m', 'backup-data-tree.bin', '/backup'));
    f.env.FAKE_BORG_MAJOR = '2';
    repository (f, 2, { archives: data.archives });
    success (f.runTree ('-a', 'backup-data-tree.bin', '/backup'));
    const api = await startServer (t, f);
    const keys = await api ('/api/archives/backup');
    assert.deepEqual (keys, [null, '2026-10-29-123456@' + id]);
    assert.equal ((await restore (api, keys[1])).state, 'done');
});

for (const mode of ['-m', '-i']) test (`${mode}: explicit Borg 2 snapshot keys support manual removal and reimport`, t => {
    const f = fixture (t);
    repository (f, 2);
    success (f.runTree ('-c', '-a', 'backup-data-tree.bin', '/backup'));
    const key = '2026-10-29-123456@' + id;
    success (f.runTree (mode, 'backup-data-tree.bin', '-' + key));
    assert.equal (success (f.runTree ('-p', 'backup-data-tree.bin')).includes (key), false);
    success (f.runTree (mode, 'backup-data-tree.bin', '+backup-' + key));
    assert.equal (success (f.runTree ('-p', 'backup-data-tree.bin')).includes (key), true);
});
