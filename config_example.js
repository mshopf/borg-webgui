{
    httpPort: 8080,
    //httpsPort: 8443,
    borg_backup_log: 'data/borg.log',
    borg_repo: '/space/backup/borg',    // default location
    //data: [ { file: '*-data-tree.bin', restore: '/path/to/RESTORE/to', borg_args: ['--sparse', '--strip-components', '2'], borg_repo: '/space/backup/other', } ],
    data: [ { file: 'data/borg-backup-data-tree.bin', restore: '/space/nobackup/_RESTORE', borg_args: ['--sparse'], enabled: true } ],
    auth: {
        'admin': { pwd: '$argon2id$v=19$m=65536,t=3,p=4$pxZKX/+NxOaln4c8Z7xzXg$OhJ+PjiPKmzqNAblkr1++VEfhR6W/6h8dUiH+BjCK/8', },   // admin/admin
    },
    max_cache_entries: 5000,
    max_status_entries: 30,
    client_config: {
        max_restore_entries_trivial: 1000,
        max_restore_size_trivial: 100 * 1024 * 1024,
    },
    //hook_preroutes   (app) {},
    //hook_postroutes  (app) {},
    //hook_poststartup (app, server) {},
}
