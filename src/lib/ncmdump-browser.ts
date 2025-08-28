import * as CryptoJS from 'crypto-js';

/**
 * Browser-only NCM decoder.
 * Port of scripts/ncmdump.js without Node APIs.
 */

export interface DumpResult {
  blob: Blob;
  filename: string;
  format: string;
  meta: any;
}

const CORE_KEY_HEX = '687A4852416D736F356B496E62617857';
const META_KEY_HEX = '2331346C6A6B5F215C5D2630553C2728';

const textDecoder = new TextDecoder('utf-8');

function u8ToWordArray(u8: Uint8Array): CryptoJS.lib.WordArray {
  const words: number[] = [];
  let i = 0;
  const len = u8.length;
  while (i < len) {
    words.push(
      ((u8[i++] ?? 0) << 24) | ((u8[i++] ?? 0) << 16) | ((u8[i++] ?? 0) << 8) | (u8[i++] ?? 0)
    );
  }
  return CryptoJS.lib.WordArray.create(words, len);
}

function wordArrayToU8(wa: CryptoJS.lib.WordArray): Uint8Array {
  const { words, sigBytes } = wa;
  const out = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i++) {
    out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return out;
}

function aes128EcbDecrypt(data: Uint8Array, keyHex: string): Uint8Array {
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const ciphertext = u8ToWordArray(data);
  const decrypted = CryptoJS.AES.decrypt({ ciphertext }, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return wordArrayToU8(decrypted);
}

function mimeFromFormat(format: string): string {
  switch (format.toLowerCase()) {
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'm4a':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Decode a .ncm file buffer in the browser.
 * @param input ArrayBuffer or Uint8Array of the .ncm file
 * @param opts Optional { sourceFileName } to influence output filename
 */
export function dumpNcm(
  input: ArrayBuffer | Uint8Array,
  opts?: { sourceFileName?: string }
): DumpResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;

  // Header "CTENFDAM"
  const expected = [0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d];
  for (let i = 0; i < 8; i++) if (bytes[i] !== expected[i]) throw new Error('Invalid NCM header');
  offset += 8;

  // skip 2 bytes
  offset += 2;

  // key data
  const keyLength = view.getUint32(offset, true);
  offset += 4;
  const keyDataXored = bytes.slice(offset, offset + keyLength);
  offset += keyLength;
  for (let i = 0; i < keyDataXored.length; i++) keyDataXored[i] ^= 0x64;
  const keyDecrypted = aes128EcbDecrypt(keyDataXored, CORE_KEY_HEX).subarray(17);

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
  const metaLength = view.getUint32(offset, true);
  offset += 4;
  const metaDataXored = bytes.slice(offset, offset + metaLength);
  offset += metaLength;
  for (let i = 0; i < metaDataXored.length; i++) metaDataXored[i] ^= 0x63;

  const metaB64 = textDecoder.decode(metaDataXored.subarray(22));
  const metaEncrypted = Uint8Array.from(atob(metaB64), (c) => c.charCodeAt(0));
  const metaPlain = aes128EcbDecrypt(metaEncrypted, META_KEY_HEX);
  const metaJson = JSON.parse(textDecoder.decode(metaPlain).slice(6));

  // crc32 + unknown 5 + image
  /* const crc32 = */ view.getUint32(offset, true);
  offset += 4;
  offset += 5;
  const imageSize = view.getUint32(offset, true);
  offset += 4;
  // skip image data
  offset += imageSize;

  // decode audio data
  const audioIn = bytes.subarray(offset);
  const audioOut = new Uint8Array(audioIn.length);
  for (let i = 0; i < audioIn.length; i++) {
    const j = (i + 1) & 0xff;
    const idx = (keyBox[j] + keyBox[(keyBox[j] + j) & 0xff]) & 0xff;
    audioOut[i] = audioIn[i] ^ keyBox[idx];
  }

  const format = (metaJson.format || 'mp3').toLowerCase();
  const base = (opts?.sourceFileName || 'output.ncm').replace(/\.ncm$/i, '');
  const filename = `${base}.${format}`;
  const blob = new Blob([audioOut], { type: mimeFromFormat(format) });

  return { blob, filename, format, meta: metaJson };
}

/**
 * Convenience helper: decode directly from a File object.
 */
export async function dumpNcmFile(file: File): Promise<DumpResult> {
  const buf = await file.arrayBuffer();
  return dumpNcm(buf, { sourceFileName: file.name });
}
