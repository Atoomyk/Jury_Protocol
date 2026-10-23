'use strict';

function nowIso() {
  return new Date().toISOString();
}

const SELECT_JUDGE = `
  SELECT j.id, j.full_name,
    (SELECT COUNT(*) FROM assignments a WHERE a.judge_id = j.id AND a.active = 1) AS blocks_count
  FROM judges j`;

function toJudge(r) {
  return { id: r.id, fullName: r.full_name, blocksCount: r.blocks_count };
}

function listJudges(db, competitionId) {
  return db.prepare(`${SELECT_JUDGE} WHERE j.competition_id = ? ORDER BY j.full_name, j.id`)
    .all(competitionId)
    .map(toJudge);
}

function getJudge(db, competitionId, id) {
  const r = db.prepare(`${SELECT_JUDGE} WHERE j.competition_id = ? AND j.id = ?`)
    .get(competitionId, id);
  return r ? toJudge(r) : null;
}

function insertJudge(db, competitionId, fullName) {
  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO judges (competition_id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(competitionId, fullName, ts, ts);
  return Number(info.lastInsertRowid);
}

function updateJudge(db, id, fullName) {
  db.prepare('UPDATE judges SET full_name = ?, updated_at = ? WHERE id = ?')
    .run(fullName, nowIso(), id);
}

// Сколько записей ссылаются на судью: если есть, удалять нельзя.
function judgeReferences(db, id) {
  const count = sql => db.prepare(sql).get(id).n;
  return {
    scores: count('SELECT COUNT(*) AS n FROM scores WHERE judge_id = ?'),
    assignments: count('SELECT COUNT(*) AS n FROM assignments WHERE judge_id = ?'),
    devices: count('SELECT COUNT(*) AS n FROM judge_devices WHERE judge_id = ?'),
    invitations: count('SELECT COUNT(*) AS n FROM judge_invitations WHERE judge_id = ?'),
  };
}

function deleteJudge(db, id) {
  db.prepare('DELETE FROM judges WHERE id = ?').run(id);
}

// Возвращает Set id, которые существуют в конкурсе.
function findExistingJudgeIds(db, competitionId, ids) {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT id FROM judges WHERE competition_id = ? AND id IN (${placeholders})`
  ).all(competitionId, ...ids);
  return new Set(rows.map(r => r.id));
}

module.exports = {
  listJudges,
  getJudge,
  insertJudge,
  updateJudge,
  judgeReferences,
  deleteJudge,
  findExistingJudgeIds,
};
