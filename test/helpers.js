const fs = require ('node:fs');
const os = require ('node:os');
const path = require ('node:path');
const cp = require ('node:child_process');
const { once } = require ('node:events');
const assert = require ('node:assert/strict');

const root = path.resolve (__dirname, '..');
const id = 'a'.repeat (64);
const secondId = 'b'.repeat (64);
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$pxZKX/+NxOaln4c8Z7xzXg$OhJ+PjiPKmzqNAblkr1++VEfhR6W/6h8dUiH+BjCK/8';

function fixture (t, major = 2, binary) {
    const dir = fs.mkdtempSync (path.join (os.tmpdir (), 'borg-webgui-test-'));
    t.after (() => fs.rmSync (dir, { recursive: true, force: true }));
    for (const name of ['bin', 'log', 'restore']) fs.mkdirSync (path.join (dir, name));
    fs.symlinkSync (binary ?? path.join (__dirname, 'fake-borg.js'), path.join (dir, 'bin', 'borg'));
    const env = { ...process.env, PATH: path.join (dir, 'bin') + ':' + process.env.PATH,
        FAKE_BORG_DIR: dir, FAKE_BORG_MAJOR: String (major),
        BORG_PASSPHRASE: 'test-passphrase', BORG_CACHE_DIR: path.join (dir, 'cache'),
        BORG_CONFIG_DIR: path.join (dir, 'borg-config'), BORG_SECURITY_DIR: path.join (dir, 'security'),
        BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: 'yes' };
    const config = { httpPort: '0', borg_repo: path.join (dir, 'wrong-repo'), data: [{
        file: 'backup-data-tree.bin', borg_repo: path.join (dir, 'repo'), restore: path.join (dir, 'restore'),
        borg_args: ['--sparse'], enable: true
    }], auth: { admin: { pwd: passwordHash } }, max_cache_entries: 100, max_status_entries: 30 };
    fs.writeFileSync (path.join (dir, 'config.js'), JSON.stringify (config).replace (/}$/, ', hook_poststartup(app, server) { console.log("TEST_PORT=" + server.address().port); }}'));
    const runTree = (...args) => cp.spawnSync (process.execPath, [path.join (root, 'tree.js'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    const run = (args, options = {}) => cp.spawnSync (path.join (dir, 'bin', 'borg'), args, { cwd: dir, env, encoding: 'utf8', timeout: 20000, ...options });
    return { dir, env, config, runTree, run };
}

function success (result) {
    assert.equal (result.status, 0, result.stderr + result.stdout + (result.error?.message ?? ''));
    return result.stdout;
}

async function startServer (t, f) {
    const child = cp.spawn (process.execPath, [path.join (root, 'server.js')], { cwd: f.dir, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stderr.on ('data', chunk => { errors += chunk; });
    t.after (async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill ();
            await once (child, 'exit');
        }
    });
    const port = await new Promise ((resolve, reject) => {
        const timer = setTimeout (() => reject (Error ('Server startup timeout: ' + output + errors)), 10000);
        child.once ('error', reject);
        child.once ('exit', code => { clearTimeout (timer); reject (Error ('Server exited ' + code + ': ' + output + errors)); });
        child.stdout.on ('data', chunk => {
            output += chunk;
            const match = output.match (/TEST_PORT=(\d+)/);
            if (match) { clearTimeout (timer); resolve (match[1]); }
        });
    });
    const api = async (url, options = {}) => {
        const response = await fetch ('http://127.0.0.1:' + port + url, {
            ...options, headers: { Authorization: 'Basic ' + Buffer.from ('admin:admin').toString ('base64'), 'Content-Type': 'application/json' }
        });
        assert.equal (response.status, 200, await response.clone().text ());
        return response.json ();
    };
    // Opening the index is asynchronous. Wait for it through the public API.
    for (let attempt = 0; attempt < 100; attempt++) {
        if ((await api ('/api/status')).backups.backup !== undefined) return api;
        await new Promise (resolve => setTimeout (resolve, 10));
    }
    throw Error ('Index did not open: ' + errors);
}

async function restore (api, archive, list = ['file']) {
    const handle = await api ('/api/restore/backup', { method: 'POST', body: JSON.stringify ({ archive, list }) });
    for (let attempt = 0; attempt < 200; attempt++) {
        const job = (await api ('/api/status')).state.find (e => e.handle === handle);
        if (job?.state === 'done' || job?.state === 'err') return job;
        await new Promise (resolve => setTimeout (resolve, 20));
    }
    throw Error ('Restore did not finish');
}

module.exports = { fixture, success, startServer, restore, root, id, secondId };
