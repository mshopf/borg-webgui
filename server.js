const express  = require ('express');
const http     = require ('http');
const https    = require ('https');
const path     = require ('path');
const fs       = require ('fs');
const fs_p     = fs.promises;
const stream_p = require ('stream').promises;
const cp       = require ('child_process');
const readline = require ('readline');
const crypto   = require ('crypto');
const byline   = require ('byline');
const argon2   = require ('argon2');
const DBuffer  = require ('./dbuffer');

const app      = express ();
const trees    = {};

var   config   = eval ('('+fs.readFileSync ('./config.js', 'utf8')+')');

var watching_config = false, watcher_config;
function setup_watch_config () {
    watcher_config?.close ();
    watcher_config = fs.watch ('./config.js', { persistant: false }, load_config);
}
async function load_config () {
    if (watching_borg_log) {
        return;
    }
    watching_borg_log = true;
    try {
        const str = await fs_p.readFile ('./config.js', 'utf8');
        config = eval ('('+str+')');
        console.log ('re-loaded config ', config);
        setup_watch_config ();
    } catch (e) {
        setTimeout (load_config, 5000);
    }
    watching_borg_log = false;
}
setup_watch_config ();

var last_borg_log_position = 0, watching_borg_log = 1, watcher_borg_log;
if (config.borg_backup_log) {
    setup_read_borg_log ();
    continue_read_borg_log ();
}
function setup_read_borg_log () {
    watcher_borg_log?.close ();
    watcher_borg_log = fs.watch (config.borg_backup_log, { persistant: false }, (evt) => {
        console.log ('borg_backup_log watch @'+evt);
        // file renamed / overwritten, read from start, restart watcher
        if (evt === 'rename') {
            last_borg_log_position = 0;
            setup_read_borg_log ();
        }
        // we can get multiple events for one change. due to promises these might run in "parallel"
        if (++watching_borg_log === 1) {
            continue_read_borg_log ();
        }
    });
}
async function continue_read_borg_log () {
    console.log ('* continue_read_borg_log');
    try {
        do {
            const fh = await fs_p.open (config.borg_backup_log);
            const rl = fh.readLines ({ start: last_borg_log_position });
            last_borg_log_position = (await fh.stat()).size;
            for await (const line of rl) {
                const obj = { handle: null, state: 'backup', archive: 'system', short: 'backup done', info: line, tschedule: null, texecute: null, tfinish: null };
                if (line.match (/ERR/)) {
                    obj.state = 'err';
                    obj.short = 'backup error';
                }
                queue.push (obj);
            }
            await rl.close ();
            await fh.close ();
        } while (--watching_borg_log > 0);
    } catch (e) {
        setTimeout (continue_read_borg_log, 5000);
    }
    // This *might* grow to large for a short moment, but who cares...
    if (queue.length > config.max_status_entries) {
        queue.splice (0, queue.length-config.max_status_entries);
    }
}

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

async function openTree (conf) {
    const name = conf.file.match (/^(.*?)([^/]*)-data-tree.bin$/);
    if (name == null || name[2] == null || name[2] == '') {
        throw Error (conf.file+' does not match file pattern');
    }

    console.error ('Opening data '+name[2]);
    const fh = await fs_p.open (conf.file, 'r');
    const db = new DBuffer (fh);
    await db.read_at (0);
    if (DBuffer.INIT_TAG_BUF.compare (db.cache_buf, db.cache_buf_pos_read, db.cache_buf_pos_read+4) != 0) {
        throw Error ('not a bOt0 file');
    }
    db.advance (4);
    const offset   = db.read_uvs ();
    const archives = await db.read_archives (0x20);
    const tree     = await db.read_tree     (offset);

    trees[name[2]] = { archives, db, offset, tree, cache: {}, ...conf };
}

async function openAll () {
    for (const f of config.data) {
        try {
            await openTree (f);
        } catch (e) {
            console.error ('opening '+f.file+': '+e.stack);
        }
    }
    console.log ('All data opened successfully');
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
}

// Middleware for checking passwords
async function check_passwd (req, res, next) {
    // parse login and password from headers
    const b64auth = (req.headers.authorization || '') .split(' ')[1] || '';
    const strauth = Buffer.from (b64auth, 'base64') .toString();
    const [_, user, password] = strauth.match (/(.*?):(.*)/) || [];
    // verify
    if (user != null && config.auth[user] !== undefined && password != null &&
        await argon2.verify (config.auth[user].pwd, password)) {
        return next();
    }
    // access denied...
    res .setHeader ('WWW-Authenticate', 'Basic realm="borg-backup"');
    res .status (401) .send ('Authentication required.');
}


// data will only be available after it has been successfully loaded
openAll ();

config.hook_preroutes?. (app);
app.use (express.json ());
app.use (express.urlencoded ({ extended: true }));
app.use (express.static (path.join (__dirname, 'public')));
app.use ('/log/', express.static (path.join (__dirname, 'log')));
express.static.mime.define ({'text/plain': ['log']});

