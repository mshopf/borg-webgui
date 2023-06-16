module.exports = {
    httpPort: 8080,
    //httpsPort: 8443,
    //data: [ { file: '*-data-tree.bin', restore: '/space/nobackup/_RESTORE', borg_args: ['--sparse', '--strip-components', '2'] } ],
    borg_repo: '/space/backup/borg',
    data: [ { file: 'borg-backup-data-tree.bin', restore: '/space/nobackup/_RESTORE', borg_args: ['--sparse'] } ],
    user: 'admin',
    pwd: '$argon2id$v=19$m=65536,t=3,p=4$pxZKX/+NxOaln4c8Z7xzXg$OhJ+PjiPKmzqNAblkr1++VEfhR6W/6h8dUiH+BjCK/8',   // admin/admin
    max_cache_entries: 5000,
};
