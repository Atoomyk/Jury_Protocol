'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db/database');
const { createApp } = require('../src/app');
const { createAdmin } = require('../src/db/admins');
const { hashPassword } = require('../src/utils/crypto');

// Тестовые пароли случайные, создаются при каждом запуске, нигде не сохраняются.
function randomPassword() {
  return 'T-' + crypto.randomBytes(12).toString('base64url');
}
const PASSWORD = randomPassword();
const WRONG_PASSWORD = randomPassword();
const NEW_PASSWORD = randomPassword();

function makeConfig(overrides = {}) {
  return Object.freeze({
    nodeEnv: 'test',
    port: 0,
    publicOrigin: 'https://example.test',
    databasePath: ':memory:',
    invitationExpiresAt: '2030-01-01T00:00:00.000Z',
    sessionTtlHours: 12,
    loginMaxAttempts: 100,
    loginWindowMinutes: 15,
    trustProxy: 0,
    ...overrides,
  });
}

async function startServer(config) {
  const db = openDatabase(':memory:');
  const hash = await hashPassword(PASSWORD);
  createAdmin(db, 'admin', hash);
  const app = createApp({ db, config });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    db,
    base,
    close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); })),
  };
}

function request(base, method, path, { body, cookie, csrf } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers = {};
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    const req = http.request(url, { method, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookie(res) {
  const sc = res.headers['set-cookie'] || [];
  const line = sc.find(s => s.startsWith('lz_admin='));
  return line ? line.split(';')[0] : null;
}

test('health отвечает без авторизации', async () => {
  const s = await startServer(makeConfig());
  try {
    const r = await request(s.base, 'GET', '/api/v1/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  } finally {
    await s.close();
  }
});

test('без сессии админские маршруты отвечают 401', async () => {
  const s = await startServer(makeConfig());
  try {
    const r1 = await request(s.base, 'GET', '/api/v1/admin/auth/session');
    assert.equal(r1.status, 401);
    const r2 = await request(s.base, 'POST', '/api/v1/admin/auth/logout', { body: {} });
    assert.equal(r2.status, 401);
  } finally {
    await s.close();
  }
});

test('логин выставляет cookie с HttpOnly, Secure, SameSite=Strict', async () => {
  const s = await startServer(makeConfig());
  try {
    const r = await request(s.base, 'POST', '/api/v1/admin/auth/login', {
      body: { login: 'admin', password: PASSWORD },
    });
    assert.equal(r.status, 200);
    assert.ok(r.json.csrfToken);
    const setCookie = (r.headers['set-cookie'] || []).find(c => c.startsWith('lz_admin='));
    assert.ok(setCookie, 'cookie выставлена');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
  } finally {
    await s.close();
  }
});

test('в БД сохраняется только Argon2id-хеш пароля и хеш токена сессии', async () => {
  const s = await startServer(makeConfig());
  try {
    const r = await request(s.base, 'POST', '/api/v1/admin/auth/login', {
      body: { login: 'admin', password: PASSWORD },
    });
    const row = s.db.prepare('SELECT password_hash FROM admin_users WHERE login = ?').get('admin');
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
    const cookie = sessionCookie(r);
    const raw = decodeURIComponent(cookie.split('=')[1]);
    const sess = s.db.prepare('SELECT id, csrf_hash FROM admin_sessions').all();
    assert.equal(sess.length, 1);
    assert.notEqual(sess[0].id, raw, 'в БД не сам токен');
    assert.equal(sess[0].id.length, 64, 'SHA-256 hex');
  } finally {
    await s.close();
  }
});

test('неверный пароль и неизвестный логин дают одинаковый ответ 401', async () => {
  const s = await startServer(makeConfig());
  try {
    const a = await request(s.base, 'POST', '/api/v1/admin/auth/login', {
      body: { login: 'admin', password: WRONG_PASSWORD },
    });
    const b = await request(s.base, 'POST', '/api/v1/admin/auth/login', {
      body: { login: 'nobody', password: WRONG_PASSWORD },
    });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(a.json, b.json);
  } finally {
    await s.close();
  }
});

test('сессия: GET session возвращает данные и новый CSRF; logout закрывает сессию', async () => {
  const s = await startServer(makeConfig());
  try {
    const login = await request(s.base, 'POST', '/api/v1/admin/auth/login', {
      body: { login: 'admin', password: PASSWORD },
    });
    const cookie = sessionCookie(login);

    const sess = await request(s.base, 'GET', '/api/v1/admin/auth/session', { cookie });
    assert.equal(sess.status, 200);
    assert.equal(sess.json.login, 'admin');
    assert.ok(sess.json.csrfToken);

    // logout без CSRF — 403
    const noCsrf = await request(s.base, 'POST', '/api/v1/admin/auth/logout', { body: {}, cookie });
    assert.equal(noCsrf.status, 403);

    // со старым CSRF — тоже 403 (ротирован при GET session)
    const oldCsrf = await request(s.base, 'POST', '/api/v1/admin/auth/logout', {
      body: {}, cookie, csrf: login.json.csrfToken,
    });
    assert.equal(oldCsrf.status, 403);

    const ok = await request(s.base, 'POST', '/api/v1/admin/auth/logout', {
      body: {}, cookie, csrf: sess.json.csrfToken,
    });
    assert.equal(ok.status, 200);

    const after = await request(s.base, 'GET', '/api/v1/admin/auth/session', { cookie });
    assert.equal(after.status, 401);
  } finally {
    await s.close();
  }
});

test('смена пароля: неверный текущий — 403; успешная — закрывает другие сессии', async () => {
  const s = await startServer(makeConfig());
  try {
    const a = await request(s.base, 'POST', '/api/v1/admin/auth/login', {
      body: { login: 'admin', password: PASSWORD },
    });
    const b = await request(s.base, 'POST', '/api/v1/admin/auth/login', {
      body: { login: 'admin', password: PASSWORD },
    });
    const cookieA = sessionCookie(a);
    const cookieB = sessionCookie(b);
    const sessA = await request(s.base, 'GET', '/api/v1/admin/auth/session', { cookie: cookieA });

    const bad = await request(s.base, 'POST', '/api/v1/admin/auth/password', {
      body: { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD },
      cookie: cookieA, csrf: sessA.json.csrfToken,
    });
    assert.equal(bad.status, 403);

    const ok = await request(s.base, 'POST', '/api/v1/admin/auth/password', {
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      cookie: cookieA, csrf: sessA.json.csrfToken,
    });
    assert.equal(ok.status, 200);

    const otherSession = await request(s.base, 'GET', '/api/v1/admin/auth/session', { cookie: cookieB });
    assert.equal(otherSession.status, 401);
    const currentSession = await request(s.base, 'GET', '/api/v1/admin/auth/session', { cookie: cookieA });
    assert.equal(currentSession.status, 200);
  } finally {
    await s.close();
  }
});

test('неизвестный API-маршрут — JSON 404', async () => {
  const s = await startServer(makeConfig());
  try {
    const r = await request(s.base, 'GET', '/api/v1/unknown');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not_found');
  } finally {
    await s.close();
  }
});
