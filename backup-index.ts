import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { repositoryIdentity } from './backup-repository';
import type { BackupDefinition } from './management-schema';

export function treeFile (backup: BackupDefinition): string { return path.resolve ('data/managed', backup.id + '-data-tree.bin'); }
export async function indexMatchesRepository (backup: BackupDefinition): Promise<boolean> {
    try {
        const input: unknown = JSON.parse (await fs.readFile (treeFile (backup) + '.repository.json', 'utf8'));
        if (typeof input !== 'object' || input === null || !('repository' in input) || input.repository !== repositoryIdentity (backup.repository)) return false;
        await fs.access (treeFile (backup)); return true;
    } catch (error) {
        if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false;
        throw error;
    }
}
export async function recordIndexRepository (backup: BackupDefinition): Promise<void> {
    const filename = treeFile (backup) + '.repository.json';
    const temporary = filename + '.' + randomUUID () + '.tmp';
    try {
        await fs.writeFile (temporary, JSON.stringify ({ version: 1, repository: repositoryIdentity (backup.repository) }) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename (temporary, filename);
    } finally { await fs.rm (temporary, { force: true }); }
}
