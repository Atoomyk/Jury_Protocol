'use strict';

const { randomToken, sha256Hex } = require('../utils/crypto');

function nowIso() {
  return new Date().toISOString();
}

// Привязка устройства судьи. Токен возвращается один раз при входе;
// в БД — только SHA-256. Одно активное устройство на судью обеспечивает
// частичный уникальный индекс uq_judge_devices_one_active.
function createDevice(db, judgeId) {
  const token = randomToken(32); // 256 бит
  const ts = nowIso();
  const info = db.prepare(`
    INSERT INTO judge_devices (judge_id, token_hash, status, created_at, activated_at)
    VALUES (?, ?, 'active', ?, ?)
  `).run(judgeId, sha256Hex(token), ts, ts);
  return { id: Number(info.lastInsertRowid), token };
}

function findDeviceByToken(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  return db.prepare('SELECT * FROM judge_devices WHERE token_hash = ?')
    .get(sha256Hex(token)) || null;
}

function findActiveDevice(db, judgeId) {
  return db.prepare("SELECT * FROM judge_devices WHERE judge_id = ? AND status = 'active'")
    .get(judgeId) || null;
}

function revokeDevice(db, id) {
  const info = db.prepare(
    "UPDATE judge_devices SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'"
  ).run(nowIso(), id);
  return info.changes === 1;
}

function revokeActiveDevice(db, judgeId) {
  const info = db.prepare(
    "UPDATE judge_devices SET status = 'revoked', revoked_at = ? WHERE judge_id = ? AND status = 'active'"
  ).run(nowIso(), judgeId);
  return info.changes === 1;
}

// Статус устройств судьи без хешей токенов.
function listDevices(db, judgeId) {
  return db.prepare(`
    SELECT id, judge_id, status, created_at, activated_at, revoked_at
    FROM judge_devices WHERE judge_id = ? ORDER BY id DESC
  `).all(judgeId).map(r => ({
    id: r.id,
    judgeId: r.judge_id,
    status: r.status,
    createdAt: r.created_at,
    activatedAt: r.activated_at,
    revokedAt: r.revoked_at,
  }));
}

module.exports = {
  createDevice,
  findDeviceByToken,
  findActiveDevice,
  revokeDevice,
  revokeActiveDevice,
  listDevices,
};
