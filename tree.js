// borg list --format "{type} {path} {size} {isomtime}" --json-lines /data/backup/zuse2/borg::zuse2-%-2023-05-28-023001 | bzip2 >zuse2-%-2023-05-28-023001.bz2

const fs = require('fs');
const bz2 = require('unbzip2-stream');
const readline = require('readline');

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
    if (entry === "nsswitch.conf") {
        console.error (`${archive}: ns ${ns} s ${s} nt ${nt} t ${t} nl ${nl} l ${l} - ${JSON.stringify(a)}`);
    }
    if (ns !== s || nt !== t || nl !== l) {
        if (entry === "nsswitch.conf") {
            console.error ('  new');
        }
        if (last_a === archive) {
            a[a.length-1] = -archive;
        } else {
            a.push (-archive);
        }
    } else {
        if (entry === "nsswitch.conf") {
            console.error ('  same');
        }
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

var archives = []
var tree = { a:[], c:{} };
var last_path = "";
var last_tree = tree;

async function main () {

    const [,, ...files] = process.argv;

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
        await read_tree (files[i], +i+1);
    }

    consolidate_dirs (tree);
    //walk_tree (tree, "");
    console.log (JSON.stringify (tree));
};

main();
