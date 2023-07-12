const fs       = require ('fs');
const bz2      = require ('unbzip2-stream');
const readline = require ('readline');
const cp       = require ('child_process');
const fs_p     = require ('node:fs').promises;
const stream_p = require ('node:stream').promises;
const DBuffer  = require ('./dbuffer');
const config   = eval ('('+fs.readFileSync ('./config.js', 'utf8')+')');

const OUTPUT_FILE = 'borg-backup-data-tree.bin';

// walk tree structure
// unused, just kept for reference purposes
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
        // Logic:
        // Find first entry with |nr| or higher
        // Action depends on situation:
        if (tree.a[i] === nr) {
            // Found +nr -> remove and move follwing numbers up
            tree.a.splice (i, 1);
            for (var j = i; j < tree.a.length; j++) {
                tree.a[j] = Math.sign (tree.a[j]) * (Math.abs (tree.a[j]) - 1);
            }
            break;
        } else if (tree.a[i] === -nr) {
            // Found -nr -> remove and move follwing numbers up
            // If the following archive number is positive,
            // it has to be negated to conclude that following archive
            // is the first with new content
            // If there is no update of dates (s/t/l), i.e. no
            // numbers beyond this entry, nuke s/t/l
            tree.a.splice (i, 1);
            for (var j = i; j < tree.a.length; j++) {
                tree.a[j] = Math.sign (tree.a[j]) * (Math.abs (tree.a[j]) - 1);
            }
            if (i < tree.a.length) {
                if (tree.a[i] > 0) {
                    tree.a[i] = -tree.a[i];
                }
            } else {
                tree.s = tree.t = tree.l = undefined;
            }
            break;
        } else if (Math.abs (tree.a[i]) > nr) {
            // Found a higher number -> move follwing numbers up
            for (var j = i; j < tree.a.length; j++) {
                tree.a[j] = Math.sign (tree.a[j]) * (Math.abs (tree.a[j]) - 1);
            }
            break;
        }
    }
    // recurse
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

    var stream, child;
    if (file.match (/(\.json|\.bz2)$/)) {
        stream = fs.createReadStream (file);
        if (file.slice (-4) === ".bz2") {
            stream = stream.pipe (bz2());
        }
    } else {
        child = cp.spawn ('borg', ['list', '--format', '"{type} {path} {size} {isomtime}"', '--json-lines', config.borg_repo+'::'+file]);
        stream = child.stdout;
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
            add_node (last_tree, entry, archive, obj.size, Date.parse (obj.isomtime+'Z'), undefined);
        } else if (obj.type === 'l') {
            add_node (last_tree, entry, archive, undefined, undefined, obj.linktarget)
        } else {
            console.error (line);
        }
    }

    console.error ("Memory Usage: "+ process.memoryUsage().heapUsed/(1024*1024) + " MB");

    if (child !== undefined) {
        var error = "";
        for await (const chunk of child.stderr) {
            error += chunk;
        }
        const exitCode = await new Promise ( (resolve, reject) => {
            child.on ('close', resolve);
        });
        if (exitCode) {
            throw new Error( `subprocess error exit ${exitCode}, ${error}`);
        }
    }

    return tree;
}

async function read_full_bin_tree (fh, offset) {
    var tree = await data.read_tree (fh, offset);
    if (tree.c !== undefined) {
        for (var e in tree.c) {
            // currently replaces data - makes lots of unnecessary junk objects
            tree.c[e] = await read_full_bin_tree (fh, tree.c[e].o);
        }
    }
    return tree;
}

async function write_full_bin_tree (st, tree) {
    // Have to write depth first, to know offsets of children
    if (tree.c !== undefined) {
        for (var e in tree.c) {
            await write_full_bin_tree (st, tree.c[e]);
        }
    }
    await data.write_tree (st, tree);
}

var archives, tree, last_tree, last_path;

function streamToString (stream) {
    const chunks = [];
    return new Promise ((resolve, reject) => {
        stream.on ('data',  (chunk) => chunks.push (Buffer.from (chunk)));
        stream.on ('error', (err)   => reject  (err));
        stream.on ('end',   ()      => resolve (Buffer .concat (chunks) .toString ('utf8')));
    });
}
async function call_command (bin, args) {
    const child = cp.spawn (bin, args);
    return streamToString (child.stdout);
}


