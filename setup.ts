import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import argon2 from 'argon2';
import { ManagementStore, configurationDirectory } from './management-store';
import { readConfig } from './config';
import { userSchema } from './management-schema';

async function setup (): Promise<void> {
    const id = process.argv[2] ?? 'admin';
    if (!process.stdin.isTTY) throw Error ('Run setup from an interactive terminal');
    process.stdout.write ('New administrator password (at least 12 characters): ');
    const muted = new Writable ({ write (_chunk, _encoding, callback) { callback (); } });
    const terminal = createInterface ({ input: process.stdin, output: muted, terminal: true });
    let password: string;
    try { password = await terminal.question (''); } finally { terminal.close (); process.stdout.write ('\n'); }
    if (password.length < 12 || password.length > 1024) throw Error ('Password must contain 12–1024 characters');
    const directory = configurationDirectory ();
    await fs.mkdir (directory, { recursive: true, mode: 0o700 });
    const filename = path.join (directory, 'server.json');
    try { await fs.access (filename); }
    catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        // Keep an existing legacy deployment's listener/data settings during migration.
        let config;
        try { config = readConfig (); }
        catch { config = { httpPort: 8080, data: [], max_cache_entries: 5000, max_status_entries: 30 }; }
        await fs.writeFile (filename, JSON.stringify (config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    const store = await ManagementStore.open (directory, readConfig ());
    const user = userSchema.parse ({ id, enabled: true, admin: true, grants: [], passwordHash: await argon2.hash (password) });
    await store.update (draft => {
        if (draft.users.some (existing => existing.id === id)) throw Error ('User already exists; use the access administration page');
        draft.users.push (user);
    });
    console.log ('Administrator created. Start the server with npm start and open /admin-backups.html.');
}
void setup ().catch ((error: unknown) => { console.error (error instanceof Error ? error.message : 'Setup failed'); process.exitCode = 1; });
