'use strict';

function nowIso() {
  return new Date().toISOString();
}

const SELECT_BLOCK = `
  SELECT b.id, b.title, b.genre, b.sort_order,
    (SELECT COUNT(*) FROM participants p WHERE p.block_id = b.id AND p.deleted_at IS NULL) AS participants_count,
    (SELECT COUNT(*) FROM assignments a WHERE a.block_id = b.id AND a.active = 1) AS judges_count
  FROM blocks b`;

function toBlock(r) {
  return {
    id: r.id,
    title: r.title,
    genre: r.genre,
    sortOrder: r.sort_order,
    participantsCount: r.participants_count,
    judgesCount: r.judges_count,
  };
}

function listBlocks(db, competitionId) {
  return db.prepare(`${SELECT_BLOCK} WHERE b.competition_id = ? ORDER BY b.sort_order, b.id`)
    .all(competitionId)
    .map(toBlock);
}

function getBlock(db, competitionId, id) {
  const r = db.prepare(`${SELECT_BLOCK} WHERE b.competition_id = ? AND b.id = ?`)
    .get(competitionId, id);
  return r ? toBlock(r) : null;
}

function insertBlock(db, competitionId, { title, genre }) {
  const ts = nowIso();
  const info = db.prepare(`
    INSERT INTO blocks (competition_id, title, genre, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM blocks WHERE competition_id = ?), ?, ?)
  `).run(competitionId, title, genre, competitionId, ts, ts);
  return Number(info.lastInsertRowid);
}

function updateBlock(db, id, { title, genre }) {
  db.prepare('UPDATE blocks SET title = ?, genre = ?, updated_at = ? WHERE id = ?')
    .run(title, genre, nowIso(), id);
}

function blockReferences(db, id) {
  return {
    participants: db.prepare('SELECT COUNT(*) AS n FROM participants WHERE block_id = ?').get(id).n,
    assignments: db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE block_id = ?').get(id).n,
  };
}

function deleteBlock(db, id) {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
}

module.exports = {
  listBlocks,
  getBlock,
  insertBlock,
  updateBlock,
  blockReferences,
  deleteBlock,
};
