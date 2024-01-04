# ![Icon](public/borg.png) borg-webgui

**A web-based UI for the backup system borg, currently for managing restores only**

There are a number of UIs for borg available, but all of them only manage the backup side of things, not the restore side. Since backing up is typically done by administrators, restoring data is a more common (i.e. the only) end user action, thus a graphical user interface is required.

borg-webgui does not allow to access data directly, but only manages file/directory selection and the restore processes. Access to restored data has to be performed by regular file system access (NFS, CIFS, ...). Therefore, borg-webgui does *NOT* handle access restrictions. That means, every user that can access the UI can see all directory and file names, their sizes, and when they have been backed up. In situations where that is not acceptable, access to the UI has to be limited to administrators only. As by restoring huge directories you can easily fill up even large file spaces, some access limitation is reasonable anyway.

borg-webgui does not access borg data structures itself, but uses borg for that. So borg has to be installed on the server. It uses pattern files with `pf` and `pp` directives for restoring data.

borg-webgui is battle tested on backup sets with more than 80 archives containing over 6 TB of data in over 7 million files in a single backup configuration. The data tree for this backup set requires 1.5 GB of disc space and can be created only incrementally due to RAM restrictions. Still, consider this an early release.


## License

borg-webgui is licensed under GPL v3, written mainly by Matthias Hopf <mat@mshopf.de>.

The icon is apparently public domain, origins unclear.


# Setup

borg-webgui is implemented as a node/express server, a pure javascript client, and a node based tool for incrementally writing the compressed data structure the express server works with. By working with out-of-core data structures it is designed to work with huge and lots of backup sets.


## Configuration

Basic configuration is contained in `config.js`. An example configuration `config_example.js` is contained in the repo, copy it to `config.js` and start configuring there.