app.get ('/api/status', function (req, res) {
    console.log (`* api/status`);
    var response = { backups: {}, state: [] };
    for (const e in trees) {
        response.backups[e] = trees[e].archives.length -1;
    }
    for (const e in queue) {
        response.state[e]  = { handle: queue[e].handle, state: queue[e].state, info: queue[e].info,
                               tschedule: queue[e].tschedule, texecute: queue[e].texecute, tfinish: queue[e].tfinish,
                               short: queue[e].short, archive: queue[e].archive };
    }
    res.json (response);
});

app.use ('/api/', check_passwd);

app.get ('/api/archives/:backup', function (req, res) {
    if (trees[req.params.backup] === undefined) {
        return res .status (404) .send (null);
    }
    res.json (trees[req.params.backup].archives);
});

app.get ('/api/data/:backup/:path(*)', async function (req, res) {
    console.log (`* api/data ${req.params.backup} ${req.params.path}`);
    const entry = trees[req.params.backup];
    if (entry === undefined) {
        return res .status (404) .send (null);
    }
    var t;
    // check if dir is in cache
    if (entry.cache[req.params.path]) {
        console.log ('cache: '+req.params.path);
        t = entry.cache[req.params.path];
    } else {
        // Start searching at root
        t = entry.tree;

        var p = '';
        if (req.params.path !== '') {
            const elems = req.params.path.split ('/');
            for (const e of elems) {
                p += e + '/';
                if (entry.cache[p]) {
                    console.log ('cached /'+p);
                    t = entry.cache[p];
                    continue;
                }
                t = t.c['/'+e];
                if (t === undefined || (t.c === undefined && t.o === undefined)) {
                    res .status (404) .send (null);
                    return;
                }
                if (t.o > 0) {
                    t = await entry.db.read_tree (t.o);
                    console.log ('loaded /'+p);
                    entry.cache[p] = t;
                    if (Object.keys (entry.cache) .length > config.max_cache_entries) {
                        console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
                        console.log (`purging cache ${config.max_cache_entries} entries`);
                        entry.cache = {};
                    }
                }
            }
        }
        var logging = true;
        for (const i in t.c) {
            if (t.c[i].a === undefined) {
                var offset = t.c[i].o;
                t.c[i] = await entry.db.read_tree (offset);
                t.c[i].o = offset;
                if (logging) {
                    console.log (`fillin /${p}`);
                    logging = false;
                }
                if (t.c[i].c !== undefined) {
                    t.c[i].c = null;
                }
            }
        }
    }

    // delete references to .o - it's used differently in frontend
    // also a security measurement
    const copy = Object.assign ({}, t);
    copy.c     = Object.assign ({}, copy.c);
    for (const i in copy.c) {
        copy.c[i] = Object.assign ({}, copy.c[i]);
        delete copy.c[i].o;
    }

    res.json (copy);
});

app.post ('/api/restore/:backup', function (req, res) {
    console.log (`* api/restore ${req.params.backup}`);
    const ar   = req.body.archive;
    const list = req.body.list;
    if (list === undefined || list.length == 0) {
        return res .status (500) .send (null);
    }

    const entry = trees[req.params.backup];
    if (entry === undefined) {
        return res .status (403) .send (null);
    }

    for (const e of entry.archives) {
        if (e === ar) {
            const handle = queue_request ({ backup: req.params.backup, archive: ar, list, short: list[0].substring(0,20)+'...' });
            return res .json (handle);
        }
    }

    return res .status (404) .send (null);
});

var queue = [];
var queue_active = 0;

function queue_request (obj) {
    obj.handle = crypto .randomBytes (4) .toString ('hex');
    obj.tschedule = Date.now();
    obj.state  = 'wait';
    obj.info   = 'queued';
    queue .push (obj);
    queue_active++;
    if (queue_active === 1) {
        run_queue ();
    }
    return obj.handle;
}

async function run_queue () {
    while (queue_active > 0) {
        for (const q of queue) {
            if (q.state === 'wait') {
                console.log ('Starting restore process '+q.handle);
                q.state  = 'run';
                q.info     = 'running';
                q.texecute = Date.now();

                const result = await execute_borg_extract (q);

                if (result.error !== undefined) {
                    q.state = 'err';
                    q.info  = 'error '+result.error;
                } else {
                    q.state = 'done';
                    q.info  = 'finished restoring '+result.lines+' entries';
                }
                q.tfinish  = Date.now();
                queue_active--;
                console.log ('Finished restore process '+q.handle+' - '+JSON.stringify (result));
            }
        }
    }
    if (queue.length > config.max_status_entries) {
        queue.splice (0, queue.length-config.max_status_entries);
    }
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
}

