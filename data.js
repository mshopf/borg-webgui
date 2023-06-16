// TODO: vars unused, only as docu and initializer
// TODO: make a real class
const VS_LENGTH_MAX      = 9           // Max 9 Bytes for 64bit numbers
const DEFAULT_READ_SIZE  = 4*1024;
const FILE_LENGTH_MAX    = 256;        // limits.h: NAME_MAX
const PATH_LENGTH_MAX    = 256;        // limits.h: PATH_MAX
const CACHE_BUF_MAX      = (1024*1024);
const cache_buf          = Buffer.alloc (CACHE_BUF_MAX);
const init_tag_buf       = Buffer.from ('bOt0');
var   cache_buf_pos      = 0;
var   cache_buf_read     = 0;
var   file_currentoffset = 0;


// Low level: write buffer to stream, await if clogged
/*async function write_buffer_to_stream (st, buf, len=undefined) {
    const chunk = len === undefined ? buf : buf.subarray (0, len);
    _.file_currentoffset += chunk.length;
    if (st.write (chunk)) {
        return;
    }
    // Buffer full - wait for space
    console.error ('write buffer full');
    await new Promise ((resolve, reject) => st.on ('drain', resolve));
}*/

//
// WRITE INTERFACE
//

// Mid level: check cache for space, write it out if more is required
async function buf_check_flush (st, required) {
    if (_.cache_buf_pos + required <= _.CACHE_BUF_MAX) {
        return;
    }
    const chunk = _.cache_buf.subarray (0, _.cache_buf_pos);
    _.file_currentoffset += _.cache_buf_pos;
    _.cache_buf_pos = 0;
    if (st.write (chunk)) {
        return;
    }
    // Buffer full - wait for space
    console.error ('write buffer full');
    await new Promise ((resolve, reject) => st.on ('drain', resolve));
}
// Mid level: write (part of) buffer to cache
function buf_write_buf (buf, offset=0, len=buf.length-offset) {
    buf.copy (_.cache_buf, _.cache_buf_pos, offset, len);
    _.cache_buf_pos += len;
}
// Mid level: write string to cache
function buf_write_string (str) {
    if (str == null) {
        return buf_write_uvs (str);
    }
    buf_write_uvs (Buffer.byteLength (str));
    _.cache_buf_pos += _.cache_buf.write (str, _.cache_buf_pos);
}
// Mid level: write unsigned variable sized int to cache
// num > 2**53 only works with BigInts
// num has to be POSITIVE
function buf_write_uvs (num) {
    if (num == null) {  // || undefined
        if (num === undefined) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (0x7e, _.cache_buf_pos);
        } else {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (0x7f, _.cache_buf_pos);
        }
        return;
    }
    // Alternative: count number of bits and select by that
    if (num < 0x0000007e) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else if (num < 0x00004000) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else if (num < 0x00200000) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else if (num < 0x10000000) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>21) & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else {
        const numN = BigInt (num);
        // need overlapping 1 bit lo->hi and hi->uh, because the highest variant needs 8 low bits, which shifts everything by 1
        const lo = Number (BigInt.asUintN (29, numN)) & 0x1fffffff, hi = Number (numN >> 28n) & 0x003fffff, uh = Number (numN >> 49n) & 0x7fff;
        //console.log (num.toString(16)+'='+(num&0x7fffffff).toString(16)+' -> uh '+uh.toString(16)+' hi '+hi.toString(16)+' lo '+lo.toString(16));
        if (num < 0x0000000800000000) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else if (num < 0x0000040000000000) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else if (num < 0x0002000000000000) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else if (numN < 0x0100000000000000n) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (uh       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else {
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((uh>>8)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((uh>>1)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>15) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>8)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>1)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>22) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>15) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>8)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0xff,        _.cache_buf_pos);
        }
    }
}
// Mid level: write signed variable sized int to cache
// |num| > 2**52 only works with BigInts
function buf_write_svs (num) {
    if (num == null) {  // || undefined
        if (num === undefined) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (0x41, _.cache_buf_pos);
        } else {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (0x40, _.cache_buf_pos);
        }
        return;
    }
    // Alternative: count number of bits and select by that
    if (num >= -0x0000003e && num < 0x00000040) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else if (num >= -0x00002000 && num < 0x00002000) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else if (num >= -0x00100000 && num < 0x00100000) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else if (num >= -0x08000000 && num < 0x08000000) {
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>21) & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, _.cache_buf_pos);
        _.cache_buf_pos = _.cache_buf.writeUInt8 (num       & 0x7f,        _.cache_buf_pos);
    } else {
        const numN = BigInt (num);
        // need overlapping 1 bit lo->hi and hi->uh, because the highest variant needs 8 low bits, which shifts everything by 1
        const lo = Number (BigInt.asIntN (30, numN)) & 0x1fffffff, hi = Number (numN >> 28n) & 0x003fffff, uh = Number (numN >> 49n) & 0x7fff;
        if (num >= -0x0000000400000000 && num < 0x0000000400000000) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else if (num >= -0x0000020000000000 && num < 0x0000020000000000) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else if (num >= -0x0001000000000000 && num < 0x0001000000000000) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else if (numN >= -0x0080000000000000n && numN < 0x0080000000000000n) {
            _.cache_buf_pos = _.cache_buf.writeUInt8 (uh       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0x7f,        _.cache_buf_pos);
        } else {
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((uh>>8)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((uh>>1)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>15) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>8)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((hi>>1)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>22) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>15) & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 ((lo>>8)  & 0x7f | 0x80, _.cache_buf_pos);
            _.cache_buf_pos = _.cache_buf.writeUInt8 (lo       & 0xff,        _.cache_buf_pos);
        }
    }
}

