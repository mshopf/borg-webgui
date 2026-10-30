import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Config, DataConfig } from './types';

function object (value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray (value)) throw Error (label + ' must be an object');
    return value as Record<string, unknown>;
}
function string (value: unknown, label: string): string {
    if (typeof value !== 'string') throw Error (label + ' must be a string');
    return value;
}
function optionalString (value: unknown, label: string): string | undefined {
    return value === undefined ? undefined : string (value, label);
}
function number (value: unknown, label: string, fallback?: number): number {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger (value) || value < 0) throw Error (label + ' must be a nonnegative integer');
    return value;
}
function port (value: unknown, label: string): number | undefined {
    if (value === undefined) return undefined;
    const result = number (value, label);
    if (result > 65535) throw Error (label + ' must be at most 65535');
    return result;
}
function hook<T extends (...args: never[]) => void> (value: unknown, label: string): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'function') throw Error (label + ' must be a function');
    return value as T;
}

/** config.js remains an executable object expression, including existing hooks. */
export function parseConfig (source: string): Config {
    const input: unknown = eval ('(' + source + ')');
    return parseConfigValue (input);
}
export function parseConfigValue (input: unknown): Config {
    const value = object (input, 'config');
    if (!Array.isArray (value.data)) throw Error ('config.data must be an array');
    const data: DataConfig[] = value.data.map ((item: unknown) => {
        const entry = object (item, 'config.data entry');
        if (entry.enable !== undefined && typeof entry.enable !== 'boolean') throw Error ('enable must be a boolean');
        if (entry.borg_args !== undefined && (!Array.isArray (entry.borg_args) || !entry.borg_args.every ((arg: unknown) => typeof arg === 'string'))) throw Error ('borg_args must be a string array');
        return {
            file: string (entry.file, 'file'), restore: string (entry.restore, 'restore'), enable: entry.enable === true,
            borg_repo: optionalString (entry.borg_repo, 'borg_repo'),
            borg_args: entry.borg_args
        };
    });
    const auth: Config['auth'] = {};
    for (const [name, user] of Object.entries (object (value.auth ?? {}, 'auth'))) {
        auth[name] = { pwd: string (object (user, 'auth user').pwd, 'pwd') };
    }
    const client = object (value.client_config ?? {}, 'client_config');
    return {
        httpPort: port (value.httpPort, 'httpPort'), httpsPort: port (value.httpsPort, 'httpsPort'),
        borg_repo: optionalString (value.borg_repo, 'borg_repo'),
        borg_backup_log: optionalString (value.borg_backup_log, 'borg_backup_log'),
        data, auth,
        max_cache_entries: number (value.max_cache_entries, 'max_cache_entries', 5000),
        max_status_entries: number (value.max_status_entries, 'max_status_entries', 30),
        client_config: {
            max_restore_entries_trivial: number (client.max_restore_entries_trivial, 'max_restore_entries_trivial', 1000),
            max_restore_size_trivial: number (client.max_restore_size_trivial, 'max_restore_size_trivial', 100 * 1024 * 1024)
        },
        hook_preroutes: hook (value.hook_preroutes, 'hook_preroutes'),
        hook_postroutes: hook (value.hook_postroutes, 'hook_postroutes'),
        hook_poststartup: hook (value.hook_poststartup, 'hook_poststartup')
    };
}
export function configurationFile (): string {
    const json = path.resolve (process.env.BORG_WEBGUI_CONFIG_DIR ?? './etc', 'server.json');
    return existsSync (json) ? json : path.resolve ('config.js');
}
export function readConfig (): Config {
    const filename = configurationFile ();
    if (filename.endsWith ('.json')) {
        const value: unknown = JSON.parse (readFileSync (filename, 'utf8'));
        return parseConfigValue (value);
    }
    return parseConfig (readFileSync (filename, 'utf8'));
}
