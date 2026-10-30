import path from 'node:path';
import { createHash } from 'node:crypto';

/** Borg SSH addresses stay intact; filesystem paths are anchored to the service cwd. */
export function normalizeRepository (repository: string): string {
    if (repository.startsWith ('ssh://') || (!repository.startsWith ('/') && !repository.startsWith ('./') && !repository.startsWith ('../') && /^[^/]+:/.test (repository))) return repository;
    return path.resolve (repository);
}
export function repositoryIdentity (repository: string): string {
    return createHash ('sha256').update (normalizeRepository (repository)).digest ('hex');
}
