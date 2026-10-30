'use strict';
const page = document.body.dataset.page;
const notice = document.getElementById ('notice');
let configuration;
function message (text, error = false) { notice.textContent = text; notice.className = error ? 'error' : ''; }
async function request (route, method = 'GET', body) {
    const response = await fetch ('/api/admin' + route, { method, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Borg-Admin': '1' }, body: body === undefined ? undefined : JSON.stringify (body) });
    const json = await response.json ();
    if (!response.ok) throw Error (json.error ?? 'Request failed (' + response.status + ')');
    return json;
}
function element (tag, text, parent, attributes = {}) {
    const node = document.createElement (tag); if (text !== undefined) node.textContent = text;
    Object.assign (node, attributes); if (parent) parent.appendChild (node); return node;
}
function button (parent, text, action, danger = false) {
    const node = element ('button', text, parent, { type: 'button', className: danger ? 'danger' : '' });
    node.addEventListener ('click', () => { void perform (node, action); }); return node;
}
async function perform (control, action) {
    control.disabled = true; message ('');
    try { await action (); }
    catch (error) { message (error.message, true); }
    finally { control.disabled = false; }
}
function field (form, name) { return form.elements.namedItem (name); }
function values (text) { return text.split (/[,\n]/).map (value => value.trim ()).filter (Boolean); }
function lines (text) { return text.split (/\r?\n/).map (value => value.trim ()).filter (Boolean); }
function stamp (text) { return text ? new Date (text).toLocaleString () : 'Disabled'; }
function table (root, headers) {
    root.replaceChildren (); const node = element ('table', undefined, root); const row = element ('tr', undefined, element ('thead', undefined, node));
    for (const header of headers) element ('th', header, row); return element ('tbody', undefined, node);
}
async function refresh () {
    configuration = await request ('/configuration');
    document.getElementById ('admin-content').hidden = false;
    if (page === 'backups') { renderBackups (); renderBackupOptions (); await renderRuns (); }
    else { renderUsers (); renderCredentials (); }
}
function backupFormValue () {
    const form = document.getElementById ('backup-form');
    const value = name => field (form, name).value;
    const checked = name => field (form, name).checked;
    const backup = { id: value ('id'), name: value ('name'), enabled: checked ('enabled'), mode: value ('mode'), repository: value ('repository'), sources: lines (value ('sources')),
        credentialId: value ('credentialId') || undefined,
        schedule: { frequency: value ('frequency'), timezone: value ('timezone'), times: values (value ('times')), weekdays: [...document.querySelectorAll ('#weekdays input:checked')].map (node => Number (node.value)), monthdays: values (value ('monthdays')).map (Number) },
        templates: [...document.querySelectorAll ('#templates input:checked')].map (node => node.value), exclusions: lines (value ('exclusions')),
        retention: { enabled: checked ('retentionEnabled'), daily: Number (value ('daily')), weekly: Number (value ('weekly')), monthly: Number (value ('monthly')), yearly: Number (value ('yearly')) },
        compact: checked ('compact'), compression: value ('compression'), oneFileSystem: checked ('oneFileSystem'), excludeCaches: checked ('excludeCaches'), index: checked ('index'), restoreDirectory: value ('restoreDirectory'), timeoutMinutes: Number (value ('timeoutMinutes')) };
    if (backup.mode === 'pull') backup.remote = { host: value ('host'), user: value ('user'), port: Number (value ('port')) };
    return backup;
}
function renderBackupOptions () {
    const form = document.getElementById ('backup-form');
    const selected = field (form, 'credentialId').value; const select = field (form, 'credentialId'); select.replaceChildren ();
    element ('option', 'Use service account environment', select, { value: '' });
    for (const credential of configuration.credentials) element ('option', credential.name, select, { value: credential.id }); select.value = selected;
    const root = document.getElementById ('templates'); const selectedTemplates = [...root.querySelectorAll ('input:checked')].map (node => node.value);
    const initial = !root.children.length; root.replaceChildren ();
    for (const template of configuration.templates) {
        const label = element ('label', undefined, root);
        element ('input', undefined, label, { type: 'checkbox', value: template.id, checked: initial ? ['linux', 'caches', 'trash', 'webgui'].includes (template.id) : selectedTemplates.includes (template.id) });
        label.appendChild (document.createTextNode (' ' + template.name)); element ('small', template.description, label);
    }
}
function modeFields () {
    const form = document.getElementById ('backup-form'); const pull = field (form, 'mode').value === 'pull';
    document.getElementById ('remote-fields').hidden = !pull;
    field (form, 'host').required = pull; field (form, 'user').required = pull;
    document.getElementById ('weekdays').hidden = field (form, 'frequency').value !== 'weekly';
    document.getElementById ('monthdays-label').hidden = field (form, 'frequency').value !== 'monthly';
}
function editBackup (backup) {
    const form = document.getElementById ('backup-form'); form.reset (); form.dataset.editing = backup?.id ?? '';
    field (form, 'id').readOnly = Boolean (backup); document.getElementById ('delete-backup').hidden = !backup;
    document.getElementById ('editor-title').textContent = backup ? 'Edit ' + backup.name : 'Add backup';
    field (form, 'timezone').value = configuration.serverTimezone;
    if (backup) {
        for (const name of ['id', 'name', 'mode', 'repository', 'compression', 'timeoutMinutes', 'restoreDirectory']) field (form, name).value = backup[name];
        for (const name of ['enabled', 'compact', 'oneFileSystem', 'excludeCaches', 'index']) field (form, name).checked = backup[name];
        field (form, 'credentialId').value = backup.credentialId ?? '';
        field (form, 'sources').value = backup.sources.join ('\n'); field (form, 'exclusions').value = backup.exclusions.join ('\n');
        for (const name of ['frequency', 'timezone']) field (form, name).value = backup.schedule[name];
        field (form, 'times').value = backup.schedule.times.join (', '); field (form, 'monthdays').value = backup.schedule.monthdays.join (', ');
        for (const input of document.querySelectorAll ('#weekdays input')) input.checked = backup.schedule.weekdays.includes (Number (input.value));
        for (const input of document.querySelectorAll ('#templates input')) input.checked = backup.templates.includes (input.value);
        field (form, 'retentionEnabled').checked = backup.retention.enabled;
        for (const name of ['daily', 'weekly', 'monthly', 'yearly']) field (form, name).value = backup.retention[name];
        if (backup.mode === 'pull') for (const name of ['host', 'user', 'port']) field (form, name).value = backup.remote[name];
    } else {
        for (const input of document.querySelectorAll ('#weekdays input')) input.checked = true;
        for (const input of document.querySelectorAll ('#templates input')) input.checked = ['linux', 'caches', 'trash', 'webgui'].includes (input.value);
    }
    document.getElementById ('exclusion-preview-label').hidden = true; modeFields ();
}
function renderBackups () {
    const body = table (document.getElementById ('backup-list'), ['Backup', 'Next run', 'Actions']);
    for (const backup of configuration.backups) {
        const row = element ('tr', undefined, body); const label = element ('td', undefined, row);
        element ('strong', backup.name, label); element ('small', backup.id + ' · ' + backup.mode, label);
        element ('td', stamp (configuration.nextRuns[backup.id]), row);
        const actions = element ('td', undefined, row, { className: 'actions' });
        button (actions, 'Edit', () => { editBackup (backup); });
        button (actions, 'Run now', async () => { if (confirm ('Run backup ' + backup.name + ' now?')) { await request ('/backups/' + encodeURIComponent (backup.id) + '/run', 'POST', {}); await renderRuns (); } });
        button (actions, 'Initialize repository', async () => {
            if (confirm ('Initialize a NEW encrypted repository for ' + backup.name + '? Existing repositories must not be reinitialized. A stored passphrase is required.')) { await request ('/backups/' + encodeURIComponent (backup.id) + '/initialize', 'POST', {}); await renderRuns (); }
        });
    }
    if (!configuration.backups.length) element ('p', 'No managed backups yet.', document.getElementById ('backup-list'));
}
async function renderRuns () {
    const runs = await request ('/runs'); const body = table (document.getElementById ('run-list'), ['Backup / action', 'State', 'Started / queued', 'Log']);
    for (const run of runs.slice ().reverse ().slice (0, 50)) {
        const row = element ('tr', undefined, body); element ('td', run.backupId + ' · ' + run.action, row);
        const state = element ('td', undefined, row); element ('span', run.state, state, { className: 'status ' + run.state }); element ('small', run.message, state);
        element ('td', stamp (run.startedAt ?? run.queuedAt), row); const actions = element ('td', undefined, row);
        element ('a', 'Open log', actions, { href: '/api/admin/runs/' + encodeURIComponent (run.id) + '/log', target: '_blank', rel: 'noopener' });
        if (['running', 'queued'].includes (run.state)) button (actions, 'Cancel', async () => { await request ('/runs/' + encodeURIComponent (run.id) + '/cancel', 'POST', {}); await renderRuns (); });
    }
}
function renderUsers () {
    const body = table (document.getElementById ('user-list'), ['User', 'Access', 'Actions']);
    for (const user of configuration.users) {
        const row = element ('tr', undefined, body); element ('td', user.id, row); element ('td', !user.enabled ? 'Disabled' : user.admin ? 'Administrator' : 'Backup grants', row);
        button (element ('td', undefined, row), 'Edit', () => { editUser (user); });
    }
}
function editUser (user) {
    const form = document.getElementById ('user-form'); form.reset (); form.dataset.editing = user?.id ?? '';
    field (form, 'id').value = user?.id ?? ''; field (form, 'id').readOnly = Boolean (user); field (form, 'password').required = !user;
    field (form, 'admin').checked = user?.admin ?? false; field (form, 'enabled').checked = user?.enabled ?? true;
    document.getElementById ('user-title').textContent = user ? 'Edit ' + user.id : 'Add user'; document.getElementById ('delete-user').hidden = !user;
    const ids = [...new Set (['*', ...configuration.backups.map (backup => backup.id), ...configuration.legacyBackups, ...(user?.grants ?? []).map (grant => grant.backup)])];
    const root = document.getElementById ('grants'); root.replaceChildren ();
    const body = table (root, ['Backup', 'Browse', 'Restore', 'Run']);
    for (const id of ids) {
        const row = element ('tr', undefined, body, { className: 'grant' }); row.dataset.backup = id;
        element ('td', id === '*' ? 'All backups (including future ones)' : id, row);
        const existing = user?.grants.find (grant => grant.backup === id);
        for (const right of ['browse', 'restore', 'run']) {
            const cell = element ('td', undefined, row); const input = element ('input', undefined, cell, { type: 'checkbox', checked: existing?.[right] ?? false });
            input.dataset.right = right; input.setAttribute ('aria-label', right + ' ' + id);
        }
    }
}
function renderCredentials () {
    const body = table (document.getElementById ('credential-list'), ['Credential', 'Stored', 'Actions']);
    for (const credential of configuration.credentials) {
        const row = element ('tr', undefined, body); element ('td', credential.name + ' (' + credential.id + ')', row);
        element ('td', [credential.hasPassphrase ? 'Passphrase set' : '', credential.sshIdentityFile ? 'SSH key file' : ''].filter (Boolean).join (', ') || 'No secrets', row);
        button (element ('td', undefined, row), 'Edit', () => { editCredential (credential); });
    }
}
function editCredential (credential) {
    const form = document.getElementById ('credential-form'); form.reset (); form.dataset.editing = credential?.id ?? '';
    for (const name of ['id', 'name', 'sshIdentityFile']) field (form, name).value = credential?.[name] ?? '';
    field (form, 'id').readOnly = Boolean (credential); document.getElementById ('delete-credential').hidden = !credential;
    document.getElementById ('credential-title').textContent = credential ? 'Edit ' + credential.name : 'Add credential';
}
async function initialize () {
    try {
        await refresh ();
        document.getElementById ('refresh').addEventListener ('click', event => { void perform (event.target, refresh); });
        if (page === 'backups') {
            const form = document.getElementById ('backup-form');
            const weekdays = document.getElementById ('weekdays');
            for (const [index, name] of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].entries ()) {
                const label = element ('label', undefined, weekdays, { className: 'check' }); element ('input', undefined, label, { type: 'checkbox', value: index + 1, checked: true }); label.appendChild (document.createTextNode (name));
            }
            for (const zone of Intl.supportedValuesOf?. ('timeZone') ?? ['UTC']) element ('option', undefined, document.getElementById ('timezones'), { value: zone });
            editBackup ();
            field (form, 'mode').addEventListener ('change', modeFields); field (form, 'frequency').addEventListener ('change', modeFields);
            document.getElementById ('new-backup').addEventListener ('click', () => { editBackup (); });
            document.getElementById ('cancel-edit').addEventListener ('click', () => { editBackup (); });
            form.addEventListener ('submit', event => { event.preventDefault (); void perform (form.querySelector ('button[type=submit]'), async () => {
                const backup = backupFormValue (); await request ('/backups/' + encodeURIComponent (backup.id), 'PUT', { revision: configuration.revision, backup }); await refresh (); editBackup (configuration.backups.find (entry => entry.id === backup.id)); message ('Backup saved.');
            }); });
            document.getElementById ('delete-backup').addEventListener ('click', event => { void perform (event.target, async () => {
                if (confirm ('Remove this definition? Repository archives and restored files will be kept.')) { await request ('/backups/' + encodeURIComponent (form.dataset.editing), 'DELETE', { revision: configuration.revision }); await refresh (); editBackup (); message ('Definition removed.'); }
            }); });
            document.getElementById ('preview-exclusions').addEventListener ('click', event => { void perform (event.target, async () => {
                const patterns = await request ('/preview-exclusions', 'POST', backupFormValue ()); document.getElementById ('exclusion-preview').value = patterns.join ('\n'); document.getElementById ('exclusion-preview-label').hidden = false;
            }); });
            setInterval (() => { void renderRuns ().catch (error => { message (error.message, true); }); }, 10000);
        } else {
            editUser (); editCredential ();
            document.getElementById ('new-user').addEventListener ('click', () => { editUser (); }); document.getElementById ('new-credential').addEventListener ('click', () => { editCredential (); });
            const users = document.getElementById ('user-form'); const credentials = document.getElementById ('credential-form');
            users.addEventListener ('submit', event => { event.preventDefault (); void perform (users.querySelector ('button[type=submit]'), async () => {
                const grants = [...document.querySelectorAll ('.grant')].map (row => ({ backup: row.dataset.backup, ...Object.fromEntries ([...row.querySelectorAll ('input')].map (input => [input.dataset.right, input.checked])) })).filter (grant => grant.browse || grant.restore || grant.run);
                const user = { id: field (users, 'id').value, password: field (users, 'password').value || undefined, admin: field (users, 'admin').checked, enabled: field (users, 'enabled').checked, grants };
                await request ('/users/' + encodeURIComponent (user.id), 'PUT', { revision: configuration.revision, user }); field (users, 'password').value = ''; await refresh (); editUser (configuration.users.find (entry => entry.id === user.id)); message ('User saved.');
            }); });
            credentials.addEventListener ('submit', event => { event.preventDefault (); void perform (credentials.querySelector ('button[type=submit]'), async () => {
                const credential = { id: field (credentials, 'id').value, name: field (credentials, 'name').value, passphrase: field (credentials, 'passphrase').value || undefined, clearPassphrase: field (credentials, 'clearPassphrase').checked, sshIdentityFile: field (credentials, 'sshIdentityFile').value || undefined };
                await request ('/credentials/' + encodeURIComponent (credential.id), 'PUT', { revision: configuration.revision, credential }); field (credentials, 'passphrase').value = ''; await refresh (); editCredential (configuration.credentials.find (entry => entry.id === credential.id)); message ('Credential saved.');
            }); });
            for (const [kind, form] of [['user', users], ['credential', credentials]]) document.getElementById ('delete-' + kind).addEventListener ('click', event => { void perform (event.target, async () => {
                if (confirm ('Remove this ' + kind + '?')) { await request ('/' + kind + 's/' + encodeURIComponent (form.dataset.editing), 'DELETE', { revision: configuration.revision }); await refresh (); if (kind === 'user') editUser (); else editCredential (); message ('Removed.'); }
            }); });
        }
    } catch (error) { message (error.message, true); }
}
void initialize ();
