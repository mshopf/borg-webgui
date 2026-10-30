import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ManagementStore } from './management-store';
import type { BackupDefinition, BackupCredential } from './management-schema';
import { archiveTimestamp, dueOccurrence, nextOccurrence } from './backup-schedule';

export const runSchema = z.strictObject ({
    id: z.string ().uuid (), backupId: z.string (), archive: z.string (),
    action: z.enum (['backup', 'initialize']), origin: z.enum (['manual', 'scheduled']),
    state: z.enum (['queued', 'running', 'done', 'warning', 'error', 'cancelled', 'interrupted']),
    queuedAt: z.string (), startedAt: z.string ().optional (), finishedAt: z.string ().optional (),
    exitCode: z.number ().int ().optional (), message: z.string (), slot: z.string ().optional ()
});
const runtimeSchema = z.strictObject ({ version: z.literal (1), slots: z.record (z.string (), z.string ()), runs: z.array (runSchema).max (500) });
export type BackupRun = z.infer<typeof runSchema>;
type Runtime = z.infer<typeof runtimeSchema>;
export type BackupExecutor = (backup: BackupDefinition, credential: BackupCredential | undefined, run: BackupRun, signal: AbortSignal) => Promise<number>;

export class BackupService {
    private state: Runtime = { version: 1, slots: {}, runs: [] };
    private writes: Promise<unknown> = Promise.resolve ();
    private work: Promise<unknown> = Promise.resolve ();
    private timer?: ReturnType<typeof setInterval>;
    private controllers = new Map<string, AbortController> ();
    private stopped = false;
    private constructor (readonly store: ManagementStore, readonly directory: string, private execute: BackupExecutor) {}
    static async open (store: ManagementStore, directory: string, execute: BackupExecutor): Promise<BackupService> {
        await fs.mkdir (directory, { recursive: true, mode: 0o700 });
        const service = new BackupService (store, directory, execute);
        try {
            const input: unknown = JSON.parse (await fs.readFile (path.join (directory, 'backup-state.json'), 'utf8'));
            service.state = runtimeSchema.parse (input);
        } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
        await service.change (state => {
            for (const run of state.runs) if (run.state === 'queued' || run.state === 'running') {
                run.state = 'interrupted'; run.finishedAt = new Date ().toISOString (); run.message = 'Server stopped before this run finished; inspect the repository before retrying';
            }
        });
        return service;
    }
    runs (): BackupRun[] { return structuredClone (this.state.runs); }
    busy (backupId: string): boolean { return this.state.runs.some (run => run.backupId === backupId && (run.state === 'queued' || run.state === 'running')); }
    nextRuns (now = new Date ()): Record<string, string | null> {
        return Object.fromEntries (this.store.snapshot ().backups.map (backup => [backup.id, backup.enabled ? nextOccurrence (backup.schedule, now).toISOString () : null]));
    }
    private async change (mutate: (draft: Runtime) => void): Promise<void> {
        const write = this.writes.catch (() => {}).then (async () => {
            const draft = structuredClone (this.state);
            mutate (draft);
            while (draft.runs.length > 500) {
                const index = draft.runs.findIndex (run => run.state !== 'running' && run.state !== 'queued');
                if (index < 0) throw Error ('Too many active backup runs');
                draft.runs.splice (index, 1);
            }
            const temporary = path.join (this.directory, randomUUID () + '.tmp');
            try {
                const handle = await fs.open (temporary, 'wx', 0o600);
                try { await handle.writeFile (JSON.stringify (draft, null, 2) + '\n'); await handle.sync (); }
                finally { await handle.close (); }
                await fs.rename (temporary, path.join (this.directory, 'backup-state.json'));
                this.state = draft;
            } finally { await fs.rm (temporary, { force: true }); }
        });
        this.writes = write;
        return write;
    }
    async enqueue (id: string, action: 'backup' | 'initialize' = 'backup', slot?: string, now = new Date ()): Promise<BackupRun> {
        if (this.stopped) throw Object.assign (Error ('Backup service is stopping'), { status: 503 });
        const document = this.store.snapshot ();
        const backup = document.backups.find (item => item.id === id);
        if (!backup) throw Object.assign (Error ('Unknown backup'), { status: 404 });
        const credential = document.credentials.find (item => item.id === backup.credentialId);
        const controller = new AbortController ();
        const run: BackupRun = { id: randomUUID (), backupId: id, archive: id + '-' + archiveTimestamp (now), action, origin: slot ? 'scheduled' : 'manual', state: 'queued', queuedAt: now.toISOString (), message: 'Queued', slot };
        await this.change (state => {
            if (state.runs.some (item => item.backupId === id && (item.state === 'queued' || item.state === 'running'))) throw Object.assign (Error ('This backup is already queued or running'), { status: 409 });
            if (slot && state.slots[id] === slot) throw Object.assign (Error ('Scheduled time already claimed'), { status: 409 });
            // Archive names have second precision; retain uniqueness for rapid manual runs.
            const last = state.runs.filter (item => item.backupId === id && item.action === 'backup').at (-1);
            if (last && last.archive >= run.archive) {
                const date = last.archive.slice (id.length + 1).replace (/^(....-..-..)-(..)(..)(..)$/, '$1T$2:$3:$4Z');
                run.archive = id + '-' + archiveTimestamp (new Date (Date.parse (date) + 1000));
            }
            if (slot) state.slots[id] = slot;
            state.runs.push (run);
        });
        this.controllers.set (run.id, controller);
        this.work = this.work.catch (() => {}).then (async () => {
            let executionSignal: AbortSignal | undefined;
            try {
                if (controller.signal.aborted || this.stopped) { await this.finish (run.id, 'cancelled', 'Cancelled before starting'); return; }
                await this.change (state => {
                    const current = state.runs.find (item => item.id === run.id);
                    if (current) { current.state = 'running'; current.startedAt = new Date ().toISOString (); current.message = 'Running'; }
                });
                const signal = executionSignal = AbortSignal.any ([controller.signal, AbortSignal.timeout (backup.timeoutMinutes * 60000)]);
                const code = await this.execute (backup, credential, run, signal);
                await this.finish (run.id, signal.aborted ? 'cancelled' : code === 0 ? 'done' : code === 1 ? 'warning' : 'error', signal.aborted ? 'Cancelled or timed out' : code < 2 ? 'Backup operation finished' : 'Backup operation failed; see log', code);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Backup failed';
                await this.finish (run.id, executionSignal?.aborted || controller.signal.aborted ? 'cancelled' : 'error', credential?.passphrase ? message.replaceAll (credential.passphrase, '[redacted]') : message, 2);
            } finally { this.controllers.delete (run.id); }
        });
        // Observe persistence failures without allowing an unhandled background rejection.
        void this.work.catch ((error: unknown) => { console.error ('Backup service failure', error); });
        return structuredClone (run);
    }
    private async finish (id: string, state: BackupRun['state'], message: string, exitCode?: number): Promise<void> {
        await this.change (document => {
            const run = document.runs.find (item => item.id === id);
            if (run) { run.state = state; run.message = message; run.exitCode = exitCode; run.finishedAt = new Date ().toISOString (); }
        });
    }
    cancel (id: string): void {
        const controller = this.controllers.get (id);
        if (!controller) throw Object.assign (Error ('Run is not active'), { status: 409 });
        controller.abort ();
    }
    async tick (now = new Date ()): Promise<void> {
        if (this.stopped) return;
        for (const backup of this.store.snapshot ().backups) {
            if (!backup.enabled) continue;
            const due = dueOccurrence (backup.schedule, now);
            if (!due || this.state.slots[backup.id] === due.toISOString ()) continue;
            try { await this.enqueue (backup.id, 'backup', due.toISOString (), now); }
            catch (error) {
                if (!(error instanceof Error) || !('status' in error) || error.status !== 409) throw error;
            }
        }
    }
    start (): void {
        if (this.timer) return;
        const tick = () => { void this.tick ().catch ((error: unknown) => { console.error ('Backup scheduler', error); }); };
        this.timer = setInterval (tick, 10000); this.timer.unref (); tick ();
    }
    async idle (): Promise<void> { await this.work; }
    async stop (): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval (this.timer);
        for (const controller of this.controllers.values ()) controller.abort ();
        await this.work; await this.writes;
    }
}
