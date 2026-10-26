'use strict';

const { randomToken, sha256Hex } = require('../utils/crypto');

function nowIso() {
  return new Date().toISOString();
}

// Приглашение (QR). Токен возвращается в открытом виде ОДИН раз — при создании;
// в БД сохраняется только SHA-256 от токена. Повторно показать токен нельзя,
// для этого администратор перевыпускает приглашение.
function createInvitation(db, judgeId, expiresAt) {
  const token = randomToken(32); // 256 бит
  const info = db.prepare(`
    INSERT INTO judge_invitations (judge_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(judgeId, sha256Hex(token), nowIso(), expiresAt);
  return { id: Number(info.lastInsertRowid), token, expiresAt };
}

function findInvitationByToken(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  return db.prepare('SELECT * FROM judge_invitations WHERE token_hash = ?')
    .get(sha256Hex(token)) || null;
}

// Помечает приглашение использованным. Возвращает true, если строка изменилась
// (защита от одновременного использования одного токена на двух устройствах).
function markInvitationUsed(db, id) {
  const info = db.prepare(
    'UPDATE judge_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL'
  ).run(nowIso(), id);
  return info.changes === 1;
}

function revokeActiveInvitations(db, judgeId) {
  db.prepare(`
    UPDATE judge_invitations SET revoked_at = ?
    WHERE judge_id = ? AND revoked_at IS NULL AND used_at IS NULL
  `).run(nowIso(), judgeId);
}

// Статус приглашений судьи без хешей и токенов.
function listJudgeInvitations(db, judgeId) {
  return db.prepare(`
    SELECT id, judge_id, created_at, expires_at, used_at, revoked_at
    FROM judge_invitations WHERE judge_id = ? ORDER BY id DESC
  `).all(judgeId).map(r => ({
    id: r.id,
    judgeId: r.judge_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
  }));
}

module.exports = {
  createInvitation,
  findInvitationByToken,
  markInvitationUsed,
  revokeActiveInvitations,
  listJudgeInvitations,
};
