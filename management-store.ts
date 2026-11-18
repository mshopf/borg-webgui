import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { managementSchema } from './management-schema';
import type { ManagementDocument } from './management-schema';
import type { Config } from './types';

export function configurationDirectory (): string {
    return path.resolve (process.env.BORG_WEBGUI_CONFIG_DIR ?? './etc');
}
/** Atomic, serialized replacement. The in-memory snapshot changes only after rename succeeds. */
export class ManagementStore {
    private pending: Promise<unknown> = Promise.resolve ();
    private constructor (readonly filename: string, private document: ManagementDocument) {}
    static async open (directory: string, legacy?: Config): Promise<ManagementStore> {
        await fs.mkdir (directory, { recursive: true, mode: 0o700 });
        const filename = path.join (directory, 'management.json');
        let document: ManagementDocument;
        try {
            const input: unknown = JSON.parse (await fs.readFile (filename, 'utf8'));
            document = managementSchema.parse (input);
            await fs.chmod (filename, 0o600);
        } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
            document = managementSchema.parse ({ version: 1, backups: [], credentials: [], users:
                Object.entries (legacy?.auth ?? {}).map (([id, user], index) => ({ id, passwordHash: user.pwd, enabled: true, admin: id === 'admin' || (!Object.hasOwn (legacy?.auth ?? {}, 'admin') && index === 0), grants: [{ backup: '*', browse: true, restore: true, run: false }] })) });
            // Exclusive creation avoids overwriting a concurrent first-time setup.
            await fs.writeFile (filename, JSON.stringify (document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        }
        return new ManagementStore (filename, document);
    }
    snapshot (): ManagementDocument { return structuredClone (this.document); }
    async update (mutate: (draft: ManagementDocument) => void, expectedRevision?: number): Promise<ManagementDocument> {
        const operation = this.pending.catch (() => {}).then (async () => {
            if (expectedRevision !== undefined && expectedRevision !== this.document.revision) throw Object.assign (Error ('Configuration changed; reload before saving'), { status: 409 });
            const draft = this.snapshot ();
            mutate (draft);
            draft.revision++;
            const validated = managementSchema.parse (draft);
            if (this.document.users.some (user => user.enabled && user.admin) && !validated.users.some (user => user.enabled && user.admin)) throw Object.assign (Error ('Keep at least one enabled administrator'), { status: 409 });
            const temporary = this.filename + '.' + randomUUID () + '.tmp';
            try {
                const handle = await fs.open (temporary, 'wx', 0o600);
                try { await handle.writeFile (JSON.stringify (validated, null, 2) + '\n'); await handle.sync (); }
                finally { await handle.close (); }
                await fs.rename (temporary, this.filename);
                this.document = validated;
            } finally { await fs.rm (temporary, { force: true }); }
            return this.snapshot ();
        });
        this.pending = operation;
        return operation;
    }
}
