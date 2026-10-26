'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db/database');
const { createApp } = require('../src/app');
const { createAdmin } = require('../src/db/admins');
const { hashPassword } = require('../src/utils/crypto');

const PASSWORD = 'T-' + crypto.randomBytes(12).toString('base64url');

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

function request(base, method, path, { body, cookie, csrf, bearer } = {}) {
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
    if (bearer) headers.authorization = `Bearer ${bearer}`;
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

// Обёртки с сессией администратора.
function api(s, method, path, body) {
  return request(s.base, method, path, { body, cookie: s.cookie, csrf: s.csrf });
}

// Обёртки с токеном устройства судьи.
function judgeApi(s, method, path, { bearer, body } = {}) {
  return request(s.base, method, path, { bearer, body });
}

async function createJudge(s, fullName) {
  const r = await api(s, 'POST', '/api/v1/admin/judges', { fullName });
  assert.equal(r.status, 201, r.json && r.json.message);
  return r.json.judge.id;
}

async function createBlock(s, title, genre) {
  const r = await api(s, 'POST', '/api/v1/admin/blocks', { title, genre });
  assert.equal(r.status, 201, r.json && r.json.message);
  return r.json.block.id;
}

async function createParticipant(s, blockId, { number = 1, name = 'Участник', groupSize = 1 } = {}) {
  const r = await api(s, 'POST', '/api/v1/admin/participants', { blockId, number, name, groupSize });
  assert.equal(r.status, 201, r.json && r.json.message);
  return r.json.participant.id;
}

async function invite(s, judgeIds) {
  const r = await api(s, 'POST', '/api/v1/admin/invitations', { judgeIds });
  assert.equal(r.status, 201, r.json && r.json.message);
  return r.json.invitations;
}

async function authJudge(s, token) {
  return judgeApi(s, 'POST', '/api/v1/judge/auth', { body: { token } });
}

const VOCAL_CRITERIA = {
  impression: 8, stageImage: 9, repertoire: 7, school: 8, delivery: 9,
};

test('администратор выпускает приглашения для 10 судей: токены уникальны, URL содержит judge_token', async () => {
  const s = await startServer();
  try {
    const judgeIds = [];
    for (let i = 1; i <= 10; i++) judgeIds.push(await createJudge(s, `Судья ${i}`));

    const invitations = await invite(s, judgeIds);
    assert.equal(invitations.length, 10);
    const tokens = invitations.map(i => i.token);
    assert.equal(new Set(tokens).size, 10, 'токены уникальны');
    for (const inv of invitations) {
      assert.equal(inv.judgeId > 0, true);
      assert.ok(inv.fullName);
      assert.match(inv.url, /\?judge_token=/);
      assert.equal(inv.expiresAt, '2030-01-01T00:00:00.000Z');
    }

    // В БД только хеши токенов.
    const rows = s.db.prepare('SELECT token_hash FROM judge_invitations').all();
    assert.equal(rows.length, 10);
    for (const row of rows) {
      assert.match(row.token_hash, /^[0-9a-f]{64}$/);
      assert.ok(!tokens.includes(row.token_hash));
    }

    const status = await api(s, 'GET', '/api/v1/admin/invitations');
    assert.equal(status.status, 200);
    assert.equal(status.json.judges.length, 10);
    assert.equal(status.json.judges.filter(j => j.invitationIssuedAt).length, 10);
    assert.equal(status.json.judges.filter(j => j.deviceBound).length, 0);
  } finally {
    await s.close();
  }
});

test('вход по QR одноразовый: второй вход тем же токеном отклоняется', async () => {
  const s = await startServer();
  try {
    const judgeId = await createJudge(s, 'Петров');
    const [inv] = await invite(s, [judgeId]);

    const first = await authJudge(s, inv.token);
    assert.equal(first.status, 201);
    assert.ok(first.json.deviceToken);
    assert.equal(first.json.judge.id, judgeId);
    // В БД хранится только хеш токена устройства.
    const device = s.db.prepare('SELECT token_hash, status FROM judge_devices WHERE judge_id = ?').get(judgeId);
    assert.equal(device.status, 'active');
    assert.notEqual(device.token_hash, first.json.deviceToken);

    const second = await authJudge(s, inv.token);
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'token_used');

    const status = await api(s, 'GET', '/api/v1/admin/invitations');
    const row = status.json.judges.find(j => j.id === judgeId);
    assert.equal(row.deviceBound, true);

    const st = await judgeApi(s, 'GET', '/api/v1/judge/state', { bearer: first.json.deviceToken });
    assert.equal(st.status, 200);
    assert.equal(st.json.changed, true);
  } finally {
    await s.close();
  }
});

