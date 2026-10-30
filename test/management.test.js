const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs/promises');
const os = require ('node:os');
const path = require ('node:path');
const { backupSchema, scheduleSchema, managementSchema, allowed, publicCredential, publicUser } = require ('../dist/management-schema');
const { ManagementStore } = require ('../dist/management-store');
const { nextOccurrence, dueOccurrence } = require ('../dist/backup-schedule');
const { BackupService } = require ('../dist/backup-runtime');
const { effectiveExclusions } = require ('../dist/exclusion-templates');
const hash = '$argon2id$test';
const definition = extra => backupSchema.parse ({ id: 'host-root', name: 'Root', mode: 'local', repository: '/backup/repo', sources: ['/'], ...extra });
const temporary = async t => { const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-managed-')); t.after (() => fs.rm (dir, { recursive: true, force: true })); return dir; };

test ('backup schema defaults mirror scripts and reject unsafe definitions', () => {
    const backup = definition ({});
    assert.equal (backup.enabled, false);
    assert.deepEqual (backup.schedule.times, ['03:00']);
    assert.deepEqual (backup.retention, { enabled: true, daily: 14, weekly: 8, monthly: 24, yearly: 10 });
    for (const extra of [{ id: '../x' }, { sources: ['--foo'] }, { compression: ';touch pwned' },
        { repository: '-repo' }, { repository: '/repo::archive' }, { exclusions: ['foo\n+pp:bar'] },
        { schedule: { times: ['24:00'] } }, { schedule: { timezone: 'not/a/zone' } },
        { retention: { daily: 0, weekly: 0, monthly: 0, yearly: 0 } }]) assert.throws (() => definition (extra));
    assert.throws (() => managementSchema.parse ({ version: 1, users: [], credentials: [], backups: [backup, definition ({ id: 'host-root-extra' })] }));
    const patterns = effectiveExclusions (backup);
    assert.ok (patterns.includes ('pp:/backup/repo'));
    assert.ok (patterns.includes ('/proc/*'));
    assert.equal (patterns.includes ('*/node_modules'), false);
});

test ('calendar schedules handle weekly/monthly selection and both DST transitions', () => {
    const weekly = scheduleSchema.parse ({ frequency: 'weekly', weekdays: [1], times: ['03:00'], timezone: 'Europe/Berlin' });
    assert.equal (nextOccurrence (weekly, new Date ('2026-10-30T00:00:00Z')).toISOString (), '2026-11-02T02:00:00.000Z');
    const monthly = scheduleSchema.parse ({ frequency: 'monthly', monthdays: [31], times: ['03:00'], timezone: 'UTC' });
    assert.equal (nextOccurrence (monthly, new Date ('2026-04-01T00:00:00Z')).toISOString (), '2026-05-31T03:00:00.000Z');
    const daily = scheduleSchema.parse ({ timezone: 'Europe/Berlin', times: ['02:30'] });
    assert.equal (nextOccurrence (daily, new Date ('2026-03-29T00:00:00Z')).toISOString (), '2026-03-30T00:30:00.000Z');
    assert.equal (dueOccurrence (daily, new Date ('2026-10-25T00:30:15Z')).toISOString (), '2026-10-25T00:30:00.000Z');
    assert.equal (dueOccurrence (daily, new Date ('2026-10-25T01:30:15Z')), null);
});

test ('store serializes saves, rejects stale edits, and preserves the last administrator', async t => {
    const dir = await temporary (t);
    const store = await ManagementStore.open (dir, { auth: { admin: { pwd: hash } } });
    await Promise.all ([store.update (draft => { draft.backups.push (definition ({})); }), store.update (draft => { draft.credentials.push ({ id: 'secret', name: 'Secret', passphrase: 'hidden' }); })]);
    assert.equal (store.snapshot ().backups.length, 1);
    assert.equal (store.snapshot ().credentials.length, 1);
    assert.equal ((await fs.stat (store.filename)).mode & 0o777, 0o600);
    await assert.rejects (store.update (() => {}, 0), /reload/);
    await assert.rejects (store.update (draft => { draft.users = []; }), /administrator/);
    const reopened = await ManagementStore.open (dir);
    assert.equal (reopened.snapshot ().revision, 2);
    assert.equal ('passphrase' in publicCredential (store.snapshot ().credentials[0]), false);
    assert.equal ('passwordHash' in publicUser (store.snapshot ().users[0]), false);
    const reader = { id: 'reader', passwordHash: hash, enabled: true, admin: false, grants: [{ backup: 'host-root', browse: true, restore: false, run: false }] };
    assert.equal (allowed (reader, 'host-root', 'browse'), true);
    assert.equal (allowed (reader, 'other', 'browse'), false);
    assert.equal (allowed (reader, 'host-root', 'restore'), false);
});

test ('scheduler persists claims, avoids duplicate runs and recovers interrupted state', async t => {
    const dir = await temporary (t);
    const store = await ManagementStore.open (path.join (dir, 'etc'));
    await store.update (draft => { draft.backups.push (definition ({ enabled: true, schedule: { timezone: 'UTC', times: ['03:00'] } })); });
    let calls = 0;
    const service = await BackupService.open (store, path.join (dir, 'var'), async () => { calls++; return 0; });
    const now = new Date ('2026-10-30T03:00:12Z');
    await Promise.all ([service.tick (now), service.tick (now)]);
    await service.idle ();
    assert.equal (calls, 1);
    const restarted = await BackupService.open (store, path.join (dir, 'var'), async () => { calls++; return 0; });
    await restarted.tick (now); await restarted.idle ();
    assert.equal (calls, 1);
    await restarted.enqueue ('host-root'); await restarted.idle ();
    assert.equal (calls, 2);
    const statePath = path.join (dir, 'var/backup-state.json');
    const state = JSON.parse (await fs.readFile (statePath, 'utf8'));
    state.runs[0].state = 'running';
    await fs.writeFile (statePath, JSON.stringify (state));
    const recovered = await BackupService.open (store, path.join (dir, 'var'), async () => 0);
    assert.equal (recovered.runs ()[0].state, 'interrupted');
});

test ('service serializes work, rejects overlapping runs and can cancel queued work', async t => {
    const dir = await temporary (t);
    const store = await ManagementStore.open (path.join (dir, 'etc'));
    await store.update (draft => { draft.backups.push (definition ({}), definition ({ id: 'other' })); });
    let release;
    const pending = new Promise (resolve => { release = resolve; });
    const calls = [];
    const service = await BackupService.open (store, path.join (dir, 'var'), async backup => { calls.push (backup.id); await pending; return 1; });
    const first = await service.enqueue ('host-root');
    await assert.rejects (service.enqueue ('host-root'), /already/);
    const second = await service.enqueue ('other');
    await service.cancel (second.id);
    assert.equal (service.runs ().find (run => run.id === second.id).state, 'cancelled');
    assert.equal (service.busy ('other'), false);
    release ();
    await service.idle ();
    assert.deepEqual (calls, ['host-root']);
    assert.equal (service.runs ().find (run => run.id === first.id).state, 'warning');
    assert.equal (service.runs ().find (run => run.id === second.id).state, 'cancelled');
});

test ('automatic exclusions use literal Borg path prefixes while user patterns stay patterns', () => {
    const backup = definition ({ repository: '/srv/repo[12]', restoreDirectory: '/srv/restores[12]', exclusions: ['*.cache'] });
    const patterns = effectiveExclusions (backup);
    assert.ok (patterns.includes ('pp:/srv/repo[12]'));
    assert.ok (patterns.includes ('pp:/srv/restores[12]'));
    assert.equal (patterns.includes ('/srv/repo[12]'), false);
    assert.ok (patterns.includes ('*.cache'));
});
