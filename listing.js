var archives = [];
var tree = {};
const days = [ 'Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag' ];

fetch ('archives.json',
       { headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' }}
)
.then (res => res.json())
.then (json => {
    archives = parse_archives (json);
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

function parse_archives (ar) {
    var res = [];
    for (const e of ar) {
        var entry = { name: e };
        if (e != null) {
            const d = new Date (e.replace (/^(....-..-..)-(..)(..)(..)$/, '$1T$2:$3:$4.000Z'));
            if (isNaN (d)) {
                console.log ('Invalid date: '+e);
            }
            entry.time = d.getTime();
            entry.descr = 'Backup performed on '+d.toLocaleDateString();
            // Parse all times *before* 6am as day before - that's the way people tick
            const t = entry.time - 6*60*60*1000;
            const dd = new Date (t);
            const now = Date.now();
            if (now - t < 6*24*60*60*1000) {
                entry.short = days [dd.getDay()];
            } else if (now - t < 10*30*24*60*60*1000) {
                entry.short = dd.getDate()+'.'+(dd.getMonth()+1)+'.';
            } else {
                entry.short = dd.getDate()+'.'+(dd.getMonth()+1)+'.'+dd.getFullYear();
            }
        }
        res.push (entry);
    }
    return res;
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
        var ar = [];
        var last = 1e30, count = 0;
        for (const a of [...t.a, 1e30]) {
            if (a == last+1) {
                last = a;
                count++;
            } else {
                if (count === 1) {
                    ar.push (archives[last].short);
                } else if (count > 1) {
                    ar.push (archives[last].short+'('+count+')');
                }
                last = Math.abs(a);
                count = 1;
            }
        }

        html += ' - ' + escapeHtml (ar.join(' '));
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
