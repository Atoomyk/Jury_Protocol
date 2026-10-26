'use strict';

function nowIso() {
  return new Date().toISOString();
}

const SELECT_PARTICIPANT = `
  SELECT p.id, p.competition_id, p.block_id, p.number, p.name, p.title, p.group_size,
    p.nomination, p.category, p.city, p.leader, p.deleted_at, b.genre
  FROM participants p
  JOIN blocks b ON b.id = p.block_id`;

function toParticipant(r) {
  return {
    id: r.id,
    blockId: r.block_id,
    genre: r.genre,
    number: r.number,
    name: r.name,
    title: r.title,
    groupSize: r.group_size,
    nomination: r.nomination,
    category: r.category,
    city: r.city,
    leader: r.leader,
    deleted: r.deleted_at !== null,
  };
}

function listBlockParticipants(db, blockId) {
  return db.prepare(`
    ${SELECT_PARTICIPANT}
    WHERE p.block_id = ? AND p.deleted_at IS NULL
    ORDER BY p.number, p.id
  `).all(blockId).map(toParticipant);
}

// Все неудалённые участники конкурса (для администратора).
function listCompetitionParticipants(db, competitionId) {
  return db.prepare(`
    ${SELECT_PARTICIPANT}
    WHERE p.competition_id = ? AND p.deleted_at IS NULL
    ORDER BY p.number, p.id
  `).all(competitionId).map(toParticipant);
}

function getParticipant(db, competitionId, id) {
  const r = db.prepare(`${SELECT_PARTICIPANT} WHERE p.competition_id = ? AND p.id = ?`)
    .get(competitionId, id);
  return r ? toParticipant(r) : null;
}

// Есть ли неудалённый участник с таким номером (exceptId — не учитывать).
function findActiveByNumber(db, competitionId, number, exceptId = 0) {
  return db.prepare(`
    SELECT id FROM participants
    WHERE competition_id = ? AND number = ? AND deleted_at IS NULL AND id <> ?
  `).get(competitionId, number, exceptId) || null;
}

function insertParticipant(db, competitionId, {
  blockId, number, name, title, groupSize, nomination, category, city, leader,
}) {
  const ts = nowIso();
  const info = db.prepare(`
    INSERT INTO participants
      (competition_id, block_id, number, name, title, group_size, nomination, category, city, leader, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    competitionId, blockId, number, name, title, groupSize,
    nomination, category, city, leader, ts, ts
  );
  return Number(info.lastInsertRowid);
}

function updateParticipant(db, id, {
  number, name, title, groupSize, nomination, category, city, leader,
}) {
  db.prepare(`
    UPDATE participants
    SET number = ?, name = ?, title = ?, group_size = ?,
        nomination = ?, category = ?, city = ?, leader = ?, updated_at = ?
    WHERE id = ?
  `).run(
    number, name, title, groupSize,
    nomination, category, city, leader, nowIso(), id
  );
}

// Soft-delete: оценки остаются, участник скрывается из выдач.
function softDeleteParticipant(db, id) {
  const ts = nowIso();
  db.prepare('UPDATE participants SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(ts, ts, id);
}

module.exports = {
  listBlockParticipants,
  listCompetitionParticipants,
  getParticipant,
  findActiveByNumber,
  insertParticipant,
  updateParticipant,
  softDeleteParticipant,
  toParticipant,
};
