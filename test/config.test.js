const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs');
const { parseConfig } = require ('../dist/config');

const base = { data: [{ file: 'test-data-tree.bin', restore: '/restore', enable: true }], auth: { admin: { pwd: 'hash' } } };
const parse = value => parseConfig (JSON.stringify (value));

test ('configuration validates legacy expressions, defaults, hooks and the example', () => {
    const result = parse (base);
    assert.equal (result.data[0].enable, true);
    assert.equal (result.max_cache_entries, 5000);
    assert.equal (result.max_status_entries, 30);
    assert.equal (result.client_config.max_restore_entries_trivial, 1000);
    assert.equal (parse ({ ...base, httpPort: 0 }).httpPort, 0);
    assert.equal (parse ({ ...base, data: [{ file: 'x', restore: 'y' }] }).data[0].enable, false);
    const hooks = parseConfig ('({... ' + JSON.stringify (base) + ', hook_preroutes(app) { app.called = true; }})');
    const app = {};
    hooks.hook_preroutes (app);
    assert.equal (app.called, true);
    const example = parseConfig (fs.readFileSync (require.resolve ('../config_example.js'), 'utf8'));
    assert.equal (example.data[0].enable, true);
});

test ('invalid configuration is rejected at its untyped boundary', () => {
    for (const value of [null, [], {}, { ...base, data: false }, { ...base, auth: [] },
        { ...base, httpPort: '8080' }, { ...base, httpsPort: 65536 },
        { ...base, max_cache_entries: -1 }, { ...base, max_status_entries: 1.5 },
        { ...base, data: [{ file: 'x', restore: 'y', enable: 'true' }] },
        { ...base, data: [{ file: 'x', restore: 'y', borg_args: [12] }] },
        { ...base, auth: { admin: { pwd: false } } }, { ...base, hook_postroutes: true }]) {
        assert.throws (() => parse (value));
    }
});
