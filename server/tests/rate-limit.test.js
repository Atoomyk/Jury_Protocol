'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db/database');
const { createApp } = require('../src/app');
const { createAdmin } = require('../src/db/admins');
const { hashPassword } = require('../src/utils/crypto');

function randomPassword() {
  return 'T-' + crypto.randomBytes(12).toString('base64url');
}
const PASSWORD = randomPassword();
const WRONG_PASSWORD = randomPassword();

function makeConfig(overrides = {}) {
  return Object.freeze({
    nodeEnv: 'test',
    port: 0,
    publicOrigin: 'https://example.test',
    databasePath: ':memory:',
    invitationExpiresAt: '2030-01-01T00:00:00.000Z',
    sessionTtlHours: 12,
    loginMaxAttempts: 3,
    loginWindowMinutes: 15,
    trustProxy: 0,
    ...overrides,
  });
}

function postLogin(base, password) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ login: 'admin', password });
    const req = http.request(new URL('/api/v1/admin/auth/login', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function startServer(config) {
  const db = openDatabase(':memory:');
  createAdmin(db, 'admin', await hashPassword(PASSWORD));
  const app = createApp({ db, config });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); })),
  };
}

test('после LOGIN_MAX_ATTEMPTS неудачных попыток вход блокируется (429)', async () => {
  const s = await startServer(makeConfig({ loginMaxAttempts: 3 }));
  try {
    for (let i = 0; i < 3; i++) {
      const r = await postLogin(s.base, WRONG_PASSWORD);
      assert.equal(r.status, 401, `попытка ${i + 1}`);
    }
    const blocked = await postLogin(s.base, PASSWORD);
    assert.equal(blocked.status, 429, 'даже верный пароль заблокирован в окне');
    assert.match(blocked.body, /too_many_attempts/);
  } finally {
    await s.close();
  }
});

test('успешные входы не расходуют лимит неудачных попыток', async () => {
  const s = await startServer(makeConfig({ loginMaxAttempts: 2 }));
  try {
    for (let i = 0; i < 4; i++) {
      const r = await postLogin(s.base, PASSWORD);
      assert.equal(r.status, 200, `успешный вход ${i + 1}`);
    }
  } finally {
    await s.close();
  }
});
