'use strict';

function nowIso() {
  return new Date().toISOString();
}

function listBlockJudges(db, blockId) {
  return db.prepare(`
    SELECT j.id, j.full_name, a.active
    FROM assignments a
    JOIN judges j ON j.id = a.judge_id
    WHERE a.block_id = ?
    ORDER BY j.full_name, j.id
  `).all(blockId).map(r => ({ id: r.id, fullName: r.full_name, active: r.active === 1 }));
}

// Делает активным ровно набор judgeIds (проверки — в маршруте).
// Снятый судья: active=0, оценки не удаляются.
function setBlockJudges(db, blockId, judgeIds) {
  const ts = nowIso();
  const existing = new Map(
    db.prepare('SELECT judge_id, active FROM assignments WHERE block_id = ?')
      .all(blockId)
      .map(r => [r.judge_id, r.active])
  );
  const wanted = new Set(judgeIds);

  const insert = db.prepare(`
    INSERT INTO assignments (judge_id, block_id, active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `);
  const setActive = db.prepare('UPDATE assignments SET active = ?, updated_at = ? WHERE judge_id = ? AND block_id = ?');

  for (const judgeId of judgeIds) {
    if (!existing.has(judgeId)) {
      insert.run(judgeId, blockId, ts, ts);
    } else if (existing.get(judgeId) !== 1) {
      setActive.run(1, ts, judgeId, blockId);
    }
  }
  for (const [judgeId, active] of existing) {
    if (active === 1 && !wanted.has(judgeId)) {
      setActive.run(0, ts, judgeId, blockId);
    }
  }
}

module.exports = { listBlockJudges, setBlockJudges };
