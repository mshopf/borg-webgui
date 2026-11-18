import type { BrowseEntry, ArchivePage, PublicNode, TreeEntry } from './types';
import type { DiskNode } from './dbuffer';

// DBuffer has a mutable read cursor. Serialize requests sharing a file handle.
const pending = new WeakMap<object, Promise<unknown>> ();
export async function withTree<T> (entry: object, action: () => Promise<T>): Promise<T> {
    const previous = pending.get (entry) ?? Promise.resolve ();
    const current = previous.catch (() => {}).then (action);
    pending.set (entry, current);
    try { return await current; }
    finally { if (pending.get (entry) === current) pending.delete (entry); }
}

export async function browseArchive (entry: BrowseEntry, path: string, archive: number, cursor = 0, limit = 200): Promise<ArchivePage | null> {
    const db = entry.db;
    let offset = entry.offset;
    const parts = path.split ('/').filter (part => part !== '');
    if (db.version === 1) {
        for (const part of parts) {
            const childOffset = await db.find_snapshot_child (offset, '/' + part);
            if (childOffset === undefined) return null;
            offset = childOffset;
        }
        const page = await db.read_snapshot_page (offset, archive, cursor, limit);
        const children = Object.create (null) as Record<string, PublicNode>;
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
    const children = Object.create (null) as Record<string, PublicNode>;
    let next = null, count = 0;
    const keys = Object.keys (tree.c ?? {});
    for (let i = cursor; i < keys.length; i++) {
        const name = keys[i];
        if (name === undefined) continue;
        const reference = tree.c?.[name];
        if (!reference) continue;
        const child = await db.read_tree (reference.o);
        if (!child.a.some (value => Math.abs (value) === archive)) continue;
        if (count++ === limit) { next = i; break; }
        children[name] = { s: child.s, c: child.c === undefined ? undefined : null, C: child.C, S: child.S };
    }
    return { c: children, next };
}

function publicNode (node: DiskNode): PublicNode {
    return { a: node.a, s: node.s, t: node.t, l: node.l, C: node.C, S: node.S,
        c: node.c === undefined ? undefined : null };
}

export async function browseFiles (entry: TreeEntry, path: string, maxCacheEntries: number): Promise<PublicNode | null> {
    let node = entry.cache.get ('');
    if (!node) {
        node = await entry.db.read_tree (entry.offset);
        if (entry.cache.size >= maxCacheEntries) entry.cache.clear ();
        if (maxCacheEntries > 0) entry.cache.set ('', node);
    }
    let key = '';
    for (const part of path.split ('/').filter (part => part !== '')) {
        key += '/' + part;
        const cached = entry.cache.get (key);
        if (cached) { node = cached; continue; }
        const reference = node.c?.['/' + part];
        if (!reference) return null;
        node = await entry.db.read_tree (reference.o);
        if (entry.cache.size >= maxCacheEntries) entry.cache.clear ();
        if (maxCacheEntries > 0) entry.cache.set (key, node);
    }
    const children = Object.create (null) as Record<string, PublicNode>;
    for (const [name, reference] of Object.entries (node.c ?? {})) {
        children[name] = publicNode (await entry.db.read_tree (reference.o));
    }
    return { ...publicNode (node), c: children };
}
