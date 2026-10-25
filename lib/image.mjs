import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskError } from './errors.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
function structuredPng(bytes) {
  let position = 8,
    header = false,
    pixels = false;
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position);
    const kind = bytes.toString('ascii', position + 4, position + 8);
    if (length > bytes.length - position - 12) return false;
    if (!header) {
      if (
        kind !== 'IHDR' ||
        length !== 13 ||
        !bytes.readUInt32BE(position + 8) ||
        !bytes.readUInt32BE(position + 12)
      )
        return false;
      header = true;
    } else if (kind === 'IHDR') return false;
    if (kind === 'IDAT' && length) pixels = true;
    position += length + 12;
    if (kind === 'IEND') return length === 0 && pixels && position === bytes.length;
  }
  return false;
}

function structuredJpeg(bytes) {
  if (bytes.length < 16 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
  let position = 2,
    frame = false;
  while (position + 4 <= bytes.length) {
    if (bytes[position++] !== 255) return false;
    while (bytes[position] === 255) position++;
    if (position + 3 > bytes.length) return false;
    const marker = bytes[position++];
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8 || !bytes.readUInt16BE(position + 3) || !bytes.readUInt16BE(position + 5)) return false;
      frame = true;
    }
    if (marker === 218) return frame && length >= 6 && position + length < bytes.length - 2;
    position += length;
  }
  return false;
}
export function validateImagePayload(payload, outPath) {
  if (
    !payload ||
    typeof payload.base64 !== 'string' ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.base64) ||
    payload.base64.length % 4 !== 0 ||
    payload.base64.length > Math.ceil(MAX_BYTES / 3) * 4
  )
    throw new TaskError('IMAGE_INVALID', 'Invalid or oversized image payload');
  const bytes = Buffer.from(payload.base64, 'base64');
  let mime;
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    structuredPng(bytes)
  )
    mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && structuredJpeg(bytes)) mime = 'image/jpeg';
  else if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length &&
    bytes.length >= 25 &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) &&
    bytes.readUInt32LE(16) > 0 &&
    bytes.readUInt32LE(16) <= bytes.length - 20
  )
    mime = 'image/webp';
  else throw new TaskError('IMAGE_INVALID', 'Downloaded content has no supported image signature');
  if (payload.mime?.split(';')[0].trim().toLowerCase() !== mime)
    throw new TaskError('IMAGE_INVALID', 'Image MIME type does not match its byte signature');
  const expected = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[extname(outPath).toLowerCase()];
  if (!expected || expected !== mime)
    throw new TaskError(
      'IMAGE_EXTENSION',
      `Output extension does not match ${mime}; select a matching .png, .jpg or .webp path`,
    );
  return bytes;
}

export async function saveImagePayload(payload, outPath) {
  const bytes = validateImagePayload(payload, outPath);
  await mkdir(dirname(outPath), { recursive: true });
  const temporary = `${outPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, outPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes.length;
}
