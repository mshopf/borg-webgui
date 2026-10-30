const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs/promises');
const os = require ('node:os');
const path = require ('node:path');
const { spawn, spawnSync } = require ('node:child_process');
const { once } = require ('node:events');
const argon2 = require ('argon2');

test ('authenticated API serves snapshots, union trees and rejects invalid queries', { timeout: 15000 }, async t => {
    const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-server-'));
    t.after (() => fs.rm (dir, { recursive: true, force: true }));
    const config = { httpPort: 0, borg_repo: '/test/repository', data: [{ file: 'api-data-tree.bin', restore: 'restore', enable: true }],
        auth: { test: { pwd: await argon2.hash ('password') } }, max_cache_entries: 10, max_status_entries: 10 };
    const configSource = '({...' + JSON.stringify (config) + ', hook_poststartup(app, server) { console.log("TEST_PORT=" + server.address().port); }})';
    await fs.writeFile (path.join (dir, 'config.js'), configSource);
    const filename = '2024-01-01-120000.json';
    await fs.writeFile (path.join (dir, filename), JSON.stringify ({ type: '-', path: 'dir/file', size: 5, isomtime: '2024-01-01T12:00:00' }));
    const build = spawnSync (process.execPath, [path.resolve (__dirname, '../tree.js'), '-c', '-m', 'api-data-tree.bin', '+' + filename], { cwd: dir, encoding: 'utf8' });
    assert.equal (build.status, 0, build.stderr);
    await fs.mkdir (path.join (dir, 'log'));
    await fs.mkdir (path.join (dir, 'bin'));
    const fakeBorg = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const pattern = args[args.indexOf('--patterns-from') + 1];
fs.writeFileSync(path.basename(pattern) + '.json', JSON.stringify({args, patterns: fs.readFileSync(pattern, 'utf8')}));
process.stdout.write('restored entry\\n');
process.stderr.write('diagnostic entry\\n');
const marker = path.join(process.env.BORG_TEST_ROOT, 'fail-next');
if (fs.existsSync(marker)) { fs.unlinkSync(marker); process.exitCode = 2; }
`;
    await fs.writeFile (path.join (dir, 'bin/borg'), fakeBorg, { mode: 0o755 });
    const child = spawn (process.execPath, [path.resolve (__dirname, '../server.js')], { cwd: dir, env: { ...process.env, PATH: path.join (dir, 'bin') + path.delimiter + process.env.PATH, BORG_TEST_ROOT: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after (async () => { child.kill (); if (child.exitCode === null) await once (child, 'exit'); });
    let output = '', errors = '';
    child.stderr.on ('data', chunk => { errors += chunk; });
    const port = await new Promise ((resolve, reject) => {
        child.on ('error', reject);
        child.on ('exit', code => reject (Error (`server exited ${code}: ${errors}`)));
        child.stdout.on ('data', chunk => {
            output += chunk;
            const match = output.match (/TEST_PORT=(\d+)/);
            if (match && output.includes ('All data opened successfully')) resolve (Number (match[1]));
        });
    });
    const url = 'http://127.0.0.1:' + port;
    assert.equal ((await fetch (url + '/api/data/api/?archive=1')).status, 401);
    const headers = { Authorization: 'Basic ' + Buffer.from ('test:password').toString ('base64') };
    const request = route => fetch (url + route, { headers });
    assert.deepEqual (await (await request ('/api/archives/api')).json (), [null, '2024-01-01-120000']);
    const snapshot = await (await request ('/api/data/api/?archive=1')).json ();
    assert.deepEqual (Object.keys (snapshot.c), ['/dir']);
    assert.equal (snapshot.c['/dir'].a, undefined);
    assert.equal (snapshot.c['/dir'].o, undefined);
    const nested = await (await request ('/api/data/api/dir?archive=1')).json ();
    assert.equal (nested.c.file.s, 5);
    const union = await (await request ('/api/data/api/')).json ();
    assert.deepEqual (union.c['/dir'].a, [-1]);
    for (const query of ['archive=0', 'archive=2', 'archive=nope', 'archive=1&cursor=-1', 'archive=1&cursor=1.2']) {
        assert.equal ((await request ('/api/data/api/?' + query)).status, 400);
    }
    assert.equal ((await request ('/api/data/api/missing?archive=1')).status, 404);
    assert.equal ((await fetch (url + '/listing.html')).status, 200);
    const post = body => fetch (url + '/api/restore/api', { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify (body) });
    for (const body of [null, {}, [], { archive: 1, list: ['file'] },
        { archive: '2024-01-01-120000', list: [] }, { archive: '2024-01-01-120000', list: [1] },
        { archive: '2024-01-01-120000', list: ['file\n+pp:other'] }]) {
        assert.equal ((await post (body)).status, 400);
    }
    assert.equal ((await post ({ archive: 'missing', list: ['dir/file'] })).status, 404);
    for (const query of ['archive[]=1', 'archive=1&archive=1', 'archive=1&cursor[]=0']) {
        assert.equal ((await request ('/api/data/api/?' + query)).status, 400);
    }
    const waitForOutput = marker => new Promise ((resolve, reject) => {
        const check = () => {
            if (output.includes (marker)) { child.stdout.off ('data', check); resolve (); }
        };
        child.once ('exit', code => { reject (Error ('Server exited: ' + code + errors)); });
        child.stdout.on ('data', check);
        check ();
    });
    // A failed Borg process must finish its queue entry and allow the next restore.
    await fs.writeFile (path.join (dir, 'fail-next'), '');
    const failed = await (await post ({ archive: '2024-01-01-120000', list: ['dir/file'] })).json ();
    const succeeded = await (await post ({ archive: '2024-01-01-120000', list: ['dir/'] })).json ();
    await waitForOutput ('Finished restore process ' + failed);
    await waitForOutput ('Finished restore process ' + succeeded);
    const status = await (await fetch (url + '/api/status', { headers })).json ();
    assert.equal (status.state.find (entry => entry.handle === failed).state, 'err');
    const done = status.state.find (entry => entry.handle === succeeded);
    assert.equal (done.state, 'done');
    assert.equal (done.info, 'finished restoring 2 entries');
    const restored = path.join (dir, 'restore/2024-01-01-120000');
    const invocation = JSON.parse (await fs.readFile (path.join (restored, 'borg-restore-' + succeeded + '.patterns.json'), 'utf8'));
    assert.equal (invocation.args.at (-1), '/test/repository::api-2024-01-01-120000');
    assert.ok (invocation.patterns.includes ('+pp:dir/\n'));
    assert.ok (invocation.patterns.endsWith ('!*\n'));
    for (const handle of [failed, succeeded]) {
        await assert.rejects (fs.access ('/tmp/borg-restore-' + handle + '.patterns'));
        const log = await fs.readFile (path.join (dir, 'log', handle + '.log'), 'utf8');
        assert.ok (log.includes ('diagnostic entry'));
        assert.ok (log.includes ('lines 2'));
    }
    // A missing Borg executable must also produce an error status and clean up.
    await fs.rename (path.join (dir, 'bin/borg'), path.join (dir, 'bin/borg-disabled'));
    const missing = await (await post ({ archive: '2024-01-01-120000', list: ['dir/file'] })).json ();
    await waitForOutput ('Finished restore process ' + missing);
    const missingStatus = await (await fetch (url + '/api/status', { headers })).json ();
    assert.equal (missingStatus.state.find (entry => entry.handle === missing).state, 'err');
    await assert.rejects (fs.access ('/tmp/borg-restore-' + missing + '.patterns'));
    const reloaded = waitForOutput ('re-loaded config');
    await fs.writeFile (path.join (dir, 'config.js.new'), configSource.replace ('"max_status_entries":10', '"max_status_entries":20')
        .replace ('"auth":', '"client_config":{"max_restore_entries_trivial":7},"auth":'));
    await fs.rename (path.join (dir, 'config.js.new'), path.join (dir, 'config.js'));
    await reloaded;
    assert.equal ((await (await fetch (url + '/api/status', { headers })).json ()).config.max_restore_entries_trivial, 7);
    const pages = await Promise.all (Array.from ({ length: 6 }, () => request ('/api/data/api/dir?archive=1').then (res => res.json ())));
    assert.ok (pages.every (page => page.c.file.s === 5));
});
