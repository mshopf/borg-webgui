#!/bin/bash -e

rm -f borg-backup-data-tree.bin m4-data-tree.bin m2-?-data-tree.bin i2-?-data-tree.bin m3-?-data-tree.bin i3-?-data-tree.bin

node ./tree.js -m - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2
mv -f borg-backup-data-tree.bin m4-data-tree.bin

if [ "x$1" = x1 -o "x$1" = x ] ; then

    node ./tree.js -i -                         +data/zuse2-%-2022-01-31-023001.bz2
    node ./tree.js -i borg-backup-data-tree.bin +data/zuse2-%-2023-01-31-023001.bz2
    node ./tree.js -i borg-backup-data-tree.bin +data/zuse2-%-2023-05-27-023001.bz2
    node ./tree.js -i borg-backup-data-tree.bin +data/zuse2-%-2023-05-28-023001.bz2
    # re-read and dump to sort entries in same maner as in-memory creation
    node ./tree.js -i borg-backup-data-tree.bin

    echo diff 1
    cmp m4-data-tree.bin borg-backup-data-tree.bin || exit 1

    rm -f borg-backup-data-tree.bin

fi

if [ "x$1" = x2 -o "x$1" = x ] ; then

    ln m4-data-tree.bin m2-1-data-tree.bin
    ln m4-data-tree.bin m2-2-data-tree.bin
    ln m4-data-tree.bin i2-3-data-tree.bin
    ln m4-data-tree.bin i2-4-data-tree.bin
    node ./tree.js -m m2-1-data-tree.bin -2022-01-31-023001 -2023-01-31-023001
    node ./tree.js -m m2-2-data-tree.bin -2023-01-31-023001 -2022-01-31-023001

    echo diff 2a
    cmp m2-1-data-tree.bin m2-2-data-tree.bin || exit 1

    node ./tree.js -i i2-3-data-tree.bin -2022-01-31-023001
    node ./tree.js -i i2-3-data-tree.bin -2023-01-31-023001
    node ./tree.js -i i2-4-data-tree.bin -2023-01-31-023001
    node ./tree.js -i i2-4-data-tree.bin -2022-01-31-023001

    echo diff 2b
    cmp i2-3-data-tree.bin i2-4-data-tree.bin || exit 1

    echo diff 2c
    cmp i2-3-data-tree.bin m2-1-data-tree.bin || exit 1

    rm -f m2-?-data-tree.bin i2-?-data-tree.bin
    ln m4-data-tree.bin m2-1-data-tree.bin
    ln m4-data-tree.bin i2-3-data-tree.bin
    ln m4-data-tree.bin i2-4-data-tree.bin

    node ./tree.js -m m2-1-data-tree.bin -2023-05-27-023001 -2023-05-28-023001
    node ./tree.js -i i2-3-data-tree.bin -2023-05-27-023001
    node ./tree.js -i i2-3-data-tree.bin -2023-05-28-023001
    node ./tree.js -i i2-4-data-tree.bin -2023-05-28-023001
    node ./tree.js -i i2-4-data-tree.bin -2023-05-27-023001

    echo diff 2d
    cmp i2-3-data-tree.bin i2-4-data-tree.bin || exit 1

    echo diff 2e
    cmp i2-3-data-tree.bin m2-1-data-tree.bin || exit 1

    rm -f m2-?-data-tree.bin i2-?-data-tree.bin
fi

if [ "x$1" = x3 -o "x$1" = x ] ; then

    ln m4-data-tree.bin i3-0-data-tree.bin
    ln m4-data-tree.bin i3-1-data-tree.bin
    ln m4-data-tree.bin i3-2-data-tree.bin
    ln m4-data-tree.bin i3-3-data-tree.bin
    ln m4-data-tree.bin i3-4-data-tree.bin

    node ./tree.js -i i3-0-data-tree.bin -2023-05-28-023001
    node ./tree.js -i i3-0-data-tree.bin +data/zuse2-%-2023-05-28-023001.bz2
    # re-read and dump to sort entries in same maner as in-memory creation
    node ./tree.js -i i3-0-data-tree.bin

    echo diff 3x
    cmp m4-data-tree.bin i3-0-data-tree.bin || exit 1

    # ATM this fails - entries are never fully removed
    node ./tree.js -m - +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2
    mv -f borg-backup-data-tree.bin m3-1-data-tree.bin
    node ./tree.js -i i3-1-data-tree.bin -2022-01-31-023001
    node ./tree.js -i i3-1-data-tree.bin +data/zuse2-%-2022-01-31-023001.bz2

    echo diff 3a
    cmp m3-1-data-tree.bin i3-1-data-tree.bin || exit 1

    node ./tree.js -m - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2
    mv -f borg-backup-data-tree.bin m3-2-data-tree.bin
    node ./tree.js -i i3-2-data-tree.bin -2023-01-31-023001

    echo diff 3b
    cmp m3-2-data-tree.bin i3-2-data-tree.bin || exit 1

    node ./tree.js -m - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2
    mv -f borg-backup-data-tree.bin m3-3-data-tree.bin
    node ./tree.js -i i3-3-data-tree.bin -2023-05-27-023001

    echo diff 3c
    cmp m3-3-data-tree.bin i3-3-data-tree.bin || exit 1

    node ./tree.js -m - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2
    mv -f borg-backup-data-tree.bin m3-4-data-tree.bin
    node ./tree.js -i i3-4-data-tree.bin -2023-05-28-023001

    echo diff 3d
    cmp m3-4-data-tree.bin i3-4-data-tree.bin || exit 1

fi

rm -f borg-backup-data-tree.bin m4-data-tree.bin m2-?-data-tree.bin i2-?-data-tree.bin m3-?-data-tree.bin i3-?-data-tree.bin

echo "test finished successfully"
exit 0

