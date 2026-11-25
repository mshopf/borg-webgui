import path from 'node:path';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { once } from 'node:events';
import type { BackupDefinition, BackupCredential } from './management-schema';
import { backupStatisticsSchema } from './backup-runtime';
import type { BackupRun, BackupStatistics } from './backup-runtime';
import { BackupLog, command, credentialEnvironment, privateRunDirectory, shellQuote, terminate } from './backup-process';
import { effectiveExclusions } from './exclusion-templates';
import { treeFile, indexMatchesRepository, recordIndexRepository } from './backup-index';
export { treeFile } from './backup-index';

// This suffix works as both a Borg glob and a JavaScript regular expression.
const digit = '[0-9]';
const archiveSuffix = digit.repeat (4) + '-' + digit.repeat (2) + '-' + digit.repeat (2) + '-' + digit.repeat (6);

export function createArguments (backup: BackupDefinition, archive: string, repository = backup.repository, repositories: readonly string[] = []): string[] {
    return ['create', '--json', '--progress', '--show-rc', '--lock-wait', '60', '--compression', backup.compression,
        '--noatime', '--nobsdflags', '--numeric-ids', ...(backup.oneFileSystem ? ['--one-file-system'] : []),
        ...(backup.excludeCaches ? ['--exclude-caches'] : []),
        ...effectiveExclusions (backup, repositories).flatMap (pattern => ['--exclude', pattern]), '--', repository + '::' + archive, ...backup.sources];
}
export function pruneArguments (backup: BackupDefinition): string[] {
    return ['prune', '--list', '--show-rc', '--lock-wait', '60', '--glob-archives', backup.id + '-' + archiveSuffix,
        '--keep-daily', String (backup.retention.daily), '--keep-weekly', String (backup.retention.weekly),
        '--keep-monthly', String (backup.retention.monthly), '--keep-yearly', String (backup.retention.yearly), '--', backup.repository];
}
/** Each forwarded connection gets a constrained Borg server; the peer never gets shell access locally. */
export async function serveRepository (socketPath: string, repository: string, output: Writable): Promise<{ close: () => Promise<void> }> {
    const children = new Set<ChildProcess> ();
    const sockets = new Set<net.Socket> ();
    const server = net.createServer (socket => {
        sockets.add (socket); socket.once ('close', () => { sockets.delete (socket); });
        const child = spawn ('borg', ['serve', '--append-only', '--restrict-to-repository', repository], {
            stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, SSH_ORIGINAL_COMMAND: '' }
        });
        children.add (child);
        child.on ('error', error => { output.write ('Borg serve failed: ' + error.message + '\n'); socket.destroy (); });
        child.once ('close', () => { children.delete (child); socket.destroy (); });
        socket.on ('error', () => { terminate (child); });
        socket.once ('close', () => { terminate (child); });
        child.stdin.on ('error', () => { socket.destroy (); });
        child.stdout.on ('error', () => { socket.destroy (); });
        socket.pipe (child.stdin); child.stdout.pipe (socket); child.stderr.pipe (output, { end: false });
    });
    server.listen (socketPath);
    try { await once (server, 'listening'); }
    catch (error) { server.close (); throw error; }
    await fs.chmod (socketPath, 0o600);
    // Observe later listener errors rather than taking down the web server.
    server.on ('error', error => { output.write ('Repository socket error: ' + error.message + '\n'); });
    return { close: async () => {
        const closed = new Promise<void> ((resolve, reject) => { server.close (error => { if (error) reject (error); else resolve (); }); });
        for (const socket of sockets) socket.destroy ();
        const waits = [...children].map (child => once (child, 'close').catch (() => {}));
        for (const child of children) terminate (child);
        const force = setTimeout (() => { for (const child of children) terminate (child, 'SIGKILL'); }, 5000); force.unref ();
        try { await Promise.all ([closed, ...waits]); }
        finally { clearTimeout (force); await fs.rm (socketPath, { force: true }); }
    } };
}

export function pullInvocation (backup: Extract<BackupDefinition, {mode: 'pull'}>, credential: BackupCredential | undefined, run: BackupRun, localSocket: string): { args: string[]; input: string } {
    const remoteSocket = '/tmp/borg-webgui-' + run.id + '.sock';
    const rsh = 'sh -c ' + shellQuote ('exec socat STDIO UNIX-CONNECT:' + remoteSocket);
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
        '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'IPQoS=af11',
        '-p', String (backup.remote.port), ...(credential?.sshIdentityFile ? ['-i', credential.sshIdentityFile] : []),
        '-R', remoteSocket + ':' + localSocket, '--', backup.remote.user + '@' + backup.remote.host, 'sh -s'];
    // Deliver credentials and the quoted command via stdin, never process arguments.
    const input = ['set +x', 'set -eu', 'umask 077',
        'trap ' + shellQuote ('rm -f -- ' + shellQuote (remoteSocket)) + ' EXIT HUP INT TERM',
        'unset BORG_PASSCOMMAND BORG_PASSPHRASE_FD',
        'export LC_ALL=C',
        'export BORG_RSH=' + shellQuote (rsh),
        ...(credential?.passphrase !== undefined ? ['export BORG_PASSPHRASE=' + shellQuote (credential.passphrase)] : []),
        'borg ' + createArguments (backup, run.archive, 'ssh://borg@localhost' + backup.repository).map (shellQuote).join (' '),
        ''].join ('\n');
    return { args, input };
}

