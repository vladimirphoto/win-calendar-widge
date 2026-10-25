// Генерирует иконку календаря (PNG) без внешних зависимостей.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function makePng(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.2, pad = size * 0.06;
  const inRound = (x, y) => {
    const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const headerH = size * 0.30;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRound(x + 0.5, y + 0.5)) continue;
      let col = [255, 255, 255];                // тело
      if (y < pad + headerH) col = [0, 103, 192]; // шапка Windows-синий
      // сетка точек-дат
      const gx0 = size * 0.22, gy0 = size * 0.46, cell = size * 0.12, dot = size * 0.04;
      for (let row = 0; row < 3; row++) {
        for (let c = 0; c < 4; c++) {
          const dx = gx0 + c * (cell + size * 0.045) + cell / 2;
          const dy = gy0 + row * (cell + size * 0.03) + cell / 2;
          if ((x - dx) ** 2 + (y - dy) ** 2 <= (dot * 1.3) ** 2) {
            col = row === 1 && c === 2 ? [0, 103, 192] : [160, 170, 185];
          }
        }
      }
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { makePng };

if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, 'icon.png'), makePng(512));
  console.log('build/icon.png создан');
}
