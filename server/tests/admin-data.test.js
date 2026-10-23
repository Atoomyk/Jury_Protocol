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

function makeConfig() {
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
  });
}

async function startServer() {
  const db = openDatabase(':memory:');
  createAdmin(db, 'admin', await hashPassword(PASSWORD));
  const app = createApp({ db, config: makeConfig() });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await login(base);
  return {
    db,
    base,
    cookie: session.cookie,
    csrf: session.csrf,
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

async function login(base) {
  const r = await request(base, 'POST', '/api/v1/admin/auth/login', {
    body: { login: 'admin', password: PASSWORD },
  });
  const line = (r.headers['set-cookie'] || []).find(c => c.startsWith('lz_admin='));
  return { cookie: line.split(';')[0], csrf: r.json.csrfToken };
}

// Удобные обёртки с сессией.
function api(s, method, path, body) {
  return request(s.base, method, path, { body, cookie: s.cookie, csrf: s.csrf });
}

function revision(db) {
  return db.prepare('SELECT revision FROM app_state WHERE id = 1').get().revision;
}

test('без сессии данные конкурса недоступны (401), без CSRF изменение запрещено (403)', async () => {
  const s = await startServer();
  try {
    const noSession = await request(s.base, 'GET', '/api/v1/admin/blocks');
    assert.equal(noSession.status, 401);
    const noCsrf = await request(s.base, 'POST', '/api/v1/admin/judges', {
      body: { fullName: 'Иванов' }, cookie: s.cookie,
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
  }
});

test('блоки: жанр только из списка; смена жанра заблокирована при участниках', async () => {
  const s = await startServer();
  try {
    const bad = await api(s, 'POST', '/api/v1/admin/blocks', { title: 'Б1', genre: 'Цирк' });
    assert.equal(bad.status, 400);

    const b = await api(s, 'POST', '/api/v1/admin/blocks', { title: 'Б1', genre: 'Вокал' });
    assert.equal(b.status, 201);
    const blockId = b.json.block.id;

    const p = await api(s, 'POST', '/api/v1/admin/participants', {
      blockId, number: 1, name: 'Ансамбль', groupSize: 3,
    });
    assert.equal(p.status, 201);

    const changeGenre = await api(s, 'PATCH', `/api/v1/admin/blocks/${blockId}`, {
      title: 'Б1', genre: 'Театр',
    });
    assert.equal(changeGenre.status, 409);
    assert.equal(changeGenre.json.error, 'genre_locked');
  } finally {
    await s.close();
  }
});

test('блок нельзя удалить, пока в нём участники', async () => {
  const s = await startServer();
  try {
    const b = await api(s, 'POST', '/api/v1/admin/blocks', { title: 'Б', genre: 'Театр' });
    const blockId = b.json.block.id;
    await api(s, 'POST', '/api/v1/admin/participants', {
      blockId, number: 5, name: 'Х', groupSize: 1,
    });
    const del = await api(s, 'DELETE', `/api/v1/admin/blocks/${blockId}`);
    assert.equal(del.status, 409);
  } finally {
    await s.close();
  }
});

test('назначения судей: от 2 до 8; снятый судья сохраняет оценки и не считается активным', async () => {
  const s = await startServer();
  try {
    const b = await api(s, 'POST', '/api/v1/admin/blocks', { title: 'Б', genre: 'Инструментал' });
    const blockId = b.json.block.id;
    const judgeIds = [];
    for (let i = 1; i <= 9; i++) {
      const j = await api(s, 'POST', '/api/v1/admin/judges', { fullName: `Судья ${i}` });
      judgeIds.push(j.json.judge.id);
    }

    const tooFew = await api(s, 'PUT', `/api/v1/admin/blocks/${blockId}/judges`, { judgeIds: [judgeIds[0]] });
    assert.equal(tooFew.status, 400);
    const tooMany = await api(s, 'PUT', `/api/v1/admin/blocks/${blockId}/judges`, { judgeIds });
    assert.equal(tooMany.status, 400, '9 судей — больше максимума 8');

    const ok = await api(s, 'PUT', `/api/v1/admin/blocks/${blockId}/judges`, { judgeIds: judgeIds.slice(0, 3) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.judges.filter(j => j.active).length, 3);

    // Снимаем судью с блока: строка остаётся, active=0.
    const reduced = await api(s, 'PUT', `/api/v1/admin/blocks/${blockId}/judges`, { judgeIds: judgeIds.slice(0, 2) });
    assert.equal(reduced.status, 200);
    const removed = s.db.prepare(
      'SELECT active FROM assignments WHERE block_id = ? AND judge_id = ?'
    ).get(blockId, judgeIds[2]);
    assert.equal(removed.active, 0, 'строка назначения сохранена, судья снят');
  } finally {
    await s.close();
  }
});

test('судья с оценками нельзя удалить (409)', async () => {
  const s = await startServer();
  try {
    const b = await api(s, 'POST', '/api/v1/admin/blocks', { title: 'Б', genre: 'Театр' });
    const j1 = await api(s, 'POST', '/api/v1/admin/judges', { fullName: 'Петров' });
    const j2 = await api(s, 'POST', '/api/v1/admin/judges', { fullName: 'Сидоров' });
    const blockId = b.json.block.id;
    const judgeId = j1.json.judge.id;
    const put = await api(s, 'PUT', `/api/v1/admin/blocks/${blockId}/judges`, {
      judgeIds: [judgeId, j2.json.judge.id],
    });
    assert.equal(put.status, 200);
    const del = await api(s, 'DELETE', `/api/v1/admin/judges/${judgeId}`);
    assert.equal(del.status, 409, 'судья связан с назначением');
  } finally {
    await s.close();
  }
});

test('участники: номер уникален среди неудалённых; soft-delete освобождает номер; оценки остаются', async () => {
  const s = await startServer();
  try {
    const b = await api(s, 'POST', '/api/v1/admin/blocks', { title: 'Б', genre: 'Вокал' });
    const blockId = b.json.block.id;

    const first = await api(s, 'POST', '/api/v1/admin/participants', {
      blockId, number: 7, name: 'Первый', groupSize: 1,
    });
    assert.equal(first.status, 201);
    const participantId = first.json.participant.id;

    const dup = await api(s, 'POST', '/api/v1/admin/participants', {
      blockId, number: 7, name: 'Второй', groupSize: 1,
    });
    assert.equal(dup.status, 409);

    // Оценка от судьи для участника.
    const j = await api(s, 'POST', '/api/v1/admin/judges', { fullName: 'Судья' });
    s.db.prepare(`
      INSERT INTO scores (competition_id, participant_id, judge_id, change_id, version, criteria_json, created_at, received_at)
      VALUES (1, ?, ?, 'test-change-1', 1, '{}', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    `).run(participantId, j.json.judge.id);

    const del = await api(s, 'DELETE', `/api/v1/admin/participants/${participantId}`);
    assert.equal(del.status, 200);

    const list = await api(s, 'GET', `/api/v1/admin/blocks/${blockId}/participants`);
    assert.equal(list.json.participants.length, 0, 'удалённый скрыт из выдачи');

    const score = s.db.prepare('SELECT COUNT(*) AS n FROM scores WHERE participant_id = ?').get(participantId);
    assert.equal(score.n, 1, 'оценка сохранена');

    const reuse = await api(s, 'POST', '/api/v1/admin/participants', {
      blockId, number: 7, name: 'Новый', groupSize: 2,
    });
    assert.equal(reuse.status, 201, 'номер 7 свободен после soft-delete');
  } finally {
    await s.close();
  }
});

test('группа: groupSize 1..50; номер и имя валидируются', async () => {
  const s = await startServer();
  try {
    const b = await api(s, 'POST', '/api/v1/admin/blocks', { title: 'Б', genre: 'Хореография' });
    const blockId = b.json.block.id;
    const zero = await api(s, 'POST', '/api/v1/admin/participants', {
      blockId, number: 1, name: 'X', groupSize: 0,
    });
    assert.equal(zero.status, 400);
    const noName = await api(s, 'POST', '/api/v1/admin/participants', {
      blockId, number: 2, name: '   ', groupSize: 1,
    });
    assert.equal(noName.status, 400);
  } finally {
    await s.close();
  }
});

test('изменения увеличивают ревизию конкурса', async () => {
  const s = await startServer();
  try {
    const before = revision(s.db);
    await api(s, 'POST', '/api/v1/admin/judges', { fullName: 'Ревизия' });
    assert.equal(revision(s.db), before + 1);
  } finally {
    await s.close();
  }
});
