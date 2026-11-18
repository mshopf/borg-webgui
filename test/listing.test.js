const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs');
const path = require ('node:path');
const vm = require ('node:vm');

test ('the browser keeps archive IDs in requests and displays valid legacy and Borg 2 dates', () => {
    const element = { addEventListener () {} };
    const context = vm.createContext ({
        window: { location: { search: '?backup=backup' } }, URLSearchParams,
        document: { getElementsByTagName: () => [element], getElementById: () => element },
        fetch: () => new Promise (() => {}), console
    });
    vm.runInContext (fs.readFileSync (path.join (__dirname, '..', 'public', 'listing.js'), 'utf8'), context);
    const key = '2026-10-29-123456@' + 'a'.repeat (64);
    const entries = context.parse_archives ([null, '2026-10-29-123456', key]);
    assert.equal (entries[1].time, Date.parse ('2026-10-29T12:34:56Z'));
    assert.equal (entries[2].time, entries[1].time);
    assert.equal (entries[2].name, key);
    assert.match (entries[2].descr, /archive a{64}/);
    assert.doesNotMatch (entries[2].descr, /Invalid Date/);
});
