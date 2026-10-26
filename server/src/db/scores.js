'use strict';

function findScore(db, participantId, judgeId) {
  return db.prepare('SELECT * FROM scores WHERE participant_id = ? AND judge_id = ?')
    .get(participantId, judgeId) || null;
}

function toScore(r) {
  return {
    participantId: r.participant_id,
    judgeId: r.judge_id,
    changeId: r.change_id,
    version: r.version,
    criteria: JSON.parse(r.criteria_json),
    comment: r.comment,
    createdAt: r.created_at,
    receivedAt: r.received_at,
  };
}

// Идемпотентный приём изменения оценки.
// Возвращает { result: 'accepted' | 'duplicate' | 'stale' }.
// Конфликт решается по version: клиент увеличивает её при каждой правке.
// При одном активном устройстве на судью порядок версий совпадает с порядком
// поступления, поэтому «последняя запись» = изменение с большей версией.
// received_at проставляет сервер (время получения), оно нужно для журнала и
// не участвует в выборе победителя.
function applyChange(db, {
  competitionId, judgeId, participantId, changeId, version, criteria, comment, receivedAt,
}) {
  const seen = db.prepare('SELECT id FROM score_events WHERE change_id = ?').get(changeId);
  if (seen) return { result: 'duplicate' };

  const existing = findScore(db, participantId, judgeId);
  let result;
  if (!existing) {
    db.prepare(`
      INSERT INTO scores
        (competition_id, participant_id, judge_id, change_id, version, criteria_json, comment, created_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      competitionId, participantId, judgeId, changeId, version,
      JSON.stringify(criteria), comment, receivedAt, receivedAt
    );
    result = 'accepted';
  } else if (version <= existing.version) {
    result = 'stale';
  } else {
    db.prepare(`
      UPDATE scores SET change_id = ?, version = ?, criteria_json = ?, comment = ?, received_at = ?
      WHERE id = ?
    `).run(changeId, version, JSON.stringify(criteria), comment, receivedAt, existing.id);
    result = 'accepted';
  }

  db.prepare(`
    INSERT INTO score_events (change_id, competition_id, judge_id, participant_id, version, result, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(changeId, competitionId, judgeId, participantId, version, result, receivedAt);

  return { result };
}

// Все оценки конкурса (для администратора).
function listCompetitionScores(db, competitionId) {
  return db.prepare(`
    SELECT * FROM scores WHERE competition_id = ? ORDER BY participant_id, judge_id
  `).all(competitionId).map(toScore);
}

// Только оценки конкретного судьи (для клиента судьи).
function listJudgeScores(db, judgeId) {
  return db.prepare('SELECT * FROM scores WHERE judge_id = ? ORDER BY participant_id')
    .all(judgeId).map(toScore);
}

module.exports = {
  findScore,
  toScore,
  applyChange,
  listCompetitionScores,
  listJudgeScores,
};
