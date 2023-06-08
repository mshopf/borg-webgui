const express = require ('express');
const http    = require ('http');
const https   = require ('https');
const path    = require ('path');
const fs      = require ('fs');
const bz2     = require ('unbzip2-stream');
const cp      = require ('child_process');
const crypto  = require ('crypto');
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
    const name = conf.tree.match (/^(.*?)([^/]*)-backup-tree(\.json)?(\.bz2)?$/);
    if (name == null || name[2] == null || name[2] == '') {
        throw Error (conf.tree+' does not match file pattern');
    }

    console.error ('Reading data '+name[2]);
    var stream = fs.createReadStream (conf.tree);
    if (conf.tree.slice (-4) === '.bz2') {
        stream = stream.pipe (bz2());
    }
    var data = JSON.parse (await streamToString (stream));
    trees[name[2]] = { archives: data[0], tree: data[1], restore: conf.restore };
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
}

async function loadAll () {
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
    for (const f of config.data) {
        await loadTree (f);
    }
    console.log ('All data successfully loaded');
}


// data will only be available after it has been successfully loaded
loadAll ();

app.use (express.json ());
app.use (express.urlencoded ({ extended: true }));
app.use (express.static (path.join (__dirname, 'public')));

app.get ('/api/status', function (req, res) {
    var response = { backups: {}, state: [] };
    for (const e in trees) {
        response.backups[e] = trees[e].archives.length;
    }
    for (const e in queue) {
        response.state[e]  = { handle: queue[e].handle, info: queue[e].info,
                               tschedule: queue[e].tschedule, texecute: queue[e].texecute, tfinish: queue[e].tfinish,
                               firstfullpath: queue[e].firstfullpath };
    }
    res.json (response);
});

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

    //console.log (req.params.path + ' - ' + JSON.stringify (copy));
    console.log (req.params.path);
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
    obj.active = true;
    obj.tschedule = Date.now();
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
            if (q.active) {
                console.log ('Starting restore process '+q.handle);
                q.info     = 'running';
                q.texecute = Date.now();
                await new Promise ((resolve, reject) => setTimeout (resolve, 30000));
                console.log ('Finished restore process '+q.handle);
                q.info     = 'finished';
                q.tfinish  = Date.now();
                q.active   = false;
                queue_active--;
            }
        }
    }
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
