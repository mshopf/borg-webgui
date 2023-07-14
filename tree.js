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
    if (tree.c == null) {
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

// remove an archive in one tree level
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
}

// recursivelly remove an archive
function remove_full_archive (tree, nr) {
    remove_archive (tree, nr);
    // recurse
    if (tree.c !== undefined) {
        for (const e in tree.c) {
            remove_full_archive (tree.c[e], nr);
        }
    }
}

// incrementally remove an archive
async function remove_archive_incr (tree, nr, input_db, output_db) {
    remove_archive (tree, nr);
    // Have to write depth first, to know offsets of children
    if (tree.c !== undefined) {
        const keys = Object.keys (tree.c) .sort();
        for (var e of keys) {
            // tree.c[e].o contains offset to element in input_db
            tree.c[e] = await input_db.read_tree (tree.c[e].o);
            await remove_archive_incr (tree.c[e], nr, input_db, output_db);
            // tree.c[e].o now contains offset to element in output_db
        }
    }
    await output_db.write_tree (tree);
}


async function read_tree (file, archive, tree, _find_tree, _add_tree, _add_node) {

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

    var last_tree = tree;
    var last_path = '';

    for await (const line of rl) {
        const obj = JSON.parse (line);
        if (obj.path === '.') {
            continue;
        }
        const path = "/" + obj.path;
        const last_index = path.lastIndexOf ('/');
        const check_path = path.slice (0, last_index);
        if (last_path !== check_path) {
            // There has been a dir entry missing in input (shouldn't occur), or we switched directory level
            last_tree = await _find_tree (tree, check_path, archive);
            last_path = check_path;
        }
        // directory entry?
        if (obj.type === 'd') {
            const dir_name = path.slice (last_index);
            last_path = path;
            last_tree = await _add_tree (last_tree, dir_name, archive);
            continue;
        }
        // Something different - create entries as necessary
        const entry = path.slice (last_index+1);
        var node;
        if (obj.type === '-') {
            node = { a: undefined, s: obj.size, t: Date.parse (obj.isomtime+'Z'), l: undefined, o: undefined };
        } else if (obj.type === 'l') {
            node = { a: undefined, s: undefined, t: undefined, l: obj.linktarget, o: undefined };
        } else {
            console.error (line);
            continue;
        }
        await _add_node (last_tree, entry, archive, node);
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

// add a full archive to in-memory tree
async function add_full_archive (file, name, tree) {
    await read_tree (file, archives.length, tree, find_tree, add_tree, add_node);
    archives.push (name);

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

    // create / set directory entry
    function add_tree (t, entry, archive) {
        if (t.c[entry] === undefined) {
            t.c[entry] = { a: [], c: {} };
        }
        return t.c[entry];
    }

    // create a node
    function add_node (t, e, archive, n) {
        if (t.c[e] === undefined) {
            n.a = [ -archive ];
            t.c[e] = n;
        } else {
            const oldnode = t.c[e];
            t.c[e] = n;
            n.a = oldnode.a;
            const last_a = oldnode.a[oldnode.a.length-1];
            if (last_a === archive || last_a === -archive) {
                throw Error ('duplicate archive in entry');
                return;
            }
            if (oldnode.s !== n.s || oldnode.t !== n.t || oldnode.l !== n.l) {
                n.a.push (-archive);
            } else {
                n.a.push (archive);
            }
        }
    }
}

// incrementally add an archive
async function add_archive_incr (file, name, archive, input_db, output_db) {
    var current_trees = [];
    await read_tree (file, archive, tree, find_tree, add_tree, add_node);
    // write rest of tree, keep loading while it occurs
    await write_full_bin_tree_incr (input_db, output_db, tree);
    return;

    // find and create subdirectory entries
    async function find_tree (tree, path, archive) {
        const new_trees = [];
        const p = path.split ('/');
        var t = tree;
        for (const e of p) {
            if (e === '') {
                continue;
            }
            t = await add_tree (t, '/'+e, archive);
            new_trees.push (t);
        }
        // check where we differ in path and write old tree to disk (it's done)
        for (const i in current_trees) {
            if (new_trees[i] != current_trees[i]) {
                if (current_trees[i] !== undefined) {
                    await write_full_bin_tree_incr (input_db, output_db, current_trees[i]);
                }
                // everything below has been written as well
                break;
            }
        }
        current_trees = new_trees;
        return t;
    }

    // create / set directory entry
    async function add_tree (t, e, archive) {
        if (t.c[e] === undefined) {
            // data not yet in current active tree
            t.c[e] = { a: [], c: {} };
        } else if (t.c[e].c === null) {
            // data has been written out - should not occur in depth-first ordered log data
            throw Error ("re-occurance of already processed dir");
        } else if (t.c[e].a === undefined) {
            // data not loaded yet
            if (t.c[e].o === undefined) {
                throw Error ("missing .o in entry");
            }
            t.c[e] = await input_db.read_tree (t.c[e].o);
        }
        // else already there
        return t.c[e];
    }

    // create a node
    async function add_node (t, e, archive, n) {
        if (t.c[e] === undefined) {
            n.a = [ -archive ];
            t.c[e] = n;
        } else if (t.c[e] === null) {
            throw Error ("re-occurance of already processed node");
        } else {
            var oldnode;
            if (t.c[e].a === undefined) {
                if (t.c[e].o === undefined) {
                    throw Error ("missing .o in e");
                }
                oldnode = await input_db.read_tree (t.c[e].o);
            } else {
                oldnode = t.c[e];
            }
            t.c[e] = n;
            n.a = oldnode.a;
            const last_a = oldnode.a[oldnode.a.length-1];
            if (last_a === archive || last_a === -archive) {
                throw Error ('duplicate archive in entry');
                return;
            }
            if (oldnode.s !== n.s || oldnode.t !== n.t || oldnode.l !== n.l) {
                n.a.push (-archive);
            } else {
                n.a.push (archive);
            }
        }
    }
}

async function read_full_bin_tree (db, offset) {
    var tree = await db.read_tree (offset);
    if (tree.c !== undefined) {
        for (var e in tree.c) {
            // currently replaces data - makes lots of unnecessary junk objects
            tree.c[e] = await read_full_bin_tree (db, tree.c[e].o);
        }
    }
    return tree;
}

async function write_full_bin_tree (db, tree) {
    // Have to write depth first, to know offsets of children
    if (tree.c !== undefined) {
        const keys = Object.keys (tree.c) .sort();
        for (var e of keys) {
            await write_full_bin_tree (db, tree.c[e]);
        }
    }
    await db.write_tree (tree);
    tree.c = null;      // this has been processed (required for incremental add)
}

async function write_full_bin_tree_incr (input_db, output_db, tree) {
    // Have to write depth first, to know offsets of children
    if (tree.c !== undefined) {
        const keys = Object.keys (tree.c) .sort();
        for (var e of keys) {
            if (tree.c[e].c === null) {
                // already processed
                continue;
            } else if (tree.c[e].a === undefined) {
                // data not loaded yet
                // tree.c[e].o contains offset to element in input_db
                if (tree.c[e].o === undefined) {
                    throw Error ("missing .o in entry");
                }
                tree.c[e] = await input_db.read_tree (tree.c[e].o);
            }
            await write_full_bin_tree_incr (input_db, output_db, tree.c[e]);
            // tree.c[e].o now contains offset to element in output_db after output_db.write_tree()
        }
    }
    consolidate_dirs (tree);
    await output_db.write_tree (tree);
    tree.c = null;      // this has been processed (required for incremental add)
}

var archives, tree, input_db, output_db;

function streamToString (stream) {
    const chunks = [];
    return new Promise ((resolve, reject) => {
        stream.on ('data',  (chunk) => chunks.push (Buffer.from (chunk)));
        stream.on ('error', (err)   => reject  (err));
        stream.on ('end',   ()      => resolve (Buffer .concat (chunks) .toString ('utf8')));
        stream.on ('close', ()      => console.error ('stream closed'));
    });
}
async function call_command (bin, args) {
    const child = cp.spawn (bin, args);
    return streamToString (child.stdout);
}

async function open_tree_incr (file) {
    const name = file.match (/^(.*\/)?([^/]*)-data-tree.bin$/);
    console.error (name);
    if (name == null || name[2] == null || name[2] == '') {
        throw Error (file+' does not match file pattern');
    }

    console.error ('Opening data '+name[2]);
    const fh = await fs_p.open (file, 'r');
    const db = new DBuffer (fh);
    await db.read_at (0);
    if (DBuffer.INIT_TAG_BUF.compare (db.cache_buf, db.cache_buf_pos_read, db.cache_buf_pos_read+4) != 0) {
        throw Error ('not a bOt0 file');
    }
    db.advance (4);
    const offset   = db.read_uvs ();
    const archives = await db.read_archives (0x20);
    const tree     = await db.read_tree     (offset);

    return [archives, tree, db];
}

async function create_tree_incr (file, archives) {
    var fh = await fs_p.open (file, 'w', 0o644);
    var db = new DBuffer (fh);
    db.write_pos = 0x20;
    await db.write_archives (archives);
    return db;
}

async function end_tree_incr (file, db, offset) {
    // flush write buffer unconditionally
    await db.write_flush ();
    await db.close ();

    // Create buffer object with tag and offset to main data structure
    const fh = await fs_p.open (file, 'r+', 0o644);
    db.open (fh);
    // Write to slot at beginning of file
    db.write_buf (DBuffer.INIT_TAG_BUF);
    db.write_uvs (offset);
    console.error (db.cache_buf);
    await db.write_flush ();
    await db.close ();
}


async function main () {

    var [,, mode, datafile, ...files] = process.argv;

    if (! mode) {
        // TODO: loop over all data in config.js
        console.error ('Usage: cmd -m datafile.[json[.bz2]|.bin]|- /regex|(-|+)archive[.bz2] [...]');
        console.error ('       cmd -i BACKUP-data-tree.bin|- (-|+)archive[.bz2]');
        console.error ('       cmd -a BACKUP-data-tree.bin|- /regex | [(-|+)archive[.bz2]] [...]');
        console.error ('       cmd -p BACKUP-data-tree.bin|- /regex | [(-|+)archive[.bz2]] [...]');
        console.error ('-m: in-memory tree building  -i: incremental build (single)  -a: incremental build (all, looping)  -p: in-memory print');
        console.error ('/regex: reads in borg list and determines added/removed archives automatically');
        console.error ('-archive_name: removes archive  +archive_file[.bz2]: adds archive   (multiple possible)');
        console.error ('-i: work in progress   -a: NOT IMPLEMENTED YET');
        process.exit (1);
    }
    if (mode !== '-m' && mode !== '-i' /* && mode !== '-a' */ && mode !== '-p') {
        console.error ('bad mode '+mode);
        process.exit (1);
    }
    if (datafile === '-') {
        datafile = OUTPUT_FILE;
        console.error ('fresh start, creating new backup-data');
        archives = [ null ];
        tree = { a:[], c:{} };
    } else {
        if (mode === '-m' || mode === '-p') {
            console.error ('Reading original data '+datafile);
            try {
                var db;
                [ archives, tree, db ] = await open_tree_incr (datafile);
                tree = await read_full_bin_tree (db, tree.o);
                await db.close ();
            } catch (e) {
                console.error ('Reading data: '+e.stack);
                return;
            }
        } else {
            [ archives, tree, input_db ] = await open_tree_incr (datafile);
        }
    }

    // parse borg list of archives if wanted
    const obj_archives = { };
    if (files[0] && files[0][0] === '/' && files.length === 1) {
        console.error ('reading borg archive list');
        const filter = new RegExp (files[0].slice(1));
        const json = JSON.parse (await call_command ('borg', ['list', '--json', config.borg_repo]));
        for (const e of json.archives) {
            const name = e.name.match (/^((.*\/)?([^\/]*-)?(\d{4}-\d{2}-\d{2}-\d{6})(\.json)?(\.bz2)?)$/);
            if (name [1] .match (filter)) {
                obj_archives[name[4]] = e.name;
            }
        }
    }

    if (mode === '-m' || mode === '-p') {
        if (files[0] && files[0][0] === '/' && files.length === 1) {
            // walk backwards (removing an archive shifts everything after it back)
            // archives[0] is always null
            for (var nr = archives.length-1; nr > 0; nr--) {
                var name = archives[nr];
                if (obj_archives [name] === undefined) {
                    console.error ('purging archive '+name);
                    remove_full_archive (tree, nr);
                    archives.splice (nr, 1);
                }
                delete obj_archives[name];
            }
            for (const e of Object.keys (obj_archives) .sort()) {
                console.error ('adding archive '+obj_archives[e]+' as '+e);
                await add_full_archive (obj_archives[e], e, tree);
            }
        } else {

            for (const i in files) {
                console.error (files[i]);
                const name = files[i].match (/^([-+])((.*\/)?([^\/]*-)?(\d{4}-\d{2}-\d{2}-\d{6})(\.json)?(\.bz2)?)$/);
                if (name == null || name[1] == null) {
                    console.error ("* does not match parameter pattern");
                    return;
                }
                if (name[1] == '-') {
                    // remove archive
                    var nr;
                    for (nr = 1; nr < archives.length; nr++) {
                        if (name[5] === archives[nr]) {
                            break;
                        }
                    }
                    if (nr >= archives.length) {
                        console.error ('* not part of archives: '+name[5]);
                        continue;
                    }
                    console.error ("removing archive "+nr);
                    remove_full_archive (tree, nr);
                    archives.splice (nr, 1);
                    continue;
                }
                else if (name[1] == '+') {
                    // add archive
                    await add_full_archive (name[2], name[5], tree);
                }
            }
        }

        consolidate_dirs (tree);

        if (mode === '-p') {
            console.log (JSON.stringify (archives, null, 4));
            console.log (JSON.stringify (tree, null, 4));
        } else {
            output_db = await create_tree_incr (datafile+'.new', archives);
            await write_full_bin_tree (output_db, tree);
            await end_tree_incr (datafile+'.new', output_db, tree.o);
            await fs_p.rename (datafile+".new", datafile);
        }

    } else if (mode === '-i') {

        console.error (files[0]);
        const name = files[0]?.match (/^([-+])((.*\/)?([^\/]*-)?(\d{4}-\d{2}-\d{2}-\d{6})(\.json)?(\.bz2)?)$/);
        if (name == null) {
            console.error ("copying archive ");
            output_db = await create_tree_incr (datafile+".new", archives);
            await write_full_bin_tree_incr (input_db, output_db, tree);
            await end_tree_incr (datafile+".new", output_db, tree.o);
            await fs_p.rename (datafile+".new", datafile);
        }
        else if (name[1] == null) {
            console.error ("* does not match parameter pattern");
            return;
        }
        else if (name[1] == '-') {
            // remove archive
            var nr;
            for (nr = 1; nr < archives.length; nr++) {
                if (name[5] === archives[nr]) {
                    break;
                }
            }
            if (nr >= archives.length) {
                console.error ('* not part of archives: '+name[5]);
                process.exit  (1);
            }
            console.error ("removing archive "+nr);
            archives.splice (nr, 1);
            output_db = await create_tree_incr (datafile+".new", archives);
            await remove_archive_incr (tree, nr, input_db, output_db);
            await end_tree_incr (datafile+".new", output_db, tree.o);
            await fs_p.rename (datafile+".new", datafile);
        }
        else if (name[1] == '+') {
            // add archive
            archives.push (name[5]);
            output_db = await create_tree_incr (datafile+".new", archives);
            await add_archive_incr (name[2], name[5], archives.length-1, input_db, output_db);
            await end_tree_incr (datafile+".new", output_db, tree.o);
            await fs_p.rename (datafile+".new", datafile);
        }
    }

    console.error ("Memory Usage: "+ process.memoryUsage().heapUsed/(1024*1024) + " MB");
    console.error ('done');
};

main().catch ((e) => console.error ('* '+e.stack));


// Data structure:
// Object: a "Archives" - Array of archive names TBC
//         c "Children" - keys are dir/file names ; null for already saved dirs (incremental only)
//         s "Size"  t "mTime"  l "link" of last added archive
//         c available on dirs, s and t on files, l on links
//         o offset to structure on disk
    //{"type": "d", "mode": "drwxr-xr-x", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2022-01-24T16:33:10.461280", "size": 0}
    //{"type": "-", "mode": "-rw-r--r--", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/64bit_strstr_via_64bit_strstr_sse2_unaligned", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2021-11-15T19:29:28.000000", "size": 0}
    //{"type": "l", "mode": "lrwxrwxrwx", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/grub", "healthy": true, "source": "../default/grub", "linktarget": "../default/grub", "flags": 0, "isomtime": "2022-01-12T16:23:39.000000", "size": 15}
