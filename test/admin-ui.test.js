const { test } = require ('node:test');
const assert = require ('node:assert/strict');
const fs = require ('node:fs');
const { JSDOM } = require ('jsdom');
const { backupSchema } = require ('../dist/management-schema');
const { exclusionTemplates } = require ('../dist/exclusion-templates');
const script = fs.readFileSync (require.resolve ('../public/admin.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise (resolve => { setImmediate (resolve); }); };
async function page (t, name) {
    const dom = new JSDOM (fs.readFileSync (require.resolve ('../public/admin-' + name + '.html'), 'utf8'), { url: 'http://localhost/admin-' + name + '.html', runScripts: 'outside-only', pretendToBeVisual: true });
    t.after (() => dom.window.close ());
    const config = { revision: 0, backups: [], users: [{ id: 'admin', enabled: true, admin: true, grants: [] }], credentials: [{ id: 'key', name: 'Repository', hasPassphrase: true }], templates: exclusionTemplates, nextRuns: {}, runs: [], serverTimezone: 'Europe/Berlin', legacyBackups: ['legacy'] };
    const requests = [];
    const outputs = new Map ();
    let poll;
    dom.window.setInterval = callback => { poll = callback; };
    dom.window.confirm = () => true;
    dom.window.fetch = async (url, options) => {
        const body = options.body === undefined ? undefined : JSON.parse (options.body);
        requests.push ({ url, options, body });
        if (['PUT', 'DELETE'].includes (options.method) && body.revision !== config.revision) return { ok: false, json: async () => ({ error: 'Configuration changed; reload before saving' }) };
        let value = {};
        if (url.endsWith ('/configuration')) value = config;
        else if (url.endsWith ('/runs')) value = config.runs;
        else if (url.endsWith ('/output')) value = outputs.get (url.split ('/').at (-2)) ?? { text: '', available: false, truncated: false };
        else if (url.endsWith ('/run')) {
            value = { id: 'live', backupId: url.split ('/').at (-2), action: 'backup', origin: 'manual', archive: 'live-archive', state: 'running', message: 'Running' };
            config.runs.push (value);
        }
        else if (url.endsWith ('/preview-exclusions')) value = ['template-pattern', ...body.backup.exclusions];
        else if (options.method === 'PUT') {
            if (body.revision !== config.revision) return { ok: false, json: async () => ({ error: 'Configuration changed; reload before saving' }) };
            if (body.destinations) {
                const id = url.split ('/').at (-1);
                config.backups = [...config.backups.filter (backup => (backup.sourceId ?? backup.id) !== id), ...body.destinations.map (backup => backupSchema.parse (backup))];
            }
            if (body.user) config.users.push ({ ...body.user, password: undefined });
            if (body.credential) config.credentials = [{ ...body.credential, passphrase: undefined, hasPassphrase: true }];
            config.revision++; value = { revision: config.revision };
        } else if (options.method === 'DELETE') { config.backups = []; config.revision++; }
        return { ok: true, json: async () => JSON.parse (JSON.stringify (value)) };
    };
    dom.window.eval (script); await settle ();
    assert.equal (dom.window.document.getElementById ('admin-content').hidden, false);
    return { window: dom.window, doc: dom.window.document, requests, config, outputs, poll };
}

test ('backup admin edits schedules/exclusions and saves local or pull configurations', async t => {
    const { window, doc, requests } = await page (t, 'backups');
    const form = doc.getElementById ('backup-form'); const field = name => form.elements.namedItem (name);
    field ('sourceName').value = 'Server files'; field ('id').value = 'host-root'; field ('name').value = 'Root'; field ('repository').value = '/backup/repo'; field ('sources').value = '/\n/home';
    field ('times').value = '03:00, 15:45'; field ('frequency').value = 'weekly'; field ('frequency').dispatchEvent (new window.Event ('change'));
    assert.equal (doc.getElementById ('weekdays').hidden, false);
    field ('exclusions').value = '/custom/cache';
    doc.getElementById ('preview-exclusions').click (); await settle ();
    assert.ok (doc.getElementById ('exclusion-preview').value.includes ('/custom/cache'));
    doc.getElementById ('add-destination').click ();
    field ('id').value = 'host-offsite'; field ('name').value = 'Offsite'; field ('repository').value = '/backup/offsite';
    field ('times').value = '05:45'; field ('enabled').checked = true;
    doc.getElementById ('destination-tabs').firstElementChild.click ();
    assert.equal (field ('times').value, '03:00, 15:45');
    form.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    const destinations = requests.find (item => item.options.method === 'PUT').body.destinations;
    let saved = destinations[0];
    assert.equal (destinations.length, 2);
    assert.equal (destinations[1].sourceId, saved.sourceId);
    assert.deepEqual (destinations[1].schedule.times, ['05:45']);
    assert.equal (destinations[1].enabled, true);
    assert.deepEqual (destinations[1].sources, ['/','/home']);
    assert.match (doc.getElementById ('backup-list').textContent, /Server files.*2 destinations/);
    assert.deepEqual (saved.sources, ['/', '/home']); assert.deepEqual (saved.schedule.times, ['03:00', '15:45']);
    assert.equal (saved.schedule.timezone, 'Europe/Berlin'); assert.equal (field ('id').readOnly, true);
    field ('mode').value = 'pull'; field ('mode').dispatchEvent (new window.Event ('change'));
    assert.equal (doc.getElementById ('remote-fields').hidden, false);
    field ('host').value = 'client.example'; field ('user').value = 'root';
    form.dispatchEvent (new window.Event ('submit', { cancelable: true })); await settle ();
    const updated = requests.filter (item => item.options.method === 'PUT').at (-1).body.destinations;
    saved = updated[0];
    assert.deepEqual (updated[1].remote, saved.remote);
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
    for (const [name, value] of Object.entries ({ id: 'job', name: 'Original', sourceName: 'A source', repository: '/repo', sources: '/home' })) form.elements.namedItem (name).value = value;
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

test ('backup console starts a specific destination, follows live output and filters completed statistics', async t => {
    const { window, doc, requests, config, outputs, poll } = await page (t, 'backups');
    config.backups.push (backupSchema.parse ({ id: 'local', name: 'Local disk', sourceId: 'files', sourceName: 'Files', mode: 'local', repository: '/repo', sources: ['/home'] }));
    config.runs.push (
        { id: 'old-1', backupId: 'local', destinationName: 'Local disk', sourceName: 'Files', archive: 'local-2026-10-30-030000',
            startedAt: '2026-10-30T03:00:00Z', finishedAt: '2026-10-30T03:02:22Z', action: 'backup', origin: 'scheduled',
            state: 'done', message: 'Finished', statistics: { files: 13, originalBytes: 2048, compressedBytes: 128, deduplicatedBytes: 64 } },
        { id: 'old-2', backupId: 'removed', action: 'backup', origin: 'manual', state: 'warning', message: 'Finished with warnings' }
    );
    doc.getElementById ('refresh').click (); await settle ();
    doc.querySelector ('.source-card').click ();
    outputs.set ('live', { text: 'Reading /home\rPacking files <b>sample</b>', available: true, truncated: false });
    [...doc.querySelectorAll ('#destination-actions button')].find (button => button.textContent === 'Run now').click ();
    await settle ();
    assert.ok (requests.some (request => request.url.endsWith ('/backups/local/run')));
    assert.equal (doc.getElementById ('history-view').hidden, false);
    const log = doc.getElementById ('log-text');
    assert.match (log.textContent, /Reading \/home\nPacking files <b>sample<\/b>/);
    assert.equal (log.querySelector ('b'), null);
    assert.match (doc.getElementById ('output-status').textContent, /Running/);
    const live = config.runs.find (run => run.id === 'live');
    live.state = 'done'; live.message = 'Finished';
    outputs.set ('live', { text: 'Finished create', available: true, truncated: true });
    poll (); await settle ();
    assert.match (log.textContent, /Finished create/);
    assert.match (doc.getElementById ('output-status').textContent, /Succeeded.*last 64 KiB/);
    assert.match (doc.getElementById ('download-log').href, /runs\/live\/log$/);
    const filter = doc.getElementById ('history-filter');
    filter.value = 'local'; filter.dispatchEvent (new window.Event ('change'));
    const history = doc.getElementById ('run-list').textContent;
    assert.match (history, /2m 22s.*2 KiB.*13 files.*128 B compressed.*64 B deduplicated/);
    assert.doesNotMatch (history, /removed/);
    assert.match (doc.getElementById ('history-metrics').textContent, /Completed backups2Succeeded2Warnings or failures0Deduplicated data written64 B/);
    assert.equal (doc.getElementById ('download-log').hidden, false);
    doc.getElementById ('close-output').click ();
    assert.equal (doc.getElementById ('run-output').hidden, true);
});
