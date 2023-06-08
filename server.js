const express = require ('express');
const http    = require ('http');
const https   = require ('https');
const path    = require ('path');
const fs      = require ('fs');
const bz2     = require ('unbzip2-stream');
const cp      = require ('child_process');
const readline = require ('readline');
const crypto  = require ('crypto');
const argon2  = require ('argon2');
const config  = require ('./config');

const app     = express ();

const trees   = {};


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

async function loadTree (conf) {
    const name = conf.file.match (/^(.*?)([^/]*)-backup-tree(\.json)?(\.bz2)?$/);
    if (name == null || name[2] == null || name[2] == '') {
        throw Error (conf.tree+' does not match file pattern');
    }

    console.error ('Reading data '+name[2]);
    var stream = fs.createReadStream (conf.file);
    if (conf.file.slice (-4) === '.bz2') {
        stream = stream.pipe (bz2());
    }
    var data = JSON.parse (await streamToString (stream));
    trees[name[2]] = { archives: data[0], tree: data[1], ...conf };
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
}

async function loadAll () {
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
    for (const f of config.data) {
        await loadTree (f);
    }
    console.log ('All data successfully loaded');
}

// Middleware for checking passwords
async function check_passwd (req, res, next) {
    // parse login and password from headers
    const b64auth = (req.headers.authorization || '') .split(' ')[1] || '';
    const strauth = Buffer.from (b64auth, 'base64') .toString();
    const [_, user, password] = strauth.match (/(.*?):(.*)/) || [];
    // verify
    if (user != null && user === config.user && password != null && await argon2.verify (config.pwd, password)) {
        return next()
    }
    // access denied...
    res .setHeader ('WWW-Authenticate', 'Basic realm="borg-backup"');
    res .status (401) .send ('Authentication required.');
}


// data will only be available after it has been successfully loaded
loadAll ();

app.use (express.json ());
app.use (express.urlencoded ({ extended: true }));
app.use (express.static (path.join (__dirname, 'public')));

app.get ('/api/status', function (req, res) {
    var response = { backups: {}, state: [] };
    for (const e in trees) {
        response.backups[e] = trees[e].archives.length -1;
    }
    for (const e in queue) {
        response.state[e]  = { handle: queue[e].handle, state: queue[e].state, info: queue[e].info,
                               tschedule: queue[e].tschedule, texecute: queue[e].texecute, tfinish: queue[e].tfinish,
                               firstfullpath: queue[e].firstfullpath, archive: queue[e].archive };
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

app.get ('/api/data/:backup/:path(*)', function (req, res) {
    const data = trees[req.params.backup];
    if (data === undefined) {
        return res .status (404) .send (null);
    }
    var t = data.tree;

    if (req.params.path !== '') {
        const elems = req.params.path.split ('/');
        for (const e of elems) {
            t = t.c['/'+e];
            if (t === undefined || t.c === undefined) {
                res .status (404) .send (null);
                return;
            }
        }
    }

    const copy = Object.assign ({}, t);
    copy.c = Object.assign ({}, copy.c);
    for (const i in copy.c) {
        copy.c[i] = Object.assign ({}, copy.c[i]);
        if (copy.c[i].c !== undefined) {
            copy.c[i].c = null;
        }
    }

    res.json (copy);
});

app.post ('/api/restore/:backup', function (req, res) {
    const ar   = req.body.archive;
    const list = req.body.list;
    if (list === undefined || list.length == 0) {
        return res .status (500) .send (null);
    }

    const data = trees[req.params.backup];
    if (data === undefined) {
        return res .status (403) .send (null);
    }

    for (const e of data.archives) {
        if (e === ar) {
            const handle = queue_request ({ backup: req.params.backup, archive: ar, list, firstfullpath: list[0] });
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
}

async function execute_borg_extract (q) {
    const log = await fs.promises.open ('log/'+q.handle+'.log', 'w', 0o644);
    // use absolute path for patterns, as we run in a directory somewhere else
    const pat = await fs.promises.open ('/tmp/borg-restore-'+q.handle+'.patterns', 'w', 0o644);
    // Make log data human readable
    const qlog = { ... q, texecute: new Date (q.texecute) .toLocaleString(), tschedule: new Date (q.tschedule) .toLocaleString() };
    await log.writeFile (JSON.stringify (qlog, null, 4));
    await log.writeFile ('\n***********\n\n');

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
            log.writeFile ('dir  '+e.substring (0, index)+'\n');
            pat.writeFile ('+pf:'+e.substring (0, index)+'\n');
        }
        if (index >= 0) {
            log.writeFile ('dir! '+e+'\n');
            pat.writeFile ('+pf:'+e.substring (0, index)+'\n');
            pat.writeFile ('+pp:'+e+'\n');
        } else {
            log.writeFile ('file '+e+'\n');
            pat.writeFile ('+pf:'+e+'\n');
        }
        lastpath = e;
    }
    // don't extract ANYTHING we haven't specifically added to the pattern
    // that includes directories (so don't recurse here)
    pat.writeFile ('!*\n');
    await pat.close();

    const cwd = trees[q.backup].restore + '/' + q.archive
    await log.writeFile (`\n***********\n\nrestore path: ${cwd}\n`);
    await fs.promises.mkdir (cwd, { recursive: true });

    const args = ['extract', '--list', ...trees[q.backup].borg_args??[], '--patterns-from', '/tmp/borg-restore-'+q.handle+'.patterns', config.borg_repo+'::'+q.backup+'-'+q.archive];
    await log.writeFile ('borg '+args.join(' ')+'\n');
    await log.writeFile ('\n***********\n\n');

    const borg = cp.spawn ('borg', args, {stdio: ['ignore', 'pipe', 'pipe'], cwd });
    const borg_promise = new Promise ((resolve, reject) => borg.on ('close', (code, signal) => resolve({code, signal}) ));
    var borg_stderr_open = true;
    borg.stdout.on ('close', () => borg_stderr_open = false );  // not needed for stdout, no new tick happened => still open

    const rl = readline.createInterface ({ input: borg.stdout, output: null, terminal: false });
    var lines = 0;
    for await (const line of rl) {
        await log.writeFile (line+'\n');
        lines++;
    }
    if (borg_stderr_open) {
        const rl2 = readline.createInterface ({ input: borg.stderr, output: null, terminal: false });
        for await (const line of rl2) {
            await log.writeFile (line+'\n');
        }
    }

    const { code, signal } = await borg_promise;
    await log.writeFile ('\n\n***********\n');
    await log.writeFile (`Exit code ${code}, signal ${signal}\n`);
    await log.close();

    await fs.promises.unlink ('/tmp/borg-restore-'+q.handle+'.patterns');
    if (code !== 0 || signal != null) {
        return { error: `Exit code ${code}, signal ${signal}` };
    }
    return { lines };
}


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
    });
}
