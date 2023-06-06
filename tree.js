// Usage: node ./tree.js -<path> <path> [...]
//        Removes entries ('-'), adds entries
//
// borg list --format "{type} {path} {size} {isomtime}" --json-lines /data/backup/zuse2/borg::zuse2-%-2023-05-28-023001 | bzip2 >zuse2-%-2023-05-28-023001.bz2

const fs  = require ('fs');
const node_stream = require('stream');
const bz2 = require ('unbzip2-stream');
const readline = require ('readline');

// walk tree structure
function walk_tree (tree, path, level=0) {
    var ar = "";
    for (const e of tree.a) {
        ar += " "+e;
    }
    console.log ("walk: " + path +
                 " ["+ar.trimStart()+"]" +
                 (tree.s ? " Size "+tree.s+" Time "+tree.t : "") +
                 (tree.l ? " Link "+tree.l : ""));
    if (tree.c !== undefined) {
        for (const e in tree.c) {
            walk_tree (tree.c[e], path + '/' + (e[0] === '/' ? e.slice(1) : e), level+1);
        }
    }
}

// update directory entries
function consolidate_dirs (tree) {
    if (tree.c === undefined) {
        return tree.a;
    }
    // TODO? creates directory data afresh - reuse known data?
    var ar = [];
    // Logic:
    // Unite all entries below this directory.
    // Negative entries mean changes, they win over positive entries
    for (const e in tree.c) {
        var sub = consolidate_dirs (tree.c[e]);
        var new_ar = [];
        // i: index over new entries, j: index over old current entries
        for (var i = 0, j = 0; i < sub.length; i++) {
            // Push entries already there before new one
            while (Math.abs (Math.abs(ar[j]) < Math.abs (sub[i]))) {
                new_ar.push (ar[j++]);
            }
            if (ar[j] === sub[i]) {
                // New is the same, advance both indices
                new_ar.push (ar[j++]);
            } else if (ar[j] === -sub[i]) {
                // New is the same, with different sign, advance both indices,
                // push negative entry (negative wins over positive)
                new_ar.push (- Math.abs (ar[j++]));
            } else {
                // Gap in current list, don't advance index
                new_ar.push (sub[i]);
            }
        }
        // Push all left over indices from current list
        while (ar[j] !== undefined) {
            new_ar.push (ar[j++]);
        }
        ar = new_ar;
    }
    tree.a = ar;
    return ar;
}

// recursivelly remove an archive
function remove_archive (tree, nr) {
    for (const i in tree.a) {
        if (tree.a[i] === nr) {
            tree.a.splice (i, 1);
            for (var j = i; j < tree.a.length; j++) {
                tree.a[j] = Math.sign (tree.a[j]) * (Math.abs (tree.a[j]) - 1);
            }
            break;
        } else if (tree.a[i] === -nr) {
            tree.a.splice (i, 1);
            for (var j = i; j < tree.a.length; j++) {
                tree.a[j] = Math.sign (tree.a[j]) * (Math.abs (tree.a[j]) - 1);
            }
            if (i < tree.a.length && tree.a[i] > 0) {
                tree.a[i] = -tree.a[i];
            }
            break;
        } else if (Math.abs (tree.a[i]) > nr) {
            for (var j = i; j < tree.a.length; j++) {
                tree.a[j] = Math.sign (tree.a[j]) * (Math.abs (tree.a[j]) - 1);
            }
            break;
        }
    }
    if (tree.c !== undefined) {
        for (const e in tree.c) {
            remove_archive (tree.c[e], nr);
        }
    }
}


// create a node
function add_node (tree, entry, archive, s, t, l) {
    if (tree.c[entry] === undefined) {
        tree.c[entry] = { a: [] };
    }
    const node = tree.c[entry];
    const a = node.a;
    const last_a = a[a.length-1];
    const ns = node.s, nt = node.t, nl = node.l;
    node.s = s;
    node.t = t;
    node.l = l;
    if (last_a === -archive) {
        return;
    }
    if (ns !== s || nt !== t || nl !== l) {
        if (last_a === archive) {
            a[a.length-1] = -archive;
        } else {
            a.push (-archive);
        }
    } else {
        if (last_a !== archive) {
            a.push (archive);
        }
    }
}

// create / set directory entry
function add_tree (t, entry, archive) {
    if (t.c[entry] === undefined) {
        t.c[entry] = { a: [], c: {} };
    }
    return t.c[entry];
}

