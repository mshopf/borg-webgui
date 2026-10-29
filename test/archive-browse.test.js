const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs/promises');
const os = require ('node:os');
const path = require ('node:path');
const { spawnSync } = require ('node:child_process');
const DBuffer = require ('../dbuffer');
const { browseArchive, withTree } = require ('../archive-browse');
const cli = path.resolve (__dirname, '../tree.js');

function file (name, size = 1) {
    return { type: '-', path: name, size, isomtime: '2024-01-01T12:00:00' };
}
async function fixture (t) {
    const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-tree-'));
    t.after (() => fs.rm (dir, { recursive: true, force: true }));
    await fs.writeFile (path.join (dir, 'config.js'), '({data: []})');
    const generations = [
        [{ type: 'd', path: 'empty' }, file ('old'), file ('same'), file ('dir/first')],
        [file ('same'), file ('dir/second')],
        [{ type: 'd', path: 'empty' }, file ('old', 9), file ('same'), file ('dir/second')]
    ];
    const names = [];
    for (let i = 0; i < generations.length; i++) {
        const name = `2024-01-0${i + 1}-120000.json`;
        await fs.writeFile (path.join (dir, name), generations[i].map (e => JSON.stringify (e)).join ('\n'));
        names.push (name);
    }
    const run = (...args) => {
        const result = spawnSync (process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
        assert.equal (result.status, 0, result.stderr);
    };
    return { dir, names, run };
}
async function open (t, filename) {
    const db = new DBuffer (await fs.open (filename, 'r'));
    t.after (() => db.close ());
    const offset = await db.read_header ();
    const archives = await db.read_archives (0x20);
    return { db, offset, archives };
}

for (const mode of ['-m', '-i']) {
    test (`archive filtering, empty directories, pagination and removal (${mode})`, async t => {
        const { dir, names, run } = await fixture (t);
        const filename = 'test-data-tree.bin';
        if (mode === '-m') run ('-c', mode, filename, ...names.map (n => '+' + n));
        else for (const name of names) run ('-c', mode, filename, '+' + name);
        const entry = await open (t, path.join (dir, filename));
        assert.equal (entry.db.version, 1);
        const expected = [['/dir', '/empty', 'old', 'same'], ['/dir', 'same'], ['/dir', '/empty', 'old', 'same']];
        for (let archive = 1; archive <= 3; archive++) {
            const result = await browseArchive (entry, '', archive);
            assert.deepEqual (Object.keys (result.c).sort (), expected[archive - 1]);
            assert.equal (result.c.same.a, undefined);
            assert.equal (result.c.same.o, undefined);
            const paged = [];
            let cursor = 0;
            do {
                const page = await browseArchive (entry, '', archive, cursor, 1);
                paged.push (...Object.keys (page.c));
                cursor = page.next;
            } while (cursor !== null);
            assert.deepEqual (paged.sort (), expected[archive - 1]);
            assert.equal (new Set (paged).size, paged.length);
        }
        assert.deepEqual (Object.keys ((await browseArchive (entry, 'dir', 1)).c), ['first']);
        assert.deepEqual (Object.keys ((await browseArchive (entry, 'dir', 2)).c), ['second']);
        assert.deepEqual (Object.keys ((await browseArchive (entry, 'empty', 3)).c), []);
        assert.equal (await browseArchive (entry, 'missing', 1), null);
        const union = await entry.db.read_tree (entry.offset);
        assert.deepEqual ((await entry.db.read_tree (union.c.old.o)).a, [-1, -3]);
        run (mode, filename, '-2024-01-02-120000');
        const removed = await open (t, path.join (dir, filename));
        assert.deepEqual (Object.keys ((await browseArchive (removed, '', 2)).c).sort (), expected[2]);
        // Rewriting the entire file also regenerates indexes without Borg access.
        run ('-i', filename);
        const rewritten = await open (t, path.join (dir, filename));
        assert.deepEqual (Object.keys ((await browseArchive (rewritten, 'dir', 2)).c), ['second']);
    });
}

test ('index skips thousands of absent children and bounds page reads', async t => {
    const dir = await fs.mkdtemp (path.join (os.tmpdir (), 'borg-index-'));
    t.after (() => fs.rm (dir, { recursive: true, force: true }));
    const filename = path.join (dir, 'large.bin');
    const db = new DBuffer (await fs.open (filename, 'w+'), 0, 4096);
    const children = {};
    // Force prefix patches after flush, and long histories that snapshot reads must skip.
    for (let i = 0; i < 10000; i++) {
        const child = { a: i < 9990 ? [-1] : Array.from ({length: 2000}, (_, j) => j + 1), s: 1 };
        await db.write_tree (child);
        children['file' + String (i).padStart (5, '0')] = child;
    }
    const root = { a: [-1, 2], c: children, C: 10000, S: 10000 };
    await db.write_tree (root);
    await db.write_flush ();
    await db.close ();
    const reader = new DBuffer (await fs.open (filename, 'r'));
    t.after (() => reader.close ());
    let reads = 0;
    const readAt = reader.read_at.bind (reader);
    reader.read_at = (...args) => { reads++; return readAt (...args); };
    const result = await browseArchive ({ db: reader, offset: root.o }, '', 2000, 0, 3);
    assert.equal (Object.keys (result.c).length, 3);
    assert.ok (result.next !== null);
    assert.ok (reads < 80, `expected indexed lookup, got ${reads} reads`);
    reads = 0;
    assert.equal (await reader.find_snapshot_child (root.o, 'file09999'), children.file09999.o);
    assert.ok (reads < 35, `expected binary name lookup, got ${reads} reads`);
});

test ('shared readers serialize concurrent requests and recover after failures', async () => {
    const entry = {};
    const sequence = [];
    const first = withTree (entry, async () => { sequence.push (1); await Promise.resolve (); sequence.push (2); });
    const second = withTree (entry, async () => { sequence.push (3); throw Error ('failure'); });
    const third = withTree (entry, async () => sequence.push (4));
    await Promise.all ([first, assert.rejects (second), third]);
    assert.deepEqual (sequence, [1, 2, 3, 4]);
});

test ('bOt0 files remain readable and can be upgraded without Borg', async t => {
    const { dir, run } = await fixture (t);
    const filename = path.join (dir, 'legacy-data-tree.bin');
    const writer = new DBuffer (await fs.open (filename, 'w'));
    writer.write_pos = 0x20;
    await writer.write_archives ([null, '2024-01-01-120000']);
    const childOffset = writer.write_pos;
    writer.write_uvs (7); writer.write_uvs (undefined); writer.write_string (undefined);
    writer.write_uvs (1); writer.write_svs (-1); writer.write_uvs (0);
    const rootOffset = writer.write_pos;
    writer.write_uvs (undefined); writer.write_uvs (undefined); writer.write_string (undefined);
    writer.write_uvs (1); writer.write_svs (-1); writer.write_uvs (2);
    writer.write_uvs (1); writer.write_uvs (7);
    writer.write_string ('old'); writer.write_uvs (childOffset);
    await writer.write_flush ();
    await writer.close ();
    const header = new DBuffer (await fs.open (filename, 'r+'));
    header.write_buf (Buffer.from ('bOt0'));
    header.write_uvs (rootOffset);
    await header.write_flush ();
    await header.close ();
    const entry = await open (t, filename);
    assert.equal (entry.db.version, 0);
    assert.equal ((await browseArchive (entry, '', 1)).c.old.s, 7);
    run ('-i', 'legacy-data-tree.bin');
    const upgraded = await open (t, filename);
    assert.equal (upgraded.db.version, 1);
    assert.equal ((await browseArchive (upgraded, '', 1)).c.old.s, 7);
});
