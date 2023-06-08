var backups = [];

fetch ('/api/backups', { headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' }})
.then (res => res.json())
.then (json => {
    backups = json;
    update_list (document.getElementById ('root'));
});

function escapeHtml(x) {
    return x .replaceAll ('&', '&amp;') .replaceAll ('<', '&lt;') .replaceAll ('>', '&gt;');
}
function escapeQuery(x) {
    return encodeURIComponent (x) .replaceAll ('%20', '+');
}

async function update_list (root) {
    var html = '<ul>';
    for (const e in backups) {
        html += `<li><a href="listing.html?backup=${escapeQuery(e)}"><div class=entry>${escapeHtml(''+backups[e])} Archives</div><div class=path>${escapeHtml(e)}</div></a></li>`;
    }
    root.innerHTML = html;
}

