import type { FileHandle } from 'node:fs/promises';

/** On-disk children are references, not recursively loaded nodes. */
export interface DiskNode {
    a: number[];
    o: number;
    s?: number;
    t?: number;
    l?: string;
    C?: number;
    S?: number;
    c?: Record<string, { o: number }>;
}
export interface SnapshotNode {
    s?: number;
    t?: number;
    l?: string;
    C?: number;
    S?: number;
    c?: null;
    index?: number;
    names?: number;
    runs?: number;
}

declare class DBuffer {
    constructor (file: FileHandle, initialPosition?: number, cacheSize?: number);
    version: number;
    close (): Promise<void>;
    read_header (): Promise<number | null | undefined>;
    read_archives (offset: number): Promise<(string | null)[]>;
    read_tree (offset: number): Promise<DiskNode>;
    read_snapshot (offset: number): Promise<SnapshotNode>;
    find_snapshot_child (offset: number, name: string): Promise<number | undefined>;
    read_snapshot_page (offset: number, archive: number, cursor?: number, limit?: number): Promise<{
        entries: [string, number][];
        next: number | null;
    }>;
}
export default DBuffer;
