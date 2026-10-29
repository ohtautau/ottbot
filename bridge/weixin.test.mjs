import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { trustedWeixinUrl, decodeImage } from './weixin.mjs';

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
