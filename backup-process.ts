import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { finished } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import os from 'node:os';
import type { BackupCredential } from './management-schema';

export function shellQuote (value: string): string { return "'" + value.replaceAll ("'", "'\\''") + "'"; }
export function credentialEnvironment (credential?: BackupCredential): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
    if (credential?.passphrase !== undefined) { env.BORG_PASSPHRASE = credential.passphrase; delete env.BORG_PASSCOMMAND; delete env.BORG_PASSPHRASE_FD; }
    if (credential?.sshIdentityFile) env.BORG_RSH = 'ssh -o BatchMode=yes -o IPQoS=af11 -i ' + shellQuote (credential.sshIdentityFile);
    return env;
}
/** Redact complete secrets even when stdout/stderr split them across chunks. */
export class RedactingStream extends Transform {
    private carry = '';
    private decoder = new StringDecoder ('utf8');
    constructor (private secret?: string) { super (); }
    override _transform (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.carry += this.decoder.write (chunk);
        this.emitSafe (false); callback ();
    }
    override _flush (callback: (error?: Error | null) => void): void {
        this.carry += this.decoder.end (); this.emitSafe (true); callback ();
    }
    private emitSafe (final: boolean): void {
        // Keep a possible prefix of the secret until the next chunk arrives.
        let safe = final ? this.carry.length : Math.max (0, this.carry.length - (this.secret?.length ?? 1) + 1);
        if (this.secret) {
            let match = this.carry.indexOf (this.secret);
            while (match >= 0 && match < safe) {
                this.push (this.carry.slice (0, match)); this.push ('[redacted]');
                this.carry = this.carry.slice (match + this.secret.length);
                safe = final ? this.carry.length : Math.max (0, this.carry.length - this.secret.length + 1);
                match = this.carry.indexOf (this.secret);
            }
        }
        if (safe > 0 && safe < this.carry.length &&
            this.carry.charCodeAt (safe - 1) >= 0xd800 && this.carry.charCodeAt (safe - 1) <= 0xdbff &&
            this.carry.charCodeAt (safe) >= 0xdc00 && this.carry.charCodeAt (safe) <= 0xdfff) safe--;
        this.push (this.carry.slice (0, safe)); this.carry = this.carry.slice (safe);
    }
}
export class BackupLog {
    readonly stream: RedactingStream;
    private done: Promise<void>;
    private output;
    constructor (filename: string, secret?: string) {
        this.output = createWriteStream (filename, { flags: 'a', mode: 0o600 });
        this.stream = new RedactingStream (secret);
        this.stream.pipe (this.output);
        this.stream.on ('error', error => this.output.destroy (error));
        this.output.on ('error', error => this.stream.destroy (error));
        this.done = Promise.all ([finished (this.stream), finished (this.output)]).then (() => {});
        void this.done.catch (() => {});
    }
    write (message: string): void { this.stream.write (message); }
    async close (): Promise<void> { this.stream.end (); await this.done; }
}
export function terminate (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
        if (process.platform !== 'win32' && child.pid) process.kill (-child.pid, signal);
        else child.kill (signal);
    } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; }
}
export async function command (bin: string, args: string[], output: Writable, options: { env?: NodeJS.ProcessEnv; signal: AbortSignal; input?: string } ): Promise<number> {
    options.signal.throwIfAborted ();
    if (output.destroyed) throw output.errored ?? Error ('Backup log is closed');
    const child = spawn (bin, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let outputFailure: Error | undefined;
    const abort = () => {
        terminate (child);
        if (killTimer) return;
        killTimer = setTimeout (() => { terminate (child, 'SIGKILL'); }, 5000); killTimer.unref ();
    };
    const failedOutput = (error: Error) => { outputFailure = error; abort (); };
    output.once ('error', failedOutput);
    options.signal.addEventListener ('abort', abort, { once: true });
    if (options.signal.aborted) abort ();
    const completed = new Promise<number> ((resolve, reject) => {
        child.once ('error', reject);
        child.once ('close', (code, signal) => { resolve (signal ? 2 : code ?? 2); });
    });
    child.stdout.pipe (output, { end: false }); child.stderr.pipe (output, { end: false });
    // EPIPE means the remote command exited before consuming its script.
    child.stdin.on ('error', error => { if (!('code' in error) || error.code !== 'EPIPE') terminate (child); });
    child.stdin.end (options.input);
    try {
        const code = await completed;
        if (outputFailure) throw outputFailure;
        return code;
    }
    finally {
        options.signal.removeEventListener ('abort', abort);
        output.removeListener ('error', failedOutput);
        if (killTimer) clearTimeout (killTimer);
        child.stdout.unpipe (output); child.stderr.unpipe (output);
    }
}
export async function privateRunDirectory (id: string): Promise<string> {
    return fs.mkdtemp (path.join (os.tmpdir (), 'borg-webgui-' + id.slice (0, 8) + '-'));
}
