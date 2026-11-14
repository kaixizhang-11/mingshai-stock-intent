const SESSION_DAYS = 7;
const encoder = new TextEncoder();

function accountJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

function db(env) {
  if (!env.DB?.prepare) throw new Error('账号数据库尚未连接');
  return env.DB;
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordHash(password, salt, pepper) {
  if (!pepper) throw new Error('账号加密密钥尚未配置');
  const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mixed = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(password));
  const key = await crypto.subtle.importKey('raw', mixed, 'PBKDF2', false, ['deriveBits']);
  return base64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(salt), iterations: 100000 }, key, 256)));
}

function equalBytes(a, b) {
  const left = unbase64(a); const right = unbase64(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function rateLimit(database, key, max, windowMs) {
  const period = Math.floor(Date.now() / windowMs);
  const scope = `${key}:${period}`;
  await database.prepare('INSERT INTO request_rates (key, period, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1').bind(scope, period).run();
  const row = await database.prepare('SELECT count FROM request_rates WHERE key = ?').bind(scope).first();
  if (Math.random() < 0.01) {
    await database.prepare('DELETE FROM request_rates WHERE key LIKE ? AND period < ?').bind(`${key.split(':')[0]}:%`, period - 2).run();
    await database.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  }
  return row.count <= max;
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  return request.headers.get('sec-fetch-site') !== 'cross-site';
}

function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `ms_session=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookie(request) {
  return sessionCookie('', request).replace(/Max-Age=\d+/, 'Max-Age=0');
}

async function createSession(database, userId, request) {
  const token = base64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const now = Date.now();
  await database.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), userId, now, now + SESSION_DAYS * 86400000).run();
  return sessionCookie(token, request);
}

async function currentUser(request, env) {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)ms_session=([^;]+)/)?.[1];
  if (!token) return null;
  const row = await db(env).prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').bind(await sha256(token), Date.now()).first();
  return row ? { id: row.id, email: row.email } : null;
}

function validConditions(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(item => item && METRICS.has(item.metric) && ['gt', 'gte', 'lt', 'lte', 'between'].includes(item.op) && Number.isFinite(item.value) && (item.op !== 'between' || Number.isFinite(item.max)));
}

async function accountRoute(request, env, url) {
  const database = db(env);
  const path = url.pathname;
  const method = request.method;
  if (method !== 'GET' && !sameOrigin(request)) return accountJson({ error: '跨站请求被拒绝' }, 403);
  if (path === '/api/session' && method === 'GET') return accountJson({ user: await currentUser(request, env) });

  if ((path === '/api/auth/register' || path === '/api/auth/login') && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return accountJson({ error: '请输入有效邮箱地址' }, 400);
    if (password.length > 128) return accountJson({ error: '密码长度不能超过 128 个字符' }, 400);
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const identity = await sha256(`${ip}:${email}`);
    const limit = path.endsWith('register') ? 5 : 10;
    if (!await rateLimit(database, `${path}:${identity}`, limit, path.endsWith('register') ? 3600000 : 900000)) return accountJson({ error: '尝试次数过多，请稍后再试' }, 429);
    if (!await rateLimit(database, `${path}:ip:${await sha256(ip)}`, path.endsWith('register') ? 20 : 100, path.endsWith('register') ? 3600000 : 900000)) return accountJson({ error: '当前网络请求过于频繁，请稍后再试' }, 429);
    if (path.endsWith('register')) {
      if (password.length < 12 || password.length > 128) return accountJson({ error: '密码长度须为 12–128 个字符' }, 400);
      let stage = 'lookup';
      try {
        const existing = await database.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) return accountJson({ error: '此邮箱已注册，请登录' }, 409);
        stage = 'random';
        const id = crypto.randomUUID();
        const salt = base64(crypto.getRandomValues(new Uint8Array(16)));
        stage = 'hash';
        const hash = await passwordHash(password, salt, env.AUTH_PEPPER);
        stage = 'insert';
        try { await database.prepare('INSERT INTO users (id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, email, salt, hash, Date.now()).run(); }
        catch { return accountJson({ error: '邮箱已注册或注册失败' }, 409); }
        stage = 'session';
        return accountJson({ user: { id, email } }, 201, { 'set-cookie': await createSession(database, id, request) });
      } catch (error) {
        console.error('MINGSHAI_REGISTER_ERROR', stage, error?.name || 'Error', error?.message || 'unknown');
        return accountJson({ error: '注册服务暂不可用', code: `register_${stage}` }, 503);
      }
    }
    const user = await database.prepare('SELECT id, email, password_salt, password_hash FROM users WHERE email = ?').bind(email).first();
    const candidate = await passwordHash(password, user?.password_salt || base64(new Uint8Array(16)), env.AUTH_PEPPER);
    if (!user || !equalBytes(candidate, user.password_hash)) return accountJson({ error: '邮箱或密码不正确' }, 401);
    return accountJson({ user: { id: user.id, email: user.email } }, 200, { 'set-cookie': await createSession(database, user.id, request) });
  }

  const user = await currentUser(request, env);
  if (!user) return accountJson({ error: '请先登录账号' }, 401);
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = request.headers.get('cookie')?.match(/(?:^|;\s*)ms_session=([^;]+)/)?.[1];
    if (token) await database.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return accountJson({ ok: true }, 200, { 'set-cookie': clearCookie(request) });
  }
  if (path === '/api/account' && method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    if (!password || password.length > 128) return accountJson({ error: '请输入当前密码' }, 400);
    const row = await database.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').bind(user.id).first();
    if (!row || !equalBytes(await passwordHash(password, row.password_salt, env.AUTH_PEPPER), row.password_hash)) return accountJson({ error: '密码不正确' }, 403);
    await database.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
    return accountJson({ deleted: true }, 200, { 'set-cookie': clearCookie(request) });
  }

  if (path === '/api/strategies' && method === 'GET') {
    const result = await database.prepare('SELECT id, title, prompt, conditions_json, assumptions_json, created_at, updated_at FROM strategies WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50').bind(user.id).all();
    return accountJson({ strategies: result.results.map(row => ({ id: row.id, title: row.title, text: row.prompt, conditions: JSON.parse(row.conditions_json), assumptions: JSON.parse(row.assumptions_json), createdAt: row.created_at, updatedAt: row.updated_at })) });
  }
  if (path === '/api/strategies' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!validConditions(body.conditions)) return accountJson({ error: '策略条件无效，至少需要一条可执行条件' }, 400);
    const title = String(body.title || body.text || '未命名策略').trim().slice(0, 80);
    const prompt = String(body.text || '').slice(0, 500);
    const assumptions = Array.isArray(body.assumptions) ? body.assumptions.slice(0, 8).map(x => String(x).slice(0, 160)) : [];
    const id = crypto.randomUUID(); const now = Date.now();
    await database.prepare('INSERT INTO strategies (id, user_id, title, prompt, conditions_json, assumptions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, user.id, title, prompt, JSON.stringify(body.conditions), JSON.stringify(assumptions), now, now).run();
    return accountJson({ id, title, savedAt: now }, 201);
  }
  const match = path.match(/^\/api\/strategies\/([0-9a-f-]{36})$/);
  if (match && method === 'DELETE') {
    const result = await database.prepare('DELETE FROM strategies WHERE id = ? AND user_id = ?').bind(match[1], user.id).run();
    return accountJson({ deleted: result.meta?.changes || 0 });
  }
  return accountJson({ error: '未知账号接口' }, 404);
}
