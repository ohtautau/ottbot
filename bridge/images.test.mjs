import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { imageReply, readReplyImage, validateReplyImages, MAX_IMAGE_BYTES } from './images.mjs';
import { createWorker } from './worker.mjs';
import { createHub } from './hub.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ6kAAAAASUVORK5CYII=', 'base64');

test('outgoing image files are bounded, local, and inside the workspace after symlink resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ottbot-images-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const config = { workspace };
  try {
    await writeFile(join(workspace, 'food photo.png'), png);
    const image = await readReplyImage('food photo.png', config);
    assert.equal(image.data, png.toString('base64'));
    const reply = await imageReply(`这里是照片：\n![照片](<${join(workspace, 'food photo.png')}>)`, config);
    assert.equal(reply.text, '这里是照片：');
    assert.equal(reply.images.length, 1);
    assert.equal((await imageReply('![远程](https://example.com/photo.png)', config)).images.length, 0);
    const example = '语法：`![示例](missing.png)`\n```markdown\n![示例](missing.png)\n```\n~~~\n![示例](missing.png)\n~~~';
    assert.deepEqual(await imageReply(example, config), { text: example, images: [] });
    await writeFile(join(root, 'outside.png'), png);
    assert.equal((await readReplyImage(join(root, 'outside.png'), { workspace, imageRoots: [join(root, 'missing'), root] })).data, png.toString('base64'));
    assert.equal((await readReplyImage('food photo.png', { workspace, imageRoots: [join(root, 'missing')] })).data, png.toString('base64'));
    await mkdir(join(workspace, 'local-state'));
    await writeFile(join(workspace, 'local-state', 'private.png'), png);
    await writeFile(join(workspace, 'fake.png'), 'not an image');
    await writeFile(join(workspace, 'large.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    for (const path of ['../outside.png', 'local-state/private.png', 'fake.png', 'large.png', 'https://example.com/photo.png']) await assert.rejects(readReplyImage(path, config), /图片无法发送/);
    if (process.platform !== 'win32') {
      await symlink(join(root, 'outside.png'), join(workspace, 'link.png'));
      await assert.rejects(readReplyImage('link.png', config), /图片无法发送/);
    }
    assert.throws(() => validateReplyImages([{ data: Buffer.from('secret').toString('base64') }]), /图片格式/);
    assert.throws(() => validateReplyImages(Array(5).fill(image)), /四张/);
    const oversized = { data: Buffer.concat([png, Buffer.alloc(7 * 1024 * 1024)]).toString('base64') };
    assert.throws(() => validateReplyImages([oversized, oversized, oversized]), /合计最多20MB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hub carries images from both executors; direct sends skip inference and API text cannot read local files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-image-route-'));
  const headers = { Authorization: 'Bearer test-image-private-token', 'Content-Type': 'application/json' };
  const servers = [];
  let calls = 0;
  try {
    await writeFile(join(folder, 'photo.png'), png);
    const providers = { custom: { enabled: true, apiKey: 'test-not-real-api-key', endpoint: 'https://api.example.com/v1/chat/completions', defaultModel: 'example' } };
    const startWorker = async target => {
      const worker = await createWorker({ workspace: folder, runtimeDirectory: join(folder, target), workerToken: 'test-image-private-token', providers }, async () => { calls++; return '照片\n![照片](photo.png)'; });
      worker.listen(0, '127.0.0.1'); await once(worker, 'listening'); servers.push(worker); return worker;
    };
    const server = await startWorker('server'), computer = await startWorker('computer');
    const hub = await createHub({ runtimeDirectory: join(folder, 'hub'), workerToken: 'test-image-private-token', providers,
      serverWorkerUrl: `http://127.0.0.1:${server.address().port}`, computerWorkerUrl: `http://127.0.0.1:${computer.address().port}` });
    hub.listen(0, '127.0.0.1'); await once(hub, 'listening'); servers.unshift(hub);
    const base = `http://127.0.0.1:${hub.address().port}`;
    const chat = (text, stream = false) => fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'codex-local', messages: [{ role: 'user', content: text }], stream }) });
    for (const command of ['/img photo.png', '/pc /图片 photo.png', '/服务器 请发回照片', '/电脑 请发回照片']) {
      const response = await chat(command);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ottbot_images[0].data, png.toString('base64'));
      assert.ok(!result.choices[0].message.content.includes('!['));
    }
    assert.equal(calls, 2);
    const sse = await (await chat('/img photo.png', true)).text();
    assert.ok(sse.includes('ottbot_images') && sse.includes('[DONE]'));
    const rejected = await chat('/img ../outside.png');
    assert.equal(rejected.status, 502);
    assert.match((await rejected.json()).error.message, /图片无法发送/);
    assert.equal(calls, 2);
    await (await chat('/m custom/example')).body.cancel();
    const directUnderApi = await (await chat('/pc /img photo.png')).json();
    assert.equal(directUnderApi.ottbot_images[0].data, png.toString('base64'));
    assert.equal(calls, 2);
    const apiReply = await (await chat('hello')).json();
    assert.equal(apiReply.ottbot_images, undefined);
    assert.ok(apiReply.choices[0].message.content.includes('![照片]'));
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
