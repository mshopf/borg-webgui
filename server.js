const express = require ('express');
const http    = require ('http');
const https   = require ('https');
const path    = require ('path');
const fs      = require ('fs');
const bz2     = require ('unbzip2-stream');
const cp      = require ('child_process');
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

async function loadTree (file) {
    const name = file.match (/^(.*?)([^/]*)-backup-tree(\.json)?(\.bz2)?$/);
    if (name == null || name[2] == null || name[2] == '') {
        throw Error (file+' does not match file pattern');
    }

    console.error ('Reading data '+name[2]);
    var stream = fs.createReadStream (file);
    if (file.slice (-4) === '.bz2') {
        stream = stream.pipe (bz2());
    }
    var data = JSON.parse (await streamToString (stream));
    trees[name[2]] = { archives: data[0], tree: data[1] };
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
}

async function loadAll () {
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
    for (const f of config.trees) {
        await loadTree (f);
    }
    console.log ('All data successfully loaded');
}


// data will only be available after it has been successfully loaded
loadAll ();

app.use (express.static (path.join (__dirname, 'public')));

app.get ('/api/backups', function (req, res) {
    var response = {};
    for (const e in trees) {
        response[e] = trees[e].archives.length;
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
    var t = trees[req.params.backup].tree;
    if (t === undefined) {
        return res .status (404) .send (null);
    }
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


