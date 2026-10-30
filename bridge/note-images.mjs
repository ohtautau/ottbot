import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MAX_NOTE_IMAGE_BYTES } from './ottlog-shared.mjs';

export async function compressNoteImages(images) {
  const result = [];
  for (const image of images) {
    const dataUrl = image.dataUrl;
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) throw new Error('图片格式不支持。');
    let bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (bytes.length > MAX_NOTE_IMAGE_BYTES) {
      bytes = await new Promise((accept, reject) => {
        const child = spawn(process.env.OTTBOT_IMAGE_PYTHON || 'python3', [fileURLToPath(new URL('./note-images.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const chunks = []; let size = 0;
        const timer = setTimeout(() => child.kill(), 20000);
        child.on('error', () => { clearTimeout(timer); reject(new Error('图片压缩服务不可用，未保存便签。')); });
        child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_NOTE_IMAGE_BYTES) child.kill(); else chunks.push(chunk); });
        child.stdin.on('error', () => {}); child.stdin.end(bytes);
        child.on('close', code => { clearTimeout(timer); code === 0 && size > 0 && size <= MAX_NOTE_IMAGE_BYTES ? accept(Buffer.concat(chunks)) : reject(new Error('图片压缩失败，未保存便签；请压缩后重发。')); });
      });
      result.push({ id: 'bot-image-' + randomUUID(), dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') });
    } else result.push({ id: 'bot-image-' + randomUUID(), dataUrl });
  }
  return result;
}
