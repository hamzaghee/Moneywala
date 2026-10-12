// Generates solid-design PNG icons (192/512) without any dependencies.
// Design mirrors icon.svg: teal rounded square with a light circle.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const TEAL = [15, 118, 110];
const LIGHT = [236, 253, 245];
const TRANSPARENT = [0, 0, 0, 0];

function inRoundedSquare(x, y, S, rad) {
  const cx = Math.min(Math.max(x, rad), S - rad);
  const cy = Math.min(Math.max(y, rad), S - rad);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function render(S) {
  const px = Buffer.alloc(S * S * 4);
  const rad = S * (96 / 512);
  const c = S / 2;
  const r = S * (184 / 512);
  const halfStroke = S * (12 / 512) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let col = null;
      if (inRoundedSquare(x, y, S, rad)) {
        col = TEAL;
        const d = Math.hypot(x - c, y - c);
        if (d <= r - halfStroke) col = LIGHT;
        else if (d <= r + halfStroke) col = TEAL;
      }
      const o = (y * S + x) * 4;
      px[o] = col ? col[0] : TRANSPARENT[0];
      px[o + 1] = col ? col[1] : TRANSPARENT[1];
      px[o + 2] = col ? col[2] : TRANSPARENT[2];
      px[o + 3] = col ? 255 : 0;
    }
  }
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public');
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(`wrote ${file} (${fs.statSync(file).size} bytes)`);
}