// Hi level: read list of archives
async function write_archives (st, archives) {
    await buf_check_flush (st, _.VS_LENGTH_MAX + archives.length * (_.VS_LENGTH_MAX + _.PATH_LENGTH_MAX));
    buf_write_uvs (archives.length);
    for (const e of archives) {
        buf_write_string (e);
    }
}

// Hi level: write single tree element to cache
async function write_tree (st, tree) {
    tree.o = _.file_currentoffset + _.cache_buf_pos;
    // .s .t.length .l.length .a.length .c.length/null + a*svs + .t + .t
    await buf_check_flush (st, (5+tree.a.length) * _.VS_LENGTH_MAX + 2 * _.PATH_LENGTH_MAX);
    buf_write_uvs    (tree.s);
    buf_write_uvs    (tree.t);
    buf_write_string (tree.l);
    buf_write_uvs    (tree.a.length);
    for (const e of tree.a) {
        buf_write_svs (e);
    }
    if (tree.c === undefined) {
        buf_write_uvs (0);
    } else {
        buf_write_uvs (Object.keys (tree.c) .length + 1);        // 0 is reserved for 'no array' (one byte less than null)
        for (const i in tree.c) {
            if (tree.c[i].o === undefined) {
                console.error ('undefined .o');
            }
            // i.length .o
            await buf_check_flush (st, 2 * _.VS_LENGTH_MAX + _.FILE_LENGTH_MAX);
            buf_write_string (i);
            buf_write_uvs    (tree.c[i].o);
        }
    }
}

//
// READ INTERFACE
//

async function buf_file_offset (fh, offset) {
    if (offset == null) {
        offset = _.file_currentoffset + _.cache_buf_pos;
    }
    await fh.read (_.cache_buf, 0, _.DEFAULT_READ_SIZE, offset);
    _.file_currentoffset = offset;
    _.cache_buf_pos  = 0;
    _.cache_buf_read = _.DEFAULT_READ_SIZE;
}
async function buf_check_avail (fh, required) {
    while (_.cache_buf_pos + required > _.cache_buf_read) {
        await fh.read (_.cache_buf, _.cache_buf_read, _.DEFAULT_READ_SIZE, _.file_currentoffset + _.cache_buf_read);
        _.cache_buf_read += _.DEFAULT_READ_SIZE;
    }
}

