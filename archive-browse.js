// DBuffer has a mutable read cursor. Serialize requests sharing a file handle.
const pending = new WeakMap ();
async function withTree (entry, action) {
    const previous = pending.get (entry) ?? Promise.resolve ();
    const current = previous.catch (() => {}).then (action);
    pending.set (entry, current);
    try { return await current; }
    finally { if (pending.get (entry) === current) pending.delete (entry); }
}

async function browseArchive (entry, path, archive, cursor = 0, limit = 200) {
    const db = entry.db;
    let offset = entry.offset;
    const parts = path.split ('/').filter (part => part !== '');
    if (db.version === 1) {
        for (const part of parts) {
            offset = await db.find_snapshot_child (offset, '/' + part);
            if (offset === undefined) return null;
        }
        const page = await db.read_snapshot_page (offset, archive, cursor, limit);
        const children = Object.create (null);
        for (const [name, childOffset] of page.entries) {
            const child = await db.read_snapshot (childOffset);
            // Internal offsets, indexes, and archive histories never reach the client.
            children[name] = { s: child.s, c: child.c, C: child.C, S: child.S };
        }
        return { c: children, next: page.next };
    }
    // Compatibility for old files. Rewriting with tree.js creates the fast index.
    let tree = await db.read_tree (offset);
    for (const part of parts) {
        const child = tree.c?.['/' + part];
        if (!child) return null;
        tree = await db.read_tree (child.o);
    }
    const children = Object.create (null);
    let next = null, count = 0;
    const keys = Object.keys (tree.c ?? {});
    for (let i = cursor; i < keys.length; i++) {
        const name = keys[i];
        const child = await db.read_tree (tree.c[name].o);
        if (!child.a.some (value => Math.abs (value) === archive)) continue;
        if (count++ === limit) { next = i; break; }
        children[name] = { s: child.s, c: child.c === undefined ? undefined : null, C: child.C, S: child.S };
    }
    return { c: children, next };
}

module.exports = { withTree, browseArchive };
