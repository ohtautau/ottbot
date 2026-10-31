import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MAX_NOTE_IMAGE_BYTES } from './ottlog-shared.mjs';

export const MAX_WEIXIN_COMPAT_BYTES = 48 * 1024;

async function compress(bytes, limit, weixin = false) {
  return new Promise((accept, reject) => {
    const args = [fileURLToPath(new URL('./note-images.py', import.meta.url)), ...(weixin ? ['--weixin'] : [])];
    const child = spawn(process.env.OTTBOT_IMAGE_PYTHON || 'python3', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = []; let size = 0;
    const failure = () => new Error(weixin ? '图片兼容压缩失败。' : '图片压缩失败，未保存便签；请压缩后重发。');
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', () => { clearTimeout(timer); reject(failure()); });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > limit) child.kill(); else chunks.push(chunk); });
    child.stdin.on('error', () => {}); child.stdin.end(bytes);
    child.on('close', code => { clearTimeout(timer); code === 0 && size > 0 && size <= limit ? accept(Buffer.concat(chunks)) : reject(failure()); });
  });
}

export async function compressWeixinImage(bytes) {
  return compress(bytes, MAX_WEIXIN_COMPAT_BYTES, true);
}

export async function compressNoteImages(images) {
  const result = [];
  for (const image of images) {
    const dataUrl = image.dataUrl;
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) throw new Error('图片格式不支持。');
    let bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (bytes.length > MAX_NOTE_IMAGE_BYTES) {
      bytes = await compress(bytes, MAX_NOTE_IMAGE_BYTES);
      result.push({ id: 'bot-image-' + randomUUID(), dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') });
    } else result.push({ id: 'bot-image-' + randomUUID(), dataUrl });
  }
  return result;
}
