const html_root  = document.getElementById ('root');
const html_state = document.getElementById ('state');

function fetch_status () {
    fetch ('/api/status', { headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' }, cache: "no-store"})
    .then (res => res.json())
    .then (json => {
        update_backups (json.backups);
        update_state   (json.state?.reverse());
    });
}
window.onload = fetch_status;
setInterval (fetch_status, 5000);

function escapeHtml(x) {
    return x .replaceAll ('&', '&amp;') .replaceAll ('<', '&lt;') .replaceAll ('>', '&gt;');
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

        html += `<li><div class="entry ${escapeHtml(e.state)}">${info}</a></div><div class=path><div><a href="log/${escapeHtml(e.handle)}.log"><b>${escapeHtml(e.handle)}</b></a> (${escapeHtml(e.archive)}): ${escapeHtml(e.fullinfo)}</div></div></li>`;
    }
    if (state.length == 0) {
        html += '<li>None</li>'
    }
    html_state.innerHTML = html+'</ul>';
}
