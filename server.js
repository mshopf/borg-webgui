const express = require ('express');
const path    = require ('path');
const fs      = require ('fs');

const app     = express ();

// TODO: Make this use promises to wait on startup?

const archives = JSON.parse (fs.readFileSync ('archives.json', 'utf-8'));
const tree     = JSON.parse (fs.readFileSync ('data.json', 'utf-8'));

app.use (express.static (path.join (__dirname, 'public')));

app.get ('/archives.json', function (req, res) {
    res.json (archives);
});

app.get ('/data/:path(*)', function (req, res) {
    var t = tree;
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

    //console.log (req.params.path + " - " + JSON.stringify (copy));
    console.log (req.params.path);
    res.json (copy);
});

app.listen(8080);
console.log ("Listening on port 8080");
console.log ("Memory Usage: "+ process.memoryUsage().heapUsed/(1024*1024) + " MB");



