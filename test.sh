#!/bin/bash -xe
node ./tree.js - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2 | jq -S . >z_1234_direct.json

if [ "x$1" = x1 -o "x$1" = x ] ; then
node ./tree.js - +data/zuse2-%-2022-01-31-023001.bz2 >z_1.json
node ./tree.js ./z_1.json +data/zuse2-%-2023-01-31-023001.bz2 >z_12.json
node ./tree.js ./z_12.json +data/zuse2-%-2023-05-27-023001.bz2 >z_123.json
node ./tree.js ./z_123.json +data/zuse2-%-2023-05-28-023001.bz2 | jq -S . >z_1234.json
echo "diff 1"
diff -uq z_1234{,_direct}.json
rm z_1.json z_12.json z_123.json z_1234.json
fi

if [ "x$1" = x2 -o "x$1" = x ] ; then
node ./tree.js ./z_1234_direct.json -2022-01-31-023001 -2023-01-31-023001 | jq -S . >z_1234_12.json
node ./tree.js ./z_1234_direct.json -2023-01-31-023001 -2022-01-31-023001 | jq -S . >z_1234_21.json
echo "diff 2a"
diff -uq z_1234_12.json z_1234_21.json
node ./tree.js ./z_1234_direct.json -2022-01-31-023001 -2023-05-27-023001 | jq -S . >z_1234_13.json
node ./tree.js ./z_1234_direct.json -2023-05-27-023001 -2022-01-31-023001 | jq -S . >z_1234_31.json
echo "diff 2b"
diff -uq z_1234_13.json z_1234_31.json
node ./tree.js ./z_1234_direct.json -2022-01-31-023001 -2023-05-28-023001 | jq -S . >z_1234_14.json
node ./tree.js ./z_1234_direct.json -2023-05-28-023001 -2022-01-31-023001 | jq -S . >z_1234_41.json
echo "diff 2c"
diff -uq z_1234_14.json z_1234_41.json
fi

node ./tree.js - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 | jq -S . >z_123_direct.json
node ./tree.js - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2 | jq -S . >z_134_direct.json
if [ "x$1" = x3 -o "x$1" = x ] ; then
node ./tree.js ./z_123_direct.json +data/zuse2-%-2023-05-28-023001.bz2 | jq -S . >z_1234.json
echo "diff 3a"
diff -uq z_1234{,_direct}.json
node ./tree.js ./z_134_direct.json -2023-05-27-023001 -2023-05-28-023001 +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2 | jq -S . >z_1234.json
echo "diff 3b"
#diff -uq z_1234{,_direct}.json
fi

if [ "x$1" = x4 -o "x$1" = x ] ; then
node ./tree.js - +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-27-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2 | jq -S . >z_234_direct.json
node ./tree.js - +data/zuse2-%-2022-01-31-023001.bz2 +data/zuse2-%-2023-01-31-023001.bz2 +data/zuse2-%-2023-05-28-023001.bz2 | jq -S . >z_124_direct.json
node ./tree.js ./z_1234_direct.json -2022-01-31-023001 | jq -S . >z_234.json
node ./tree.js ./z_1234_direct.json -2023-01-31-023001 | jq -S . >z_134.json
node ./tree.js ./z_1234_direct.json -2023-05-27-023001 | jq -S . >z_124.json
node ./tree.js ./z_1234_direct.json -2023-05-28-023001 | jq -S . >z_123.json
# not 100% identical
# z_234 has some entries without(!) any archives left compared to z_234_direct
echo "diff 4a"
diff -uq z_234{,_direct}.json
echo "diff 4b"
diff -uq z_134{,_direct}.json
echo "diff 4c"
diff -uq z_124{,_direct}.json
echo "diff 4d"
diff -uq z_123{,_direct}.json
fi

rm -f z_*.json
exit 0
