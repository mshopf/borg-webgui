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
app.get ('/data.json', function (req, res) {
    res.json (tree);
});

app.listen(8080);
console.log ("Listening on port 8080");
console.log ("Memory Usage: "+ process.memoryUsage().heapUsed/(1024*1024) + " MB");



