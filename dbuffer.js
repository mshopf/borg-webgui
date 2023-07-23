class DBuffer {

    static VS_LENGTH_MAX      = 9;          // Max 9 Bytes for 64bit numbers
    static DEFAULT_READ_SIZE  = 512;
    static FILE_LENGTH_MAX    = 256;        // limits.h: NAME_MAX
    static PATH_LENGTH_MAX    = 256;        // limits.h: PATH_MAX
    static CACHE_BUF_SIZE_STD = (1024*1024);
    static INIT_TAG_BUF       = Buffer.from ('bOt0');

    cache_buf_write    = 0;
    cache_buf_pos_read = 0;
    cache_buf_read     = 0;
    cache_buf_size;
    file_currentoffset;
    fh;
    cache_buf;

    constructor (fh, initial_pos = 0, cache_buf_size = DBuffer.CACHE_BUF_SIZE_STD) {
        this.cache_buf_size = cache_buf_size;
        this.cache_buf = Buffer.alloc (this.cache_buf_size);
        this.open (fh, initial_pos);
    }

    // TODO: mixing read/write will not really work ATM
    // TODO: use own writing position, add goto(), remove re-opening file in tree.js

    // re-open file, so we can reuse buffer
    open (fh, initial_pos = 0) {
        this.fh = fh;
        this.file_currentoffset = initial_pos;
        this.cache_buf_write = 0;
    }
    async close () {
        console.error(); (' done '+(this.file_currentoffset/(1024*1024))+' MB\n');
        return this.fh.close();
    }
    //
    // WRITE INTERFACE
    //

    // current file position
    get write_pos() {
        return this.file_currentoffset + this.cache_buf_write;
    }
    // Move to position in file - currently only forward regarding file, and less than cache_buf_size
    set write_pos (pos) {
        var diff = pos - this.file_currentoffset;
        if (diff < 0) {
            throw Error ('buf_advance_to negative');
        }
        if (diff >= this.cache_buf_size) {
            throw Error ('buf_advance_to beyond cache');
        }
        if (diff > this.cache_buf_write) {
            this.cache_buf.fill (0, this.cache_buf_write, diff);
        }
        this.cache_buf_write = diff;
    }
    // check cache for space, write it out if more is required
    async check_flush (required) {
        if (this.cache_buf_write + required <= this.cache_buf_size) {
            return;
        }
        return this.write_flush();
    }
    // Flush cache
    async write_flush () {
        process.stderr.write ('.');
        const len = this.cache_buf_write;
        this.file_currentoffset += len;
        this.cache_buf_write = 0;
        return this.fh.write (this.cache_buf, 0, len);
    }

    // write (part of) buffer to cache
    write_buf (buf, offset=0, len=buf.length-offset) {
        buf.copy (this.cache_buf, this.cache_buf_write, offset, len);
        this.cache_buf_write += len;
    }
    // write string to cache
    write_string (str) {
        if (str == null) {
            return this.write_uvs (str);
        }
        this.write_uvs (Buffer.byteLength (str));
        this.cache_buf_write += this.cache_buf.write (str, this.cache_buf_write);
    }
    // write unsigned variable sized int to cache
    // num > 2**53 only works with BigInts
    // num has to be POSITIVE
    write_uvs (num) {
        // 0x7e and 0x7f are reserved for specials (null,undefined)
        if (num == null) {  // || undefined
            if (num === undefined) {
                this.cache_buf_write = this.cache_buf.writeUInt8 (0x7e, this.cache_buf_write);
            } else {
                this.cache_buf_write = this.cache_buf.writeUInt8 (0x7f, this.cache_buf_write);
            }
            return;
        }
        // Alternative: count number of bits and select by that
        if (num < 0x0000007e) {
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else if (num < 0x00004000) {
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else if (num < 0x00200000) {
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else if (num < 0x10000000) {
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>21) & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else {
            const numN = BigInt (num);
            // need overlapping 1 bit lo->hi and hi->uh, because the highest variant needs 8 low bits, which shifts everything by 1
            const lo = Number (BigInt.asUintN (29, numN)) & 0x1fffffff, hi = Number (numN >> 28n) & 0x003fffff, uh = Number (numN >> 49n) & 0x7fff;
            //console.log (num.toString(16)+'='+(num&0x7fffffff).toString(16)+' -> uh '+uh.toString(16)+' hi '+hi.toString(16)+' lo '+lo.toString(16));
            if (num < 0x0000000800000000) {
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else if (num < 0x0000040000000000) {
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else if (num < 0x0002000000000000) {
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else if (numN < 0x0100000000000000n) {
                this.cache_buf_write = this.cache_buf.writeUInt8 (uh       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else {
                this.cache_buf_write = this.cache_buf.writeUInt8 ((uh>>8)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((uh>>1)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>15) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>8)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>1)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>22) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>15) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>8)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0xff,        this.cache_buf_write);
            }
        }
    }
    // write signed variable sized int to cache
    // |num| > 2**52 only works with BigInts
    write_svs (num) {
        // 0x40 and 0x41 are reserved for specials (null,undefined)
        if (num == null) {  // || undefined
            if (num === undefined) {
                this.cache_buf_write = this.cache_buf.writeUInt8 (0x41, this.cache_buf_write);
            } else {
                this.cache_buf_write = this.cache_buf.writeUInt8 (0x40, this.cache_buf_write);
            }
            return;
        }
        // Alternative: count number of bits and select by that
        if (num >= -0x0000003e && num < 0x00000040) {
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else if (num >= -0x00002000 && num < 0x00002000) {
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else if (num >= -0x00100000 && num < 0x00100000) {
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else if (num >= -0x08000000 && num < 0x08000000) {
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>21) & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>14) & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 ((num>>7)  & 0x7f | 0x80, this.cache_buf_write);
            this.cache_buf_write = this.cache_buf.writeUInt8 (num       & 0x7f,        this.cache_buf_write);
        } else {
            const numN = BigInt (num);
            // need overlapping 1 bit lo->hi and hi->uh, because the highest variant needs 8 low bits, which shifts everything by 1
            const lo = Number (BigInt.asIntN (30, numN)) & 0x1fffffff, hi = Number (numN >> 28n) & 0x003fffff, uh = Number (numN >> 49n) & 0x7fff;
            if (num >= -0x0000000400000000 && num < 0x0000000400000000) {
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else if (num >= -0x0000020000000000 && num < 0x0000020000000000) {
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else if (num >= -0x0001000000000000 && num < 0x0001000000000000) {
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else if (numN >= -0x0080000000000000n && numN < 0x0080000000000000n) {
                this.cache_buf_write = this.cache_buf.writeUInt8 (uh       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (hi       & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>21) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>14) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>7)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0x7f,        this.cache_buf_write);
            } else {
                this.cache_buf_write = this.cache_buf.writeUInt8 ((uh>>8)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((uh>>1)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>15) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>8)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((hi>>1)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>22) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>15) & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 ((lo>>8)  & 0x7f | 0x80, this.cache_buf_write);
                this.cache_buf_write = this.cache_buf.writeUInt8 (lo       & 0xff,        this.cache_buf_write);
            }
        }
    }

    // Hi level: write list of archives
    async write_archives (archives) {
        await this.check_flush (DBuffer.VS_LENGTH_MAX + archives.length * (DBuffer.VS_LENGTH_MAX + DBuffer.PATH_LENGTH_MAX));
        this.write_uvs (archives.length);
        for (const e of archives) {
            this.write_string (e);
        }
    }

    // Hi level: write single tree element to cache (not recursive)
    async write_tree (tree) {
        tree.o = this.file_currentoffset + this.cache_buf_write;
        // .s .t.length .l.length .a.length .c.length/null + a*svs + .t + .t
        await this.check_flush ((7 + tree.a.length) * DBuffer.VS_LENGTH_MAX + 2 * DBuffer.PATH_LENGTH_MAX);
        this.write_uvs    (tree.s);
        this.write_uvs    (tree.t);
        this.write_string (tree.l);
        this.write_uvs    (tree.a.length);
        for (const e of tree.a) {
            this.write_svs (e);
        }
        if (tree.c === undefined) {
            this.write_uvs (0);
        } else {
            const keys = Object.keys (tree.c) .sort();
            this.write_uvs (keys.length + 1);        // 0 is reserved for 'no array'
            this.write_uvs (tree.C);
            this.write_uvs (tree.S);
            for (const i of keys) {
                if (tree.c[i].o === undefined) {
                    console.error ('undefined .o');
                }
                // i.length .o
                await this.check_flush (2 * DBuffer.VS_LENGTH_MAX + DBuffer.FILE_LENGTH_MAX);
                this.write_string (i);
                this.write_uvs    (tree.c[i].o);
            }
        }
    }

    //
    // READ INTERFACE
    //

    // Cache in something starting at offset
    async read_at (offset, required=DBuffer.DEFAULT_READ_SIZE) {
        if (offset == null) {
            // explicitly re-set cache at pos 0
            offset = this.file_currentoffset + this.cache_buf_pos_read;
            // TODO: used at all?
        } else if (offset >= this.file_currentoffset &&
                   offset+required < this.file_currentoffset + this.cache_buf_read) {
            // Enough data is already in cache
            this.cache_buf_pos_read = offset - this.file_currentoffset;
            //console.log (`read_at @${offset} for ${required} -> cache`);
            return;
        }
        const ret = await this.fh.read (this.cache_buf, 0, DBuffer.DEFAULT_READ_SIZE, offset);
        this.file_currentoffset = offset;
        this.cache_buf_pos_read = 0;
        this.cache_buf_read     = ret.bytesRead;
        //console.log (`read_at @${offset} for ${required} -> read ${ret.bytesRead}`);
        if (ret.bytesRead < required) {
            return this.check_avail (required);
        }
    }
    // check cache for required read data
    async check_avail (required) {
        if (this.cache_buf_pos_read + required < this.cache_buf_read) {
            //console.log (`check_avail @${this.file_currentoffset+this.cache_buf_pos_read} for ${required} -> cache`);
            return;
        }
        if (required > this.cache_buf_size) {
            throw Error ('more than cache_buf_size='+this.cache_buf_size+' requested');
        }

        // move unprocessed data to front of buffer
        //console.log (`check_avail @${this.file_currentoffset+this.cache_buf_pos_read} for ${required} -> copy+read`);
        this.cache_buf.copy (this.cache_buf, 0, this.cache_buf_pos_read, this.cache_buf_read);
        this.file_currentoffset += this.cache_buf_pos_read;
        this.cache_buf_read     -= this.cache_buf_pos_read;
        this.cache_buf_pos_read  = 0;
        // fill remainder of buffer up to DEFAULT_READ_SIZE or required size
        const read_len = required < DBuffer.DEFAULT_READ_SIZE ? DBuffer.DEFAULT_READ_SIZE : required;
        while (this.cache_buf_read < required) {
            const ret = await this.fh.read (this.cache_buf, this.cache_buf_read, read_len - this.cache_buf_read,
                                            this.file_currentoffset + this.cache_buf_read);
            if (ret.bytesRead < 1) {
                // technically speaking, cache is invalid after cache_buf_read, but there shouldn't be data there anyways
                //console.log ('EOF reached');
                return;
            }
            this.cache_buf_read += ret.bytesRead;
        }
    }

    // advance in cache; no sanity checks!
    advance (bytes) {
        this.cache_buf_pos_read += bytes;
    }

    // read string; only checks buf availability of chars
    read_string () {
        const len = this.read_uvs ();
        if (len == null) {
            return len;
        }
        if (this.cache_buf_pos_read + len > this.cache_buf_read) {
            throw Error ('string not completely in cache');
        }
        const str = this.cache_buf.toString (undefined, this.cache_buf_pos_read, this.cache_buf_pos_read+len);
        this.cache_buf_pos_read += len;
        return str;
    }
    // read unsigned variable sized int; does not check buf availability
    read_uvs () {
        var byte = this.cache_buf.readUInt8(this.cache_buf_pos_read);
        if (byte === 0x7e) {
            this.cache_buf_pos_read++;
            return undefined;
        } else if (byte === 0x7f) {
            this.cache_buf_pos_read++;
            return null;
        }
        var num = 0;
        for (var i = 0; i < 8; i++) {
            byte = this.cache_buf.readUInt8 (this.cache_buf_pos_read++);
            if (! (byte & 0x80)) {
                return num + byte;
            }
            num = (num + (byte & 0x7f)) * 0x80;
        }
        // Would only work correctly with BigInts for >53bits
        byte = this.cache_buf.readUInt8 (this.cache_buf_pos_read++);
        return num*2 + byte;
    }
    // read signed variable sized int; does not check buf availability
    read_svs () {
        var byte = this.cache_buf.readUInt8(this.cache_buf_pos_read++);
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
            byte = this.cache_buf.readUInt8 (this.cache_buf_pos_read++);
            topbit = byte & 0x80;
            num += (negate ? ~byte : byte) & 0x7f;
            if (! topbit) {
                return negate ? -num-1 : num ;
            }
            num *= 0x80;
        }
        // Would only work correctly with BigInts for >53bits
        byte = this.cache_buf.readUInt8 (this.cache_buf_pos_read++);
        num = num * 2 + ((negate ? ~byte : byte) & 0xff);
        return negate ? -num-1 : num ;
    }

    // Hi level: read list of archives
    async read_archives (offset) {
        await this.read_at (offset, DBuffer.VS_LENGTH_MAX);
        var len = this.read_uvs();
        await this.check_avail (len * (DBuffer.VS_LENGTH_MAX + DBuffer.FILE_LENGTH_MAX));
        var ar = [];
        for (var i = 0; i < len; i++) {
            ar.push (this.read_string());
        }
        return ar;
    }

    // Hi level: read single tree element to cache
    async read_tree (offset) {
        await this.read_at (offset, 6 * DBuffer.VS_LENGTH_MAX + DBuffer.FILE_LENGTH_MAX);
        var t = { a: [], o: offset };
        t.s = this.read_uvs();
        t.t = this.read_uvs();
        t.l = this.read_string();
        var len = this.read_uvs();
        await this.check_avail ((len+1) * DBuffer.VS_LENGTH_MAX);
        for (var i = 0; i < len; i++) {
            t.a[i] = this.read_svs();
        }
        len = this.read_uvs();
        if (len > 0) {
            t.C = this.read_uvs();
            t.S = this.read_uvs();
            t.c = {};
            for (var i = 1; i < len; i++) {
                await this.check_avail (2 * DBuffer.VS_LENGTH_MAX + DBuffer.FILE_LENGTH_MAX);
                var str = this.read_string();
                t.c[str] = { o: this.read_uvs() };
            }
        }
        return t;
    }

};

Object.freeze (DBuffer);
module.exports = DBuffer;