// find and create subdirectory entries
function find_tree (tree, path, archive) {
    const p = path.split ('/');
    var t = tree;
    for (const e of p) {
        if (e === '') {
            continue;
        }
        t = add_tree (t, '/'+e, archive);
    }
    return t;
}


async function read_tree (file, archive) {

//        if (files[i].match (/\.json
    var stream = fs.createReadStream (file);
    if (file.slice (-4) === ".bz2") {
        stream = stream.pipe (bz2());
    }

    const rl = readline.createInterface ({
        input: stream,
        output: null,
        terminal: false
    });

    for await (const line of rl) {
        const obj = JSON.parse (line);
        if (obj.path === '.') {
            continue;
        }
        const path = "/" + obj.path;
        const last_index = path.lastIndexOf ('/');
        if (last_index !== last_path.length) {
            // There has been a dir entry missing
            last_path = path.slice (0, last_index);
            last_tree = find_tree (tree, last_path, archive);
        }
        // directory entry?
        if (obj.type === 'd') {
            const dir_name = path.slice (last_path.length);
            last_path = path;
            last_tree = add_tree (last_tree, dir_name, archive);
            continue;
        }
        // Something different - find in tree and create entries as necessary
        const entry = path.slice (last_index+1);
        if (obj.type === '-') {
            add_node (last_tree, entry, archive, obj.size, obj.isomtime, undefined);
        } else if (obj.type === 'l') {
            add_node (last_tree, entry, archive, undefined, undefined, obj.linktarget)
        } else {
            console.error (line);
        }
    }

    console.error ("Memory Usage: "+ process.memoryUsage().heapUsed/(1024*1024) + " MB");
    return tree;
}

var archives, tree, last_tree, last_path;

function streamToString (stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    })
}

async function main () {

    const [,, datafile, ...files] = process.argv;

    if (datafile == null || datafile === '') {
        console.error ('Usage: cmd datafile.json[.bz2]|- [-remove_archive] [add_archive] [...]');
        return;
    }
    if (datafile === '-') {
        console.error ('fresh start, creating new backup-data');
        archives = [ null ];
        tree = { a:[], c:{} };
        last_tree = tree;
        last_path = '';
    } else {
        console.error ('Reading original data '+datafile);
        try {
            var stream = fs.createReadStream (datafile);
            if (datafile.slice (-4) === ".bz2") {
                stream = stream.pipe (bz2());
            }
            var data = await streamToString (stream);
            [ archives, tree ] = JSON.parse (data);
            last_tree = tree;
            last_path = '';
        } catch (e) {
            console.error ('Reading data: '+e.message);
        }
    }

// Data structure:
// Object: a "Archives" - Array of archive names TBC
//         c "Children" - keys are dir/file names
//         s "Size"  t "mTime"  l "link" of last added archive
//         c available on dirs, s and t on files, l on links
    //{"type": "d", "mode": "drwxr-xr-x", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2022-01-24T16:33:10.461280", "size": 0}
    //{"type": "-", "mode": "-rw-r--r--", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/64bit_strstr_via_64bit_strstr_sse2_unaligned", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2021-11-15T19:29:28.000000", "size": 0}
    //{"type": "l", "mode": "lrwxrwxrwx", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/grub", "healthy": true, "source": "../default/grub", "linktarget": "../default/grub", "flags": 0, "isomtime": "2022-01-12T16:23:39.000000", "size": 15}

    for (const i in files) {
        console.error (files[i]);
        const name = files[i].match (/^([-+])((.*)-(\d{4}-\d{2}-\d{2}-\d{6})(\.json)?(\.bz2)?)$/);
        if (name == null || name[1] == null) {
            console.error ("* does not match pattern");
            continue;
        }
        if (name[1] == '-') {
            // remove archive
            var nr;
            for (nr = 1; nr < archives.length; nr++) {
                if (name[4] === archives[nr]) {
                    break;
                }
            }
            if (nr >= archives.length) {
                console.error ('* not part of archives: '+name[4]);
                continue;
            }
            console.error ("removing archive "+nr);
            remove_archive (tree, nr);
            archives.splice (nr, 1);
            continue;
        }
        else if (name[1] == '+') {
            // add archive
            await read_tree (name[2], archives.length);
            archives.push (name[4]);
        }
    }

    consolidate_dirs (tree);
    //walk_tree (tree, "");
    console.log (JSON.stringify ([archives, tree]));
};

main();
