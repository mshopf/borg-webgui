import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fs_p } from 'node:fs';
import { promises as stream_p } from 'node:stream';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import byline from 'byline';
import DBuffer from './dbuffer';
import { withTree, browseArchive, browseFiles } from './archive-browse';
import { readConfig, configurationFile } from './config';
import { ManagementStore, configurationDirectory } from './management-store';
import { AccessControl, protectMutation } from './access-control';
import { managementRouter } from './management-api';
import { BackupService } from './backup-runtime';
import { createBackupExecutor, treeFile } from './backup-engine';
import { credentialEnvironment } from './backup-process';
import { allowed } from './management-schema';
import { indexMatchesRepository } from './backup-index';
import { normalizeRepository } from './backup-repository';
import type { BackupDefinition } from './management-schema';
import { ZodError } from 'zod';
import type { DataConfig, TreeEntry, StatusEntry, RestoreInput, RestoreJob } from './types';

// Express 4 does not forward rejected async handlers to error middleware.
function asyncHandler<P = ParamsDictionary> (handler: (req: Request<P, unknown, unknown>, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler<P, unknown, unknown> {
    return (req, res, next) => { void handler (req, res, next).catch (next); };
}
function background (task: Promise<unknown>): void {
    void task.catch ((error: unknown) => { console.error (error); });
}

async function main (): Promise<void> {
const app      = express ();
const trees = Object.create (null) as Record<string, TreeEntry>;
const queue: (StatusEntry | RestoreJob)[] = [];
const restoreContexts = new WeakMap<RestoreJob, { repository?: string; directory: string; args: string[]; env: NodeJS.ProcessEnv }> ();
let queue_active = 0;

let config = readConfig ();
const store = await ManagementStore.open (configurationDirectory (), config);
const access = new AccessControl (store);
const managedTrees = new Set<string> ();
const service = await BackupService.open (store, path.resolve ('var'), createBackupExecutor (async () => { await syncManagedTrees (); }));
const servers = new Set<http.Server> ();

let watching_config = false;
let watcher_config: fs.FSWatcher | undefined;
function setup_watch_config () {
    watcher_config?.close ();
    watcher_config = fs.watch (configurationFile (), { persistent: false }, () => { load_config (); });
}
function load_config () {
    if (watching_config) {
        return;
    }
    watching_config = true;
    try {
        config = readConfig ();
        console.log ('re-loaded config');
        setup_watch_config ();
    } catch {
        setTimeout (() => { load_config (); }, 5000);
    }
    watching_config = false;
}
setup_watch_config ();

let last_borg_log_position = 0, watching_borg_log = 1;
let watcher_borg_log: fs.FSWatcher | undefined;
if (config.borg_backup_log) {
    setup_read_borg_log ();
    background (continue_read_borg_log ());
}
function setup_read_borg_log () {
    watcher_borg_log?.close ();
    if (!config.borg_backup_log) return;
    watcher_borg_log = fs.watch (config.borg_backup_log, { persistent: false }, (evt) => {
        console.log ('borg_backup_log watch @'+evt);
        // file renamed / overwritten, read from start, restart watcher
        if (evt === 'rename') {
            last_borg_log_position = 0;
            setup_read_borg_log ();
        }
        // we can get multiple events for one change. due to promises these might run in "parallel"
        if (++watching_borg_log === 1) {
            background (continue_read_borg_log ());
        }
    });
}
async function continue_read_borg_log () {
    console.log ('* continue_read_borg_log');
    try {
        do {
            if (!config.borg_backup_log) return;
            const fh = await fs_p.open (config.borg_backup_log);
            const rl = fh.readLines ({ start: last_borg_log_position });
            last_borg_log_position = (await fh.stat()).size;
            for await (const line of rl) {
                const obj: StatusEntry = { handle: null, state: 'backup', archive: 'system', short: 'backup done', info: line, tschedule: null, texecute: null, tfinish: null };
                if (line.match (/ERR/)) {
                    obj.state = 'err';
                    obj.short = 'backup error';
                }
                queue.push (obj);
            }
            rl.close ();
            await fh.close ();
        } while (--watching_borg_log > 0);
    } catch {
        setTimeout (() => { background (continue_read_borg_log ()); }, 5000);
    }
    // This *might* grow to large for a short moment, but who cares...
    if (queue.length > config.max_status_entries) {
        queue.splice (0, queue.length-config.max_status_entries);
    }
}


const watching_tree = Object.create (null) as Record<string, number>;
const watcher_tree = Object.create (null) as Record<string, fs.FSWatcher>;
function setup_watch_tree (name: string) {
    watching_tree[name] ??= 0;
    watcher_tree[name]?.close ();
    const entry = trees[name];
    if (!entry) return;
    watcher_tree[name] = fs.watch (entry.file, { persistent: false }, function (evt) {
        background ((async () => {
            console.log ('borg_backup_tree watch @'+evt);
            // file renamed / overwritten, restart watcher
            if (evt === 'rename') {
                setup_watch_tree (name);
            }
            // we can get multiple events for one change. due to promises these might run in "parallel"
            watching_tree[name] = (watching_tree[name] ?? 0) + 1;
            if (watching_tree[name] === 1) {
                do {
                    const current = trees[name];
                    if (current) await withTree (current, () => openTree (current));
                    watching_tree[name] = (watching_tree[name] ?? 0) > 1 ? 1 : 0;
                } while (watching_tree[name]);    // if (at least) another one in flight, start again
            }
        }) ().catch ((error: unknown) => {
            watching_tree[name] = 0;
            console.error ('Cannot reload tree ' + name, error);
        }));
    });
}

async function openTree (conf: DataConfig & { db?: DBuffer }) {
    const name = conf.file.match (/^(.*?)([^/]*)-data-tree.bin$/);
    if (name == null || name[2] == null || name[2] == '') {
        throw Error (conf.file+' does not match file pattern');
    }

    console.error ('Opening data '+name[2]+': '+conf.file);
    const fh = await fs_p.open (conf.file, 'r');
    const db = new DBuffer (fh);
    let offset: number;
    let archives: (string | null)[];
    try {
        const rootOffset = await db.read_header ();
        if (typeof rootOffset !== 'number' || !Number.isSafeInteger (rootOffset) || rootOffset < 0x20) throw Error ('Invalid root offset');
        offset = rootOffset;
        archives = await db.read_archives (0x20);
    } catch (error) {
        await db.close ();
        throw error;
    }
    if (conf.db) await conf.db.close ();

    console.error ('Done reading '+name[2]+': '+JSON.stringify (archives));
    trees[name[2]] = { ...conf, archives, db, offset, cache: new Map () };
    return name[2];
}

async function syncManagedTrees (): Promise<void> {
    const definitions: BackupDefinition[] = [];
    for (const backup of store.snapshot ().backups) if (backup.index && await indexMatchesRepository (backup)) definitions.push (backup);
    const ids = new Set (definitions.map (backup => backup.id));
    for (const id of managedTrees) if (!ids.has (id)) {
        watcher_tree[id]?.close (); delete watcher_tree[id];
        const entry = trees[id];
        if (entry) await withTree (entry, async () => { await entry.db.close (); delete trees[id]; });
        managedTrees.delete (id);
    }
    for (const backup of definitions) {
        const file = treeFile (backup);
        try { await fs_p.access (file); } catch { continue; }
        const previous = trees[backup.id];
        const conf: DataConfig = { file, restore: path.resolve (backup.restoreDirectory, backup.id), enable: true, borg_repo: backup.repository, credentialId: backup.credentialId };
        if (previous) {
            previous.restore = conf.restore; previous.borg_repo = backup.repository; previous.credentialId = backup.credentialId;
        } else { await openTree (conf); setup_watch_tree (backup.id); }
        managedTrees.add (backup.id);
    }
}

async function openAll () {
    for (const f of config.data) {
        if (! f.enable) {
            continue;
        }
        try {
            const name = await openTree (f);
            setup_watch_tree (name);
        } catch (e) {
            console.error ('opening '+f.file+': '+String (e));
        }
    }
    await syncManagedTrees ();
    console.log ('All data opened successfully');
    console.log ('Memory Usage: '+ process.memoryUsage().heapUsed/(1024*1024) + ' MB');
}
// data will only be available after it has been successfully loaded
// await is not available outside async
background (openAll ());

config.hook_preroutes?. (app);

app.use (express.json ());
app.use (express.urlencoded ({ extended: true }));

app.use (express.static (path.join (__dirname, '..', 'public')));

app.get ('/log/:filename', asyncHandler (access.authenticate), (req, res) => {
    const filename = req.params.filename;
    if (!filename || !/^[a-f0-9]{8}\.log$/.test (filename)) return res.status (404).end ();
    const user = access.principal (req);
    const item = queue.find (entry => entry.handle === filename.slice (0, -4));
    if (!user.admin && (!item || !('backup' in item) || !allowed (user, item.backup, 'restore'))) return res.status (403).end ();
    return res.type ('text/plain').sendFile (filename, { root: path.resolve ('log') });
});
express.static.mime.define ({'text/plain': ['log']});

app.use ('/api/', asyncHandler (access.authenticate));
app.use ('/api/', protectMutation);
app.use ('/api/admin', managementRouter (store, service, access, syncManagedTrees, () => config.data.map (entry => path.basename (entry.file).replace (/-data-tree\.bin$/, ''))));

app.get ('/api/status', function (req, res) {
    console.log (`* api/status`);
    const response: { backups: Record<string, number>; state: StatusEntry[]; config: typeof config.client_config } = { backups: {}, state: [], config: config.client_config };
    for (const [name, entry] of Object.entries (trees)) {
        if (allowed (access.principal (req), name, 'browse')) response.backups[name] = entry.archives.length - 1;
    }
    response.state = queue.filter (item => access.principal (req).admin || ('backup' in item && allowed (access.principal (req), item.backup, 'restore'))).map (({handle, state, info, tschedule, texecute, tfinish, short, archive}) =>
        ({handle, state, info, tschedule, texecute, tfinish, short, archive}));
    const user = access.principal (req);
    const nextRuns = service.nextRuns ();
    res.json ({ ...response, admin: user.admin, scheduled: store.snapshot ().backups.filter (backup => allowed (user, backup.id, 'browse') || allowed (user, backup.id, 'run')).map (backup => ({ id: backup.id, name: backup.name, enabled: backup.enabled, nextRun: nextRuns[backup.id], canRun: allowed (user, backup.id, 'run') })), backupRuns: service.runs ().filter (run => allowed (user, run.backupId, 'run')) });
});

app.get ('/api/archives/:backup', function (req, res) {
    access.require (req, req.params.backup, 'browse');
    const entry = trees[req.params.backup];
    if (!entry) return res.status (404).send (null);
    return res.json (entry.archives);
});

app.get ('/api/data/:backup/:path(*)', asyncHandler<{ backup: string; path: string }> (async function (req, res) {
    access.require (req, req.params.backup, 'browse');
    console.log (`* api/data ${req.params.backup} ${req.params.path}`);
    const entry = trees[req.params.backup];
    if (entry === undefined) {
        return res .status (404) .send (null);
    }
    return withTree (entry, async () => {
        if (req.query.archive !== undefined) {
            const archive = typeof req.query.archive === 'string' ? Number (req.query.archive) : NaN;
            const cursor = req.query.cursor === undefined ? 0 : typeof req.query.cursor === 'string' ? Number (req.query.cursor) : NaN;
            if (!Number.isSafeInteger (archive) || archive < 1 || archive >= entry.archives.length ||
                !Number.isSafeInteger (cursor) || cursor < 0) {
                return res.status (400).json ({ error: 'Invalid archive or cursor' });
            }
            const result = await browseArchive (entry, req.params.path, archive, cursor);
            return result === null ? res.status (404).send (null) : res.json (result);
        }
        const result = await browseFiles (entry, req.params.path, config.max_cache_entries);
        return result === null ? res.status (404).send (null) : res.json (result);
    }).catch (error => {
        console.error (error);
        if (!res.headersSent) res.status (500).json ({ error: 'Cannot read backup data' });
    });
}));

app.post<{ backup: string }, unknown, unknown> ('/api/restore/:backup', function (req, res) {
    access.require (req, req.params.backup, 'restore');
    console.log (`* api/restore ${req.params.backup}`);
    const body = req.body;
    if (typeof body !== 'object' || body === null || !('archive' in body) || !('list' in body) ||
        typeof body.archive !== 'string' || !Array.isArray (body.list) || body.list.length === 0 ||
        !body.list.every ((item: unknown) => typeof item === 'string' && item.length > 0 && !/[\r\n\0]/.test (item))) {
        return res.status (400).json ({ error: 'Expected an archive name and nonempty list of paths' });
    }
    const ar = body.archive;
    const list = body.list as string[];

    const entry = trees[req.params.backup];
    if (entry === undefined) {
        return res .status (403) .send (null);
    }

    for (const e of entry.archives) {
        if (e === ar) {
            const handle = queue_request ({ backup: req.params.backup, archive: ar, list, short: (list[0] ?? '').substring(0,20)+'...' }, entry);
            return res .json (handle);
        }
    }

    return res .status (404) .send (null);
});

function queue_request (input: RestoreInput, entry: TreeEntry): string {
    const obj: RestoreJob = { ...input, handle: crypto.randomBytes (4).toString ('hex'),
        tschedule: Date.now (), texecute: null, tfinish: null, state: 'wait', info: 'queued' };
    const repository = entry.borg_repo ?? config.borg_repo;
    const credential = store.snapshot ().credentials.find (item => item.id === entry.credentialId);
    // Keep credential/environment snapshots out of the job that status/log JSON serializes.
    restoreContexts.set (obj, { repository: repository ? normalizeRepository (repository) : undefined,
        directory: path.resolve (entry.restore), args: [...entry.borg_args ?? []], env: credentialEnvironment (credential) });
    queue.push (obj);
    queue_active++;
    if (queue_active === 1) background (run_queue ());
    return obj.handle;
}

async function run_queue () {
    while (queue_active > 0) {
        for (const q of queue) {
            if (q.state === 'wait' && 'backup' in q) {
                console.log ('Starting restore process '+q.handle);
                q.state  = 'run';
                q.info     = 'running';
                q.texecute = Date.now();

                const result = await execute_borg_extract (q).catch ((error: unknown) => ({ error: String (error), lines: 0 }));
                restoreContexts.delete (q);

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

async function execute_borg_extract (q: RestoreJob): Promise<{ error?: string; lines: number }> {
    await fs_p.mkdir ('log', { recursive: true });
    const patternPath = '/tmp/borg-restore-' + q.handle + '.patterns';
    const log = fs.createWriteStream ('log/'+q.handle+'.log', { flags: 'w', mode: 0o644 });
    // use absolute path for patterns, as borg runs in a directory somewhere else
    const logFinished = stream_p.finished (log);
    // Observe write errors immediately, including before Borg's pipelines exist.
    void logFinished.catch (() => {});
    let pat: fs_p.FileHandle | undefined;
    try {
        pat = await fs_p.open (patternPath, 'w', 0o644);
        // Make log data human readable
        const qlog = { ... q, texecute: new Date (q.texecute ?? Date.now ()) .toLocaleString(), tschedule: new Date (q.tschedule) .toLocaleString() };
        log.write (JSON.stringify (qlog, null, 4));
        log.write ('\n***********\n\n');

        let lastpath = '';
        for (const e of q.list) {
            // get all paths elements
            let index = 0;
            for (; index >= 0 && index < e.length-1; index = e.indexOf ('/', index+1)) {
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
        pat = undefined;

        const context = restoreContexts.get (q);
        if (!context) throw Error ('Restore context is missing');
        const cwd = context.directory + '/' + q.archive;
        log.write (`\n***********\n\nrestore path: ${cwd}\n`);
        await fs_p.mkdir (cwd, { recursive: true });

        const repo = context.repository;
        if (!repo) throw Error ('No Borg repository configured');
        const args = [ 'extract', '--list', '--lock-wait', '60',
                       ... context.args,
                       '--patterns-from', '/tmp/borg-restore-'+q.handle+'.patterns',
                        repo+'::'+q.backup+'-'+q.archive];
        log.write ('borg '+args.join(' ')+'\n');
        log.write ('\n***********\n\n');

        const borg         = cp.spawn ('borg', args, {stdio: ['ignore', 'pipe', 'pipe'], cwd, env: context.env });
        const borg_promise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }> ((resolve, reject) => {
            borg.once ('error', reject);
            borg.once ('close', (code, signal) => resolve ({ code, signal }));
        });

        // pipe stdout and stderr of borg to log
        let lines = 0;
        async function* countit (source: AsyncIterable<unknown>) {
            for await (const chunk of source) {
                lines++;
                if (typeof chunk !== 'string' && !Buffer.isBuffer (chunk)) throw Error ('Unexpected Borg output');
                yield chunk.toString () + '\n';
            }
        }
        const stdoutDone = stream_p.pipeline (borg.stdout, new byline.LineStream(), countit, log, { end: false });
        const stderrDone = stream_p.pipeline (borg.stderr, new byline.LineStream(), countit, log, { end: false });

        const [ { code, signal } ] = await Promise.all ( [ borg_promise, stdoutDone, stderrDone ] ).catch (async (error: unknown) => {
            borg.kill ();
            await Promise.allSettled ([borg_promise, stdoutDone, stderrDone]);
            throw error;
        });

        log.write ('\n\n***********\n');
        log.write (`Exit code ${code}, signal ${signal}, lines ${lines}\n`);
        if (code !== 0 || signal != null) {
            return { error: `Exit code ${code}, signal ${signal}`, lines };
        }
        return { lines };
    } finally {
        await pat?.close ();
        log.end ();
        try { await logFinished; }
        finally {
            log.destroy ();
            await fs_p.rm (patternPath, { force: true });
        }
    }
}


app.use ((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ZodError) { res.status (400).json ({ error: error.issues.map (issue => issue.path.join ('.') + ': ' + issue.message).join ('; ') }); return; }
    console.error (error instanceof Error ? error.message : 'Request failed');
    if (res.headersSent) { next (error); return; }
    const status = typeof error === 'object' && error !== null && 'status' in error &&
        typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status (status).json ({ error: status < 500 && error instanceof Error ? error.message : 'Request failed' });
});

config.hook_postroutes?. (app);

if (config.httpPort !== undefined) {
    if (config.httpsPort !== undefined) {
        // When both http and https are enabled, http should only be a redirecting server
        http.createServer (function (req, res) {
            let host = req.headers.host?.replace(/:.*/,'') ?? 'localhost';
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
        http .createServer (app) .listen (config.httpPort, function (this: http.Server) {
            console.log ('Express http server listening on port ' + config.httpPort);
            servers.add (this); service.start ();
            config.hook_poststartup?. (app, this);
        });
    }
}
if (config.httpsPort !== undefined) {
    const ssl_opts = {
        key:  fs.readFileSync ('ssl/server.key'),
        cert: fs.readFileSync ('ssl/server.crt'),
//        ca:   glob.sync ('ssl/chain*.crt') .map (function (e) { return fs.readFileSync (e); }),
        //ciphers: '',
    };
    https.createServer (ssl_opts, app) .listen (config.httpsPort, function (this: https.Server) {
        console.log ('Express https server listening on port ' + config.httpsPort);
        servers.add (this); service.start ();
        config.hook_poststartup?. (app, this);
    });
}

let shuttingDown = false;
const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    background ((async () => {
        for (const server of servers) { server.close (); server.closeIdleConnections (); }
        await service.stop ();
        for (const entry of Object.values (trees)) await entry.db.close ();
        process.exit (0);
    }) ());
};
process.once ('SIGTERM', shutdown); process.once ('SIGINT', shutdown);
}
void main ().catch ((error: unknown) => { console.error (error instanceof Error ? error.message : error); process.exit (1); });
