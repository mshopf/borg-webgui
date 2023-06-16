*** Create snake oil cert:
openssl req -x509 -nodes -newkey rsa:2048 -keyout key.pem -out server.pem -days 7300 -subj '/CN=Borg Backup/C=DE/OU=Borg Backup/O=ACME' -addext "keyUsage = digitalSignature, keyEncipherment, dataEncipherment, cRLSign, keyCertSign" -addext "extendedKeyUsage = serverAuth, clientAuth"

*** Hash your password:
node -e 'async function m() { rl=require("readline").promises.createInterface({ input: process.stdin, output: process.stdout, terminal: true}); p=await rl.question("Password: "); rl.close(); console.log (await require ("argon2").hash(p));} m()'

*** More memory for node:
NODE_OPTIONS=--max-old-space-size=16384

*** Bugs
- write buffer full
  (node:414855) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 drain listeners added to [WriteStream]. Use emitter.setMaxListeners() to increase limit
  (Use `node --trace-warnings ...` to show where the warning was created)


*** Dev Notes

Object: a "Archives" - Array of archive names TBC
            c "Children" - keys are dir/file names
            s "Size"  t "mTime"  l "link" of last added archive
            c available on dirs, s and t on files, l on links
     //{"type": "d", "mode": "drwxr-xr-x", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2022-01-24T16:33:10.461280", "size": 0}
         //{"type": "-", "mode": "-rw-r--r--", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/64bit_strstr_via_64bit_strstr_sse2_unaligned", "healthy": true, "source": "", "linktarget": "", "flags": 0, "isomtime": "2021-11-15T19:29:28.000000", "size": 0}
             //{"type": "l", "mode": "lrwxrwxrwx", "user": 0, "group": 0, "uid": 0, "gid": 0, "path": "etc/sysconfig/grub", "healthy": true, "source": "../default/grub", "linktarget": "../default/grub", "flags": 0, "isomtime": "2022-01-12T16:23:39.000000", "size": 15}

.c === undefined: file/link/special
.c === [] empty dir
.c === null: subtree already written, o (offset) should be set


File data structure
===================

Numbers written as variably sized integer
This scheme does not create binary patters starting with 0x80 (and 0xff for signed values). Except for
-  0x7e and  0x7f  in uvs: 0x807e and 0x807f
- -0x3f and -0x40  in svs: 0xff41 and 0xff40
These numbers are reserved for specials:
- 0x7e (uvs) 0x41 (svs) : undefined
- 0x7f (uvs) 0x40 (svs) : null

NOTE: Numbers > 52bit currently not represented exactly on reading
Numbers to be delivered as BigInts to be written exactly
Variable sized integer (uvs (unsigned)) - big endian
- 0x00000000-0x0000007d   - 0xxxxxxx
- 0x0000007e-0x00003fff   - 1xxxxxxx (hi 7 bits)  0xxxxxxx (lo 7 bits)
- 0x00004000-0x001fffff   - 1xxxxxxx (hi 7 bits)  1xxxxxxx  0xxxxxxx (lo 7 bits)
[...]
- 0x0002000000000000-0x00ffffffffffffff   - hi-to-lo 7x 1xxxxxxx  ...  0xxxxxxx (lo 7 bits)
- 0x0100000000000000-0xffffffffffffffff   - hi-to-lo 8x 1xxxxxxx  ...  xxxxxxxx (lo 8(!) bits)
Variable sized integer (svs (signed))
- -0x0000003e-0x0000003f   - 0sxxxxxx
- -0x00002000-0x00001fff   - 1sxxxxxx (hi 7 bits)  0xxxxxxx (lo 7 bits)
- -0x00100000-0x000fffff   - 1sxxxxxx (hi 7 bits)  1xxxxxxx  0xxxxxxx (lo 7 bits)
[...]
- -0x0080000000000000-0x007fffffffffffff   - hi-to-lo 7x 1sxxxxxx  ...  0xxxxxxx (lo 7 bits)
- -0x8000000000000000-0x7fffffffffffffff   - hi-to-lo 8x 1sxxxxxx  ...  xxxxxxxx (lo 8(!) bits)


File Format
===========

0x0000..0x0003       Magic 'bOt0' - binary offset tree 0
0x0004..0x000b(max)  uvs  Offset to root (at end of file)
      ..0x0014(max)  uvs  Current time, used for time offset coding (currently not set / unused)
0x0020..             tree data




TODO: Future work - generic data structure
==========================================

0x0000..0x0003  Magic 'bOt1' - binary offset tree 1
0x0004..0x000c  uvs  Offset to root (at end of file)
0x0010..        data type descriptions

structure / data type description
- new type (1byte)-0x00 end of description
                   0x40 and following
- type (1byte)   - 0x00 end of new type
                   0x01 undefined
                   0x02 null
                   0x03 s8  (1byte)
                   0x04 u8  (1byte)
                   0x05 s16 (svs)
                   0x06 u16 (uvs)
                   0x07 s32 (svs)
                   0x08 u32 (uvs)
                   0x09 s64 (svs)
                   0x0a u64 (uvs)
                   0x20 string
                   0x21 double
                   0x22 BigInt
                        TODO
                   0x30 reference
                        (1byte) type
                   0x31 sub-type / structure / single object / fixed associative array:
                        (1byte) type
                   0x32 fixed size array:
                        (uvs)   size of array
                        (1byte) type of entries  (<0x30 || >=0x40)
                   0x33 flexible array:
                        (1byte) type of entries  (<0x30 || >=0x40)
                   0x34 associative array:
                        (1byte) type of entries  (<0x30 || >=0x40)
- name (utf8)    - 0x00-0x7f ascii, >0x80: -0x80 index on name strings
  repeat type+name until type === 0x00
- strings for names
  - size    (1    vs)
  - content (size utf8)
- end of header, beginning of data

- data per type
  - 0x01 undefined           none
  - 0x02 null                none
  - 0x03 s8                  (1byte)
  - 0x04 u8                  (1byte)
  - 0x05 s16                 (svs)
  - 0x06 u16                 (uvs)
  - 0x07 s32                 (svs)
  - 0x08 u32                 (uvs)
  - 0x09 s64                 (svs)
  - 0x0a u64                 (uvs)
  - 0x20 string              (uvs) size  size*(utf8) string
  - 0x21 double              (8bytes)
  - 0x22 BigInt              TODO
  - 0x30 reference           (uvs) offset to type
  - 0x31 type/structure      (depending-on-type)
  - 0x32 fixed size array    size*(depending-on-type)
  - 0x33 flexible array      (uvs) size    size*(depending-on-type)
  - 0x34 associative array   (uvs) size    (uvs) offset-to-strings    size*(uvs) offset-to-keys     size*(depending-on-type)
- 0x05-0x0e #of bytes
- 0x0f see above
- 0x10 ?
- 0x11 string
- 0x12 double             (8bytes)

