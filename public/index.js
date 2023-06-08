var backups, state;

function fetch_status () {
    fetch ('/api/status', { headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' }})
    .then (res => res.json())
    .then (json => {
        backups = json.backups;
        state   = json.state;
        update_backups (document.getElementById ('root'));
        update_state   (document.getElementById ('state'));
    });
}
fetch_status();
setInterval (fetch_status, 5000);

function escapeHtml(x) {
    return x .replaceAll ('&', '&amp;') .replaceAll ('<', '&lt;') .replaceAll ('>', '&gt;');
}
function escapeQuery(x) {
    return encodeURIComponent (x) .replaceAll ('%20', '+');
}

async function update_backups (root) {
    var html = '<ul>';
    for (const e in backups) {
        html += `<li><a href="listing.html?backup=${escapeQuery(e)}"><div class=entry>${escapeHtml(''+backups[e])} Archives</div><div class=path>${escapeHtml(e)}</div></a></li>`;
    }
    root.innerHTML = html+'</ul>';
}

async function update_state (root) {
    var html = '<ul>';
    for (const e of state) {
        var info = escapeHtml (e.info) + ' - Scheduled ' + (new Date (e.tschedule) .toLocaleString());
        if (e.tfinish) {
            info += ' - Finished ' + (new Date (e.tfinish) .toLocaleTimeString());
        } else if (e.texecute) {
            info += ' - Started ' + (new Date (e.texecute) .toLocaleTimeString());
        }

        html += `<li><div class=entry>${info}</div><div class=path>${escapeHtml(e.handle)} - ${escapeHtml(e.firstfullpath)}...</div></li>`;
    }
    if (state.length == 0) {
        html += '<li>None</li>'
    }
    root.innerHTML = html+'</ul>';
}
