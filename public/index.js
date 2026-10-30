const html_root  = document.getElementById ('root');
const html_state = document.getElementById ('state');
var config = {};

function fetch_status () {
    fetch ('/api/status', { headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' }, cache: "no-store"})
    .then (res => { if (!res.ok) throw Error ('Authentication required or request failed'); return res.json(); })
    .then (json => {
        update_backups (json.backups);
        update_state   (json.state?.reverse());
        config = json.config;
        document.getElementById ('admin-nav').hidden = !json.admin;
        update_scheduled (json.scheduled ?? [], json.backupRuns ?? []);
    }).catch (error => { html_root.textContent = error.message; });
}
window.onload = fetch_status;
setInterval (fetch_status, 5000);

function escapeHtml(x) {
    if (x == null) {
        return '';
    }
    return x .replaceAll ('&', '&amp;') .replaceAll ('<', '&lt;') .replaceAll ('>', '&gt;') .replaceAll ('"', '&quot;');
}
function escapeQuery(x) {
    return encodeURIComponent (x) .replaceAll ('%20', '+');
}

async function update_backups (backups) {
    var html = '<ul>';
    for (const e in backups) {
        html += `<li><a href="listing.html?backup=${escapeQuery(e)}"><div class=entry>${escapeHtml(''+backups[e])} Archives</div><div class=path><b>${escapeHtml(e)}</b></div></a></li>`;
    }
    html_root.innerHTML = html+'</ul>';
}

async function update_state (state) {
    var html = '<ul>';
    for (const e of state) {
        var info = escapeHtml (e.info);
        if (e.texecute) {
            info += ' - Started ' + (new Date (e.texecute) .toLocaleTimeString());
        } else if (e.tschedule) {
            info += ' - Scheduled ' + (new Date (e.tschedule) .toLocaleString());
        }
        if (e.tfinish) {
            info += ' - Finished ' + (new Date (e.tfinish) .toLocaleTimeString());
        }

        html += `<li><div class="entry ${escapeHtml(e.state)}">${info}</div><div class=path><div>`;
        if (e.handle != null) {
            html += `<a href="log/${escapeHtml(e.handle)}.log"><b>${escapeHtml(e.handle)}</b></a> `;
        }
        html += `(${escapeHtml(e.archive)}): ${escapeHtml(e.short)}</div></div></li>`;
    }
    if (state.length == 0) {
        html += '<li>None</li>'
    }
    html_state.innerHTML = html+'</ul>';
}

function update_scheduled (backups, runs) {
    const root = document.getElementById ('scheduled'); root.replaceChildren ();
    for (const backup of backups) {
        const row = document.createElement ('p');
        row.textContent = backup.name + ' — ' + (backup.nextRun ? new Date (backup.nextRun).toLocaleString () : 'Schedule disabled') + ' ';
        if (backup.canRun) {
            const button = document.createElement ('button'); button.type = 'button'; button.textContent = 'Run now';
            button.addEventListener ('click', async () => {
                if (!confirm ('Run ' + backup.name + ' now?')) return;
                button.disabled = true;
                try {
                    const response = await fetch ('/api/admin/backups/' + encodeURIComponent (backup.id) + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Borg-Admin': '1' }, body: '{}' });
                    const result = await response.json ();
                    if (!response.ok) throw Error (result.error);
                    fetch_status ();
                } catch (error) { alert (error.message); }
                finally { button.disabled = false; }
            }); row.appendChild (button);
        }
        root.appendChild (row);
    }
    if (!backups.length) root.textContent = 'No scheduled backups available.';
    const log = document.getElementById ('backup-runs'); log.replaceChildren ();
    for (const run of runs.slice ().reverse ().slice (0, 30)) {
        const row = document.createElement ('p');
        row.textContent = run.backupId + ': ' + run.state + ' — ' + run.message + ' ';
        const link = document.createElement ('a'); link.textContent = 'Log'; link.href = '/api/admin/runs/' + encodeURIComponent (run.id) + '/log'; row.appendChild (link); log.appendChild (row);
        if (['queued', 'running'].includes (run.state)) {
            const cancel = document.createElement ('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
            cancel.addEventListener ('click', async () => {
                cancel.disabled = true;
                try {
                    const response = await fetch ('/api/admin/runs/' + encodeURIComponent (run.id) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Borg-Admin': '1' }, body: '{}' });
                    const result = await response.json ();
                    if (!response.ok) throw Error (result.error);
                    fetch_status ();
                } catch (error) { alert (error.message); }
                finally { cancel.disabled = false; }
            }); row.appendChild (cancel);
        }
    }
    if (!runs.length) log.textContent = 'No backup runs yet.';
}
