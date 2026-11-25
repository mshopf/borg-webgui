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
    for (const form of document.forms) if (page !== 'backups' && !form.dataset.editing && field (form, 'id')?.value === '') form.dataset.revision = configuration.revision;
    if (page === 'backups') {
        runs = configuration.runs;
        renderBackups (); credentialOptions (); renderHistoryFilter ();
        if (destinations.length) renderDestinationActions ();
        if (view === 'history') renderHistory ();
    }
    else { renderUsers (); renderCredentials (); }
}
let sourceId;
let destinationIndex = 0;
let destinations = [];
let runs = [];
let historyPage = 0;
let watchedRun;
let watchVersion = 0;
let view = 'sources';
let polling = false;

const runActive = run => run.state === 'queued' || run.state === 'running';
const sourceKey = backup => backup.sourceId ?? backup.id;
const historyPageSize = 12;
const backupForm = () => document.getElementById ('backup-form');

function sourceGroups () {
    const groups = new Map ();
    for (const backup of configuration.backups) {
        const id = sourceKey (backup);
        if (!groups.has (id)) groups.set (id, []);
        groups.get (id).push (backup);
    }
    return groups;
}
function sourceValues () {
    const form = backupForm ();
    const value = name => field (form, name).value;
    const source = { sourceName: value ('sourceName').trim (), mode: value ('mode'), sources: lines (value ('sources')) };
    if (source.mode === 'pull') source.remote = { host: value ('host').trim (), user: value ('user').trim (), port: Number (value ('port')) };
    return source;
}
function destinationValues () {
    const form = backupForm ();
    const value = name => field (form, name).value;
    const checked = name => field (form, name).checked;
    return {
        id: value ('id').trim (), name: value ('name').trim (), enabled: checked ('enabled'), repository: value ('repository').trim (),
        credentialId: value ('credentialId') || undefined,
        schedule: { frequency: value ('frequency'), timezone: value ('timezone').trim (), times: values (value ('times')),
            weekdays: [...document.querySelectorAll ('#weekdays input:checked')].map (node => Number (node.value)), monthdays: values (value ('monthdays')).map (Number) },
        templates: [...document.querySelectorAll ('#templates input:checked')].map (node => node.value), exclusions: lines (value ('exclusions')),
        retention: { enabled: checked ('retentionEnabled'), daily: Number (value ('daily')), weekly: Number (value ('weekly')), monthly: Number (value ('monthly')), yearly: Number (value ('yearly')) },
        compact: checked ('compact'), compression: value ('compression'), oneFileSystem: checked ('oneFileSystem'),
        excludeCaches: checked ('excludeCaches'), index: checked ('index'), restoreDirectory: value ('restoreDirectory').trim (), timeoutMinutes: Number (value ('timeoutMinutes'))
    };
}
function defaultDestination () {
    return {
        id: '', name: '', repository: '', enabled: false, compression: 'lz4', timeoutMinutes: 720, restoreDirectory: './restore',
        oneFileSystem: true, excludeCaches: true, index: true, compact: false, exclusions: [],
        templates: ['linux', 'caches', 'trash', 'webgui'],
        schedule: { frequency: 'daily', timezone: configuration.serverTimezone, times: ['03:00'], monthdays: [1], weekdays: [1, 2, 3, 4, 5, 6, 7] },
        retention: { enabled: true, daily: 14, weekly: 8, monthly: 24, yearly: 10 }
    };
}
function credentialOptions () {
    const select = field (backupForm (), 'credentialId');
    const selected = select.value;
    select.replaceChildren ();
    element ('option', 'Use service account environment', select, { value: '' });
    for (const credential of configuration.credentials) element ('option', credential.name, select, { value: credential.id });
    selectCredential (selected);
}
function selectCredential (id) {
    const select = field (backupForm (), 'credentialId');
    select.querySelector ('[data-missing]')?.remove ();
    if (id && ![...select.options].some (option => option.value === id)) {
        const missing = element ('option', 'Unavailable credential (' + id + ')', select, { value: id });
        missing.dataset.missing = 'true';
    }
    select.value = id ?? '';
}
function modeFields () {
    const form = backupForm ();
    const pull = field (form, 'mode').value === 'pull';
    document.getElementById ('remote-fields').hidden = !pull;
    for (const name of ['host', 'user', 'port']) field (form, name).disabled = !pull;
    field (form, 'host').required = pull; field (form, 'user').required = pull;
    document.getElementById ('weekdays').hidden = field (form, 'frequency').value !== 'weekly';
    document.getElementById ('monthdays-label').hidden = field (form, 'frequency').value !== 'monthly';
}
function editSource (id) {
    const group = sourceGroups ().get (id);
    const source = group?.[0];
    const form = backupForm ();
    sourceId = source ? id : undefined;
    form.dataset.revision = configuration.revision;
    field (form, 'sourceName').value = source?.sourceName ?? source?.name ?? '';
    field (form, 'sources').value = source?.sources.join ('\n') ?? '';
    field (form, 'mode').value = source?.mode ?? 'local';
    const remote = source?.remote;
    for (const [name, value] of Object.entries ({ host: remote?.host ?? '', user: remote?.user ?? 'root', port: remote?.port ?? 22 })) field (form, name).value = value;
    destinations = group ? group.map (destination => ({ saved: destination, draft: destination })) : [{ draft: defaultDestination () }];
    document.getElementById ('editor-title').textContent = source ? 'Edit ' + field (form, 'sourceName').value : 'Add source';
    document.getElementById ('delete-backup').hidden = !source;
    form.dataset.dirty = '';
    loadDestination (0);
    renderBackups ();
}
function saveDestinationDraft () {
    destinations[destinationIndex].draft = destinationValues ();
}
function loadDestination (index) {
    destinationIndex = index;
    const form = backupForm ();
    const { saved, draft } = destinations[index];
    for (const name of ['id', 'name', 'repository', 'compression', 'timeoutMinutes', 'restoreDirectory']) field (form, name).value = draft[name];
    for (const name of ['enabled', 'compact', 'oneFileSystem', 'excludeCaches', 'index']) field (form, name).checked = draft[name];
    field (form, 'id').readOnly = Boolean (saved);
    selectCredential (draft.credentialId);
    field (form, 'exclusions').value = draft.exclusions.join ('\n');
    for (const name of ['frequency', 'timezone']) field (form, name).value = draft.schedule[name];
    field (form, 'times').value = draft.schedule.times.join (', ');
    field (form, 'monthdays').value = draft.schedule.monthdays.join (', ');
    for (const input of document.querySelectorAll ('#weekdays input')) input.checked = draft.schedule.weekdays.includes (Number (input.value));
    for (const input of document.querySelectorAll ('#templates input')) input.checked = draft.templates.includes (input.value);
    field (form, 'retentionEnabled').checked = draft.retention.enabled;
    for (const name of ['daily', 'weekly', 'monthly', 'yearly']) field (form, name).value = draft.retention[name];
    document.getElementById ('exclusion-preview-label').hidden = true;
    modeFields ();
    renderDestinationTabs ();
    renderDestinationActions ();
}
function renderDestinationTabs () {
    const tabs = document.getElementById ('destination-tabs');
    tabs.replaceChildren ();
    for (const [index, destination] of destinations.entries ()) {
        const tab = element ('button', destination.draft.name || 'Destination ' + (index + 1), tabs, { type: 'button' });
        tab.setAttribute ('aria-pressed', index === destinationIndex);
        tab.addEventListener ('click', () => {
            if (index === destinationIndex) return;
            saveDestinationDraft (); loadDestination (index);
            tabs.children[index].focus ();
        });
    }
}
function renderDestinationActions () {
    const root = document.getElementById ('destination-actions');
    root.replaceChildren ();
    const { saved } = destinations[destinationIndex];
    if (saved) {
        const active = runs.find (run => run.backupId === saved.id && runActive (run));
        if (active) button (root, 'Watch run', () => watchRun (active.id));
        else {
            button (root, 'Run now', async () => {
                if (!confirm ('Run the saved configuration for ' + saved.name + ' now?')) return;
                const run = await request ('/backups/' + encodeURIComponent (saved.id) + '/run', 'POST', {});
                runs = [...runs, run]; await watchRun (run.id);
            }).classList.add ('primary');
            button (root, 'Initialize repository', async () => {
                if (!confirm ('Initialize a new encrypted repository for ' + saved.name + '? A stored passphrase is required.')) return;
                const run = await request ('/backups/' + encodeURIComponent (saved.id) + '/initialize', 'POST', {});
                runs = [...runs, run]; await watchRun (run.id);
            });
        }
        const next = configuration.nextRuns[saved.id];
        element ('small', next ? 'Next scheduled run ' + stamp (next) : 'Schedule disabled', root);
    }
    if (destinations.length > 1) button (root, 'Remove destination', () => {
        if (saved && !confirm ('Remove ' + saved.name + ' on save? Its archives and logs will be kept.')) return;
        destinations.splice (destinationIndex, 1);
        backupForm ().dataset.dirty = 'true';
        loadDestination (Math.min (destinationIndex, destinations.length - 1));
    }, true);
}
function canDiscard () {
    return !backupForm ().dataset.dirty || confirm ('Discard unsaved source changes?');
}
function renderBackups () {
    const root = document.getElementById ('backup-list');
    root.replaceChildren ();
    const groups = sourceGroups ();
    for (const [id, group] of groups) {
        const source = group[0];
        const card = element ('button', undefined, root, { type: 'button', className: 'source-card' });
        card.setAttribute ('aria-pressed', id === sourceId);
        card.addEventListener ('click', () => {
            if (id !== sourceId && canDiscard ()) {
                editSource (id);
                root.querySelector ('[aria-pressed=true]')?.focus ();
            }
        });
        element ('strong', source.sourceName ?? source.name, card);
        const paths = source.sources.join (', ');
        element ('span', source.mode === 'pull' ? source.remote.host + ' · ' + paths : paths, card, { className: 'source-path', title: paths });
        element ('span', group.length + (group.length === 1 ? ' destination' : ' destinations'), card, { className: 'source-count' });
    }
    if (!groups.size) element ('p', 'No sources configured.', root, { className: 'empty' });
    renderOverview ();
}
function metric (root, name, value) {
    const card = element ('div', undefined, root, { className: 'metric' });
    element ('span', name, card); element ('strong', String (value), card);
}
function renderOverview () {
    const root = document.getElementById ('overview-metrics');
    root.replaceChildren ();
    metric (root, 'Sources', sourceGroups ().size);
    metric (root, 'Destinations', configuration.backups.length);
    metric (root, 'Active runs', runs.filter (runActive).length);
}
function renderHistoryFilter () {
    const filter = document.getElementById ('history-filter');
    const previous = filter.value;
    const labels = new Map (runs.map (run => [run.backupId, run.destinationName ?? run.backupId]));
    for (const backup of configuration.backups) labels.set (backup.id, (backup.sourceName ? backup.sourceName + ' / ' : '') + backup.name);
    filter.replaceChildren ();
    element ('option', 'All destinations', filter, { value: '' });
    for (const [id, name] of labels) element ('option', name, filter, { value: id });
    filter.value = labels.has (previous) ? previous : '';
}
function bytes (value) {
    if (value === undefined) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return new Intl.NumberFormat (undefined, { maximumFractionDigits: 1 }).format (value) + ' ' + units[unit];
}
function duration (run) {
    if (!run.startedAt || !run.finishedAt) return '—';
    const seconds = Math.max (0, Math.round ((Date.parse (run.finishedAt) - Date.parse (run.startedAt)) / 1000));
    if (seconds >= 3600) return Math.floor (seconds / 3600) + 'h ' + Math.floor ((seconds % 3600) / 60) + 'm';
    return seconds >= 60 ? Math.floor (seconds / 60) + 'm ' + (seconds % 60) + 's' : seconds + 's';
}
function runState (state) {
    return ({ done: 'Succeeded', error: 'Failed', warning: 'Warning', queued: 'Queued', running: 'Running', cancelled: 'Cancelled', interrupted: 'Interrupted' })[state] ?? state;
}
function renderHistory () {
    const destination = document.getElementById ('history-filter').value;
    const filtered = runs.filter (run => !destination || run.backupId === destination);
    const count = Math.ceil (filtered.length / historyPageSize);
    historyPage = Math.min (historyPage, Math.max (0, count - 1));
    const completed = filtered.filter (run => run.action === 'backup' && !runActive (run));
    const stored = completed.flatMap (run => run.statistics?.deduplicatedBytes === undefined ? [] : [run.statistics.deduplicatedBytes]);
    const metrics = document.getElementById ('history-metrics');
    metrics.replaceChildren ();
    metric (metrics, 'Completed backups', completed.length);
    metric (metrics, 'Succeeded', completed.filter (run => run.state === 'done').length);
    metric (metrics, 'Warnings or failures', completed.filter (run => ['warning', 'error', 'interrupted'].includes (run.state)).length);
    metric (metrics, 'Deduplicated data written', bytes (stored.length ? stored.reduce ((total, size) => total + size, 0) : undefined));
    const root = document.getElementById ('run-list');
    if (!filtered.length) { root.replaceChildren (); element ('p', 'No runs for this selection.', root, { className: 'empty' }); }
    else {
        const body = table (root, ['Destination', 'Started', 'Status', 'Duration', 'Archive size', 'Output']);
        for (const run of filtered.slice ().reverse ().slice (historyPage * historyPageSize, (historyPage + 1) * historyPageSize)) {
            const row = element ('tr', undefined, body);
            const dest = element ('td', undefined, row);
            element ('strong', run.destinationName ?? run.backupId, dest);
            element ('small', run.sourceName ?? run.backupId, dest);
            const time = element ('td', stamp (run.startedAt ?? run.queuedAt), row);
            element ('small', run.action === 'initialize' ? 'Repository initialization' : run.origin === 'scheduled' ? 'Scheduled' : 'Manual', time);
            const state = element ('td', undefined, row);
            element ('span', runState (run.state), state, { className: 'status ' + run.state, title: run.message });
            element ('td', duration (run), row);
            const stats = element ('td', bytes (run.statistics?.originalBytes), row);
            if (run.statistics?.files !== undefined) element ('small', run.statistics.files.toLocaleString () + ' files', stats);
            if (run.statistics?.compressedBytes !== undefined) element ('small', bytes (run.statistics.compressedBytes) + ' compressed', stats);
            if (run.statistics?.deduplicatedBytes !== undefined) element ('small', bytes (run.statistics.deduplicatedBytes) + ' deduplicated', stats);
            const actions = element ('div', undefined, element ('td', undefined, row), { className: 'actions' });
            button (actions, runActive (run) ? 'Watch' : 'View log', () => watchRun (run.id));
            if (runActive (run)) button (actions, 'Cancel', async () => {
                if (!confirm ('Cancel this backup run?')) return;
                await request ('/runs/' + encodeURIComponent (run.id) + '/cancel', 'POST', {}); await pollRuns ();
            });
        }
    }
    document.getElementById ('history-pagination').hidden = count < 2;
    document.getElementById ('newer-runs').disabled = historyPage === 0;
    document.getElementById ('older-runs').disabled = historyPage + 1 >= count;
    document.getElementById ('run-page').textContent = 'Page ' + (historyPage + 1) + ' of ' + count;
}
function showView (name) {
    view = name;
    const history = name === 'history';
    document.getElementById ('sources-view').hidden = history;
    document.getElementById ('history-view').hidden = !history;
    document.getElementById ('new-backup').hidden = history;
    document.getElementById ('view-title').textContent = history ? 'Run history' : 'Backup management';
    document.getElementById ('view-description').textContent = history ? 'Watch running backups and review results from previous runs.' : 'Configure what gets backed up, where it goes, and when it runs.';
    for (const button of document.querySelectorAll ('[data-view]')) {
        if (button.dataset.view === name) button.setAttribute ('aria-current', 'page'); else button.removeAttribute ('aria-current');
    }
    if (history) renderHistory ();
}
async function watchRun (id) {
    watchedRun = id;
    watchVersion++;
    showView ('history');
    const panel = document.getElementById ('run-output');
    panel.hidden = false;
    const log = document.getElementById ('log-text');
    log.textContent = 'Loading output…';
    document.getElementById ('download-log').hidden = true;
    const output = updateOutput ();
    panel.scrollIntoView?. ({ block: 'nearest' });
    log.focus ({ preventScroll: true });
    await output;
}
async function updateOutput () {
    const run = runs.find (entry => entry.id === watchedRun);
    if (!run) {
        document.getElementById ('output-status').textContent = 'This run is no longer in retained history.';
        return;
    }
    const version = ++watchVersion;
    const url = '/runs/' + encodeURIComponent (run.id);
    document.getElementById ('output-title').textContent = run.archive;
    const status = document.getElementById ('output-status');
    const state = runState (run.state);
    status.textContent = run.message === state ? state : state + ' · ' + run.message;
    const output = await request (url + '/output');
    if (version !== watchVersion) return;
    const log = document.getElementById ('log-text');
    const follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    const text = output.text ? output.text.replace (/\r\n?/g, '\n') : output.available ? 'Waiting for output…' : 'No log has been written for this run.';
    if (log.textContent !== text) {
        log.textContent = text;
        if (follow) log.scrollTop = log.scrollHeight;
    }
    const download = document.getElementById ('download-log');
    download.hidden = !output.available;
    download.href = '/api/admin' + url + '/log';
    if (output.truncated) status.textContent += ' · Showing the last 64 KiB';
}
async function pollRuns () {
    if (polling) return;
    polling = true;
    try {
        const previous = runs.find (run => run.id === watchedRun);
        const next = await request ('/runs');
        const runsChanged = JSON.stringify (next) !== JSON.stringify (runs);
        const scheduleElapsed = Object.values (configuration.nextRuns).some (time => time && Date.parse (time) <= Date.now ());
        if (runsChanged) {
            runs = next;
            renderOverview ();
            renderHistoryFilter ();
            if (view === 'history') renderHistory ();
        }
        if (scheduleElapsed) configuration.nextRuns = (await request ('/backups')).nextRuns;
        if ((runsChanged || scheduleElapsed) && destinations.length) renderDestinationActions ();
        const selected = runs.find (run => run.id === watchedRun);
        if (view === 'history' && watchedRun && (!selected || runActive (selected) || (previous && runActive (previous)))) await updateOutput ();
    } finally { polling = false; }
}
function initializeBackups () {
    const form = backupForm ();
    const weekdays = document.getElementById ('weekdays');
    for (const [index, name] of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].entries ()) {
        const label = element ('label', undefined, weekdays, { className: 'check' });
        element ('input', undefined, label, { type: 'checkbox', value: index + 1 });
        label.appendChild (document.createTextNode (name));
    }
    for (const template of configuration.templates) {
        const label = element ('label', undefined, document.getElementById ('templates'));
        element ('input', undefined, label, { type: 'checkbox', value: template.id });
        label.appendChild (document.createTextNode (' ' + template.name));
        element ('small', template.description, label);
    }
    for (const zone of Intl.supportedValuesOf?. ('timeZone') ?? ['UTC']) element ('option', undefined, document.getElementById ('timezones'), { value: zone });
    credentialOptions ();
    editSource (sourceGroups ().keys ().next ().value);
    form.addEventListener ('input', () => { form.dataset.dirty = 'true'; });
    field (form, 'mode').addEventListener ('change', modeFields);
    field (form, 'frequency').addEventListener ('change', modeFields);
    document.getElementById ('new-backup').addEventListener ('click', () => { if (canDiscard ()) { editSource (); field (form, 'sourceName').focus (); } });
    document.getElementById ('cancel-edit').addEventListener ('click', () => { if (canDiscard ()) editSource (sourceId); });
    document.getElementById ('add-destination').addEventListener ('click', () => {
        saveDestinationDraft ();
        destinations.push ({ draft: defaultDestination () });
        form.dataset.dirty = 'true';
        loadDestination (destinations.length - 1);
        field (form, 'name').focus ();
    });
    for (const control of document.querySelectorAll ('[data-view]')) control.addEventListener ('click', () => {
        showView (control.dataset.view);
        if (view === 'history' && watchedRun) void updateOutput ().catch (error => { message (error.message, true); });
    });
    document.getElementById ('history-filter').addEventListener ('change', () => { historyPage = 0; renderHistory (); });
    document.getElementById ('newer-runs').addEventListener ('click', () => { historyPage--; renderHistory (); });
    document.getElementById ('older-runs').addEventListener ('click', () => { historyPage++; renderHistory (); });
    document.getElementById ('close-output').addEventListener ('click', () => {
        watchedRun = undefined; watchVersion++;
        document.getElementById ('run-output').hidden = true;
        document.getElementById ('history-filter').focus ();
    });
    form.addEventListener ('submit', event => {
        event.preventDefault ();
        void perform (form.querySelector ('button[type=submit]'), async () => {
            saveDestinationDraft ();
            const incomplete = destinations.findIndex (({ draft }) => !draft.id || !draft.name || !draft.repository);
            if (incomplete >= 0) {
                loadDestination (incomplete);
                form.reportValidity ();
                throw Error ('Enter a name, archive prefix and repository for each destination.');
            }
            const id = sourceId ?? 'source-' + crypto.getRandomValues (new Uint32Array (4)).join ('-');
            const source = sourceValues ();
            form.inert = true;
            try {
                await request ('/sources/' + encodeURIComponent (id), 'PUT', {
                    revision: Number (form.dataset.revision), destinations: destinations.map (({ draft }) => ({ ...draft, ...source, sourceId: id }))
                });
                await refresh (); editSource (id); message ('Source saved.');
            } finally { form.inert = false; }
        });
    });
    document.getElementById ('delete-backup').addEventListener ('click', event => {
        void perform (event.target, async () => {
            if (!confirm ('Remove this source and all its destination definitions? Archives and logs will be kept.')) return;
            form.inert = true;
            try {
                await request ('/sources/' + encodeURIComponent (sourceId), 'DELETE', { revision: Number (form.dataset.revision) });
                await refresh (); editSource (); message ('Source removed.');
            } finally { form.inert = false; }
        });
    });
    document.getElementById ('preview-exclusions').addEventListener ('click', event => {
        void perform (event.target, async () => {
            saveDestinationDraft ();
            const backup = { ...destinations[destinationIndex].draft, ...sourceValues (), sourceId };
            const repositories = destinations.map (({ draft }) => draft.repository).filter (Boolean);
            const patterns = await request ('/preview-exclusions', 'POST', { backup, repositories });
            document.getElementById ('exclusion-preview').value = patterns.join ('\n');
            document.getElementById ('exclusion-preview-label').hidden = false;
        });
    });
    setInterval (() => { if (!document.hidden) void pollRuns ().catch (error => { message (error.message, true); }); }, 3000);
}
function renderUsers () {
    const body = table (document.getElementById ('user-list'), ['User', 'Access', 'Actions']);
    for (const user of configuration.users) {
        const row = element ('tr', undefined, body); element ('td', user.id, row); element ('td', !user.enabled ? 'Disabled' : user.admin ? 'Administrator' : 'Backup grants', row);
        button (element ('td', undefined, row), 'Edit', () => { editUser (user); });
    }
}
function editUser (user) {
    const form = document.getElementById ('user-form'); form.reset (); form.dataset.editing = user?.id ?? ''; form.dataset.revision = configuration.revision;
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
    const form = document.getElementById ('credential-form'); form.reset (); form.dataset.editing = credential?.id ?? ''; form.dataset.revision = configuration.revision;
    for (const name of ['id', 'name', 'sshIdentityFile']) field (form, name).value = credential?.[name] ?? '';
    field (form, 'id').readOnly = Boolean (credential); document.getElementById ('delete-credential').hidden = !credential;
    document.getElementById ('credential-title').textContent = credential ? 'Edit ' + credential.name : 'Add credential';
}
async function initialize () {
    try {
        await refresh ();
        document.getElementById ('refresh').addEventListener ('click', event => { void perform (event.target, refresh); });
        if (page === 'backups') initializeBackups ();
        else {
            editUser (); editCredential ();
            document.getElementById ('new-user').addEventListener ('click', () => { editUser (); }); document.getElementById ('new-credential').addEventListener ('click', () => { editCredential (); });
            const users = document.getElementById ('user-form'); const credentials = document.getElementById ('credential-form');
            users.addEventListener ('submit', event => { event.preventDefault (); void perform (users.querySelector ('button[type=submit]'), async () => {
                const grants = [...document.querySelectorAll ('.grant')].map (row => ({ backup: row.dataset.backup, ...Object.fromEntries ([...row.querySelectorAll ('input')].map (input => [input.dataset.right, input.checked])) })).filter (grant => grant.browse || grant.restore || grant.run);
                const user = { id: field (users, 'id').value, password: field (users, 'password').value || undefined, admin: field (users, 'admin').checked, enabled: field (users, 'enabled').checked, grants };
                await request ('/users/' + encodeURIComponent (user.id), 'PUT', { revision: Number (users.dataset.revision), user }); field (users, 'password').value = ''; await refresh (); editUser (configuration.users.find (entry => entry.id === user.id)); message ('User saved.');
            }); });
            credentials.addEventListener ('submit', event => { event.preventDefault (); void perform (credentials.querySelector ('button[type=submit]'), async () => {
                const credential = { id: field (credentials, 'id').value, name: field (credentials, 'name').value, passphrase: field (credentials, 'passphrase').value || undefined, clearPassphrase: field (credentials, 'clearPassphrase').checked, sshIdentityFile: field (credentials, 'sshIdentityFile').value || undefined };
                await request ('/credentials/' + encodeURIComponent (credential.id), 'PUT', { revision: Number (credentials.dataset.revision), credential }); field (credentials, 'passphrase').value = ''; await refresh (); editCredential (configuration.credentials.find (entry => entry.id === credential.id)); message ('Credential saved.');
            }); });
            for (const [kind, form] of [['user', users], ['credential', credentials]]) document.getElementById ('delete-' + kind).addEventListener ('click', event => { void perform (event.target, async () => {
                if (confirm ('Remove this ' + kind + '?')) { await request ('/' + kind + 's/' + encodeURIComponent (form.dataset.editing), 'DELETE', { revision: Number (form.dataset.revision) }); await refresh (); if (kind === 'user') editUser (); else editCredential (); message ('Removed.'); }
            }); });
        }
    } catch (error) { message (error.message, true); }
}
void initialize ();