- `httpPort`, `httpsPort`:\
  If both are available, http will be a redirector only. https requires a [proper certificate](#Certificates) in `ssl/server.key` and `ssl/server.crt`
- `borg_backup_log`:\
  Log is used for displaying when the last backups have been performed. Lines should contain `ERR` to be detected as errors.
- `borg_repo`:\
  Default repository used for all commands.
- `data`: List (array) of configurations, each:
  - `file`: path to data tree
  - `restore`: path to where to extract backups to
  - `borg_repo`: override repository (optional)
  - `borg_args`: additional borg arguments; useful are e.g. `--sparse`, `'--strip-components` (optional)
- `auth`: List (object) of users, each:
  - `pwd`: argon2id [hashed password](#Password-hashing)
- `max_cache_entries`:\
  Maximum number of cache entries kept in server before purging
- `max_status_entries`:\
  Number of status entries from log and restoring process kept before truncating
- `client_config`: Information sent to client for UI behavior
  - `max_restore_entries_trivial`: User has to explicitly confirm restoration when more files are to be restored
  - `max_restore_size_trivial`: User has to explicitly confirm restoration when larger data is to be restored
- `hook_preroutes`, `hook_postroutes`, `hook_poststartup`:\
  Own routes and functionality can be added to server.


## Backup list processing

> [!NOTE]
> The *typical* command run directly after performing a backup is
> ```Shell
> node ./tree.js -a server-data-tree.bin /server-
> ```
> if the backups are named like `server-2023-12-31-011505`.\
> The data tree has to exist already for this to work.

The [data structure](INTERNALS.txt) required for out-of-core direct access to all backup data is initially created with
```
node ./tree.js -c -m server-data-tree.bin
```
Use separate data trees for different backups. Data trees tend to get pretty big for large backup sets, choose their location accordingly.

> [!IMPORTANT]
> For borg-webgui to work correctly, backups have to be strictly named after the scheme `BACKUPNAME-YYYY-MM-DD-hhmmss`. `BACKUPNAME` is an arbitrary name, typically comprised of hostname and directory (without `/`!). The remainder is the date and time of the backup. This strict naming requirement may change in the future.

Data trees have to be named the same way as the included backups, with the extension `-data-tree.bin`, e.g. `server-root-data-tree.bin` will contain backups named like `server-root-2023-12-17-010000`.

You can combine initial creation (`-c`) with adding (several) backups to the data tree. Without `-c` the old data tree is read in and additional backups are added or removed to/from it. For initial setup and not too large backup sets, it is reasonable to [do that in-memory](#In-memory-parameters):
```
node ./tree.js -c -m server-data-tree.bin +BACKUP_1 +BACKUP_2 -BACKUP_3
```
This will add BACKUP_1 and BACKUP_2 and remove the data from BACKUP_3 (not useful while creating a data tree for the first time).
Using `/REGEX` will use `borg list` to find available backup names automatically, and add and/or remove backups that are (still) accessible automatically. Note that due to the strict naming requirements, the regex must typically be the same as the base name at the moment.

For larger backup sets, it requires much less RAM when doing this out-of-core, i.e. incrementally. Instead option `-m` use `-i` for a single iteration, `-a` for repeatedly adding/removing all given backup sets. Using that together with `/REGEX` is probably the most commonly used form (see top of chapter). Incrementally changing the data tree is much slower than in-memory, especially if multiple changes have to be applied.


## Server setup

> [!NOTE]
> The server is started with
> ```Shell
> `node ./server.js
> ```

Server log is printed to stdout. See [the script section below](#Server-startup) for a typical startup script.

The server only requires a restart, if configuration options `http_port`, `https_port`, `borg_backup_log`, the `data` configurations, the hooks, or the server code change. All other changes in the configuration and the data trees are detected and acted upon by watchers.


# Client Usage

borg-webgui displays backups not separated by backup date, but the whole tree at once. Users typically want to restore a specific file or directory, and decide the exact backup date after they know which ones actually exist. This is a design decision. Archive specific views might be added in the future.


## Initial view

After surfing to the configured entry page a list of backup configurations and an event log is presented. Clicking on an event log displays the according log file. Clicking on a backup configuration enters the file/directory selection mode. For those actions, valid credentials have to be entered.

## File/directory selection mode

The action bar contains a `Restore` button that is grayed out as long as no entries are selected for restoration. It contains a backup selector and shows the number of elements and total size of the upcoming restore process. When a big restore process shall be activated, it has to be confirmed explicitly.

Beneath that is a typical tree view of the backed up data. All directories and files that ever existed in the backup are shown, all at once. That is, if a directory `alice` is renamed to `bob`, both will show up. The former will only exist in older backups, the later only in newer. To the right a (shortened) list of available backups is presented. Whenever an entry is unchanged in several backups, those are merged into one item and shown with the oldest date (e.g. `30.3.2020(32)`). Tooltips show the exact times and dates of the backups.

Clicking on the triangle icon or the name will open/close directories.\
Clicking on the square or the backup dates will select according directory or file for recovery.\
Half-filled squares on directories indicate that some but not all of the elements beneath are selected.

If all entries of an directory are selected, the system considers this as an request to reconstruct the directory of the selected date as-is. In that case, only files that were actually present in that backup are reconstructed. That is typically what users want.

If too many entries are selected (e.g. all but one in a large directory), chances are that there is not a single backup, in which all selected entries exist. That happens e.g. when you select a large directory, and deselect a single entry of it afterwards.

> [!IMPORTANT]
> Humans consider dates, when they worked on a file, not when a backup is done. As backups are typically done during the night, often past midnight, all backups performed between 12am and 6am are considered to contain the state of the previous date and displayed accordingly. Tooltips reveal the true backup times and dates.

After selecting the wanted items, one should select the backup date that should be used for restoration and start the process. Back on the entry page the restoration process will show up in the event log.

When the process is finished, the restored entries will show up within the configured restore path in a directory with the backup date and time as name. It is up to the administrator to [remove leftover restoration directories](#Cleanup-restore-directories).


# Bugs, Testing, Limitations, Contributions

## Side notes

- Removing backups from the data tree will *NOT* reunite data that has been split by that backup.

  For example consider a data tree, that has a file in version a in backup sets 1, 2, and 4, and in version b in backup set 3 (e.g. renamed for set 3 and moved back again for set 4). That leaves backup possibilities 1+2, 3, and 4. After removing backup set 3, it will still be 1+2 and 4, though these two are the same. If the data tree is recreated from backup sets 1, 2, and 4 from scratch, backup possibilities will be only the single 1+2+4.

- Symlinks are displayed and can be selected accordingly

- Files are considered differently, if their sizes or modification times differ. borg-webgui does not check any checksums, because extracting those slows down `borg list` significantly.

- `borg extract` is still a relatively slow operation. Requests are queued and processed one at a time. Future changes in borg might help, as the used `pp` and `pf` patterns could be optimized easier than others, but that requires changes to the borg archive structure.


## Bugs

Bug tracking is not set up yet.

[ ] The testing scripts `test.sh` and `test_data.js` are written for an older version of the data structures and thus inoperable at the moment.

[ ] write buffer full\
  (node:414855) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 drain listeners added to [WriteStream]. Use emitter.setMaxListeners() to increase limit
  (Use `node --trace-warnings ...` to show where the warning was created)\
  To be recreated...

[ ] (incompatible) Optimization of on-disk data structure\
  Use `null` for "no entry" in write_tree()/read_tree(). Use relative offsets. Relative dates have already been tested, not useful enough for the additional overhead.


## Limitations and TODOs

- At the moment, there is no handling of the backup side of borg. That may change in the future.
- At the moment, borg backups have to be strictly named `BACKUPNAME-YYYY-MM-DD-hhmmss` (e.g. `server-2023-12-31-011505`). That may change in the future.
- At the moment there is only trivial all-or-nothing access restriction in place. A role based authentication model and finer granular access controls are planed.
- There are no archive specific views ATM.


## Contributions

Bug reports, patches, merge requests welcome.

Processing on my side can take a while, though.


# Support Scripts

## Certificates

Create snake oil certificate, if only accessible in intranet (no public hostname available for LetsEncrypt):
```Shell
openssl req -x509 -nodes -newkey rsa:2048 -keyout ssl/server.key -out ssl/server.crt -days 7300 -subj '/CN=Borg Backup/C=DE/OU=Borg Backup/O=ACME' -addext "keyUsage = digitalSignature, keyEncipherment, dataEncipherment, cRLSign, keyCertSign" -addext "extendedKeyUsage = serverAuth, clientAuth"
```

## Password hashing

Print the hash your password for use with `config.js`:
```Shell
node -e 'async function m() { rl=require("readline").promises.createInterface({ input: process.stdin, output: process.stdout, terminal: true}); p=await rl.question("Password: "); rl.close(); console.log (await require ("argon2").hash(p));} m()'
```

## In-memory parameters

Increase available memory for node by using this environment variable:
```Shell
NODE_OPTIONS=--max-old-space-size=16384
```

## Server startup

A typical startup script for the server, handling restarts as well;\
be aware, that this does kill all servers started with `node ./server.js`!
```Shell
#!/bin/sh
cd /local/srv/borg-webgui || exit 1
mkdir -p log
log=log/server-`date +'%Y%m%d-%H%M%S'`.log
exec >$log 2>&1 </dev/null
pkill -f 'node ./server.js'
nohup node ./server.js &
```

## Cleanup restore directories

Example script for cleaning up restore directory `/local/_RESTORE` after 14 days
```Shell
#!/bin/sh
tmp=`mktemp /tmp/borg_XXXXXXXXXXXX`
maxage=14
shopt -s nullglob
for d in /local/_RESTORE/[1-9]* ; do
        find "$d" -depth \! -ctime -$maxage >>$tmp
        find "$d" -depth \! -ctime -$maxage -delete
done
logger -t borg -p daemon.notice "Cleanup of borg restores, deleted `wc -l <$tmp` files/dirs"
rm -f $tmp
```
