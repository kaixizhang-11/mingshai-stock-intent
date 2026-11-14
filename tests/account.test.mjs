import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
import { createLocalDb } from '../scripts/local-db.mjs';

const accountEnv = DB => ({ DB, AUTH_PEPPER: 'test-pepper-only' });

const base = 'https://example.test';
const password = 'long-unique-password-2026';
const request = (path, method = 'GET', body, cookie, extra = {}) => new Request(`${base}${path}`, {
  method,
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

async function register(DB, email) {
  const response = await worker.fetch(request('/api/auth/register', 'POST', { email, password }), accountEnv(DB));
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

test('registration creates a durable session; login and logout work', async () => {
  const DB = createLocalDb();
  const cookie = await register(DB, 'one@example.com');
  assert.match(cookie, /^ms_session=/);
  const session = await worker.fetch(request('/api/session', 'GET', null, cookie), accountEnv(DB));
  assert.equal((await session.json()).user.email, 'one@example.com');
  const wrong = await worker.fetch(request('/api/auth/login', 'POST', { email: 'one@example.com', password: 'wrong-password' }), accountEnv(DB));
  assert.equal(wrong.status, 401);
  const login = await worker.fetch(request('/api/auth/login', 'POST', { email: 'one@example.com', password }), accountEnv(DB));
  assert.equal(login.status, 200);
  const freshCookie = login.headers.get('set-cookie').split(';')[0];
  const logout = await worker.fetch(request('/api/auth/logout', 'POST', null, freshCookie), accountEnv(DB));
  assert.equal(logout.status, 200);
  const after = await worker.fetch(request('/api/session', 'GET', null, freshCookie), accountEnv(DB));
  assert.equal((await after.json()).user, null);
  DB.close();
});

test('saved strategies are isolated by user and survive a new session', async () => {
  const DB = createLocalDb();
  const first = await register(DB, 'first@example.com');
  const second = await register(DB, 'second@example.com');
  const conditions = [{ metric: 'pe_ttm', op: 'lte', value: 25, label: '估值' }];
  const save = await worker.fetch(request('/api/strategies', 'POST', { title: '估值研究', text: 'PE不超过25', conditions }, first), accountEnv(DB));
  assert.equal(save.status, 201);
  const id = (await save.json()).id;
  const own = await worker.fetch(request('/api/strategies', 'GET', null, first), accountEnv(DB));
  assert.equal((await own.json()).strategies[0].id, id);
  const other = await worker.fetch(request('/api/strategies', 'GET', null, second), accountEnv(DB));
  assert.equal((await other.json()).strategies.length, 0);
  const forbiddenDelete = await worker.fetch(request(`/api/strategies/${id}`, 'DELETE', null, second), accountEnv(DB));
  assert.equal((await forbiddenDelete.json()).deleted, 0);
  const login = await worker.fetch(request('/api/auth/login', 'POST', { email: 'first@example.com', password }), accountEnv(DB));
  const newCookie = login.headers.get('set-cookie').split(';')[0];
  const again = await worker.fetch(request('/api/strategies', 'GET', null, newCookie), accountEnv(DB));
  assert.equal((await again.json()).strategies.length, 1);
  DB.close();
});

test('auth rejects weak passwords and cross-site writes', async () => {
  const DB = createLocalDb();
  const weak = await worker.fetch(request('/api/auth/register', 'POST', { email: 'weak@example.com', password: 'short' }), accountEnv(DB));
  assert.equal(weak.status, 400);
  const cross = await worker.fetch(request('/api/auth/register', 'POST', { email: 'cross@example.com', password }, null, { origin: 'https://other.test' }), accountEnv(DB));
  assert.equal(cross.status, 403);
  const anonymous = await worker.fetch(request('/api/strategies'), accountEnv(DB));
  assert.equal(anonymous.status, 401);
  DB.close();
});

test('registration is rate limited across different emails from one IP', async () => {
  const DB = createLocalDb();
  for (let index = 0; index < 20; index++) {
    const response = await worker.fetch(request('/api/auth/register', 'POST', { email: `weak-${index}@example.com`, password: 'short' }), accountEnv(DB));
    assert.equal(response.status, 400);
  }
  const blocked = await worker.fetch(request('/api/auth/register', 'POST', { email: 'weak-21@example.com', password: 'short' }), accountEnv(DB));
  assert.equal(blocked.status, 429);
  DB.close();
});

test('account deletion removes private strategies and invalidates session', async () => {
  const DB = createLocalDb();
  const cookie = await register(DB, 'delete@example.com');
  const save = await worker.fetch(request('/api/strategies', 'POST', { conditions: [{ metric: 'pe_ttm', op: 'lte', value: 25 }] }, cookie), accountEnv(DB));
  assert.equal(save.status, 201);
  const wrong = await worker.fetch(request('/api/account', 'DELETE', { password: 'wrong-password-123' }, cookie), accountEnv(DB));
  assert.equal(wrong.status, 403);
  const deleted = await worker.fetch(request('/api/account', 'DELETE', { password }, cookie), accountEnv(DB));
  assert.equal(deleted.status, 200);
  const session = await worker.fetch(request('/api/session', 'GET', null, cookie), accountEnv(DB));
  assert.equal((await session.json()).user, null);
  const count = await DB.prepare('SELECT count(*) AS n FROM strategies').first();
  assert.equal(count.n, 0);
  DB.close();
});
