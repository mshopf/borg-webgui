# Security, configuration, and correctness review

Reviewed on 2026-11-18, on local branch `temp/security-review-2026-11-18`.

## Scope and integration record

Base: `origin/main`, commit `427b42f74d9f4eeeb479a4ccae0b7794567618ef`.
Reviewed integration commit: `3780b5e4b4fe1e769bc305d37fca49405456775a`.
All five open PR heads are ancestors of this integration commit:

| PR | Change | Reviewed head |
| --- | --- | --- |
| [#1](https://github.com/mshopf/borg-webgui/pull/1) | Borg 1/2 compatibility | `10558103907c771b1c0b80b50cac61d483a5f7f1` |
| [#2](https://github.com/mshopf/borg-webgui/pull/2) | Indexed backup-first browsing | `b04151418f1dcf6dae9ad79c8ddb13c61ca32267` |
| [#3](https://github.com/mshopf/borg-webgui/pull/3) | TypeScript server migration | `694f693c93c75f4716205412a533f291c970d7a8` |
| [#4](https://github.com/mshopf/borg-webgui/pull/4) | Scheduled backups and access management | `e08521e5b578dc3adb87d55588803ec07b68be1b` |
| [#5](https://github.com/mshopf/borg-webgui/pull/5) | Dependency audit fixes | `95413ecf518786914561e061a54ea90424fa3062` |

Merged locally in PR-number order, using separate merge commits. No PR was merged or closed on GitHub, and nothing was pushed. Conflicts occurred in the server entry point, listing tests, README, and indexing CLI. Resolution retained the TypeScript server entry shim from #3, both listing test cases, the newer management documentation, and the CLI's Borg adapter together with the management repository override and list lock-wait option. The server-side Borg implementation from #1 was not ported into TypeScript: that is an integration defect explicitly reported as G02, not silently repaired during review.

Application code was not edited after the integration commit. This report is the only subsequent workspace change. Recommendations below have **not** been implemented.

Reviewed the server, authentication/authorization and mutation protection, management schemas/storage/API, backup execution/process handling, scheduling, indexing/binary reader, browser clients, setup/configuration, dependency manifest/lockfile, CI, and tests. Temporary reproductions used disposable configurations, fake subprocesses, and a disposable real Borg 1 repository; no production repository was accessed.

Findings are ordered as requested: **user/operator errors first, security second, general correctness third**, with descending severity within each category. “User/operator error” means a hazardous deployment or configuration choice, including documented behavior; it does not mean an attacker can exploit every installation. No unconditional critical vulnerability was established. High findings include significant data-loss, privilege, and service-availability risks under the stated conditions.

## 1. User/operator errors and configuration hazards

### U01 — High: copying the example installs a public administrator password

**Evidence:** [config_example.js](/root/borg-webgui/config_example.js:9), [management-store.ts](/root/borg-webgui/management-store.ts:25), [setup.ts](/root/borg-webgui/setup.ts:23).

The example contains the working `admin:admin` Argon2 hash. On first startup it is imported as a fully privileged administrator. The README still instructs users to copy this example. Running setup afterward does not replace it: setup refuses an existing account. Management administrators can select arbitrary readable sources and repository destinations, so this exposes considerably more than restore browsing.

**Trigger/impact:** deploy the copied configuration without replacing its hash, or assume setup rotated it. Anyone who reaches the service can administer backups and access management.

**Recommendation:** remove usable credentials from the example, require explicit first-admin creation, and fail startup on the known sample hash. Existing deployments must rotate it through the access page or a deliberate recovery procedure.

### U02 — High: default setup exposes Basic authentication over plain HTTP

**Evidence:** [config.ts](/root/borg-webgui/config.ts:98), [etc/server.example.json](/root/borg-webgui/etc/server.example.json:2), [server.ts](/root/borg-webgui/server.ts:493), [access-control.ts](/root/borg-webgui/access-control.ts:11).

New setup defaults to HTTP port 8080. The listener supplies no host argument, so it binds to the available interfaces rather than only loopback. HTTP Basic credentials, configuration writes, and repository passphrases entered in the admin form then cross the network without transport encryption unless an external TLS boundary protects them. The management guide advises HTTPS, but setup does not enforce or prominently surface this requirement.

**Recommendation:** bind the backend to loopback/configurable interfaces by default and require a deliberate decision for network HTTP exposure. Configure TLS before entering credentials. TLS termination also needs the origin handling correction described in G09.

### U03 — High: overlapping unmanaged archive prefixes can cause unintended pruning

**Evidence:** [management-schema.ts](/root/borg-webgui/management-schema.ts:75), [management-api.ts](/root/borg-webgui/management-api.ts:63), [backup-engine.ts](/root/borg-webgui/backup-engine.ts:21).

The overlap check covers managed definitions only. The API rejects an *equal* legacy ID, but accepts managed `host` beside legacy `host-root`. With a shared repository, `--glob-archives host-*` includes `host-root-*`. Retention is enabled by default and runs even after a warning-level create. An administrator can consequently prune another backup set while believing the definition owns only its own archives. External writers are similarly outside validation. This is documented as an operator responsibility, but the legacy collision is already knowable to the application.

**Validation:** the schema accepts managed `host`; API source only tests `legacyIds().includes(id)`. [Borg prune documentation](https://borgbackup.readthedocs.io/en/stable/usage/prune.html) confirms the glob limits the deletion candidate set.

**Recommendation:** reject prefix overlaps with legacy definitions too, and require explicit archive ownership review before enabling retention on an existing repository.

### U04 — Medium: JSON migration silently drops executable hooks and changes the active configuration source

**Evidence:** [config.ts](/root/borg-webgui/config.ts:73), [config.ts](/root/borg-webgui/config.ts:86), [setup.ts](/root/borg-webgui/setup.ts:20).

Setup serializes the legacy configuration with `JSON.stringify`, which omits hook functions, then the new JSON file takes precedence over the JavaScript configuration. Hook-provided access restrictions, reverse-proxy settings, or extension behavior disappear on restart. The guide acknowledges this limitation, but the migration itself does not warn or refuse hooked configurations. Merely keeping the old file does not preserve its behavior while the generated JSON exists.

**Recommendation:** detect functions before migration and require explicit migration handling. Clearly identify the effective file and the separate management user store. Verify hook-dependent controls before switching the service to JSON.

### U05 — Medium: default exclusion and filesystem options can omit wanted data

**Evidence:** [management-schema.ts](/root/borg-webgui/management-schema.ts:27), [exclusion-templates.ts](/root/borg-webgui/exclusion-templates.ts:8), [backup-engine.ts](/root/borg-webgui/backup-engine.ts:15).

Definitions default to one filesystem per source, honoring cache tags, and excluding cache/trash locations. Backing up `/` does not automatically cover separately mounted `/home` or application data. Broad patterns such as `*.cache`, or a misplaced `CACHEDIR.TAG`, can exclude valuable contents. These are intentional defaults, not proof of a broken Borg implementation, but a successful run can be an incomplete recovery set if the operator assumes “all files.”

**Recommendation:** inventory mount points, list each intended source, inspect effective patterns and cache tags, and perform a restore trial. Show these omissions clearly when enabling a definition rather than relying only on the successful run state.

## 2. Security issues

### S01 — High: restore pattern files permit local symlink clobbering

**Evidence:** [server.ts](/root/borg-webgui/server.ts:317), [server.ts](/root/borg-webgui/server.ts:364), [server.ts](/root/borg-webgui/server.ts:372).

Restore handles are exposed when requests are queued. The worker later opens `/tmp/borg-restore-HANDLE.patterns` using `w`, follows an existing symlink, and truncates its target with the service account's privileges. The filename is not inside a private per-request directory, and the file is created as `0644`. The safer exclusive-create implementation in #1 was lost when the TypeScript server replaced the old server file.

**Reproduced:** blocked one disposable restore, queued another, obtained its handle, planted its pattern path as a symlink to a disposable victim, and released the first restore. The victim's `ORIGINAL CONTENT` became `+pf:file\n!*\n`. No guessing was necessary. Exploitation requires local filesystem access plus knowledge of a queued handle; a local user with restore access meets those conditions. Root service execution would increase the impact. On systems enforcing protected-symlink rules, a different-UID attack may be blocked; same-UID access or other configurations remain relevant.

**Recommendation:** use a private `mkdtemp` directory, exclusive creation with mode `0600`, and a stronger handle. Do not follow preexisting paths in shared temporary storage.

### S02 — High: upgrade automatically promotes an ordinary legacy user to administrator

**Evidence:** [management-store.ts](/root/borg-webgui/management-store.ts:25), [management-api.ts](/root/borg-webgui/management-api.ts:51).

When importing legacy authentication, the user named `admin` becomes an administrator; if none exists, the first user becomes one. Legacy users previously needed only restore/browse trust. They now gain user administration and the ability to back up arbitrary service-readable files to administrator-selected destinations. The `admin` name or object order is not evidence that the person should receive this stronger role.

**Reproduced:** opening a new management store with only legacy account `reader` imports it with `admin: true`. This behavior is documented, but remains an automatic privilege expansion during upgrade.

**Recommendation:** explicitly provision or designate the first administrator, with a local recovery path, and import all other legacy accounts without administrative privileges.

### S03 — Medium: authentication has no application-level rate or concurrency limits

**Evidence:** [access-control.ts](/root/borg-webgui/access-control.ts:10), [server.ts](/root/borg-webgui/server.ts:240).

Every request for an enabled username invokes Argon2, including failed logins and status polling. There is no request throttling, failure backoff, or bound on queued verification work. An unauthenticated client knowing a username can repeatedly consume expensive verification capacity and attempt passwords. Legitimate users also repeat verification on every API poll. The sample username is public.

**Validation:** source-confirmed; no load attack was run. A reverse proxy may mitigate this in a particular deployment, but none is configured by the project.

**Recommendation:** bound verification concurrency and request rates, throttle failures by account and source, and consider a suitably protected session after initial authentication.

### S04 — Medium: restore permission permits unbounded work with no cancellation or timeout

**Evidence:** [server.ts](/root/borg-webgui/server.ts:290), [server.ts](/root/borg-webgui/server.ts:325), [server.ts](/root/borg-webgui/server.ts:423), [server.ts](/root/borg-webgui/server.ts:514).

Restore requests have no queue bound, disk quota, server-side work budget, or execution deadline. Client confirmation thresholds are usability settings, not server enforcement. A user with restore permission can enqueue repeated large restores, or one stuck Borg process can block all later restores. Unlike scheduled backups, restores have no cancellation endpoint or process-group cleanup. Shutdown stops the backup service but neither waits for nor explicitly terminates the active restore child before exiting.

**Impact:** disk/resource exhaustion, indefinitely stalled restores, and potentially an orphaned extraction after shutdown. This is a containment gap for deployments granting restore rights to less-trusted users, not a bypass of backup authorization.

**Recommendation:** cap queued work per user and globally, add deadlines/cancellation and process cleanup, and enforce an operator-defined staging-space policy.

### S05 — Medium: administration pages lack application-level framing protection

**Evidence:** [server.ts](/root/borg-webgui/server.ts:228), [public/admin-backups.html](/root/borg-webgui/public/admin-backups.html:1), [public/admin-access.html](/root/borg-webgui/public/admin-access.html:1).

The application supplies neither `Content-Security-Policy: frame-ancestors` nor `X-Frame-Options`. A hostile page can frame the administration interface and attempt to trick an already authenticated operator into clicking controls. JSON/custom-header mutation protection does not prevent this: the framed application's own scripts make same-origin requests with the required header. Browser credential handling and any proxy-provided headers affect exploitability; no browser exploit was executed.

**Recommendation:** disallow framing with `frame-ancestors 'none'` or a deliberate allowlist, with a suitable fallback header where needed. Treat this separately from CSRF validation.

## 3. General correctness and consistency issues

### G01 — High: backup-log trimming can discard active jobs and permanently spin the restore queue

**Evidence:** [server.ts](/root/borg-webgui/server.ts:109), [server.ts](/root/borg-webgui/server.ts:118), [server.ts](/root/borg-webgui/server.ts:331).

Backup-log lines and restore jobs share `queue`. Log processing truncates it indiscriminately to `max_status_entries`, including queued/running jobs, but does not adjust `queue_active`. Once discarded jobs are the only outstanding work, `run_queue` repeatedly scans the remaining entries without encountering an `await`. The count never reaches zero and the event loop spins indefinitely.

**Reproduced:** with a watched backup log and `max_status_entries: 1`, blocked the first restore, queued a second, then appended a log line. Status contained only that line. Releasing the active restore produced its finish marker, then `/api/status` timed out; the disposable server required `SIGKILL`. Normal settings can hit the same condition with sufficient queued work/log entries.

**Recommendation:** separate active work from bounded history, never evict active jobs, and derive worker progress from actual pending work rather than an independent counter.

### G02 — High: the combined application does not deliver its advertised Borg 2 server support

**Evidence:** [server.js](/root/borg-webgui/server.js:1), [server.ts](/root/borg-webgui/server.ts:416), [backup-engine.ts](/root/borg-webgui/backup-engine.ts:15), [backup-engine.ts](/root/borg-webgui/backup-engine.ts:98), [borg.js](/root/borg-webgui/borg.js:74).

The active entry point loads the TypeScript output. That implementation does not detect Borg's version or use the adapter. It builds Borg 1 `repo::archive` extract commands and reuses the timestamp directory. Indexing does use #1's adapter and emits `timestamp@id` Borg 2 keys, so browsing can succeed while extraction fails. Managed create/init/prune/compact commands also use Borg 1 syntax/options. README claims automatic server detection and separate empty Borg 2 restore directories, while the management guide says backups support Borg 1 only.

**Reproduced:** after correcting the *disposable* fixture's numeric port, indexed a Borg 2 snapshot successfully. Its restore finished `err`, exit code 1; the recorded argument ended in `repo::backup-2026-10-29-123456@aaaaaaaa…`, rather than using the adapter's separate repository and immutable-ID selector.

**Recommendation:** explicitly reconcile the adapter with the TypeScript runtime and management workflow, or reject unsupported operations and narrow the documentation. This requires implementation work, not just accepting a textual merge.

### G03 — High: ordinary prototype-named files break indexing

**Evidence:** [tree.js](/root/borg-webgui/tree.js:285), [tree.js](/root/borg-webgui/tree.js:361), [dbuffer.js](/root/borg-webgui/dbuffer.js:575).

File dictionaries use `{}` and direct property reads. Valid filenames `constructor`, `toString`, and `__proto__` resolve to inherited properties instead of being treated as new files. The code expects an existing node's archive array, then fails. Assignment of `__proto__` additionally changes the dictionary's prototype. The server's null-prototype backup dictionary does not address these separate structures.

**Reproduced:** an ordinary JSON listing containing those filenames plus `normal` failed `tree.js -c -m` with per-file archive-array errors and a final exception in `consolidate_dirs`, exit 1. No malicious JSON structure was required. Source-host users can also cause this by creating such files.

**Recommendation:** use null-prototype dictionaries or maps throughout indexing/reading, own-property checks, and tests covering valid prototype-shaped filenames in every indexing mode.

### G04 — Medium: trailing whitespace can restore a different file; newline names are rejected

**Evidence:** [server.ts](/root/borg-webgui/server.ts:294), [server.ts](/root/borg-webgui/server.ts:379).

Selected paths are written verbatim into a line-based Borg pattern file. Borg trims pattern-line whitespace, so a selected filename ending in a space can match the corresponding filename without that space. Paths containing CR/LF are rejected by the API, although the index/browser can contain them. The rejection prevents pattern injection, but these valid filesystem names cannot currently be restored through the GUI.

**Reproduced with real Borg 1.4.5:** archived both `source/file` and `source/file `, then used the generated-style `+pf:source/file ` rule. Extraction produced `source/file`, not `source/file `, with a warning return code. This is incorrect file selection, not merely a display problem. [Borg pattern documentation](https://borgbackup.readthedocs.io/en/stable/usage/help.html#borg-help-patterns) describes line-based pattern behavior.

**Recommendation:** encode selections without lossy line parsing, or explicitly detect unsupported paths and explain them before submission. Preserve injection protection.

### G05 — Medium: long valid symlink targets make directories unreadable in files-first browsing

**Evidence:** [dbuffer.js](/root/borg-webgui/dbuffer.js:5), [dbuffer.js](/root/borg-webgui/dbuffer.js:401), [dbuffer.js](/root/borg-webgui/dbuffer.js:559), [archive-browse.ts](/root/borg-webgui/archive-browse.ts:80).

The reader assumes short strings using a 256-byte path allowance and fixed prefetch sizes, while indexing accepts longer symlink targets. `read_string` throws instead of fetching the complete target. A files-first directory listing reads every child's metadata, so one such link can fail the entire directory request.

**Reproduced:** indexed a symlink with a 1,024-character target successfully; reading its node with the default DBuffer failed `string not completely in cache`.

**Recommendation:** read length-prefixed strings according to their actual bounded length, and reserve/write enough space using byte lengths rather than a filename-size assumption.

### G06 — Medium: archive-list prefetch imposes an unexpected 3,957-entry limit

**Evidence:** [dbuffer.js](/root/borg-webgui/dbuffer.js:7), [dbuffer.js](/root/borg-webgui/dbuffer.js:371), [dbuffer.js](/root/borg-webgui/dbuffer.js:547).

`read_archives` requests `count * (9 + 256)` bytes in a single cache operation before reading individual strings. The server's default cache is 1 MiB, so 3,957 entries (including the null sentinel) exceed it even when the actual archive names/list are much smaller. Such an index becomes unavailable to the server; configured retention can exceed this count.

**Reproduced:** wrote 3,957 short archive strings, flushed successfully, then read them using the default reader: `more than cache_buf_size=1048576 requested`.

**Recommendation:** stream the list incrementally with bounds on actual encoded lengths instead of prefetching a worst-case estimate for the entire list.

### G07 — Medium: the integrated required checks fail, with fixtures masking runtime compatibility

**Evidence:** [test/helpers.js](/root/borg-webgui/test/helpers.js:26), [test/listing.test.js](/root/borg-webgui/test/listing.test.js:7), [test/backup-engine.test.js](/root/borg-webgui/test/backup-engine.test.js:25), [.github/workflows/check.yml](/root/borg-webgui/.github/workflows/check.yml:18).

`npm run check` stops at two `no-promise-executor-return` lint errors in `test/helpers.js:69,79`. Running `npm test` separately gives **64 tests: 48 passed, 14 failed, 2 skipped**. Twelve failures are server integration cases using string `httpPort: '0'`, now rejected by the numeric validator. Another listing test lacks `queueMicrotask` in its VM context and uses a DOM stub predating the new controls. The backup-engine indexing fixture does not implement the newly required `borg --version`, causing the remaining failure.

**Impact:** neither CI success nor complete compatibility coverage can be claimed for this integration. Fixing the fixtures alone will expose G02; it will not repair it. Real-Borg CI uses the same incompatible helper port type.

**Recommendation:** reconcile fixtures and lint rules, then rerun the complete suite including actual Borg versions. Keep runtime defects distinct from fixture failures.

### G08 — Medium: restore UI reports navigation as success even when the server rejects the request

**Evidence:** [public/listing.js](/root/borg-webgui/public/listing.js:486).

`initiate_restore` awaits `response.json()` but never checks `response.ok` or the returned handle. JSON error responses such as permission-denied, invalid-path, or stale-archive errors therefore take the normal `history.back()` path. Users can believe a restore started when none was queued. The same script's browsing helper correctly checks HTTP status.

**Recommendation:** reject unsuccessful statuses, validate the returned handle, retain the user's selection, and show the server error instead of navigating away.

### G09 — Medium: ordinary TLS reverse-proxy deployments reject legitimate writes

**Evidence:** [access-control.ts](/root/borg-webgui/access-control.ts:41), [server.ts](/root/borg-webgui/server.ts:38), [config.ts](/root/borg-webgui/config.ts:57).

The origin check compares the browser's Origin to `req.protocol + '://' + Host`. Express does not trust proxy protocol headers by default, and JSON settings offer no trusted-proxy/public-origin setting. For browser HTTPS terminated by a proxy forwarding HTTP, the comparison becomes `https://backup.example` versus `http://backup.example`, rejecting legitimate writes. The lost legacy hook in U04 can make an existing setup regress here too.

**Reproduced:** invoking the actual mutation guard with that HTTPS Origin and HTTP backend protocol returns 403, `Cross-origin writes are not allowed`.

**Recommendation:** provide a configured public origin or narrowly configured trusted-proxy handling. Do not solve this by disabling the origin check or blindly trusting all forwarding headers.

### G10 — Medium: tree replacement invalidates the lock used by already queued readers

**Evidence:** [archive-browse.ts](/root/borg-webgui/archive-browse.ts:5), [server.ts](/root/borg-webgui/server.ts:140), [server.ts](/root/borg-webgui/server.ts:174), [server.ts](/root/borg-webgui/server.ts:177).

Locks are keyed by the TreeEntry object. A watcher obtains that lock, closes its database, then replaces the dictionary entry with a new object. Requests that captured the old object and queued behind the reload still run afterward with the closed database. New requests use a different lock. Managed-tree removal has the same queued-reader lifetime problem. Atomic index publishing does not by itself make these in-process objects safe.

**Validation:** source-traced concurrency defect; no timing stress test was used to assign a failure frequency. Expected symptoms are transient 500 responses around refresh/removal, not an established cross-backup permission bypass.

**Recommendation:** keep a stable lock/lifetime per backup, resolve the current database after acquiring it, and retire old handles only when their readers have drained.

### G11 — Minor: invalid or incomplete runtime settings can appear to start successfully

**Evidence:** [config.ts](/root/borg-webgui/config.ts:57), [server.ts](/root/borg-webgui/server.ts:203), [server.ts](/root/borg-webgui/server.ts:476), [management-schema.ts](/root/borg-webgui/management-schema.ts:60).

The server accepts settings with neither HTTP nor HTTPS enabled; there is then no listener callback to start the scheduler. `openAll` logs “All data opened successfully” even after every configured tree failed. Stored user hashes are validated only by an `$argon2` prefix, so malformed hashes can pass the “enabled administrator exists” invariant while authentication always fails closed.

**Validation:** `{data: []}` is accepted without ports, and a management document with sole administrator hash `$argon2broken` passes schema validation. These do not bypass authentication, but create silent non-service or account lockout conditions.

**Recommendation:** require an explicit operating/listener mode, report partial tree failures accurately, and validate usable password hashes before counting an account as a recoverable administrator.

### G12 — Minor: ancillary documentation, scripts, and package metadata disagree with the supported project

**Evidence:** [README.md](/root/borg-webgui/README.md:1), [package.json](/root/borg-webgui/package.json:28), [.github/workflows/test.yml](/root/borg-webgui/.github/workflows/test.yml:16), [test.sh](/root/borg-webgui/test.sh:5), [test_data.js](/root/borg-webgui/test_data.js:3).

The README's appended Tests section and compatibility CI retain Node 22, while `engines` and the main install instructions require Node 24+. The license field says `ISC`, whereas README and the license file specify GPL v3. Legacy `test.sh` invokes the removed `-` output-filename convention and old external data; `test_data.js` requires nonexistent `./data` and an obsolete API. They are separate from the modern suite, but should not be presented as usable validation of this checkout. README also still uses `http_port`/`https_port` in the restart paragraph instead of the actual camel-case keys.

**Recommendation:** align the supported runtime/CI matrix and license metadata, correct configuration-key documentation, and repair or clearly archive obsolete standalone tests.

## Verification results and limits

| Check | Result |
| --- | --- |
| `npm ci` on Node `v24.22.3`, npm `11.19.1` | Installed successfully; npm reported zero known audit vulnerabilities |
| `npm run check` | Typecheck passed; lint failed at the two helper lines described in G07; test stage was therefore not reached |
| Separate `npm test` | Build passed; 48 passed, 14 failed, 2 skipped, 64 total |
| Real-Borg tests in the repository suite | Skipped because version-specific binary environment variables were unset for that baseline run |
| Disposable Borg 1.4.5 repository | Initialization/create succeeded; wrong trailing-space extraction reproduced |
| Disposable source/API reproductions | S01, S02, G01, G02, G03, G05, G06, G09, and G11 reproduced as detailed above |
| `git diff --check` after integration | Passed |

For the standalone real-Borg experiment, downloaded the official 1.4.5 Linux binary and checked SHA-256 `c8457f70660064d0f45b38283ab4cc65b342970012013201d3aec713a75898fb`, matching the project's pinned compatibility workflow. No actual Borg 2 binary or real remote SSH pull deployment was exercised. Source-traced and conditional deployment findings are labeled rather than presented as executed exploits. A clean dependency audit is not evidence that these application findings are absent.

Existing defenses that survived review include per-backup server-side grants, authenticated/filtered status and log access, JSON/origin/admin-header checks for mutations, serialized revision-checked management writes, private management-file modes, shell quoting for remote scripts, constrained append-only Borg serving, and backup process-group cancellation. No shell injection or unauthenticated access-control bypass was demonstrated through those paths. Administrator-selected filesystem paths and executable legacy configuration are trusted-operator capabilities, not independently classified as vulnerabilities here.
