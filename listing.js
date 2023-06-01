var tree = {};

fetch ('archives.json',
       { headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' }}
)
.then (res => res.json())
.then (json => {
    archives = json;
    return fetch ('data.json',
       { headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' }});
})
.then (res => res.json())
.then (json => {
    tree = json;
    update_list (document.getElementById ('root'), tree);
});

function escapeHtml(x) {
    return x .replaceAll ('&', '&amp;') .replaceAll ('<', '&lt;') .replaceAll ('>', '&gt;');
}

var global_id=1;
var refs = {};
function update_list (root, tree) {
    var html = '<ul>';
    var evts = [];
    for (const e in tree.c) {
        const t = tree.c[e];
        if (t.c != null) {
            if (t.i === undefined) {
                t.i = global_id++;
                refs[t.i] = t;
            }
        }
        if (t.i != undefined) {
            html += `<li id=${t.i} class="${get_disclosure_classes(t)}">`;
            evts.push (t.i);
        } else {
            html += '<li>';
        }
        if (e.startsWith ('/')) {
            html += escapeHtml (e.slice(1));
        } else {
            html += escapeHtml (e);
        }
        if (t.l !== undefined) {
            html += " &rarr; " + escapeHtml (t.l);
        }
        html += ' - ' + escapeHtml (JSON.stringify (t.a));
        html += '<div></div></li>';
    }
    html += '</ul>';
    root.innerHTML = html;
    for (const id of evts) {
        const elem = document.getElementById (id);
        elem .addEventListener ('click', toggle_dir);
        if (refs[id].o) {
            update_list (elem .querySelector ('div'), refs[id]);
        }
    }
}

function get_disclosure_classes (t) {
    const dir      = (t.c !== undefined ? 'dir ' : '');
    const selected = (t.y !== undefined ? (t.y === true ? 'allsel ' : 'sel ') : '');
    const open     = (t.o ? 'open' : '');
    return dir+selected+open;
}

function toggle_dir (evt) {
    evt.stopPropagation();
    const t = refs[this.id];
    const elem = document.getElementById (this.id);
    if (! t.o) {
        t.o = true;
        elem .className = get_disclosure_classes (t);
        update_list (elem .querySelector ('div'), t);
    } else {
        t.o = false;
        elem .className = get_disclosure_classes (t);
        elem .querySelector ('div') .innerHTML = '';
    }
}

// Data structure:
// Object: a "Archives" - Array of archive names TBC
//         c "Children" - keys are dir/file names
//         s "Size"  t "mTime"  l "link" of last added archive
//         c available on dirs, s and t on files, l on links
// Local properties:
//         o open
//         y "yes" selected for backup: undefined (no) false (partial) true (yes)
