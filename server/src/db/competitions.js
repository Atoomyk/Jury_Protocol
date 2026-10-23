'use strict';

const COMPETITION_NAME = 'Лазурный берег';

// Возвращает id единственного конкурса, создавая его при первом запуске.
function ensureCompetition(db) {
  const row = db.prepare('SELECT id FROM competitions ORDER BY id LIMIT 1').get();
  if (row) return row.id;
  const ts = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO competitions (name, created_at, updated_at) VALUES (?, ?, ?)'
  ).run(COMPETITION_NAME, ts, ts);
  return Number(info.lastInsertRowid);
}

module.exports = { ensureCompetition, COMPETITION_NAME };
