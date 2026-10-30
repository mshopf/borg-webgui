const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs/promises');
const os = require ('node:os');
const path = require ('node:path');
const { spawn, spawnSync } = require ('node:child_process');
const { once } = require ('node:events');
const argon2 = require ('argon2');

test ('authenticated API serves snapshots, union trees and rejects invalid queries', async t => {
    const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-server-'));
    t.after (() => fs.rm (dir, { recursive: true, force: true }));
    const config = { httpPort: 0, data: [{ file: 'api-data-tree.bin', restore: 'restore', enable: true }],
        auth: { test: { pwd: await argon2.hash ('password') } }, max_cache_entries: 10, max_status_entries: 10 };
    const configSource = '({...' + JSON.stringify (config) + ', hook_poststartup(app, server) { console.log("TEST_PORT=" + server.address().port); }})';
    await fs.writeFile (path.join (dir, 'config.js'), configSource);
    const filename = '2024-01-01-120000.json';
    await fs.writeFile (path.join (dir, filename), JSON.stringify ({ type: '-', path: 'dir/file', size: 5, isomtime: '2024-01-01T12:00:00' }));
    const build = spawnSync (process.execPath, [path.resolve (__dirname, '../tree.js'), '-c', '-m', 'api-data-tree.bin', '+' + filename], { cwd: dir, encoding: 'utf8' });
    assert.equal (build.status, 0, build.stderr);
    const child = spawn (process.execPath, [path.resolve (__dirname, '../server.js')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const pages = await Promise.all (Array.from ({ length: 6 }, () => request ('/api/data/api/dir?archive=1').then (res => res.json ())));
    assert.ok (pages.every (page => page.c.file.s === 5));
});
