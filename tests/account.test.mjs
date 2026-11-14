import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
import { createLocalDb } from '../scripts/local-db.mjs';

const base = 'https://example.test';
const password = 'long-unique-password-2026';
const request = (path, method = 'GET', body, cookie, extra = {}) => new Request(`${base}${path}`, {
  method,
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

async function register(DB, email) {
  const response = await worker.fetch(request('/api/auth/register', 'POST', { email, password }), { DB });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

test('registration creates a durable session; login and logout work', async () => {
  const DB = createLocalDb();
  const cookie = await register(DB, 'one@example.com');
  assert.match(cookie, /^ms_session=/);
  const session = await worker.fetch(request('/api/session', 'GET', null, cookie), { DB });
  assert.equal((await session.json()).user.email, 'one@example.com');
  const wrong = await worker.fetch(request('/api/auth/login', 'POST', { email: 'one@example.com', password: 'wrong-password' }), { DB });
  assert.equal(wrong.status, 401);
  const login = await worker.fetch(request('/api/auth/login', 'POST', { email: 'one@example.com', password }), { DB });
  assert.equal(login.status, 200);
  const freshCookie = login.headers.get('set-cookie').split(';')[0];
  const logout = await worker.fetch(request('/api/auth/logout', 'POST', null, freshCookie), { DB });
  assert.equal(logout.status, 200);
  const after = await worker.fetch(request('/api/session', 'GET', null, freshCookie), { DB });
  assert.equal((await after.json()).user, null);
  DB.close();
});

test('saved strategies are isolated by user and survive a new session', async () => {
  const DB = createLocalDb();
  const first = await register(DB, 'first@example.com');
  const second = await register(DB, 'second@example.com');
  const conditions = [{ metric: 'pe_ttm', op: 'lte', value: 25, label: '估值' }];
  const save = await worker.fetch(request('/api/strategies', 'POST', { title: '估值研究', text: 'PE不超过25', conditions }, first), { DB });
  assert.equal(save.status, 201);
  const id = (await save.json()).id;
  const own = await worker.fetch(request('/api/strategies', 'GET', null, first), { DB });
  assert.equal((await own.json()).strategies[0].id, id);
  const other = await worker.fetch(request('/api/strategies', 'GET', null, second), { DB });
  assert.equal((await other.json()).strategies.length, 0);
  const forbiddenDelete = await worker.fetch(request(`/api/strategies/${id}`, 'DELETE', null, second), { DB });
  assert.equal((await forbiddenDelete.json()).deleted, 0);
  const login = await worker.fetch(request('/api/auth/login', 'POST', { email: 'first@example.com', password }), { DB });
  const newCookie = login.headers.get('set-cookie').split(';')[0];
  const again = await worker.fetch(request('/api/strategies', 'GET', null, newCookie), { DB });
  assert.equal((await again.json()).strategies.length, 1);
  DB.close();
});

test('auth rejects weak passwords and cross-site writes', async () => {
  const DB = createLocalDb();
  const weak = await worker.fetch(request('/api/auth/register', 'POST', { email: 'weak@example.com', password: 'short' }), { DB });
  assert.equal(weak.status, 400);
  const cross = await worker.fetch(request('/api/auth/register', 'POST', { email: 'cross@example.com', password }, null, { origin: 'https://other.test' }), { DB });
  assert.equal(cross.status, 403);
  const anonymous = await worker.fetch(request('/api/strategies'), { DB });
  assert.equal(anonymous.status, 401);
  DB.close();
});

test('account deletion removes private strategies and invalidates session', async () => {
  const DB = createLocalDb();
  const cookie = await register(DB, 'delete@example.com');
  const save = await worker.fetch(request('/api/strategies', 'POST', { conditions: [{ metric: 'pe_ttm', op: 'lte', value: 25 }] }, cookie), { DB });
  assert.equal(save.status, 201);
  const wrong = await worker.fetch(request('/api/account', 'DELETE', { password: 'wrong-password-123' }, cookie), { DB });
  assert.equal(wrong.status, 403);
  const deleted = await worker.fetch(request('/api/account', 'DELETE', { password }, cookie), { DB });
  assert.equal(deleted.status, 200);
  const session = await worker.fetch(request('/api/session', 'GET', null, cookie), { DB });
  assert.equal((await session.json()).user, null);
  const count = await DB.prepare('SELECT count(*) AS n FROM strategies').first();
  assert.equal(count.n, 0);
  DB.close();
});
