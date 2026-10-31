import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manageOttlogAuth } from './ottlog-auth.mjs';
import { createOttlogClient } from './ottlog-client.mjs';

test('authorization maintenance CLI executes through the deployed current directory link', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-grant-cli-'));
  try {
    const configFile = join(folder, 'revoked.json'), current = join(folder, 'current');
    await writeFile(configFile, JSON.stringify({ origin: 'https://blog.example', expectedUserName: 'owner', expectedAdmin: false, authMode: 'bot', botRevokedAt: 'test' }));
    await symlink(fileURLToPath(new URL('.', import.meta.url)), current, 'junction');
    await assert.rejects(promisify(execFile)(process.execPath, [join(current, 'ottlog-auth.mjs'), 'status', '--config', configFile], { windowsHide: true }), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, /机器人授权已撤销/); return true;
    });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('independent blog grant replaces Cookies, uses scoped Bearer routes and never falls back after revocation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ottbot-grant-'));
  const configFile = join(folder, 'ottlog.json');
  const token = 'ottb_' + 't'.repeat(43), grantId = 'test-grant';
  let revoked = false, cookieRequests = 0, puts = 0, saved = null;
  await writeFile(configFile, JSON.stringify({ origin: 'https://blog.example', expectedUserName: 'owner', expectedAdmin: false, cookies: { session: 'test-login-cookie' } }));
  const transport = async (url, init) => {
    const bot = url.pathname.startsWith('/api/bot/');
    if (bot) {
      assert.equal(init.headers.Authorization, 'Bearer ' + token);
      assert.equal(init.headers.Cookie, undefined); assert.equal(init.headers['X-CSRF-TOKEN'], undefined);
      if (revoked) return new Response(null, { status: 401 });
    } else { cookieRequests++; assert.equal(init.headers.Cookie, 'session=test-login-cookie'); }
    if (url.pathname === '/api/account/bot-grants') {
      assert.equal(init.headers['X-CSRF-TOKEN'], 'test-csrf');
      return Response.json({ id: grantId, name: 'Ottbot', token }, { status: 201 });
    }
    if (url.pathname.endsWith('/session')) return Response.json({ authenticated: true, userName: 'owner', isAdmin: false, csrfToken: bot ? undefined : 'test-csrf', grantId, name: 'Ottbot' });
    if (url.pathname === '/api/bot/grant') { revoked = true; return new Response(null, { status: 204 }); }
    if (init.method === 'PUT') { puts++; saved = JSON.parse(init.body).data; }
    return Response.json({ data: saved });
  };
  try {
    const message = await manageOttlogAuth({ action: 'bind', configFile, transport });
    assert.ok(!message.includes(token));
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(config.authMode, 'bot'); assert.equal(config.botGrantId, grantId); assert.equal(config.cookies, undefined);
    if (process.platform !== 'win32') assert.equal((await stat(configFile)).mode & 0o777, 0o600);
    const client = await createOttlogClient(configFile, transport);
    assert.equal(await client.read('todos'), null);
    await client.write('todos', null, { tasks: [] }); assert.equal(puts, 1);
    assert.match(await manageOttlogAuth({ action: 'status', configFile, transport }), /有效/);
    await assert.rejects(manageOttlogAuth({ action: 'revoke', configFile, transport }), /--confirm/);
    await manageOttlogAuth({ action: 'revoke', confirm: true, configFile, transport });
    await assert.rejects(client.read('todos'), /撤销/);
    await assert.rejects(client.write('todos', saved, {}), /撤销/);
    await assert.rejects(createOttlogClient(configFile, transport), /不会回退/);
    assert.equal(puts, 1); assert.equal(cookieRequests, 2);
    assert.equal((await readFile(configFile, 'utf8')).includes(token), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
