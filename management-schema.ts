import { z } from 'zod';
import { normalizeRepository } from './backup-repository';

export const idSchema = z.string ().regex (/^[a-zA-Z0-9][a-zA-Z0-9._%-]{0,63}$/);
const line = z.string ().min (1).max (4096).refine (value => [...value].every (char => char.charCodeAt (0) >= 32 && char.charCodeAt (0) !== 127), 'Control characters are not allowed');
const absolutePath = line.refine (value => value.startsWith ('/'), 'Use an absolute path');
const timezone = z.string ().max (100).refine (value => {
    try { new Intl.DateTimeFormat ('en', { timeZone: value }); return true; } catch { return false; }
}, 'Unknown timezone');
export const scheduleSchema = z.strictObject ({
    frequency: z.enum (['daily', 'weekly', 'monthly']).default ('daily'),
    timezone: timezone.default (() => Intl.DateTimeFormat ().resolvedOptions ().timeZone),
    times: z.array (z.string ().regex (/^(?:[01]\d|2[0-3]):[0-5]\d$/)).min (1).max (24).default (['03:00']),
    weekdays: z.array (z.number ().int ().min (1).max (7)).max (7).default ([1, 2, 3, 4, 5, 6, 7]),
    monthdays: z.array (z.number ().int ().min (1).max (31)).max (31).default ([1])
}).refine (value => value.frequency !== 'weekly' || value.weekdays.length > 0, 'Choose at least one weekday')
    .refine (value => value.frequency !== 'monthly' || value.monthdays.length > 0, 'Choose at least one month day');
const common = {
    id: idSchema,
    name: line.max (120),
    enabled: z.boolean ().default (false),
    repository: line.refine (value => !value.startsWith ('-') && !value.includes ('::'), 'Invalid repository').transform (normalizeRepository),
    sources: z.array (absolutePath).min (1).max (100),
    credentialId: idSchema.optional (),
    schedule: scheduleSchema.default (() => scheduleSchema.parse ({})),
    exclusions: z.array (line).max (1000).default ([]),
    templates: z.array (z.enum (['linux', 'caches', 'trash', 'development', 'webgui', 'provided', 'provided-replacement'])).max (7).default (['linux', 'caches', 'trash', 'webgui']),
    compression: z.enum (['lz4', 'zstd,3', 'zstd,6', 'none']).default ('lz4'),
    oneFileSystem: z.boolean ().default (true),
    excludeCaches: z.boolean ().default (true),
    retention: z.strictObject ({
        enabled: z.boolean ().default (true),
        daily: z.number ().int ().min (0).max (10000).default (14),
        weekly: z.number ().int ().min (0).max (10000).default (8),
        monthly: z.number ().int ().min (0).max (10000).default (24),
        yearly: z.number ().int ().min (0).max (10000).default (10)
    }).refine (value => !value.enabled || value.daily + value.weekly + value.monthly + value.yearly > 0, 'Keep at least one generation').default (() => ({ enabled: true, daily: 14, weekly: 8, monthly: 24, yearly: 10 })),
    compact: z.boolean ().default (false),
    index: z.boolean ().default (true),
    restoreDirectory: line.default ('./restore'),
    timeoutMinutes: z.number ().int ().min (1).max (10080).default (720)
};
export const backupSchema = z.discriminatedUnion ('mode', [
    z.strictObject ({ ...common, mode: z.literal ('local') }),
    z.strictObject ({ ...common, mode: z.literal ('pull'), repository: absolutePath,
        remote: z.strictObject ({
            host: z.string ().min (1).max (255).regex (/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/),
            user: z.string ().min (1).max (64).regex (/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
            port: z.number ().int ().min (1).max (65535).default (22)
        })
    })
]);
export const credentialSchema = z.strictObject ({
    id: idSchema, name: line.max (120),
    passphrase: z.string ().max (4096).refine (value => !value.includes ('\0'), 'NUL is not allowed').optional (),
    sshIdentityFile: absolutePath.optional ()
});
export const userSchema = z.strictObject ({
    id: z.string ().regex (/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$/),
    passwordHash: z.string ().startsWith ('$argon2'),
    enabled: z.boolean ().default (true),
    admin: z.boolean ().default (false),
    grants: z.array (z.strictObject ({ backup: z.union ([idSchema, z.literal ('*')]),
        browse: z.boolean (), restore: z.boolean (), run: z.boolean () })).max (1000).default ([])
});
export const managementSchema = z.strictObject ({
    version: z.literal (1), revision: z.number ().int ().min (0).default (0),
    backups: z.array (backupSchema).max (1000), users: z.array (userSchema).max (1000),
    credentials: z.array (credentialSchema).max (1000)
}).superRefine ((value, ctx) => {
    for (const key of ['backups', 'users', 'credentials'] as const) {
        const ids = value[key].map (item => item.id);
        if (new Set (ids).size !== ids.length) ctx.addIssue ({ code: 'custom', message: 'Duplicate ' + key + ' ID' });
    }
    for (const backup of value.backups) {
        if (backup.credentialId && !value.credentials.some (item => item.id === backup.credentialId)) ctx.addIssue ({ code: 'custom', message: 'Unknown credential: ' + backup.credentialId });
        // Prevent one job's prune glob from matching another managed job's archives.
        if (value.backups.some (other => other.id !== backup.id && other.id.startsWith (backup.id + '-'))) ctx.addIssue ({ code: 'custom', message: 'Archive prefixes must not overlap: ' + backup.id });
    }
});
export type BackupDefinition = z.infer<typeof backupSchema>;
export type BackupSchedule = z.infer<typeof scheduleSchema>;
export type BackupCredential = z.infer<typeof credentialSchema>;
export type ManagedUser = z.infer<typeof userSchema>;
export type ManagementDocument = z.infer<typeof managementSchema>;
export type AccessRight = 'browse' | 'restore' | 'run';
export function allowed (user: ManagedUser, backup: string, right: AccessRight): boolean {
    return user.enabled && (user.admin || user.grants.some (grant => (grant.backup === backup || grant.backup === '*') && grant[right]));
}
export function publicUser (user: ManagedUser): Omit<ManagedUser, 'passwordHash'> {
    return { id: user.id, enabled: user.enabled, admin: user.admin, grants: user.grants };
}
export function publicCredential (credential: BackupCredential): Omit<BackupCredential, 'passphrase'> & { hasPassphrase: boolean } {
    const { passphrase, ...result } = credential;
    return { ...result, hasPassphrase: passphrase !== undefined };
}
