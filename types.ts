import type { Express } from 'express';
import type { Server } from 'node:http';
import type DBuffer from './dbuffer';
import type { DiskNode } from './dbuffer';

export interface DataConfig {
    file: string;
    restore: string;
    enable: boolean;
    borg_repo?: string;
    borg_args?: string[];
    credentialId?: string;
}
export interface ClientConfig {
    max_restore_entries_trivial: number;
    max_restore_size_trivial: number;
}
export interface Config {
    httpPort?: number;
    httpsPort?: number;
    borg_backup_log?: string;
    borg_repo?: string;
    data: DataConfig[];
    auth: Record<string, { pwd: string }>;
    max_cache_entries: number;
    max_status_entries: number;
    client_config: ClientConfig;
    hook_preroutes?: (app: Express) => void;
    hook_postroutes?: (app: Express) => void;
    hook_poststartup?: (app: Express, server: Server) => void;
}
export interface TreeEntry extends DataConfig {
    db: DBuffer;
    offset: number;
    archives: (string | null)[];
    cache: Map<string, DiskNode>;
}
export interface BrowseEntry {
    db: DBuffer;
    offset: number;
}
export interface PublicNode {
    s?: number;
    t?: number;
    l?: string;
    C?: number;
    S?: number;
    a?: number[];
    c?: Record<string, PublicNode> | null;
}
export interface ArchivePage {
    c: Record<string, PublicNode>;
    next: number | null;
}
export interface StatusEntry {
    handle: string | null;
    state: 'backup' | 'wait' | 'run' | 'done' | 'err';
    archive: string;
    short: string;
    info: string;
    tschedule: number | null;
    texecute: number | null;
    tfinish: number | null;
}
export interface RestoreInput {
    backup: string;
    archive: string;
    list: string[];
    short: string;
}
export interface RestoreJob extends StatusEntry, RestoreInput {
    handle: string;
    tschedule: number;
}