function completeStatistics (stdout: Buffer[]): BackupStatistics | undefined {
    try {
        const result = JSON.parse (Buffer.concat (stdout).toString ()) as { archive?: { stats?: Record<string, unknown> } };
        const stats = result?.archive?.stats;
        if (!stats) return;
        const parsed = backupStatisticsSchema.safeParse ({
            originalBytes: stats.original_size, compressedBytes: stats.compressed_size,
            deduplicatedBytes: stats.deduplicated_size, files: stats.nfiles
        });
        if (parsed.success && Object.values (parsed.data).some (value => value !== undefined)) return parsed.data;
    } catch { /* Borg can exit without producing a JSON report. */ }
}

export function createBackupExecutor (onIndexed: (backup: BackupDefinition) => Promise<void> = async () => {}) {
    return async (backup: BackupDefinition, credential: BackupCredential | undefined, run: BackupRun, signal: AbortSignal,
        record: (statistics: BackupStatistics) => void = () => {}, repositories: readonly string[] = []) => {
        await fs.mkdir (path.resolve ('log/backups'), { recursive: true, mode: 0o700 });
        const log = new BackupLog (path.resolve ('log/backups', run.id + '.log'), credential?.passphrase);
        const env = credentialEnvironment (credential);
        const stage = async (label: string, bin: string, args: string[], input?: string, onStdout?: (chunk: Buffer) => void) => {
            signal.throwIfAborted ();
            log.write ('\n' + new Date ().toISOString () + ' ' + label + '\n');
            const code = await command (bin, args, log.stream, { env, signal, input, onStdout });
            log.write (label + ' exit code: ' + code + '\n');
            return code;
        };
        try {
            log.write (JSON.stringify ({ backup: backup.id, archive: run.archive, action: run.action, mode: backup.mode }) + '\n');
            if (run.action === 'initialize') {
                if (backup.repository.startsWith ('/')) await fs.mkdir (path.dirname (backup.repository), { recursive: true, mode: 0o700 });
                // Encryption is always required for newly initialized repositories.
                if (!credential?.passphrase) throw Error ('Set a repository passphrase before initialization');
                return await stage ('Initialize repository', 'borg', ['init', '--encryption', 'repokey-blake2', '--', backup.repository]);
            }
            let createCode: number;
            const stdout: Buffer[] = [];
            let stdoutBytes = 0;
            const onStdout = (chunk: Buffer) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes <= 1024 * 1024) stdout.push (chunk);
                else stdout.length = 0;
            };
            if (backup.mode === 'pull') {
                const directory = await privateRunDirectory (run.id);
                try {
                    const socketPath = path.join (directory, 'repo.sock');
                    // AF_UNIX addresses have a small OS-specific size limit.
                    if (Buffer.byteLength (socketPath) > 100) throw Error ('Run directory path is too long for a Unix socket');
                    const server = await serveRepository (socketPath, backup.repository, log.stream);
                    try {
                        const invocation = pullInvocation (backup, credential, run, socketPath);
                        createCode = await stage ('Remote Borg create', 'ssh', invocation.args, invocation.input, onStdout);
                    } finally { await server.close (); }
                } finally { await fs.rm (directory, { recursive: true, force: true }); }
            } else createCode = await stage ('Borg create', 'borg', createArguments (backup, run.archive, backup.repository, repositories), undefined, onStdout);
            if (createCode > 1) { log.write ('Create failed; skipping prune, compact, and indexing\n'); return createCode; }
            const statistics = completeStatistics (stdout);
            if (statistics) record (statistics);
            let result = createCode;
            if (backup.retention.enabled) result = Math.max (result, await stage ('Borg prune', 'borg', pruneArguments (backup)));
            if (backup.compact && result < 2) result = Math.max (result, await stage ('Borg compact', 'borg', ['compact', '--lock-wait', '60', '--', backup.repository]));
            if (backup.index) {
                await fs.mkdir (path.dirname (treeFile (backup)), { recursive: true, mode: 0o700 });
                const filter = backup.id.replace (/[.*+?^${}()|[\]\\]/g, '\\$&');
                const reusable = await indexMatchesRepository (backup);
                const directory = reusable ? path.dirname (treeFile (backup)) : await fs.mkdtemp (path.join (path.dirname (treeFile (backup)), '.rebuild-'));
                const target = path.join (directory, path.basename (treeFile (backup)));
                try {
                    const code = await command (process.execPath, [path.resolve (__dirname, '../tree.js'), '-c', '-a', target, '/^' + filter + '-' + archiveSuffix + '$'], log.stream,
                        { signal, env: { ...env, BORG_WEBGUI_INDEX_REPO: backup.repository } });
                    log.write ('Tree index exit code: ' + code + '\n'); result = Math.max (result, code);
                    if (code === 0) {
                        if (!reusable) await fs.rename (target, treeFile (backup));
                        await recordIndexRepository (backup); await onIndexed (backup);
                    }
                } finally { if (!reusable) await fs.rm (directory, { recursive: true, force: true }); }
            }
            return result;
        } catch (error) {
            log.write ('Operation failed: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
            throw error;
        } finally { await log.close (); }
    };
}
