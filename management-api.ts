import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import path from 'node:path';
import type { ManagementStore } from './management-store';
import type { BackupService } from './backup-runtime';
import type { AccessControl } from './access-control';
import { backupSchema, credentialSchema, userSchema, idSchema, publicUser, publicCredential, allowed } from './management-schema';
import { exclusionTemplates, effectiveExclusions } from './exclusion-templates';

function route (handler: (req: Request<Record<string, string>, unknown, unknown>, res: Response) => unknown): RequestHandler<Record<string, string>, unknown, unknown> {
    return (req, res, next: NextFunction) => { void Promise.resolve ().then (() => handler (req, res)).catch (next); };
}
const revision = z.number ().int ().min (0);
const deletion = z.strictObject ({ revision });
const userInput = userSchema.omit ({ passwordHash: true }).extend ({ password: z.string ().min (12).max (1024).optional () });
const credentialInput = credentialSchema.extend ({ clearPassphrase: z.boolean ().optional () });
function parameter (req: Request<Record<string, string>>, key = 'id'): string { return idSchema.parse (req.params[key]); }

export function managementRouter (store: ManagementStore, service: BackupService, access: AccessControl, onChanged: () => Promise<void>, legacyIds: () => string[]): express.Router {
    const router = express.Router ();
    router.get ('/me', (req, res) => { res.json (publicUser (access.principal (req))); });
    router.get ('/backups', (req, res) => {
        const user = access.principal (req);
        res.json ({ backups: store.snapshot ().backups.filter (backup => allowed (user, backup.id, 'browse') || allowed (user, backup.id, 'run')).map (backup => ({ id: backup.id, name: backup.name, enabled: backup.enabled })),
            nextRuns: Object.fromEntries (Object.entries (service.nextRuns ()).filter (([id]) => allowed (user, id, 'browse') || allowed (user, id, 'run'))) });
    });
    router.get ('/runs', (req, res) => {
        const user = access.principal (req);
        res.json (service.runs ().filter (run => allowed (user, run.backupId, 'run')));
    });
    router.post ('/backups/:id/run', route (async (req, res) => {
        const id = parameter (req); access.require (req, id, 'run');
        z.strictObject ({}).parse (req.body);
        return res.status (202).json (await service.enqueue (id));
    }));
    router.post ('/runs/:id/cancel', route ((req, res) => {
        const run = service.runs ().find (item => item.id === req.params.id);
        if (!run) return res.status (404).json ({ error: 'Unknown run' });
        access.require (req, run.backupId, 'run'); z.strictObject ({}).parse (req.body);
        service.cancel (run.id); return res.json ({ cancelled: true });
    }));
    router.get ('/runs/:id/log', (req, res) => {
        const run = service.runs ().find (item => item.id === req.params.id);
        if (!run) return res.status (404).json ({ error: 'Unknown run' });
        access.require (req, run.backupId, 'run');
        res.type ('text/plain'); res.setHeader ('Cache-Control', 'no-store');
        return res.sendFile (run.id + '.log', { root: path.resolve ('log/backups') });
    });
    router.use ((req, _res, next) => { access.requireAdmin (req); next (); });
    router.get ('/configuration', (_req, res) => {
        const document = store.snapshot ();
        res.setHeader ('Cache-Control', 'no-store');
        res.json ({ revision: document.revision, backups: document.backups, users: document.users.map (publicUser), credentials: document.credentials.map (publicCredential),
            templates: exclusionTemplates, nextRuns: service.nextRuns (), runs: service.runs (), serverTimezone: Intl.DateTimeFormat ().resolvedOptions ().timeZone, legacyBackups: legacyIds () });
    });
    router.post ('/preview-exclusions', (req, res) => { res.json (effectiveExclusions (backupSchema.parse (req.body))); });
    router.put ('/backups/:id', route (async (req, res) => {
        const id = parameter (req);
        const input = z.strictObject ({ revision, backup: backupSchema }).parse (req.body);
        if (input.backup.id !== id) throw Object.assign (Error ('Backup ID cannot be changed'), { status: 400 });
        if (legacyIds ().includes (id)) throw Object.assign (Error ('ID belongs to a legacy backup configuration'), { status: 409 });
        if (service.busy (id)) throw Object.assign (Error ('Cancel or finish active runs before editing'), { status: 409 });
        const result = await store.update (draft => {
            const index = draft.backups.findIndex (backup => backup.id === id);
            if (index < 0) draft.backups.push (input.backup); else draft.backups[index] = input.backup;
        }, input.revision);
        await onChanged (); return res.json ({ revision: result.revision });
    }));
    router.delete ('/backups/:id', route (async (req, res) => {
        const id = parameter (req); const input = deletion.parse (req.body);
        if (service.busy (id)) throw Object.assign (Error ('Cancel or finish active runs before deleting'), { status: 409 });
        const result = await store.update (draft => {
            draft.backups = draft.backups.filter (backup => backup.id !== id);
            for (const user of draft.users) user.grants = user.grants.filter (grant => grant.backup !== id);
        }, input.revision);
        await onChanged (); return res.json ({ revision: result.revision });
    }));
    router.post ('/backups/:id/initialize', route (async (req, res) => {
        z.strictObject ({}).parse (req.body);
        return res.status (202).json (await service.enqueue (parameter (req), 'initialize'));
    }));
    router.put ('/users/:id', route (async (req, res) => {
        const input = z.strictObject ({ revision, user: userInput }).parse (req.body);
        if (input.user.id !== req.params.id) throw Object.assign (Error ('User ID cannot be changed'), { status: 400 });
        const passwordHash = input.user.password ? await argon2.hash (input.user.password) : undefined;
        const result = await store.update (draft => {
            const previous = draft.users.find (user => user.id === input.user.id);
            const hash = passwordHash ?? previous?.passwordHash;
            if (!hash) throw Object.assign (Error ('A password is required for new users'), { status: 400 });
            const user = userSchema.parse ({ id: input.user.id, enabled: input.user.enabled, admin: input.user.admin, grants: input.user.grants, passwordHash: hash });
            draft.users = draft.users.filter (item => item.id !== user.id); draft.users.push (user);
        }, input.revision);
        return res.json ({ revision: result.revision });
    }));
    router.delete ('/users/:id', route (async (req, res) => {
        const input = deletion.parse (req.body);
        const result = await store.update (draft => { draft.users = draft.users.filter (user => user.id !== req.params.id); }, input.revision);
        return res.json ({ revision: result.revision });
    }));
    router.put ('/credentials/:id', route (async (req, res) => {
        const input = z.strictObject ({ revision, credential: credentialInput }).parse (req.body); const id = parameter (req);
        if (input.credential.id !== id) throw Object.assign (Error ('Credential ID cannot be changed'), { status: 400 });
        const result = await store.update (draft => {
            const previous = draft.credentials.find (credential => credential.id === id);
            const { clearPassphrase, ...fields } = input.credential;
            const credential = credentialSchema.parse ({ ...fields, passphrase: clearPassphrase ? undefined : fields.passphrase ?? previous?.passphrase });
            draft.credentials = draft.credentials.filter (item => item.id !== id); draft.credentials.push (credential);
        }, input.revision);
        return res.json ({ revision: result.revision });
    }));
    router.delete ('/credentials/:id', route (async (req, res) => {
        const input = deletion.parse (req.body); const id = parameter (req);
        const result = await store.update (draft => { draft.credentials = draft.credentials.filter (credential => credential.id !== id); }, input.revision);
        return res.json ({ revision: result.revision });
    }));
    return router;
}
