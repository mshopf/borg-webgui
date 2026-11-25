const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs/promises');
const path = require ('node:path');
const os = require ('node:os');
const { execFile, spawnSync } = require ('node:child_process');
const { promisify } = require ('node:util');
const { ManagementStore } = require ('../dist/management-store');
const { BackupService } = require ('../dist/backup-runtime');
const { createBackupExecutor } = require ('../dist/backup-engine');

const borg = promisify (execFile);
const version = spawnSync ('borg', ['--version'], { encoding: 'utf8' });
const hasBorg1 = version.status === 0 && /^borg 1\./.test (version.stdout);

test ('Borg 1 writes independent archives and durable statistics for manual and scheduled destinations', {
    skip: hasBorg1 ? false : 'Borg 1 is required for the real repository test', timeout: 60000
}, async () => {
    const root = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-real-'));
    const cwd = process.cwd ();
    const previous = process.env;
    process.chdir (root);
    process.env = { ...previous, BORG_BASE_DIR: root, BORG_CACHE_DIR: path.join (root, 'cache') };
    try {
        await fs.mkdir ('source-a');
        await fs.mkdir ('source-b');
        await fs.writeFile ('source-a/first.txt', 'first source\n');
        await fs.writeFile ('source-a/excluded.tmp', 'exclude me\n');
        await fs.writeFile ('source-b/second.txt', 'second source\n');
        await fs.mkdir ('source-a/sibling-repository');
        for (const repo of ['daily', 'source-a/sibling-repository/offsite', 'secondary']) await borg ('borg', ['init', '--encryption=none', path.join (root, repo)]);
        const store = await ManagementStore.open (path.join (root, 'etc'));
        const plan = (id, repository, source, options = {}) => ({
            id, name: id, repository: path.join (root, repository), sourceId: 'group-' + source, sourceName: source,
            mode: 'local', sources: [path.join (root, source)], templates: [], exclusions: ['*.tmp'],
            index: false, ...options
        });
        const schedule = { timezone: 'UTC', times: ['03:00'] };
        await store.update (draft => {
            draft.backups.push (
                plan ('primary', 'daily', 'source-a'),
                plan ('offsite', 'source-a/sibling-repository/offsite', 'source-a', { enabled: true, schedule }),
                plan ('missing', 'absent', 'source-b', { enabled: true, schedule }),
                plan ('secondary', 'secondary', 'source-b', { enabled: true, schedule })
            );
        });
        const directory = path.join (root, 'var');
        const service = await BackupService.open (store, directory, createBackupExecutor ());
        await service.enqueue ('primary');
        const due = new Date ('2026-11-25T03:00:05Z');
        await Promise.all ([service.tick (due), service.tick (due)]);
        await service.idle ();
        const reopened = await BackupService.open (store, directory, createBackupExecutor ());
        await reopened.tick (due);
        await reopened.idle ();
        const runs = reopened.runs ();
        assert.equal (runs.length, 4);
        for (const [id, repo, expectedFile] of [['primary', 'daily', 'first.txt'], ['offsite', 'source-a/sibling-repository/offsite', 'first.txt'], ['secondary', 'secondary', 'second.txt']]) {
            const run = runs.find (entry => entry.backupId === id);
            assert.equal (run.state, 'done', await fs.readFile ('log/backups/' + run.id + '.log', 'utf8'));
            assert.equal (run.origin, id === 'primary' ? 'manual' : 'scheduled');
            assert.equal (run.statistics.files, 1);
            assert.ok (run.statistics.originalBytes > 0);
            assert.ok (run.statistics.compressedBytes > 0);
            assert.ok (run.statistics.deduplicatedBytes > 0);
            const { stdout } = await borg ('borg', ['list', '--json', path.join (root, repo)]);
            assert.deepEqual (JSON.parse (stdout).archives.map (archive => archive.name), [run.archive]);
            const listing = await borg ('borg', ['list', '--json-lines', path.join (root, repo) + '::' + run.archive]);
            const files = listing.stdout.trim ().split ('\n').map (line => JSON.parse (line)).filter (entry => entry.type === '-');
            assert.deepEqual (files.map (entry => path.basename (entry.path)), [expectedFile]);
            const log = await fs.readFile ('log/backups/' + run.id + '.log', 'utf8');
            assert.match (log, /Borg create exit code: 0/);
            assert.match (log, /Borg prune exit code: 0/);
        }
        assert.equal (runs.find (entry => entry.backupId === 'missing').state, 'error');
    } finally {
        process.chdir (cwd);
        process.env = previous;
        await fs.rm (root, { recursive: true, force: true });
    }
});
