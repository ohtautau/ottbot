import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { trustedWeixinUrl, decodeImage, formatWeixinText, sendWeixinImages, receiptText } from './weixin.mjs';

test('receipt acknowledges tasks before media download without repeating controls or sensitive inputs', () => {
  for (const text of ['你好', '/pc 做任务', '/img photo.png', '/img', '//普通聊天']) assert.equal(receiptText(text), '收到，正在处理…');
  assert.equal(receiptText('', [{ type: 2 }]), '收到，正在处理…');
  for (const text of ['/h', '/m 2', '/st', '/api add', '/api cancel', '/cl', '/unknown']) assert.equal(receiptText(text), '');
  assert.equal(receiptText('', [{ type: 3, voice_item: { text: '/h' } }]), '');
});

test('Weixin menus use stable paragraph breaks without changing alignment or model replies', () => {
  const menu = '【默认执行端】\r\n\r\n/t srv   服务器  ← 当前\r\n/t pc    电脑';
  const expected = '【默认执行端】\n\n/t srv   服务器  ← 当前\n\n/t pc    电脑';
  assert.equal(formatWeixinText(menu, true), expected);
  assert.equal(formatWeixinText(expected, true), expected);
  assert.equal(formatWeixinText(menu.replace(/\r/g, ''), true), expected);
  const answer = '说明\n```js\nconst a = 1;\n```';
  assert.equal(formatWeixinText(answer), answer);
  assert.ok(formatWeixinText(('一行\n').repeat(2000), true).length <= 3800);
});

test('Weixin URLs reject non-Tencent hosts, redirects, plaintext and credentials', () => {
  assert.equal(trustedWeixinUrl('https://ilinkai.weixin.qq.com/ilink/bot/getupdates').hostname, 'ilinkai.weixin.qq.com');
  assert.equal(trustedWeixinUrl('https://novac2c.cdn.weixin.qq.com/c2c/download').protocol, 'https:');
  for (const url of ['http://ilinkai.weixin.qq.com/', 'https://127.0.0.1/', 'https://weixin.qq.com.evil.example/', 'https://user:password@ilinkai.weixin.qq.com/', 'https://ilinkai.weixin.qq.com:4433/']) assert.throws(() => trustedWeixinUrl(url));
});

test('plaintext and encrypted images with both documented key encodings', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ6kAAAAASUVORK5CYII=', 'base64');
  const expected = 'data:image/png;base64,' + png.toString('base64');
  assert.equal(decodeImage(png, {}), expected);
  const key = randomBytes(16);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  assert.equal(decodeImage(encrypted, { aeskey: key.toString('hex') }), expected);
  assert.equal(decodeImage(encrypted, { media: { aes_key: key.toString('base64') } }), expected);
  assert.equal(decodeImage(encrypted, { media: { aes_key: Buffer.from(key.toString('hex')).toString('base64') } }), expected);
  assert.throws(() => decodeImage(Buffer.from('not an image'), {}));
  assert.throws(() => decodeImage(encrypted, { media: { aes_key: 'invalid' } }));
});

test('outbound images upload encrypted originals and send only to the bound conversation', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ6kAAAAASUVORK5CYII=', 'base64');
  const account = { owner: 'test-owner', token: 'test-not-real-bot-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const message = { from_user_id: account.owner, message_type: 1, context_token: 'test-context' };
  const images = [{ data: bytes.toString('base64') }];
  for (const full of [true, false]) {
    let metadata, sent, uploaded = 0;
    const request = async (base, path, body, token) => {
      assert.equal(base, account.baseUrl); assert.equal(token, account.token);
      if (path.endsWith('getuploadurl')) {
        metadata = body;
        assert.equal(body.rawsize, bytes.length);
        assert.equal(body.rawfilemd5, createHash('md5').update(bytes).digest('hex'));
        assert.equal(body.no_need_thumb, true);
        return full ? { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?test=1' } : { upload_param: 'test-param+/=' };
      }
      assert.ok(path.endsWith('sendmessage')); sent = body.msg; return { ret: 0 };
    };
    const transport = async (url, init) => {
      uploaded++;
      if (!full) assert.equal(new URL(url).searchParams.get('encrypted_query_param'), 'test-param+/=');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.body.length, metadata.filesize);
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(metadata.aeskey, 'hex'), null);
      assert.deepEqual(Buffer.concat([decipher.update(init.body), decipher.final()]), bytes);
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'test-download' } });
    };
    assert.equal(await sendWeixinImages(account, message, images, { request, transport }), 1);
    assert.equal(uploaded, 1);
    assert.equal(sent.to_user_id, account.owner);
    assert.equal(sent.context_token, message.context_token);
    assert.equal(sent.item_list[0].type, 2);
    assert.equal(sent.item_list[0].image_item.media.encrypt_query_param, 'test-download');
    assert.equal(Buffer.from(sent.item_list[0].image_item.media.aes_key, 'base64').toString(), metadata.aeskey);
  }
  let calls = 0;
  const forbidden = { request: async () => { calls++; }, transport: async () => { calls++; } };
  await assert.rejects(sendWeixinImages(account, { ...message, from_user_id: 'someone-else' }, images, forbidden), /私聊/);
  await assert.rejects(sendWeixinImages(account, { ...message, group_id: 'group' }, images, forbidden), /私聊/);
  assert.equal(calls, 0);
  const request = async () => ({ upload_full_url: 'https://example.com/steal' });
  await assert.rejects(sendWeixinImages(account, message, images, { request, transport: forbidden.transport }), /图片发送未完成/);
  assert.equal(calls, 0);
  let uploads = 0;
  await assert.rejects(sendWeixinImages(account, message, images, {
    request: async () => ({ upload_param: 'test' }),
    transport: async () => { uploads++; return new Response('', { status: 403 }); },
  }), /0\/1/);
  assert.equal(uploads, 1);
  uploads = 0;
  await assert.rejects(sendWeixinImages(account, message, images, {
    request: async () => ({ upload_param: 'test' }),
    transport: async () => { uploads++; return new Response('', { status: 200 }); },
  }), /0\/1/);
  assert.equal(uploads, 3);
});
