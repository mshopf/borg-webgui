const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs');
const path = require ('node:path');
const { fixture, success, startServer, restore } = require ('./helpers');

for (const major of [1, 2]) {
    const binary = process.env['BORG' + major + '_BINARY'];
    test (`real Borg ${major}: index, sync, restore exact snapshots, symlinks and patterns`, {
        skip: !binary && 'Set BORG' + major + '_BINARY to an absolute Borg executable path', timeout: 60000
    }, async t => {
        const f = fixture (t, major, binary);
        // The test filesystem does not support restoring security.selinux xattrs.
        const configFile = path.join (f.dir, 'config.js');
        fs.writeFileSync (configFile, fs.readFileSync (configFile, 'utf8').replace ('"--sparse"', '"--sparse","--noxattrs"'));
        const repo = path.join (f.dir, 'repo');
        const source = path.join (f.dir, 'source');
        fs.mkdirSync (source);
        const run = args => success (f.run (args));
        const prefix = major === 2 ? ['--repo', repo] : [];
        run (major === 1 ? ['init', '--encryption=repokey', repo] : [...prefix, 'repo-create', '--encryption=aes256-ocb', '--key-location=repokey']);
        for (const [i, content] of ['first snapshot', 'second snapshot'].entries ()) {
            fs.writeFileSync (path.join (source, 'file'), content);
            fs.mkdirSync (path.join (source, 'directory'), { recursive: true });
            fs.writeFileSync (path.join (source, 'directory', 'child'), content);
            fs.writeFileSync (path.join (source, 'unselected'), 'must not restore');
            if (i === 0) fs.symlinkSync ('file', path.join (source, 'link'));
            const name = major === 1 ? 'backup-2026-10-29-12345' + i : 'backup';
            success (f.run ([...prefix, 'create', '--timestamp', '2026-10-29T12:34:5' + i + '+00:00',
                ...(major === 1 ? [repo + '::' + name] : [name]), '.'], { cwd: source }));
        }
        success (f.runTree ('-c', '-a', 'backup-data-tree.bin', '/^backup'));
        const before = fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin'));
        success (f.runTree ('-a', 'backup-data-tree.bin', '/^backup'));
        assert.deepEqual (fs.readFileSync (path.join (f.dir, 'backup-data-tree.bin')), before);
        const api = await startServer (t, f);
        const keys = await api ('/api/archives/backup');
        assert.equal (keys.length, 3);
        const tree = await api ('/api/data/backup/');
        assert.equal (tree.c.link.l, 'file');
        assert.ok (tree.c.file.t > 0);
        for (const [i, key] of keys.slice (1).entries ()) {
            const job = await restore (api, key, ['directory/', 'file', 'link']);
            assert.equal (job.state, 'done', job.info + '\n' + fs.readFileSync (path.join (f.dir, 'log', job.handle + '.log'), 'utf8'));
            const cwd = path.join (f.dir, 'restore', key, ...(major === 2 ? [job.handle] : []));
            const content = i === 0 ? 'first snapshot' : 'second snapshot';
            assert.equal (fs.readFileSync (path.join (cwd, 'file'), 'utf8'), content);
            assert.equal (fs.readFileSync (path.join (cwd, 'directory', 'child'), 'utf8'), content);
            assert.equal (fs.readlinkSync (path.join (cwd, 'link')), 'file');
            assert.equal (fs.existsSync (path.join (cwd, 'unselected')), false);
            assert.equal ((await restore (api, key)).state, 'done');
        }
    });
}