test('перевыпуск QR отзывает старое устройство; новое устройство работает по новому токену', async () => {
  const s = await startServer();
  try {
    const judgeId = await createJudge(s, 'Сидоров');
    const [inv1] = await invite(s, [judgeId]);
    const auth1 = await authJudge(s, inv1.token);
    assert.equal(auth1.status, 201);

    const [inv2] = await invite(s, [judgeId]);
    assert.ok(inv2.token);
    assert.notEqual(inv2.token, inv1.token);

    const oldState = await judgeApi(s, 'GET', '/api/v1/judge/state', { bearer: auth1.json.deviceToken });
    assert.equal(oldState.status, 401, 'старое устройство отозвано');

    const auth2 = await authJudge(s, inv2.token);
    assert.equal(auth2.status, 201);
    assert.notEqual(auth2.json.deviceToken, auth1.json.deviceToken);

    const newState = await judgeApi(s, 'GET', '/api/v1/judge/state', { bearer: auth2.json.deviceToken });
    assert.equal(newState.status, 200);
  } finally {
    await s.close();
  }
});

test('оценки: идемпотентность (duplicate), устаревшая версия (stale), новая версия (accepted); ревизия растёт', async () => {
  const s = await startServer();
  try {
    const blockId = await createBlock(s, 'Вокал', 'Вокал');
    const judge1 = await createJudge(s, 'Судья 1');
    const judge2 = await createJudge(s, 'Судья 2');
    const put = await api(s, 'PUT', `/api/v1/admin/blocks/${blockId}/judges`, { judgeIds: [judge1, judge2] });
    assert.equal(put.status, 200);
    const participantId = await createParticipant(s, blockId, { number: 1, name: 'Ансамбль', groupSize: 3 });

    const [inv] = await invite(s, [judge1]);
    const auth = await authJudge(s, inv.token);
    assert.equal(auth.status, 201);
    const bearer = auth.json.deviceToken;

    const st = await judgeApi(s, 'GET', '/api/v1/judge/state', { bearer });
    assert.equal(st.status, 200);
    const state = st.json.state;
    assert.equal(state.blocks.length, 1);
    assert.equal(state.participants.length, 1);
    assert.equal(state.participants[0].id, participantId);
    assert.equal(state.scores.length, 0);

    // Ревизия до изменений — для проверки since.
    const before = await api(s, 'GET', '/api/v1/admin/state');
    const revisionBefore = before.json.revision;

    const post = changes => judgeApi(s, 'POST', '/api/v1/judge/scores', { bearer, body: { changes } });

    const first = await post([{
      changeId: 'change-0001', participantId, version: 1, criteria: VOCAL_CRITERIA, comment: 'Хорошо',
    }]);
    assert.equal(first.status, 200);
    assert.equal(first.json.results[0].result, 'accepted');

    const again = await post([{
      changeId: 'change-0001', participantId, version: 1, criteria: VOCAL_CRITERIA,
    }]);
    assert.equal(again.json.results[0].result, 'duplicate');

    const stale = await post([{
      changeId: 'change-0002', participantId, version: 1, criteria: VOCAL_CRITERIA,
    }]);
    assert.equal(stale.json.results[0].result, 'stale');

    const newer = await post([{
      changeId: 'change-0003', participantId, version: 2, criteria: { ...VOCAL_CRITERIA, delivery: 10 },
    }]);
    assert.equal(newer.json.results[0].result, 'accepted');

    const row = s.db.prepare('SELECT version, comment FROM scores WHERE participant_id = ? AND judge_id = ?')
      .get(participantId, judge1);
    assert.equal(row.version, 2);
    assert.equal(row.comment, null, 'последнее изменение без комментария перезаписало');

    // Журнал: accepted, duplicate не пишется повторно, stale пишется.
    const events = s.db.prepare('SELECT change_id, result FROM score_events ORDER BY id').all();
    assert.deepEqual(events.map(e => e.result), ['accepted', 'stale', 'accepted']);

    const after = await api(s, 'GET', '/api/v1/admin/state');
    assert.ok(after.json.revision > revisionBefore);
    assert.equal(after.json.state.scores.length, 1);
    assert.equal(after.json.state.scores[0].version, 2);
    assert.equal(after.json.state.scores[0].criteria.delivery, 10);

    const same = await api(s, 'GET', `/api/v1/admin/state?since=${after.json.revision}`);
    assert.equal(same.json.changed, false);
  } finally {
    await s.close();
  }
});

