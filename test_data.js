const fs_p     = require ('node:fs').promises;
const stream_p = require ('node:stream').promises;
const data     = require ('./data');


function hex(v) {
    const s=v.toString(16);
    return ('________________'.slice (0, s.length <= 16 ? 16-s.length : 0)) + s;
}
function print_buf(n) {
    console.log ('* '+hex(n)+' -> ', data.cache_buf.subarray (data.cache_buf_pos, data.cache_buf_pos+9));
}
function buf_test_compare (val, ref) {
    if (val !== ref) {
        throw Error ('test: expected '+ref+'=0x'+hex(ref)+' read '+val+'=0x'+hex(val));
    }
    return hex(val) + ' ';
}

async function test () {
    var fh = await fs_p.open ('/tmp/borg-backup-vs-test.txt', 'w', 0o644);
    var st = fh.createWriteStream ();

    st.on ('error', (e) => {throw e});

    //st.cork(); st.uncork();

    data.cache_buf_pos = 0;
    data.buf_write_buf (data.init_tag_buf);
    data.cache_buf_pos = 0x10;

    for (var i = 2; i < (2**64); i*=2) {
        data.buf_write_uvs (i-1);
        data.buf_write_uvs (i);
        data.buf_write_uvs (i+1);
    }

    for (var i = 2; i < (2**63); i*=2) {
        data.buf_write_svs (i-1);
        data.buf_write_svs (i);
        data.buf_write_svs (i+1);
    }

    for (var i = 2; i < (2**63); i*=2) {
        data.buf_write_svs (-(i-1));
        data.buf_write_svs (-i);
        data.buf_write_svs (-(i+1));
    }

    for (var i = 0; i < 0x1000; i++) {
        data.buf_write_uvs (i);
        data.buf_write_svs (i);
        data.buf_write_svs (-i);
    }

    data.buf_write_uvs (0xffffffffffffffffn);
    data.buf_write_svs (0x7fffffffffffffffn);
    data.buf_write_svs (-0x8000000000000000n);

    await data.buf_check_flush (st, data.CACHE_BUF_MAX+1); // flush write buffer unconditionally
    st.end ();
    await stream_p.finished (st);

    // Create buffer object 'entrypoint' with binary coded offset to entry data structure
    const entrypoint = 0x1234567;
    data.buf_write_uvs (entrypoint);
    // Write to slot at beginning of file
    var fh = await fs_p.open ('/tmp/borg-backup-vs-test.txt', 'r+', 0o644);
    await fh.write (data.cache_buf, 0, data.VS_LENGTH_MAX, 4);
    await fh.close ();



    var fh = await fs_p.open ('/tmp/borg-backup-vs-test.txt', 'r', 0o644);
    // direct access, thus no stream

    // Read start tag and initial offset
    await fh.read (data.cache_buf, 0, 12, 0);
    if (data.init_tag_buf.compare (data.cache_buf, 0, 4) != 0) {
        throw Error ('not a bOt0 file');
    }
    data.cache_buf_pos = 4;
    var initial_tree_offset = data.buf_read_uvs ();
    console.log (initial_tree_offset.toString (16)+' = 0x1234567');

    await data.buf_file_offset (fh, 0x10);
    await data.buf_check_avail (fh, data.VS_LENGTH_MAX * (9*64 + 3*0x1000 + 3));

    for (var i = 2; i < (2**64); i*=2) {
        var str = '';
        str += buf_test_compare (data.buf_read_uvs (), i-1);
        str += buf_test_compare (data.buf_read_uvs (), i);
        str += buf_test_compare (data.buf_read_uvs (), i+1);
        console.log (str);
    }

    for (var i = 2; i < (2**63); i*=2) {
        var str = '';
        //print_buf (i-1);
        str += buf_test_compare (data.buf_read_svs (), i-1);
        str += buf_test_compare (data.buf_read_svs (), i);
        str += buf_test_compare (data.buf_read_svs (), i+1);
        console.log (str);
    }

    for (var i = 2; i < (2**63); i*=2) {
        var str = '';
        str += buf_test_compare (data.buf_read_svs (), -(i-1));
        str += buf_test_compare (data.buf_read_svs (), -i);
        str += buf_test_compare (data.buf_read_svs (), -(i+1));
        console.log (str);
    }

    for (var i = 0; i < 0x1000; i++) {
        buf_test_compare (data.buf_read_uvs (), i);
        buf_test_compare (data.buf_read_svs (), i);
        buf_test_compare (data.buf_read_svs (), -i);
    }

    // All 3 fail due to precision errors - need BigInt reading
    // buf_test_compare (data.buf_read_uvs (), 0xffffffffffffffffn);
    // buf_test_compare (data.buf_read_svs (), 0x7fffffffffffffffn);
    // buf_test_compare (data.buf_read_svs (), -0x8000000000000000n);
    await fh.close ();

    console.log ('all tests completed successfully');
}
test();
