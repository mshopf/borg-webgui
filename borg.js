const cp = require ('child_process');
const path = require ('path');

const DATE = '\\d{4}-\\d{2}-\\d{2}-\\d{6}';
const archiveKey = new RegExp ('^(' + DATE + ')@([a-f0-9]{64})$');
const archiveIdSuffix = new RegExp ('(?:^|-)' + DATE + '@([a-f0-9]{64})$');
const datedName = new RegExp ('(?:^|-)(' + DATE + ')$');

// Borg 1 locations remain the configuration format for both versions. In
// particular, ssh://host/path is absolute in Borg 1, but relative in Borg 2.
function repository (repo, major) {
    if (typeof repo !== 'string' || repo.length === 0) {
        throw Error ('borg_repo must be a nonempty repository location');
    }
    const scp = !repo.includes ('://') && repo.match (/^((?:[^/@:\s]+@)?(?:\[[^\]]+\]|[^/:\s]+)):(.*)$/);
    if (!repo.includes ('://') && !scp) return path.resolve (repo);
    if (major === 1) return repo;
    if (scp) {
        const remote = scp[2];
        repo = 'ssh://' + scp[1] + (remote.startsWith ('/') ? remote :
            remote.startsWith ('~') ? '/' + remote : '/./' + remote);
    }
    return repo.replace (/^(ssh:\/\/[^/]+)(\/.*)?$/, (_, host, path = '/') => {
        if (/^\/(?:\.\/|~\/)/.test (path)) return host + '/' + path.slice (3);
        if (path.startsWith ('/~')) {
            throw Error ('Borg 2 cannot resolve another user\'s home in borg_repo; use an absolute SSH path');
        }
        return host + (path.startsWith ('//') ? path : '/' + path);
    });
}

function parseTime (value) {
    // Borg 1's ISO times have no zone; Borg 2 includes an offset. Preserve
    // explicit offsets and treat old dumps as UTC, as before.
    return Date.parse (/[zZ]$|[+-]\d{2}:\d{2}$/.test (value) ? value : value + 'Z');
}

class Borg {
    constructor (version) {
        const match = version.trim().match (/^borg(?:backup)?\s+([12])\.\d+[^\s]*$/);
        if (!match) throw Error ('Unsupported Borg version: ' + version.trim());
        this.major = Number (match[1]);
        this.version = version.trim();
    }

    static detect () {
        try {
            return new Borg (cp.execFileSync ('borg', ['--version'], {
                encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
            }));
        } catch (error) {
            throw Error ('Cannot detect Borg version using borg --version: ' + error.message);
        }
    }

    repoArgs (repo) {
        return ['--repo', repository (repo, this.major)];
    }

    archivesArgs (repo) {
        return this.major === 1 ? ['list', '--json', repository (repo, 1)] :
            [...this.repoArgs (repo), 'repo-list', '--json'];
    }

    listArgs (repo, archive) {
        const match = archive.match (archiveIdSuffix);
        if (match) {
            if (this.major !== 2) throw Error ('Borg 2 archive IDs require Borg 2; rebuild this tree for Borg 1');
            archive = 'aid:' + match[1];
        }
        const options = ['--format', '{type} {path} {size} {isomtime}', '--json-lines'];
        return this.major === 1 ? ['list', ...options, repository (repo, 1) + '::' + archive] :
            [...this.repoArgs (repo), 'list', ...options, '--', archive];
    }

    extractArgs (repo, backup, key, patterns, extra = []) {
        const match = key.match (archiveKey);
        if (match && this.major !== 2) throw Error ('Borg 2 archive IDs require Borg 2; rebuild this tree for Borg 1');
        const archive = match ? 'aid:' + match[2] : backup + '-' + key;
        const options = ['--list', ...extra, '--patterns-from', patterns];
        return this.major === 1 ? ['extract', ...options, repository (repo, 1) + '::' + archive] :
            [...this.repoArgs (repo), 'extract', ...options, '--', archive];
    }

    archiveEntries (json, filter) {
        if (!Array.isArray (json.archives)) throw Error ('Invalid Borg archive listing: missing archives array');
        const entries = Object.create (null);
        for (const archive of json.archives) {
            if (typeof archive.name !== 'string') throw Error ('Invalid Borg archive name');
            if (!filter.test (archive.name)) continue;
            const dated = archive.name.match (datedName);
            let date = dated?.[1];
            let target = archive.name;
            if (this.major === 2) {
                if (!/^[a-f0-9]{64}$/.test (archive.id)) throw Error ('Invalid Borg archive ID for ' + archive.name);
                if (!date) {
                    const time = parseTime (archive.time);
                    if (!Number.isFinite (time)) throw Error ('Invalid Borg archive time for ' + archive.name);
                    date = new Date (time).toISOString().slice (0, 19).replace ('T', '-').replaceAll (':', '');
                }
                target = 'aid:' + archive.id;
                date += '@' + archive.id;
            } else if (!date) {
                console.error ('unknown archive naming scheme ' + archive.name);
                continue;
            }
            if (entries[date] !== undefined) throw Error ('Multiple archives have the same timestamp: ' + date);
            entries[date] = target;
        }
        return entries;
    }

    start (args, options = {}) {
        const child = cp.spawn ('borg', args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
        // Resolve errors as values so a fast failure cannot cause an unhandled
        // rejection while the caller is still consuming stdout.
        const completion = new Promise (resolve => {
            child.once ('error', error => resolve ({ error }));
            child.once ('close', (code, signal) => resolve ({ code, signal }));
        });
        return { child, completion };
    }

    static check (result) {
        if (result.error) throw result.error;
        if (result.code !== 0 || result.signal) {
            throw Error (`Borg exited with code ${result.code}, signal ${result.signal}`);
        }
    }

    async capture (args) {
        const { child, completion } = this.start (args);
        const chunks = [];
        for await (const chunk of child.stdout) chunks.push (chunk);
        Borg.check (await completion);
        return Buffer.concat (chunks).toString ('utf8');
    }
}

module.exports = { Borg, repository, parseTime };
