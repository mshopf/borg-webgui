# Scheduled backup management

The TypeScript server now runs the backup workflow alongside restore browsing. It
supports Borg **1.x** (matching the supplied scripts), OpenSSH, and Linux/Unix
socket forwarding. It does not run backups while you configure or test this
checkout: a definition must be enabled for its schedule, or explicitly run.

## Setup and configuration

```sh
npm ci
npm run build
npm run setup -- admin
npm start
```

`setup` reads a new administrator password from an interactive terminal without
echoing it, writes only an Argon2 hash, and creates `etc/server.json` if necessary.
It refuses to replace an existing user. With an existing `config.js`, its server
and restore settings are preserved when writing JSON. Existing JavaScript hooks
cannot be serialized into JSON; keep the legacy entry configuration if you need
those hooks, or migrate their behavior into a server extension.

The primary files, relative to the server's working directory, are:

| File | Purpose |
| --- | --- |
| `etc/server.json` | Ports, legacy restore trees, cache limits and client confirmation thresholds |
| `etc/management.json` | Backup definitions, schedules, users, grants and repository/SSH credentials |
| `var/backup-state.json` | Scheduled-time claims and the last 500 run records |
| `log/backups/RUN_ID.log` | Detailed Borg/SSH output and JSON statistics, with configured passphrases redacted |
| `data/managed/ID-data-tree.bin` | Automatically generated restore index |

Configuration and state files are written as mode `0600`; newly created private
directories use `0700`. Management saves are serialized, validated, and replaced
atomically. Stale edits receive a conflict response instead of silently losing
another administrator's change. Keep these files with your server's persistent
data. Credentials are plaintext secrets in this private JSON file; they are never
returned by the administration API. Back up the configuration securely.

Set `BORG_WEBGUI_CONFIG_DIR` to use another directory for `server.json` and
`management.json`. The working directory still determines `var`, `log`, `data` and
relative restore paths. Run **one server instance per working directory**.

`etc/server.example.json` is a minimal server configuration. The server prefers
`etc/server.json`; `config.js` remains a compatibility fallback. On first start,
legacy user hashes are imported into `management.json`. The account named `admin`
is made an administrator; if it does not exist, the first legacy account is made
an administrator. Other legacy accounts retain browsing/restoring access to all
backups and gain no backup-run permissions. After import, user changes belong in
the access page, not the legacy authentication object. Invalid JSON or an invalid
management document stops startup instead of resetting permissions.

Use HTTPS for deployments that are accessed over a network: the existing HTTP
Basic authentication sends the browser's credentials on authenticated requests.
The status endpoint, backup listings, and logs now require authentication and are
filtered by permissions. Legacy extensions that accessed status anonymously must
send credentials.

## Backup administration

Open **Manage backups** from the main page (`/admin-backups.html`). Add a stable ID
such as `host-root`, repository, one or more absolute source paths, and a timezone.
The ID is also the archive prefix and restore-tree name. IDs cannot be renamed;
create a new definition if the prefix must change. Managed prefixes cannot
contain glob characters or overlap another managed prefix. Use distinct prefixes
for other writers sharing a repository as well.

Definitions start with scheduling disabled. Use **Run now** to test a definition
before enabling it. Repository initialization is a separate action and requires
a stored passphrase; new repositories use `repokey-blake2` encryption. Existing
repositories, including ones with another encryption mode, are used without
reinitialization. Repository keys must be exported and kept separately according
to your Borg recovery procedures.

The local/active workflow replaces `borg.sh`:

1. Create an archive named `ID-YYYY-MM-DD-hhmmss` (timestamp in UTC).
2. Use lz4 by default, no atime/BSD-flag recording, numeric ownership, one filesystem
   per source, and cache-tag exclusions. Compression and filesystem/cache options
   are editable. Source paths are passed as arguments, not interpolated shell code.
3. For exit codes 0 or 1, prune only `ID-*`, defaulting to 14 daily, 8 weekly, 24
   monthly and 10 yearly archives. A failed create skips pruning and indexing.
4. Optionally compact on the server to reclaim repository space. Compaction starts
   disabled, as it was absent from the supplied scripts.
5. Refresh the binary restore tree through `tree.js -c -a`; newly indexed backups
   appear in both restore views. Index failure makes the run fail even if the
   archive itself was created successfully. Logs distinguish these stages.

Local mode reads the filesystem on the server, or a filesystem already mounted
there. A local mode repository may be an absolute/relative path or a Borg SSH
repository address. A repository's SSH host key must already be trusted by the
service account. Repository initialization is never automatic during a backup.

Detailed output and Borg statistics are kept in the web-readable run log instead
of the scripts' bzip2/Perl master-log pipeline. The run journal supplies structured
status, queue/start/finish times and exit codes. Exit code 1 is shown as a warning;
failures do not block subsequent queued backups. Backup runs are serialized and
Borg commands also use `--lock-wait 60` to coordinate with restores or external
Borg clients. Completed logs are retained even after their run records age out;
use an external retention policy for old log files.

## Remote/pull mode

