// The CLI still shares the JavaScript binary reader; copy it beside emitted imports.
const { copyFileSync } = require ('node:fs');
const { resolve } = require ('node:path');
copyFileSync (resolve (__dirname, '../dbuffer.js'), resolve (__dirname, '../dist/dbuffer.js'));
