const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const { Borg, repository, parseTime } = require ('../borg');
const path = require ('node:path');

const id = 'a'.repeat (64);
const key = '2026-10-29-123456@' + id;

test ('recognizes stable, beta and development versions and rejects unknown majors', () => {
    for (const version of ['borg 1.2.8', 'borg 1.4.5\n', 'borg 2.0.0b25', 'borg 2.0.0b26.dev171+g123']) {
        assert.equal (new Borg (version).major, Number (version[5]));
    }
    for (const version of ['borg 3.0.0', 'borg 0.29.0', 'unrecognized', 'borg 2']) {
        assert.throws (() => new Borg (version), /Unsupported Borg version/);
    }
});

test ('builds Borg 1 commands without changing arguments containing spaces', () => {
    const borg = new Borg ('borg 1.4.5');
    assert.deepEqual (borg.archivesArgs ('/a repo'), ['list', '--json', '/a repo']);
    assert.deepEqual (borg.listArgs ('/a repo', 'a name'), [
        'list', '--format', '{type} {path} {size} {isomtime}', '--json-lines', '/a repo::a name'
    ]);
    assert.deepEqual (borg.extractArgs ('/a repo', 'backup', '2026-10-29-123456', '/a pattern', ['--sparse']), [
        'extract', '--list', '--sparse', '--patterns-from', '/a pattern', '/a repo::backup-2026-10-29-123456'
    ]);
    assert.throws (() => borg.extractArgs ('/repo', 'backup', key, '/patterns'), /require Borg 2/);
});

test ('builds Borg 2 commands with a separate repo and immutable archive ID', () => {
    const borg = new Borg ('borg 2.0.0b25');
    assert.deepEqual (borg.archivesArgs ('/repo'), ['--repo', '/repo', 'repo-list', '--json']);
    assert.deepEqual (borg.listArgs ('/repo', 'aid:' + id), [
        '--repo', '/repo', 'list', '--format', '{type} {path} {size} {isomtime}', '--json-lines', '--', 'aid:' + id
    ]);
    assert.deepEqual (borg.extractArgs ('/repo', 'backup', key, '/patterns', ['--strip-components', '2']), [
        '--repo', '/repo', 'extract', '--list', '--strip-components', '2', '--patterns-from', '/patterns', '--', 'aid:' + id
    ]);
    assert.equal (borg.extractArgs ('/repo', 'backup', '2026-10-29-123456', '/patterns').at (-1), 'backup-2026-10-29-123456');
    assert.equal (borg.listArgs ('/repo', 'backup-' + key).at (-1), 'aid:' + id);
});

test ('preserves Borg 1 SSH location semantics on Borg 2', () => {
    const cases = [
        ['/repo', '/repo'], ['file:///repo', 'file:///repo'],
        ['ssh://u@host:2222/path', 'ssh://u@host:2222//path'],
        ['ssh://host//path', 'ssh://host//path'],
        ['ssh://host/./relative', 'ssh://host/relative'],
        ['ssh://host/~/relative', 'ssh://host/relative'],
        ['u@host:/absolute', 'ssh://u@host//absolute'],
        ['u@host:relative', 'ssh://u@host/relative'],
        ['u@host:~/relative', 'ssh://u@host/relative'],
        ['u@host:/~/relative', 'ssh://u@host/relative'],
        ['u@host:/./relative', 'ssh://u@host/relative'],
        ['u@[::1]:/absolute', 'ssh://u@[::1]//absolute']
    ];
    for (const [old, converted] of cases) {
        assert.equal (repository (old, 1), old);
        assert.equal (repository (old, 2), converted);
    }
    assert.throws (() => repository ('ssh://host/~other/repo', 2), /absolute SSH path/);
    assert.throws (() => repository ('u@host:~other/repo', 2), /absolute SSH path/);
    assert.throws (() => repository (undefined, 2), /borg_repo/);
});

test ('relative local repositories resolve before extraction changes working directory', () => {
    for (const major of [1, 2]) assert.equal (repository ('relative repo', major), path.resolve ('relative repo'));
});

test ('parses old UTC timestamps and new ISO offsets as the same instant', () => {
    for (const time of ['2026-10-29T12:34:56.123456', '2026-10-29T12:34:56.123456Z', '2026-10-29T14:34:56.123456+02:00']) {
        assert.equal (parseTime (time), Date.parse ('2026-10-29T12:34:56.123Z'));
    }
});

test ('indexes legacy names and detects timestamp collisions', () => {
    const borg = new Borg ('borg 1.4.5');
    const result = borg.archiveEntries ({ archives: [{ name: 'backup-2026-10-29-123456' }, { name: 'other-2026-10-29-123456' }] }, /^backup/);
    assert.deepEqual ({ ...result }, { '2026-10-29-123456': 'backup-2026-10-29-123456' });
    assert.throws (() => borg.archiveEntries ({ archives: [{ name: 'a-2026-10-29-123456' }, { name: 'b-2026-10-29-123456' }] }, /./), /same timestamp/);
});

test ('keeps duplicate Borg 2 series snapshots separate, even with identical timestamps', () => {
    const borg = new Borg ('borg 2.0.0b25');
    const result = borg.archiveEntries ({ archives: [
        { name: 'backup', id, time: '2026-10-29T14:34:56+02:00' },
        { name: 'backup', id: 'b'.repeat (64), time: '2026-10-29T12:34:56Z' }
    ] }, /^backup$/);
    assert.equal (Object.keys (result).length, 2);
    assert.equal (result[key], 'aid:' + id);
    assert.throws (() => borg.archiveEntries ({}, /./), /missing archives/);
    assert.throws (() => borg.archiveEntries ({ archives: [{ name: 'backup', id: 'bad' }] }, /./), /archive ID/);
    assert.throws (() => borg.archiveEntries ({ archives: [{ name: 'backup', id, time: 'bad' }] }, /./), /archive time/);
});

test ('all nonzero and signal exits remain failures, including modern warning codes', () => {
    Borg.check ({ code: 0, signal: null });
    for (const result of [{ code: 1 }, { code: 2 }, { code: 73 }, { code: 100 }, { code: null, signal: 'SIGTERM' }]) {
        assert.throws (() => Borg.check (result), /Borg exited/);
    }
    assert.throws (() => Borg.check ({ error: Error ('spawn failed') }), /spawn failed/);
});
