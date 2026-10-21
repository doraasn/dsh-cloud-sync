/**
 * 零依赖 tar（ustar + GNU longname）读写，配合 node:zlib 做 .tar.gz。
 *
 * 只实现本插件用得到的部分：普通文件、目录、GNU 'L' 长文件名、校验和。
 * 目的是让归档能被系统 tar / 7-Zip / bsdtar 直接解开核对，而不是自定义容器。
 */
import zlib from 'node:zlib';

const BLOCK = 512;

function octal(value, length) {
  const text = Math.max(0, value | 0).toString(8);
  return text.padStart(length - 1, '0') + '\0';
}

function writeString(buf, offset, length, text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > length) throw new Error(`tar 字段超长: ${text}`);
  bytes.copy(buf, offset);
}

function makeHeader({ name, size = 0, mode = 0o644, mtime = Date.now() / 1000, typeflag = '0' }) {
  const buf = Buffer.alloc(BLOCK, 0);
  // 长名先尝试 ustar 的 name/prefix 切分，切不动就由调用方用 GNU longname
  writeString(buf, 0, 100, name);
  writeString(buf, 100, 8, octal(mode, 8));
  writeString(buf, 108, 8, octal(0, 8));
  writeString(buf, 116, 8, octal(0, 8));
  writeString(buf, 124, 12, octal(size, 12));
  writeString(buf, 136, 12, octal(Math.floor(mtime), 12));
  buf.write('        ', 148, 8, 'utf8'); // 校验和先填空格
  writeString(buf, 156, 1, typeflag);
  writeString(buf, 257, 8, 'ustar\0');
  writeString(buf, 263, 2, '00');
  let sum = 0;
  for (const byte of buf) sum += byte;
  writeString(buf, 148, 8, octal(sum, 7).slice(0, 7) + ' ');

  return buf;
}

function fitsUstar(name) {
  return Buffer.byteLength(name, 'utf8') <= 100;
}

/** 把若干 { path, data, mode, dir } 打成 tar 字节流。 */
export function packTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const name = entry.dir ? entry.path.replace(/\/*$/, '/') : entry.path;
    const data = entry.dir ? Buffer.alloc(0) : entry.data;
    if (!fitsUstar(name)) {
      // GNU longname：一个 'L' 记录携带真实名字，紧随其后的头用截断名占位
      const longName = Buffer.from(name + '\0', 'utf8');
      chunks.push(makeHeader({ name: '././@LongLink', size: longName.length, typeflag: 'L' }));
      chunks.push(longName);
      const pad = (BLOCK - (longName.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad));
      const truncated = Buffer.from(name, 'utf8').subarray(0, 100).toString('utf8');
      chunks.push(makeHeader({ name: truncated, size: data.length, mode: entry.mode, mtime: entry.mtime, typeflag: entry.dir ? '5' : '0' }));
    } else {
      chunks.push(makeHeader({ name, size: data.length, mode: entry.mode, mtime: entry.mtime, typeflag: entry.dir ? '5' : '0' }));
    }
    if (!entry.dir) {
      chunks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function parseOctal(buf, offset, length) {
  const text = buf.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  return text ? parseInt(text, 8) : 0;
}

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** 解析 tar 字节流；返回 [{ path, data, dir }]，忽略 GNU longname 记录本身。 */
export function unpackTar(buf) {
  const out = [];
  let offset = 0;
  let pendingName = null;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const stored = parseOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== stored) throw new Error(`tar 头校验和不匹配 @${offset}（期望 ${stored}，实得 ${sum}）`);

    const rawName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const typeflag = readString(header, 156, 1) || '0';
    const size = parseOctal(header, 124, 12);
    const name = pendingName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingName = null;
    offset += BLOCK;

    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;
    const data = buf.subarray(offset, offset + size);
    offset += dataBlocks;

    if (typeflag === 'L') {
      pendingName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === '5') {
      out.push({ path: name.replace(/\/*$/, '/'), data: Buffer.alloc(0), dir: true });
      continue;
    }
    if (typeflag === '0' || typeflag === '\0') {
      out.push({ path: name, data: Buffer.from(data), dir: false });
    }
    // 其余类型（链接/xattr 等）本插件不产生，直接忽略
  }
  return out;
}

export function gzip(buf) {
  return zlib.gzipSync(buf, { level: 9 });
}

export function gunzip(buf) {
  return zlib.gunzipSync(buf);
}

export function packTarGz(entries) {
  return gzip(packTar(entries));
}

export function unpackTarGz(buf) {
  return unpackTar(gunzip(buf));
}