// Mid level: read string; only checks buf availability of chars
function buf_read_string () {
    const len = buf_read_uvs ();
    if (len == null) {
        return len;
    }
    if (_.cache_buf_pos + len > _.cache_buf_read) {
        return null;
    }
    const str = _.cache_buf.toString (undefined, _.cache_buf_pos, _.cache_buf_pos+len);
    _.cache_buf_pos += len;
    return str;
}
// Mid level: read unsigned variable sized int; does not check buf availability
function buf_read_uvs () {
    var byte = _.cache_buf.readUInt8(_.cache_buf_pos);
    if (byte === 0x7e) {
        _.cache_buf_pos++;
        return undefined;
    } else if (byte === 0x7f) {
        _.cache_buf_pos++;
        return null;
    }
    var num = 0;
    for (var i = 0; i < 8; i++) {
        byte = _.cache_buf.readUInt8 (_.cache_buf_pos++);
        if (! (byte & 0x80)) {
            return num + byte;
        }
        num = (num + (byte & 0x7f)) * 0x80;
    }
    // Would only work correctly with BigInts for >53bits
    byte = _.cache_buf.readUInt8 (_.cache_buf_pos++);
    return num*2 + byte;
}
// Mid level: read signed variable sized int; does not check buf availability
function buf_read_svs () {
    var byte = _.cache_buf.readUInt8(_.cache_buf_pos++);
    if (byte === 0x41) {
        return undefined;
    } else if (byte === 0x40) {
        return null;
    }
    var negate = byte & 0x40;
    var topbit = byte & 0x80;
    var num = (negate ? ~byte : byte) & 0x3f;
    if (! topbit) {
        return negate ? -num-1 : num ;
    }
    num *= 0x80;
    for (var i = 0; i < 7; i++) {
        byte = _.cache_buf.readUInt8 (_.cache_buf_pos++);
        topbit = byte & 0x80;
        num += (negate ? ~byte : byte) & 0x7f;
        if (! topbit) {
            return negate ? -num-1 : num ;
        }
        num *= 0x80;
    }
    // Would only work correctly with BigInts for >53bits
    byte = _.cache_buf.readUInt8 (_.cache_buf_pos++);
    num = num * 2 + ((negate ? ~byte : byte) & 0xff);
    return negate ? -num-1 : num ;
}

// Hi level: read list of archives
async function read_archives (fh, offset) {
    await buf_file_offset (fh, offset);
    var len = buf_read_uvs();
    await buf_check_avail (fh, _.cache_buf_read + len * (_.VS_LENGTH_MAX + _.FILE_LENGTH_MAX));
    var ar = [];
    for (var i = 0; i < len; i++) {
        ar.push (buf_read_string());
    }
    return ar;
}

// Hi level: read single tree element to cache
async function read_tree (fh, offset) {
    await buf_file_offset (fh, offset);
    var t = { a: [] };
    t.s = buf_read_uvs();
    t.t = buf_read_uvs();
    t.l = buf_read_string();
    var len = buf_read_uvs();
    for (var i = 0; i < len; i++) {
        t.a[i] = buf_read_svs();
    }
    len = buf_read_uvs();
    if (len > 0) {
        await buf_check_avail (fh, _.cache_buf_read + len * (2 * _.VS_LENGTH_MAX + _.FILE_LENGTH_MAX));
        t.c = {};
        for (var i = 1; i < len; i++) {
            var str = buf_read_string();
            t.c[str] = { o: buf_read_uvs() };
        }
    }
    return t;
}

var _ = {
    VS_LENGTH_MAX, DEFAULT_READ_SIZE, FILE_LENGTH_MAX, PATH_LENGTH_MAX, CACHE_BUF_MAX, cache_buf, init_tag_buf, cache_buf_pos, cache_buf_read, file_currentoffset,
    buf_check_flush, buf_write_buf, buf_write_string, buf_write_uvs, buf_write_svs, write_archives, write_tree,
    buf_file_offset, buf_check_avail, buf_read_string, buf_read_uvs, buf_read_svs, read_archives, read_tree,
};
module.exports = _;

