import { open, realpath, readdir, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename } from 'node:path';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REPLY_BYTES = 20 * 1024 * 1024;
export const MAX_REPLY_IMAGES = 4;

export async function generatedImages(config) {
  const images = [];
  let scanned = 0;
  async function visit(directory, depth = 0) {
    if (depth > 4 || scanned > 1000) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (++scanned > 1000) break;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(path, depth + 1);
      else if (entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name)) {
        const info = await stat(path);
        if (info.size > 0 && info.size <= MAX_IMAGE_BYTES) images.push({ path, modifiedAt: info.mtimeMs });
      }
    }
  }
  for (const root of config.imageRoots || []) await visit(root);
  return images.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 8);
}

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('图片格式不支持，请使用 PNG、JPEG 或 WebP。');
}

export function validateReplyImages(images) {
  if (!Array.isArray(images) || images.length > MAX_REPLY_IMAGES) throw new Error('每条回复最多发送四张图片。');
  let total = 0;
  return images.map(image => {
    if (typeof image?.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('图片数据无效或超过10MB。');
    const bytes = Buffer.from(image.data, 'base64');
    total += bytes.length;
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > MAX_REPLY_BYTES) throw new Error('图片过大：单张最多10MB，每条回复合计最多20MB。');
    return { bytes, mime: imageMime(bytes) };
  });
}

export async function readReplyImage(path, config) {
  try {
    const workspace = config.workspace && await realpath(config.workspace);
    const roots = [workspace, ...(config.imageRoots || []).map(root => resolve(root))].filter(Boolean);
    if (!roots.length || typeof path !== 'string' || !path.trim() || /^[a-z]+:\/\//i.test(path)) throw new Error();
    const candidate = await realpath(resolve(workspace || roots[0], path));
    let allowed = false;
    for (const root of roots) {
      let canonical;
      try { canonical = await realpath(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const subpath = relative(canonical, candidate);
      // Never export credentials or the bridge's private state as disguised images.
      if (subpath && !isAbsolute(subpath) && subpath !== '..' && !subpath.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
          && !subpath.split(/[\\/]/).some(part => /^(?:\.|local-state$|shared$|node_modules$)/i.test(part))) { allowed = true; break; }
    }
    if (!allowed) throw new Error();
    const file = await open(candidate, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error();
      const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_BYTES + 1));
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (!size || size > MAX_IMAGE_BYTES) throw new Error();
      const data = bytes.subarray(0, size);
      return { name: basename(candidate), mime: imageMime(data), data: data.toString('base64') };
    } finally { await file.close(); }
  } catch { throw new Error('图片无法发送：请使用执行端工作区内可读取的 PNG/JPEG/WebP 文件，单张不超过10MB；私有配置目录不能发送。'); }
}

function codeRanges(text) {
  const ranges = [];
  const fences = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
  let match;
  while ((match = fences.exec(text))) {
    const marker = match[1];
    const closing = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*(?:\\r?\\n|$)', 'gm');
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(text);
    ranges.push([match.index, end ? closing.lastIndex : text.length]);
    fences.lastIndex = end ? closing.lastIndex : text.length;
  }
  const inline = /(`+)([\s\S]*?)\1(?!`)/g;
  while ((match = inline.exec(text))) ranges.push([match.index, inline.lastIndex]);
  return ranges;
}

export async function imageReply(text, config) {
  const paths = [];
  const codes = codeRanges(text);
  const content = text.replace(/!\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\r\n)]+))\)/g, (match, angled, plain, offset) => {
    if (codes.some(([start, end]) => offset >= start && offset < end)) return match;
    const path = (angled || plain).trim();
    if (/^[a-z]+:\/\//i.test(path) || path.startsWith('data:')) return match;
    paths.push(path); return '';
  }).trim();
  if (!paths.length) return { text, images: [] };
  if (paths.length > MAX_REPLY_IMAGES) throw new Error('每条回复最多发送四张图片。');
  const images = [];
  for (const path of paths) images.push(await readReplyImage(path, config));
  validateReplyImages(images);
  return { text: content, images };
}
