const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs');
const { JSDOM } = require ('jsdom');
const { backupSchema } = require ('../dist/management-schema');
const { exclusionTemplates } = require ('../dist/exclusion-templates');
const script = fs.readFileSync (require.resolve ('../public/admin.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise (resolve => { setImmediate (resolve); }); };
async function page (t, name) {
    const dom = new JSDOM (fs.readFileSync (require.resolve ('../public/admin-' + name + '.html'), 'utf8'), { url: 'http://localhost/admin-' + name + '.html', runScripts: 'outside-only' });
    t.after (() => dom.window.close ());
    const config = { revision: 0, backups: [], users: [{ id: 'admin', enabled: true, admin: true, grants: [] }], credentials: [{ id: 'key', name: 'Repository', hasPassphrase: true }], templates: exclusionTemplates, nextRuns: {}, runs: [], serverTimezone: 'Europe/Berlin', legacyBackups: ['legacy'] };
    const requests = [];
    dom.window.confirm = () => true;
    dom.window.fetch = async (url, options) => {
        const body = options.body === undefined ? undefined : JSON.parse (options.body);
        requests.push ({ url, options, body });
        if (['PUT', 'DELETE'].includes (options.method) && body.revision !== config.revision) return { ok: false, json: async () => ({ error: 'Configuration changed; reload before saving' }) };
        let value = {};
        if (url.endsWith ('/configuration')) value = config;
        else if (url.endsWith ('/runs')) value = [];
        else if (url.endsWith ('/preview-exclusions')) value = ['template-pattern', ...body.exclusions];
        else if (options.method === 'PUT') {
            if (body.revision !== config.revision) return { ok: false, json: async () => ({ error: 'Configuration changed; reload before saving' }) };
            if (body.backup) { config.backups = [backupSchema.parse (body.backup)]; config.nextRuns[body.backup.id] = '2026-10-31T02:00:00Z'; }
            if (body.user) config.users.push ({ ...body.user, password: undefined });
            if (body.credential) config.credentials = [{ ...body.credential, passphrase: undefined, hasPassphrase: true }];
            config.revision++; value = { revision: config.revision };
        } else if (options.method === 'DELETE') { config.backups = []; config.revision++; }
        return { ok: true, json: async () => JSON.parse (JSON.stringify (value)) };
    };
    dom.window.eval (script); await settle ();
    assert.equal (dom.window.document.getElementById ('admin-content').hidden, false);
    return { window: dom.window, doc: dom.window.document, requests, config };
}

test ('backup admin edits schedules/exclusions and saves local or pull configurations', async t => {
    const { window, doc, requests } = await page (t, 'backups');
    const form = doc.getElementById ('backup-form'); const field = name => form.elements.namedItem (name);
    field ('id').value = 'host-root'; field ('name').value = 'Root'; field ('repository').value = '/backup/repo'; field ('sources').value = '/\n/home';
    field ('times').value = '03:00, 15:45'; field ('frequency').value = 'weekly'; field ('frequency').dispatchEvent (new window.Event ('change'));
    assert.equal (doc.getElementById ('weekdays').hidden, false);
    field ('exclusions').value = '/custom/cache';
    doc.getElementById ('preview-exclusions').click (); await settle ();
    assert.ok (doc.getElementById ('exclusion-preview').value.includes ('/custom/cache'));
    form.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    let saved = requests.find (item => item.options.method === 'PUT').body.backup;
    assert.deepEqual (saved.sources, ['/', '/home']); assert.deepEqual (saved.schedule.times, ['03:00', '15:45']);
    assert.equal (saved.schedule.timezone, 'Europe/Berlin'); assert.equal (field ('id').readOnly, true);
    field ('mode').value = 'pull'; field ('mode').dispatchEvent (new window.Event ('change'));
    assert.equal (doc.getElementById ('remote-fields').hidden, false);
    field ('host').value = 'client.example'; field ('user').value = 'root';
    form.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    saved = requests.filter (item => item.options.method === 'PUT').at (-1).body.backup;
    assert.deepEqual (saved.remote, { host: 'client.example', user: 'root', port: 22 });
    doc.getElementById ('delete-backup').click (); await settle ();
    assert.ok (requests.some (item => item.options.method === 'DELETE'));
    assert.equal (field ('id').readOnly, false);
});

test ('access admin saves user grants and write-only credentials', async t => {
    const { window, doc, requests } = await page (t, 'access');
    const form = doc.getElementById ('user-form');
    form.elements.namedItem ('id').value = 'reader'; form.elements.namedItem ('password').value = 'long-test-password';
    const row = [...doc.querySelectorAll ('.grant')].find (item => item.dataset.backup === 'legacy');
    row.querySelector ('input[data-right=browse]').checked = true;
    form.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    const user = requests.find (item => item.url.endsWith ('/users/reader')).body.user;
    assert.deepEqual (user.grants, [{ backup: 'legacy', browse: true, restore: false, run: false }]);
    assert.equal (form.elements.namedItem ('password').value, '');
    const credentials = doc.getElementById ('credential-form');
    credentials.elements.namedItem ('id').value = 'key'; credentials.elements.namedItem ('name').value = 'Repository';
    credentials.elements.namedItem ('passphrase').value = 'repository-secret'; credentials.elements.namedItem ('sshIdentityFile').value = '/home/borg/.ssh/key';
    credentials.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    const credential = requests.find (item => item.url.endsWith ('/credentials/key')).body.credential;
    assert.equal (credential.passphrase, 'repository-secret');
    assert.equal (credentials.elements.namedItem ('passphrase').value, '');
    assert.ok (requests.every (item => item.options.headers['X-Borg-Admin'] === '1'));
    assert.equal (doc.body.textContent.includes ('repository-secret'), false);
});

test ('refreshing lists does not advance an edited backup form revision', async t => {
    const { window, doc, requests, config } = await page (t, 'backups');
    const form = doc.getElementById ('backup-form');
    for (const [name, value] of Object.entries ({ id: 'job', name: 'Original', repository: '/repo', sources: '/home' })) form.elements.namedItem (name).value = value;
    form.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    const editingRevision = Number (form.dataset.revision);
    config.revision++; config.backups[0].name = 'Another administrator changed this';
    doc.getElementById ('refresh').click (); await settle ();
    form.elements.namedItem ('name').value = 'Stale draft';
    form.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    assert.equal (requests.filter (item => item.options.method === 'PUT').at (-1).body.revision, editingRevision);
    assert.equal (config.backups[0].name, 'Another administrator changed this');
    assert.ok (doc.getElementById ('notice').textContent.includes ('reload'));
});

for (const kind of ['user', 'credential']) test ('stale ' + kind + ' deletion keeps its editing revision', async t => {
    const { doc, requests, config } = await page (t, 'access');
    if (kind === 'user') config.users.push ({ id: 'reader', enabled: true, admin: false, grants: [] });
    doc.getElementById ('refresh').click (); await settle ();
    const root = doc.getElementById (kind + '-list');
    const edit = kind === 'user' ? [...root.querySelectorAll ('tr')].find (row => row.textContent.includes ('reader')).querySelector ('button') : root.querySelector ('button');
    edit.click (); const form = doc.getElementById (kind + '-form'); const editingRevision = Number (form.dataset.revision);
    config.revision++;
    doc.getElementById ('refresh').click (); await settle ();
    doc.getElementById ('delete-' + kind).click (); await settle ();
    assert.equal (requests.filter (item => item.options.method === 'DELETE').at (-1).body.revision, editingRevision);
    assert.ok (doc.getElementById ('notice').textContent.includes ('reload'));
});

test ('main-page Run users can cancel queued or running backups without admin access', async t => {
    const dom = new JSDOM (fs.readFileSync (require.resolve ('../public/index.html'), 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only' });
    t.after (() => dom.window.close ());
    const requests = [];
    dom.window.fetch = async (url, options) => {
        requests.push ({ url, options });
        return { ok: true, json: async () => url.includes ('/cancel') ? { cancelled: true } : { admin: false, backups: {}, state: [], scheduled: [], backupRuns: [{ id: 'run-id', backupId: 'job', state: 'running', message: 'Running' }] } };
    };
    dom.window.eval (fs.readFileSync (require.resolve ('../public/index.js'), 'utf8'));
    dom.window.fetch_status (); await settle ();
    assert.equal (dom.window.document.getElementById ('admin-nav').hidden, true);
    const cancel = dom.window.document.querySelector ('#backup-runs button'); assert.ok (cancel);
    cancel.click (); await settle ();
    const request = requests.find (item => item.url === '/api/admin/runs/run-id/cancel');
    assert.equal (request.options.method, 'POST');
    assert.equal (request.options.headers['X-Borg-Admin'], '1');
});