async function execute_borg_extract (q) {
    // We write the first few lines and all patterns asynchronously to log - might buffer up, but who cares
    const log = fs.createWriteStream ('log/'+q.handle+'.log', { flags: 'w', mode: 0o644 });
    // use absolute path for patterns, as borg runs in a directory somewhere else
    const pat = await fs_p.open ('/tmp/borg-restore-'+q.handle+'.patterns', 'w', 0o644);
    // Make log data human readable
    const qlog = { ... q, texecute: new Date (q.texecute) .toLocaleString(), tschedule: new Date (q.tschedule) .toLocaleString() };
    log.write (JSON.stringify (qlog, null, 4));
    log.write ('\n***********\n\n');

    var lastpath = '';
    for (const e of q.list) {
        // get all paths elements
        var path = '';
        var last = 0;
        for (var index = 0; index >= 0 && index < e.length-1; index = e.indexOf ('/', index+1)) {
            if (lastpath.substring (0, index) !== e.substring (0, index)) {
                break;      // found unwalked directory part
            }
        }
        // walk remaining directory parts
        for (; index >= 0 && index < e.length-1; index = e.indexOf ('/', index+1)) {
            log.write           ('dir  '+e.substring (0, index)+'\n');
            await pat.writeFile ('+pf:'+e.substring (0, index)+'\n');
        }
        if (index >= 0) {
            log.write           ('dir! '+e+'\n');
            await pat.writeFile ('+pf:'+e.substring (0, index)+'\n');
            await pat.writeFile ('+pp:'+e+'\n');
        } else {
            log.write           ('file '+e+'\n');
            await pat.writeFile ('+pf:'+e+'\n');
        }
        lastpath = e;
    }
    // don't extract ANYTHING we haven't specifically added to the pattern
    // that includes directories (so don't recurse here)
    await pat.writeFile ('!*\n');
    await pat.close();

    const cwd = trees[q.backup].restore + '/' + q.archive
    log.write (`\n***********\n\nrestore path: ${cwd}\n`);
    await fs_p.mkdir (cwd, { recursive: true });

    const args = ['extract', '--list', ...trees[q.backup].borg_args??[], '--patterns-from', '/tmp/borg-restore-'+q.handle+'.patterns', config.borg_repo+'::'+q.backup+'-'+q.archive];
    log.write ('borg '+args.join(' ')+'\n');
    log.write ('\n***********\n\n');

    const borg         = cp.spawn ('borg', args, {stdio: ['ignore', 'pipe', 'pipe'], cwd });
    const borg_promise = new Promise ((resolve, reject) => borg.on ('close', (code, signal) => resolve({code, signal}) ));

    // pipe stdout and stderr of borg to log
    var lines = 0;
    async function* countit (source) {
        for await (const chunk of source) {
            lines++;
            yield chunk+'\n';
        }
    }
    stream_p.pipeline (borg.stdout, new byline.LineStream(), countit, log, { end: false });
    stream_p.pipeline (borg.stderr, new byline.LineStream(), countit, log, { end: false });

    const [ { code, signal } ] = await Promise.all ( [ borg_promise, stream_p.finished (borg.stdout), stream_p.finished (borg.stderr) ] );

    log.write ('\n\n***********\n');
    log.write (`Exit code ${code}, signal ${signal}, lines ${lines}\n`);
    log.end ();
    await stream_p.finished (log);
    log.destroy ();

    await fs_p.unlink ('/tmp/borg-restore-'+q.handle+'.patterns');
    if (code !== 0 || signal != null) {
        return { error: `Exit code ${code}, signal ${signal}`, lines };
    }
    return { lines };
}


config.hook_postroutes?. (app);
var server;
if (config.httpPort) {
    if (config.httpsPort) {
        // When both http and https are enabled, http should only be a redirecting server
        http.createServer (function (req, res) {
            var host = req.headers.host?.replace(/:.*/,'');
            if (config.httpsPort !== 443) {
                host += ':' + config.httpsPort;
            }
            res.writeHead (301, { 'Location': 'https://' + host + req.url });
            res.end();
        }) .on  ('error', function (err) {
            console.error (err.stack);
            process.exit  (1);
        }) .listen (config.httpPort, function () {
            console.log ('Redirecting express http server listening on port ' + config.httpPort);
        });
    } else {
        server = http .createServer (app) .listen (config.httpPort, function () {
            console.log ('Express http server listening on port ' + config.httpPort);
        });
    }
}
if (config.httpsPort) {
    var ssl_opts = {
        key:  fs.readFileSync ('ssl/server.key'),
        cert: fs.readFileSync ('ssl/server.crt'),
//        ca:   glob.sync ('ssl/chain*.crt') .map (function (e) { return fs.readFileSync (e); }),
        //ciphers: '',
    };
    server = https.createServer (ssl_opts, app) .listen (config.httpsPort, function () {
        console.log ('Express https server listening on port ' + config.httpsPort);
        config.hook_poststartup?. (app, server);
    });
}