test('судья не может оценивать участника блока, куда не назначен', async () => {
  const s = await startServer();
  try {
    const blockA = await createBlock(s, 'Блок A', 'Вокал');
    const blockB = await createBlock(s, 'Блок B', 'Хореография');
    const j1 = await createJudge(s, 'A1');
    const j2 = await createJudge(s, 'A2');
    const j3 = await createJudge(s, 'B1');
    const j4 = await createJudge(s, 'B2');
    await api(s, 'PUT', `/api/v1/admin/blocks/${blockA}/judges`, { judgeIds: [j1, j2] });
    await api(s, 'PUT', `/api/v1/admin/blocks/${blockB}/judges`, { judgeIds: [j3, j4] });
    const foreignParticipant = await createParticipant(s, blockB, { number: 1, name: 'Чужой' });

    const [inv] = await invite(s, [j1]);
    const auth = await authJudge(s, inv.token);
    const bearer = auth.json.deviceToken;

    const r = await judgeApi(s, 'POST', '/api/v1/judge/scores', {
      bearer,
      body: { changes: [{
        changeId: 'foreign-0001', participantId: foreignParticipant, version: 1,
        criteria: VOCAL_CRITERIA,
      }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].result, 'rejected');
    assert.equal(r.json.results[0].code, 'not_assigned');
  } finally {
    await s.close();
  }
});

test('критерии валидируются: все обязательны, 1–10, без лишних ключей', async () => {
  const s = await startServer();
  try {
    const blockId = await createBlock(s, 'Вокал', 'Вокал');
    const judge1 = await createJudge(s, 'Судья 1');
    const judge2 = await createJudge(s, 'Судья 2');
    await api(s, 'PUT', `/api/v1/admin/blocks/${blockId}/judges`, { judgeIds: [judge1, judge2] });
    const participantId = await createParticipant(s, blockId, { number: 1, name: 'Участник' });

    const [inv] = await invite(s, [judge1]);
    const auth = await authJudge(s, inv.token);
    const bearer = auth.json.deviceToken;

    const post = changes => judgeApi(s, 'POST', '/api/v1/judge/scores', { bearer, body: { changes } });

    const missing = await post([{
      changeId: 'val-000001', participantId, version: 1,
      criteria: { impression: 8, stageImage: 9, repertoire: 7, school: 8 },
    }]);
    assert.equal(missing.json.results[0].result, 'rejected');

    const tooBig = await post([{
      changeId: 'val-000002', participantId, version: 1,
      criteria: { ...VOCAL_CRITERIA, delivery: 11 },
    }]);
    assert.equal(tooBig.json.results[0].result, 'rejected');

    const extra = await post([{
      changeId: 'val-000003', participantId, version: 1,
      criteria: { ...VOCAL_CRITERIA, unknown: 5 },
    }]);
    assert.equal(extra.json.results[0].result, 'rejected');

    const ok = await post([{
      changeId: 'val-000004', participantId, version: 1, criteria: VOCAL_CRITERIA,
    }]);
    assert.equal(ok.json.results[0].result, 'accepted');
  } finally {
    await s.close();
  }
});

test('без токена устройства судейские маршруты отвечают 401', async () => {
  const s = await startServer();
  try {
    const r = await request(s.base, 'GET', '/api/v1/judge/state');
    assert.equal(r.status, 401);
    const r2 = await request(s.base, 'POST', '/api/v1/judge/scores', { body: { changes: [] } });
    assert.equal(r2.status, 401);
  } finally {
    await s.close();
  }
});
