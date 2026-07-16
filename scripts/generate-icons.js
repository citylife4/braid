import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function insideRoundedSquare(x, y, size, radius) {
  const innerX = Math.max(radius, Math.min(size - radius - 1, x));
  const innerY = Math.max(radius, Math.min(size - radius - 1, y));
  return (x - innerX) ** 2 + (y - innerY) ** 2 <= radius ** 2;
}

function makePng(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, color) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const at = (y * size + x) * 4;
    pixels[at] = color[0];
    pixels[at + 1] = color[1];
    pixels[at + 2] = color[2];
    pixels[at + 3] = color[3] ?? 255;
  };

  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (insideRoundedSquare(x, y, size, radius)) set(x, y, [17, 24, 39, 255]);
    }
  }

  const colors = [[66, 203, 213], [76, 154, 255], [70, 195, 90]];
  const left = Math.round(size * 0.16);
  const right = Math.round(size * 0.84);
  const thickness = Math.max(1, Math.round(size * 0.075));
  const radiusSquared = (thickness / 2) ** 2;
  for (let row = 0; row < 3; row += 1) {
    for (let x = left; x <= right; x += 1) {
      const progress = (x - left) / (right - left);
      const centerY = size * (0.25 + row * 0.25)
        + Math.sin(progress * Math.PI * 2 + row * Math.PI / 2) * size * 0.055;
      for (let dy = -thickness; dy <= thickness; dy += 1) {
        for (let dx = -thickness; dx <= thickness; dx += 1) {
          if (dx ** 2 + dy ** 2 <= radiusSquared) set(x + dx, Math.round(centerY) + dy, colors[row]);
        }
      }
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowAt = y * (size * 4 + 1);
    raw[rowAt] = 0;
    pixels.copy(raw, rowAt + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 32, 48, 256];
const images = sizes.map(makePng);
const iconHeader = Buffer.alloc(6 + images.length * 16);
iconHeader.writeUInt16LE(0, 0);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(images.length, 4);
let offset = iconHeader.length;
images.forEach((image, index) => {
  const at = 6 + index * 16;
  iconHeader[at] = sizes[index] === 256 ? 0 : sizes[index];
  iconHeader[at + 1] = sizes[index] === 256 ? 0 : sizes[index];
  iconHeader[at + 2] = 0;
  iconHeader[at + 3] = 0;
  iconHeader.writeUInt16LE(1, at + 4);
  iconHeader.writeUInt16LE(32, at + 6);
  iconHeader.writeUInt32LE(image.length, at + 8);
  iconHeader.writeUInt32LE(offset, at + 12);
  offset += image.length;
});

const output = path.resolve('build');
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'icon.ico'), Buffer.concat([iconHeader, ...images]));
writeFileSync(path.join(output, 'icon.png'), images.at(-1));
console.log('generated build/icon.ico and build/icon.png');
