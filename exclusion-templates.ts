import path from 'node:path';
import { readFileSync } from 'node:fs';
const providedPatterns = (name: string): string[] => readFileSync (path.resolve (__dirname, '../etc/templates', name), 'utf8').split (/\r?\n/).map (line => line.trim ()).filter (line => line !== '' && !line.startsWith ('#'));
import type { BackupDefinition } from './management-schema';
export const exclusionTemplates = [
    { id: 'provided', name: 'Your supplied base exclusions', description: 'Original borg-base.exclude patterns, including site-specific paths. Review these for each host.', patterns: providedPatterns ('provided.exclude') },
    { id: 'provided-replacement', name: 'Your supplied replacement exclusions', description: 'Original replacement patterns; includes site-specific restore paths.', patterns: providedPatterns ('provided-replacement.exclude') },
    { id: 'linux', name: 'Linux virtual filesystems and temporary files', description: 'Virtual devices, process/kernel data, temporary files, and recovery directories.', patterns: ['/dev/*', '/proc/*', '/sys/*', '/run/*', '/tmp/*', '/var/tmp/*', '*/lost+found'] },
    { id: 'caches', name: 'Rebuildable application caches', description: 'Browser, desktop, package manager, thumbnail and application caches. Review before applying.', patterns: ['/var/cache', '*/.cache', '*.cache', '*/compile-cache', '*/.thumbnails', '*/.npm/_cacache', '*/.mozilla/*/*/cache2', '*/.config/*/GPUCache', '*/.config/*/Code Cache', '*/.config/*/Cache', '*/.config/*/CacheStorage', '*/.config/*/ScriptCache', '*/.steam/steam/appcache', '*/.local/share/Trash'] },
    { id: 'trash', name: 'Trash and network recycle bins', description: 'Deleted-file storage; omit this template if you want to recover discarded files.', patterns: ['*/.Trash-*', '*/.Trash', '*/.recycle', '*/$RECYCLE.BIN'] },
    { id: 'development', name: 'Rebuildable development dependencies', description: 'Optional: excludes installed dependencies and compiler caches. Source, lockfiles, databases and virtual machines are retained.', patterns: ['*/node_modules', '*/.venv', '*/venv', '*/.gradle/caches', '*/.cargo/registry', '*/.m2/repository', '*/__pycache__'] },
    { id: 'webgui', name: 'Backup outputs and restore staging', description: 'Exclude this service’s logs, tree indexes and restore directories; local repository paths are also excluded automatically.', patterns: [] }
] as const;
export function effectiveExclusions (backup: BackupDefinition): string[] {
    const patterns = [...backup.exclusions];
    for (const id of backup.templates) {
        const template = exclusionTemplates.find (item => item.id === id);
        if (template) patterns.push (...template.patterns);
        if (id === 'webgui') patterns.push (...[path.resolve ('log'), path.resolve ('data/managed'), path.resolve (backup.restoreDirectory)].map (directory => 'pp:' + directory));
    }
    if (backup.mode === 'local' && path.isAbsolute (backup.repository)) patterns.push ('pp:' + backup.repository);
    return [...new Set (patterns)];
}
