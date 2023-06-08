module.exports = {
    httpPort: 8080,
    //httpsPort: 8443,
    //data: [ { file: '*-backup-tree.json.bz2', restore: '/space/nobackup/_RESTORE', borg_args: ['--sparse', '--strip-components', '2'] } ],
    borg_repo: '/space/backup/borg',
    data: [ { file: 'data/zuse2-%-backup-tree.json.bz2', restore: '/space/nobackup/_RESTORE', borg_args: ['--sparse'] } ],
};