async function main () {

    const [,, datafile, ...files] = process.argv;

    if (datafile == null || datafile === '') {
        // TODO: loop over all data in config.js
        console.error ('Usage: cmd datafile.[json[.bz2]|.bin]|- [/regex] (reads in borg list and determines added/removed archives)');
        console.error ('Usage: cmd datafile.[json[.bz2]|.bin]|- [[-|+]archive] [...]');
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
            if (datafile.slice (-4) === ".bin") {
                var fh = await fs_p.open (datafile, 'r');
                // direct access, thus no stream

                // Read start tag and initial offset
                await fh.read (data.cache_buf, 0, 12, 0);
                if (data.init_tag_buf.compare (data.cache_buf, 0, 4) != 0) {
                    throw Error ('not a bOt0 file');
                }
                data.cache_buf_pos = 4;
                var initial_tree_offset = data.buf_read_uvs ();

                archives = await data.read_archives (fh, 0x20);
                tree     = await read_full_bin_tree (fh, initial_tree_offset);

                await fh.close ();

            } else {
                var stream = fs.createReadStream (datafile);
                if (datafile.slice (-4) === ".bz2") {
                    stream = stream.pipe (bz2());
                }
                var txt = await streamToString (stream);
                [ archives, tree ] = JSON.parse (txt);
            }
            last_tree = tree;
            last_path = '';
        } catch (e) {
            console.error ('Reading data: '+e.stack);
            return;
        }
    }

    if (files[0] && files[0][0] === '/' && files.length === 1) {
        console.error ('reading borg archive list');
        const filter = new RegExp (files[0].slice(1));
        const json = JSON.parse (await call_command ('borg', ['list', '--json', config.borg_repo]));
        const obj_archives = { };
        for (const e of json.archives) {
            const name = e.name.match (/^((.*-)?(\d{4}-\d{2}-\d{2}-\d{6})(\.json)?(\.bz2)?)$/);
            if (name [1] .match (filter)) {
                obj_archives[name[3]] = e.name;
            }
        }
        // walk backwards (removing an archive shifts everything after it back)
        // archives[0] is always null
        for (var nr = archives.length-1; nr > 0; nr--) {
            var name = archives[nr];
            if (obj_archives [name] === undefined) {
                console.error ('purging archive '+name);
                remove_archive (tree, nr);
                archives.splice (nr, 1);
            }
            delete obj_archives[name];
        }
        for (const e of Object.keys (obj_archives) .sort()) {
            console.error ('adding archive '+obj_archives[e]+' as '+e);
            await read_tree (obj_archives[e], archives.length);
            archives.push (e);
        }
    } else {

        for (const i in files) {
            console.error (files[i]);
            const name = files[i].match (/^([-+])((.*-)?(\d{4}-\d{2}-\d{2}-\d{6})(\.json)?(\.bz2)?)$/);
            if (name == null || name[1] == null) {
                console.error ("* does not match parameter pattern");
                return;
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
    }

    consolidate_dirs (tree);
    //walk_tree (tree, "");
    //console.log (JSON.stringify ([archives, tree], undefined, 4));

    var fh = await fs_p.open (OUTPUT_FILE, 'w', 0o644);
    var st = fh.createWriteStream ();
    data.file_currentoffset = 0;
    st.on ('error', (e) => {throw e});

    data.cache_buf_pos = 0x20;
    await data.write_archives (st, archives);
    await write_full_bin_tree (st, tree);

    // flush write buffer unconditionally
    await data.buf_check_flush (st, data.CACHE_BUF_MAX+1);
    st.end ();
    await stream_p.finished (st);

    // Create buffer object with tag and offset to main data structure
    data.cache_buf_pos = 0;
    data.buf_write_buf (data.init_tag_buf);
    data.buf_write_uvs (tree.o);
    // Write to slot at beginning of file
    var fh = await fs_p.open (OUTPUT_FILE, 'r+', 0o644);
    await fh.write (data.cache_buf, 0, data.VS_LENGTH_MAX+4, 0);
    await fh.close ();

    console.error ('done');
};

main().catch ((e) => console.error ('* '+e.stack));


// Data structure:
// Object: a "Archives" - Array of archive names TBC
//         c "Children" - keys are dir/file names
//         s "Size"  t "mTime"  l "link" of last added archive
//         c available on dirs, s and t on files, l on links
    //{"type": "d", "mode": "drwxr-xr-x", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2022-01-24T16:33:10.461280", "size": 0}
    //{"type": "-", "mode": "-rw-r--r--", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/64bit_strstr_via_64bit_strstr_sse2_unaligned", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2021-11-15T19:29:28.000000", "size": 0}
    //{"type": "l", "mode": "lrwxrwxrwx", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/grub", "healthy": true, "source": "../default/grub", "linktarget": "../default/grub", "flags": 0, "isomtime": "2022-01-12T16:23:39.000000", "size": 15}
