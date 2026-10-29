var archives = [];
var tree     = {};

var selected_count = 0, selected_size = 0;
// Restore up to that many files/dirs without asking again
var config = { max_restore_entries_trivial: 1000, max_restore_size_trivial: 100 * 1024 * 1024 };

const urlParams = new URLSearchParams(window.location.search);
const backup    = urlParams.get ('backup');
const backupurl = encodeURIComponent (backup);
const days      = [ 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday' ];

const html_body          = document.getElementsByTagName ('body')[0];
const html_root          = document.getElementById ('root');
const html_backup        = document.getElementById ('backup');
const html_button        = document.getElementById ('button');
const html_possibilities = document.getElementById ('possibilities');
const html_selectionstats= document.getElementById ('selectionstats');

html_backup.innerHTML = escapeHtml (backup);
html_button.addEventListener ('click', initiate_restore);

const html_view = document.getElementById ('view');
const html_archive = document.getElementById ('archive');
const html_archive_picker = document.getElementById ('archive-picker');
const html_error = document.getElementById ('browse-error');
let view = urlParams.get ('view') === 'archive' ? 'archive' : 'files';
let generation = 0;
html_view.value = view;
html_view.addEventListener ('change', () => { view = html_view.value; reload_tree (); });
html_archive.addEventListener ('change', reload_tree);

async function fetch_json (url, options) {
    const response = await fetch (url, options);
    if (!response.ok) throw Error ('Request failed (' + response.status + ')');
    return response.json ();
}
function data_url (path, cursor) {
    const query = view === 'archive' ? '?archive=' + html_archive.value + '&cursor=' + (cursor ?? 0) : '';
    return '/api/data/' + backupurl + '/' + path.split ('/').filter (part => part !== '').map (encodeURIComponent).join ('/') + query;
}
async function reload_tree () {
    const current = ++generation;
    html_body.className = 'wait';
    html_error.textContent = '';
    html_root.innerHTML = '';
    html_button.disabled = true;
    html_selectionstats.textContent = '';
    html_possibilities.textContent = '';
    selected_count = selected_size = 0;
    html_archive_picker.hidden = view !== 'archive';
    try {
        const json = await fetch_json (data_url (''));
        if (current !== generation) return;
        tree = json;
        tree.y = false;
        refs = [tree];
        global_id = 1;
        await update_list (html_root, tree);
    } catch (error) {
        if (current === generation) html_error.textContent = error.message;
    } finally {
        if (current === generation) html_body.className = '';
    }
}
async function initialize () {
    try {
        const status = await fetch_json ('/api/status', { cache: 'no-store' });
        config = status.config ?? config;
        archives = parse_archives (await fetch_json ('/api/archives/' + backupurl));
        // Every backup is selectable, including generations where no files changed.
        for (let i = archives.length - 1; i > 0; i--) {
            const option = document.createElement ('option');
            option.value = i;
            option.textContent = archives[i].name;
            option.title = archives[i].descr;
            html_archive.appendChild (option);
        }
        await reload_tree ();
    } catch (error) {
        html_error.textContent = error.message;
        html_body.className = '';
    }
}
// Run after refs and global_id have been initialized.
queueMicrotask (initialize);

function escapeHtml(x) {
    return x .replaceAll ('&', '&amp;') .replaceAll ('<', '&lt;') .replaceAll ('>', '&gt;') .replaceAll ('"', '&quot;');
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
            entry.descr = 'Backup performed on '+d.toLocaleString();
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
var refs = [];
async function update_list (root, tree) {
    var html = '<ul>';
    if (tree.c === null) {
        // TODO: no way w/o DOM to get parent entry
        var path = '';
        var elem = root.parentNode;
        while (elem.id != 0) {
            const test = elem.id;
            elem = elem.parentNode.parentNode.parentNode;
            const t = refs[elem.id];
            for (const e in t.c) {
                if (t.c[e].i == test) {
                    path = e + path;
                    break;
                }
            }
        }
        html_body.className = 'wait';
        const current = generation;
        const json = await fetch_json (data_url (path));
        if (current !== generation) return;
        tree.c = json.c;
        tree.next = json.next;
        if (tree.y === true) {
            for (const e in tree.c) {
                tree.c[e].y = true;
            }
        }
        html_body.className = '';
    }
    var entries = [];
    const props = Object.keys (tree.c) .sort ((a,b) => (a[0]=='/'?a.slice(1):a).localeCompare (b[0]=='/'?b.slice(1):b) );
    for (const e of props) {
        const t = tree.c[e];
        if (t.i === undefined) {
            t.i = global_id++;
            refs[t.i] = t;
        }
        entries.push (t.i);
        html += `<li id=${t.i}>`;
        html += `<div class="${get_selection_classes(t.y)}"><span>${view === 'archive' ? '' : arToDescr (t.a, 5) .join (' ')}</span></div><div class="${get_disclosure_classes(t)}"><div class=sizes>${sizesToDescr (t)}</div>`;

        if (e.startsWith ('/')) {
            html += escapeHtml (e.slice(1));
        } else {
            html += escapeHtml (e);
        }
        if (t.l !== undefined) {
            html += " &rarr; " + escapeHtml (t.l);
        }

        html += '<span class=pathright></div><div class=sub></div></li>';
    }
    html += '</ul>';
    if (tree.next != null) html += '<button type=button class=more>Load more entries</button>';
    root.innerHTML = html;
    root.querySelector (':scope > .more')?.addEventListener ('click', async event => {
        event.stopPropagation ();
        const current = generation;
        event.target.disabled = true;
        try {
            const path = path_for_tree (tree);
            const json = await fetch_json (data_url (path, tree.next));
            if (current !== generation) return;
            for (const child of Object.values (json.c)) if (tree.y === true) child.y = true;
            Object.assign (tree.c, json.c);
            tree.next = json.next;
            await update_list (root, tree);
        } catch (error) { html_error.textContent = error.message; event.target.disabled = false; }
    });
    for (const id of entries) {
        const elem = document.getElementById (id);
        elem .addEventListener ('click', toggle_dir);
        elem .querySelector ('.entry') .addEventListener ('click', toggle_entry);
        if (refs[id].o) {
            await update_list (elem .querySelector ('.sub'), refs[id]);
        }
    }
}

function path_for_tree (target, node = tree, path = '') {
    if (target === node) return path;
    for (const [name, child] of Object.entries (node.c ?? {})) {
        if (!name.startsWith ('/')) continue;
        const found = path_for_tree (target, child, path + name);
        if (found !== undefined) return found;
    }
}

function arToDescr (array, maxSize) {
    var ar = [];
    var last = 0, count = 0, short = '', long = '';
    if (array == null) {
        return [ '(none selected)' ];
    }
    for (const a of [...array, 1e30]) {
        if (a == last+1) {
            last = a;
            if (short === '') {
                short = archives[a].short;
            }
            long += '\n' + archives[a].descr;
            count++;
        } else {
            if (count > 0) {
                var str = escapeHtml (short);
                if (count > 1) {
                    str += '('+count+')';
                }
                ar.push (`<span title="${escapeHtml(long)}">${str}</span>`);
            }
            if (a < 1e29) {
                last  = Math.abs(a);
                short = archives[last].short;
                long  = archives[last].descr;
                count = 1;
            }
        }
    }

    if (ar.length > maxSize) {
        ar .splice (maxSize);
        ar .push ('...');
    }
    if (ar.length < 1) {
        ar .push ('(none available)');
    }
    return ar;
}
function arToSelect (array, name) {
    if (array == null) {
        return '(none selected)';
    }
    var last = 0, count = 0, id = null, long = '';
    var html = `<select name=${name}>`;

    for (const a of [...array, 1e30]) {
        if (a == last+1) {
            last = a;
            if (id == null) {
                id = a;
            }
            long += '\n' + archives[a].descr;
            count++;
        } else {
            if (count > 0) {
                var str = escapeHtml (archives[id].short);
                if (count > 1) {
                    str += '('+count+')';
                }
                html += `<option value="${id}" title="${escapeHtml(long)}">${str}</option>`;
            }
            last  = Math.abs(a);
            id    = last;
            long  = archives[id]?.descr;
            count = 1;
        }
    }
    html += '</select>';

    return html;
}

function sizesToDescr (t) {
    const s = t.S !== undefined ? t.S : t.s !== undefined ? t.s : 0;
    const c = t.C !== undefined ? t.C : 0;
    return (
            c > 1000000        ? `#${Math.floor(c/100000)/10}M - ` :
            c > 1000           ? `#${Math.floor(c/100)/10}k - ` :
            c > 0              ? `#${c} - ` :
            ''
        ) + (
            s >= 1099511627776 ? Math.floor(s/109951162777.6)/10 + 'TB' :
            s >= 1073741824    ? Math.floor(s/107374182.4)/10 + 'GB' :
            s >= 1048576       ? Math.floor(s/104857.6)/10 + 'MB' :
            s >= 1024          ? Math.floor(s/102.4)/10 + 'kB' :
                                 s + 'B'
       );
}

function get_disclosure_classes (t) {
    const dir      = (t.c !== undefined ? ' dir' : '');
    const open     = (t.o ? ' open' : '');
    return 'path'+dir+open;
}

function get_selection_classes (y) {
    const selected = (y !== undefined ? (y === true ? ' selected' : ' partial') : '');
    return 'entry'+selected;
}

async function toggle_dir (evt) {
    evt.stopPropagation();
    const t = refs[this.id];
    if (t.c === undefined) {
        return;
    }
    if (! t.o) {
        t.o = true;
        try { await update_list (this .querySelector ('.sub'), t); }
        catch (error) { t.o = false; html_error.textContent = error.message; html_body.className = ''; }
    } else {
        t.o = false;
        this .querySelector ('.sub') .innerHTML = '';
    }
    this .querySelector ('.path') .className = get_disclosure_classes (t);
}

function set_selection_up (t, y) {
    t.y = y;
    // TODO: no way w/o DOM to get parent entry
    const elem = document.getElementById (t.i) .querySelector ('.entry');
    elem .className = get_selection_classes (t.y);
    var count = 0, selected = false;
    const list = elem.parentNode.parentNode.children;
    for (const e of list) {
        const y = refs [e.id] .y;
        if (y === false) {
            count = -1;
            break;
        } else if (y === true) {
            count += 2;
        }
    }
    const parent = refs[elem.parentNode.parentNode.parentNode.parentNode.id];
    if (count === list.length * 2 && parent?.next == null) {
        selected = true;
    } else if (count === 0) {
        selected = undefined;
    }
    if (elem.parentNode.parentNode.parentNode.parentNode.id > 0) {
        set_selection_up (refs[elem.parentNode.parentNode.parentNode.parentNode.id], selected);
    }
}

function set_selection_down (tree, y) {
    if (y === false) {
        return;
    }
    tree.y = y;
    if (tree.i !== undefined) {
        const elem = document.getElementById (tree.i);
        if (elem) {
            elem .querySelector ('.entry') .className = get_selection_classes (y);
        }
    }
    if (tree.c != undefined) {  // || null
        for (const e in tree.c) {
            set_selection_down (tree.c[e], y);
        }
    }
}

function toggle_entry (evt) {
    evt.stopPropagation();
    const id = this.parentNode.id;
    const t = refs[id];
    if (t.y === undefined) {
        t.y = true;
    } else {
        t.y = undefined;
    }
    set_selection_up   (t, t.y);
    set_selection_down (t, t.y);
    var ar;
    [ar, selected_count, selected_size] = find_available_archives (tree, null);
    if (view === 'archive') {
        html_possibilities.textContent = archives[html_archive.value].name;
        html_button.disabled = selected_count === 0;
        html_selectionstats.textContent = selected_count === 0 ? '' : 'Selected elements: ' + sizesToDescr ({ C: selected_count, S: selected_size });
        return;
    }
    html_possibilities.innerHTML = arToSelect (ar, 'ar');
    html_button.disabled = true;
    if (ar == null || ar.length == 0) {
        html_selectionstats.innerHTML = '';
    } else {
        html_selectionstats.innerHTML = 'Selected elements: '+sizesToDescr ({ C: selected_count, S: selected_size });
        html_possibilities.querySelector ('select') .addEventListener ('click', toggle_select);
    }
}

function toggle_select () {
    html_button.disabled = false;
}

// return available archives for selected backup set, and count and size
function find_available_archives (t, ar) {
    // Endpoint - either single file or fully to be restored dir
    if (t.y === true) {
        return [view === 'archive' ? null : merge_ar (ar, t.a?.length > 0 ? t.a : null),
                t.C !== undefined ? t.C + 1 : 1,
                t.S !== undefined ? t.S : t.s !== undefined ? t.s : 0];
    }
    // Nothing to restore below
    if (t.y === undefined) {
        return [ar, 0, 0];
    }
    // Descend if anything below
    var count = t === tree ? 0 : 1, size = 0;
    for (const e in t.c) {
        const [a, c, s] = find_available_archives (t.c[e], ar);
        ar = merge_ar (ar, a);
        count += c;
        size  += s;
    }
    return [ar, count, size];
}
function merge_ar (ar, todo) {
    var new_ar = [];
    if (ar == null) {
        return todo;
    }
    if (todo == null) {
        return ar;
    }
    if (todo.length == 0) {
        return todo;
    }
    // i: index over new entries, j: index over old current entries
    for (var i = 0, j = 0; i < todo.length; i++) {
        // Entries not in original set
        while (Math.abs (Math.abs(ar[j]) < Math.abs (todo[i]))) {
            j++;
        }
        if (ar[j] === todo[i]) {
            // New is the same, advance both indices
            new_ar.push (ar[j++]);
        } else if (ar[j] === -todo[i]) {
            // New is the same, with different sign, advance both indices,
            // push negative entry (negative wins over positive)
            new_ar.push (- Math.abs (ar[j++]));
        } else {
            // Entries not the new set
        }
    }
    return new_ar;
}

// return list of full paths for (fully to be restored) directories and files
function find_end_paths (t, p, list) {
    // Endpoint - either single file or fully to be restored dir
    if (t.y === true) {
        list.push (p);
        return;
    }
    // Nothing to restore below
    if (t.y === undefined) {
        return;
    }
    // Descend if anything below
    for (const e in t.c) {
        var sub = p + (e.startsWith ('/') ? e.slice(1) + '/' : e);
        find_end_paths (t.c[e], sub, list);
    }
}

async function initiate_restore () {
    const ar = view === 'archive' ? html_archive.value : document.querySelector('select[name=ar]').value;
    if (ar == null) {
        console.log ('this should not happen');
        return;
    }
    const name = archives[Math.abs(ar)].name;
    if ((selected_count <= config.max_restore_entries_trivial && selected_size <= config.max_restore_size_trivial) ||
        confirm (`Are you REALLY sure to start the restore process on the selected files from archive ${name}?\n\nYou will be restoring\n... ${selected_count} elements\nwith a total size of\n... ${sizesToDescr({S: selected_size})}\n\n- which is quite a lot!!!`)) {
        const list = [];
        find_end_paths (tree, '', list);
        const obj = { archive: name, list: list.sort() };
        try {
            html_body.className = 'wait';
            const response = await fetch ('/api/restore/' + backupurl,
                                          {   method: 'POST',
                                              headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                                              body: JSON.stringify (obj)
                                          });
            await response.json();
            html_body.className = 'wait';
            history.back();
        } catch (e) {
            confirm ('Error: ' + e.message);
            html_body.className = '';
        }
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