Pull mode replaces `borgpull.sh` and the remote `borg.sh` invocation with
server-managed Borg commands. The source host needs:

- Borg 1.x and `socat` in the remote account's PATH;
- SSH key authentication from the server and permission to read the source paths;
- an SSH daemon that permits remote Unix-domain socket forwarding;
- sufficient remote Borg cache/config space and any required repository key.

The service creates a unique private local Unix socket. Each accepted connection
runs `borg serve --append-only --restrict-to-repository ABSOLUTE_REPOSITORY`.
OpenSSH forwards a unique remote socket to it using `-R`. On the source host,
Borg runs with a `BORG_RSH` command that connects to that socket through `socat`.
The repository path must be absolute on the server. `backupall.sh` and a separate
local `socat` daemon are no longer needed.

The command and optional repository passphrase go through SSH stdin. The
passphrase is absent from SSH process arguments and API responses. SSH is
noninteractive (`BatchMode`, strict existing host-key behavior) and fails if
forwarding cannot be established. Known-host entries and private-key files are
managed by the service account; an SSH agent can unlock encrypted identity files.
The credential's identity-file path selects the key for this SSH connection.

After the remote create finishes, the socket server and its child processes are
closed and local socket files are removed. Prune and optional compact then run
locally with the stored repository credential. Cancellation, timeout, and server
shutdown terminate the active process group. A remote trap removes its forwarded
socket on ordinary exit; a host crash or forced remote termination may leave a
uniquely named `/tmp/borg-webgui-UUID.sock` to clean up on that source host.
Append-only is Borg's storage-level behavior, not a replacement for trusting the
source account or protecting repository credentials.

See [Borg's pull-backup documentation](https://borgbackup.readthedocs.io/en/stable/deployment/pull-backup.html)
and [repository-server restrictions](https://borgbackup.readthedocs.io/en/stable/usage/serve.html).

## Scheduling and restart behavior

Each definition contains a frequency (`daily`, selected weekdays, or selected
month days), one or more exact 24-hour `HH:MM` times, and an IANA timezone. The
initial time is `03:00` in the server's timezone. The UI displays the next run in
the viewer's local timezone. Weekly day numbers are Monday=1 through Sunday=7.
Month days that do not exist in a particular month are skipped.

The scheduler checks every ten seconds. It persists each minute's claim before
queuing the run, so a normal process restart in that minute does not repeat it.
Repeated DST wall-clock times run once at their first occurrence; missing times
are skipped. Slots missed while the server is down, or while the same definition
is still running past that slot's minute, are skipped. There is no automatic
catch-up burst or automatic retry; use Run now after inspecting a failure.

A run snapshots its definition and credential when queued. Another run of the
same definition is rejected until the queued/running operation finishes or is
cancelled. Different backups queue behind each other. The per-backup timeout
starts when execution begins. On restart, formerly queued/running entries become
`interrupted`; inspect the repository before retrying. The service does not break
Borg locks or assume that an interrupted archive is complete.

Removing a definition never deletes repository archives, restored data or its
existing index file. It removes the managed restore listing and its specific
user grants. Removing a credential in use is rejected. The final enabled
administrator cannot be removed or disabled.

## Users, credentials and exclusion helpers

Open `/admin-access.html` to add/edit/remove users and repository credentials.
New web passwords require at least twelve characters. A blank password or
passphrase field retains an existing secret; a separate checkbox explicitly
removes a stored repository passphrase. The browser clears secret fields after a
successful save. All management writes require JSON, a same-origin check and a
custom header. Revision numbers protect concurrent configuration edits.

Administrators can configure sources, repositories, credentials and arbitrary
absolute paths available to the service account. This is a trusted operator role.
Other accounts receive independent per-backup grants:

| Permission | Allows |
| --- | --- |
| Browse | Read backup names, directory listings and the restore tree |
| Restore | Request extraction and read that backup's live restore logs |
| Run | Start/cancel backup runs and read their run records/logs |
| Administrator | All backup permissions plus configuration and user administration |

A grant for `*` includes future backups. Web permissions do not change filesystem
permissions on restored data. Historic restore logs without an in-memory ownership
record are available only to administrators after a restart. Backup-run ownership
is saved in the run journal and remains enforceable across restarts.

Exclusion templates cover Linux virtual filesystems/temp directories, rebuildable
application caches, trash/recycle bins, optional development dependencies, and the
service's own backup/restore outputs. The original supplied base and replacement
exclude lists are also available as optional templates, including their
site-specific paths. **Preview combined exclusions** shows the final patterns.
A local repository path is always excluded from a local source backup to prevent
backing a repository up into itself. Templates are not exhaustive: databases,
virtual machines and application state may need their own quiescing/snapshot
workflow. Development dependencies are not excluded by default.

## Validation

`npm run check` runs native TypeScript 7 checking, typed ESLint, and regression
tests. Tests use temporary directories, fake Borg/SSH executables, a real local
socket relay, HTTP permission checks and DOM admin forms. They do not access or
modify a production repository. Real deployments still need an end-to-end trial
with their installed Borg/OpenSSH versions and source-host permissions.
