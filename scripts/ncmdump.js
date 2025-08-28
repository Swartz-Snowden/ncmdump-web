import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// JS port of scripts/ncmdump.py
// Decodes NetEase .ncm files into their original audio format

export function dump(filePath) {
  const coreKey = Buffer.from('687A4852416D736F356B496E62617857', 'hex');
  const metaKey = Buffer.from('2331346C6A6B5F215C5D2630553C2728', 'hex');

  const data = fs.readFileSync(filePath);
  let offset = 0;

  // header
  const header = data.subarray(offset, offset + 8);
  offset += 8;
  if (header.toString('hex') !== '4354454e4644414d') {
    throw new Error(`Invalid NCM header for ${filePath}`);
  }

  // skip 2 bytes
  offset += 2;

  // key data
  const keyLength = data.readUInt32LE(offset);
  offset += 4;
  const keyDataXored = Buffer.from(data.subarray(offset, offset + keyLength));
  offset += keyLength;
  for (let i = 0; i < keyDataXored.length; i++) keyDataXored[i] ^= 0x64;

  const decipherKey = crypto.createDecipheriv('aes-128-ecb', coreKey, null);
  // default autoPadding = true (PKCS#7)
  const keyDecrypted = Buffer.concat([decipherKey.update(keyDataXored), decipherKey.final()]).subarray(17);

  // build key_box
  const keyBox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) keyBox[i] = i;
  let c = 0;
  let lastByte = 0;
  let keyOffset = 0;
  for (let i = 0; i < 256; i++) {
    const swap = keyBox[i];
    c = (swap + lastByte + keyDecrypted[keyOffset]) & 0xff;
    keyOffset += 1;
    if (keyOffset >= keyDecrypted.length) keyOffset = 0;
    keyBox[i] = keyBox[c];
    keyBox[c] = swap;
    lastByte = c;
  }

  // meta data
  const metaLength = data.readUInt32LE(offset);
  offset += 4;
  const metaDataXored = Buffer.from(data.subarray(offset, offset + metaLength));
  offset += metaLength;
  for (let i = 0; i < metaDataXored.length; i++) metaDataXored[i] ^= 0x63;

  const metaB64 = metaDataXored.subarray(22).toString('utf8');
  const metaEncrypted = Buffer.from(metaB64, 'base64');
  const decipherMeta = crypto.createDecipheriv('aes-128-ecb', metaKey, null);
  const metaPlain = Buffer.concat([decipherMeta.update(metaEncrypted), decipherMeta.final()]);
  const metaJson = JSON.parse(metaPlain.toString('utf8').slice(6));

  // crc32 + unknown 5 + image
  /* const crc32 = */ data.readUInt32LE(offset);
  offset += 4;
  offset += 5;
  const imageSize = data.readUInt32LE(offset);
  offset += 4;
  // skip image data
  offset += imageSize;

  // output file name
  const format = metaJson.format || 'mp3';
  const outFileName = path.basename(filePath).replace(/\.ncm$/i, '') + '.' + format;
  const outPath = path.join(path.dirname(filePath), outFileName);

  // decode and write audio data synchronously in chunks of 0x8000
  const fd = fs.openSync(outPath, 'w');
  try {
    const CHUNK = 0x8000;
    for (let pos = offset; pos < data.length; pos += CHUNK) {
      const end = Math.min(pos + CHUNK, data.length);
      const chunk = Buffer.from(data.subarray(pos, end));
      const len = chunk.length;
      for (let i = 1; i <= len; i++) {
        const j = i & 0xff;
        const idx = (keyBox[j] + keyBox[(keyBox[j] + j) & 0xff]) & 0xff;
        chunk[i - 1] = chunk[i - 1] ^ keyBox[idx];
      }
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }

  return outPath;
}

// Basic wildcard expansion for patterns like "/path/*.ncm" (no recursive ** support)
function expandPaths(arg) {
  if (!/[\*\?]/.test(arg)) return [arg];
  const baseDir = path.dirname(arg);
  const pattern = path.basename(arg);
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${esc}$`);
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => re.test(e) && fs.statSync(path.join(baseDir, e)).isFile())
    .map((e) => path.join(baseDir, e));
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node scripts/ncmdump.js <filepath|pattern> [more ...]');
    process.exit(1);
  }
  const targets = args.flatMap((a) => expandPaths(a));
  if (targets.length === 0) {
    console.error('No files matched.');
    process.exit(2);
  }
  for (const file of targets) {
    try {
      const out = dump(file);
      console.log(`Decoded: ${file} -> ${out}`);
    } catch (err) {
      console.error(`Failed: ${file}\n${err instanceof Error ? err.stack : String(err)}`);
    }
  }
}
